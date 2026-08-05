const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const bs = require('./lib/blackScholes');
const payoff = require('./lib/payoff');

const AV_KEY = process.env.ALPHAVANTAGE_API_KEY || 'demo';
const AV_BASE = 'https://www.alphavantage.co/query';

const DEFAULT_IV = 0.45;
const DEFAULT_RISK_FREE_RATE = 0.045;
const MIN_YEARS_TO_EXPIRATION = 1e-6; // keeps expired/same-day legs off a divide-by-zero
const OPTION_TYPES = ['call', 'put'];
const SYMBOL_PATTERN = /^[A-Z][A-Z.-]{0,9}$/;
const EXPIRATION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Helpers ----------------------------------------------------------

// Numeric fields arrive from JSON and are sometimes strings (a form value
// passed straight through). Coerce rather than silently falling back to a
// default, which used to discard a caller's `iv` without telling them.
function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchQuote(symbol) {
  const { data } = await axios.get(AV_BASE, {
    params: { function: 'GLOBAL_QUOTE', symbol, apikey: AV_KEY },
    timeout: 8000,
  });
  const q = data && data['Global Quote'];
  if (!q || !q['05. price']) return null;
  return {
    symbol,
    price: parseFloat(q['05. price']),
    change: parseFloat(q['09. change']),
    changePercent: q['10. change percent'],
    prevClose: parseFloat(q['08. previous close']),
  };
}

async function fetchOptionQuote(symbol, expiration, strike, type) {
  // Alpha Vantage's live options endpoint requires a premium key. We try it,
  // and fall back to a theoretical (Black-Scholes) mark if it's unavailable
  // so the app stays useful on a free/demo key.
  try {
    const { data } = await axios.get(AV_BASE, {
      params: { function: 'REALTIME_OPTIONS', symbol, require_greeks: true, apikey: AV_KEY },
      timeout: 8000,
    });
    const chain = data && data.data;
    if (Array.isArray(chain)) {
      const hit = chain.find(
        (c) =>
          c.expiration === expiration &&
          c.type === type &&
          Math.abs(parseFloat(c.strike) - strike) < 0.001
      );
      if (hit) {
        return {
          source: 'alphavantage',
          bid: parseFloat(hit.bid),
          ask: parseFloat(hit.ask),
          last: parseFloat(hit.last),
          mark: (parseFloat(hit.bid) + parseFloat(hit.ask)) / 2 || parseFloat(hit.last),
          impliedVolatility: parseFloat(hit.implied_volatility),
          delta: parseFloat(hit.delta),
          gamma: parseFloat(hit.gamma),
          theta: parseFloat(hit.theta),
          vega: parseFloat(hit.vega),
        };
      }
    }
  } catch (_) {
    // fall through to theoretical pricing
  }
  return null;
}

// ---- Routes -------------------------------------------------------------

app.get('/api/quote/:symbol', async (req, res) => {
  const symbol = req.params.symbol.trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(symbol)) {
    return res.status(400).json({ error: 'symbol must be 1-10 letters, dots or dashes' });
  }
  try {
    const quote = await fetchQuote(symbol);
    if (!quote) return res.status(404).json({ error: 'Quote not found (check API key / symbol).' });
    res.json(quote);
  } catch (err) {
    res.status(502).json({ error: 'Upstream quote provider error', detail: err.message });
  }
});

// Returns a priced leg: real market quote if available, otherwise a
// Black-Scholes theoretical price + greeks computed from spot/IV/time.
app.post('/api/price-leg', async (req, res) => {
  try {
    const body = req.body || {};
    const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : null;
    const type = typeof body.type === 'string' ? body.type.trim().toLowerCase() : null;
    const strike = toFiniteNumber(body.strike);
    const expiration = typeof body.expiration === 'string' ? body.expiration.trim() : null;

    if (!symbol || strike == null || !expiration || !type) {
      return res.status(400).json({ error: 'symbol, strike, expiration, type are required' });
    }
    if (!SYMBOL_PATTERN.test(symbol)) {
      return res.status(400).json({ error: 'symbol must be 1-10 letters, dots or dashes' });
    }
    if (strike < 0) {
      return res.status(400).json({ error: 'strike must be 0 or greater' });
    }
    if (!OPTION_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${OPTION_TYPES.join(', ')}` });
    }
    if (!EXPIRATION_PATTERN.test(expiration) || Number.isNaN(Date.parse(expiration))) {
      return res.status(400).json({ error: 'expiration must be a YYYY-MM-DD date' });
    }

    const sigma = body.iv == null ? DEFAULT_IV : toFiniteNumber(body.iv);
    if (sigma == null || sigma <= 0) {
      return res.status(400).json({ error: 'iv must be a number greater than 0' });
    }
    const r = body.riskFreeRate == null ? DEFAULT_RISK_FREE_RATE : toFiniteNumber(body.riskFreeRate);
    if (r == null) {
      return res.status(400).json({ error: 'riskFreeRate must be a number' });
    }
    if (body.spot != null && toFiniteNumber(body.spot) == null) {
      return res.status(400).json({ error: 'spot must be a number' });
    }

    let spotPrice = toFiniteNumber(body.spot);
    if (spotPrice == null) {
      const q = await fetchQuote(symbol);
      spotPrice = q ? q.price : null;
    }

    const market = await fetchOptionQuote(symbol, expiration, strike, type);
    if (market && Number.isFinite(market.mark)) {
      return res.json({ ...market, spot: spotPrice });
    }

    if (!Number.isFinite(spotPrice)) {
      return res.status(422).json({ error: 'No market quote available and no spot price to theoretically price the leg.' });
    }

    // Report the time actually used to price, not the raw (possibly negative)
    // value — an expired leg is priced at the floor, and saying otherwise
    // makes the response contradict itself.
    const t = Math.max(bs.yearsUntil(expiration), MIN_YEARS_TO_EXPIRATION);
    const theo = bs.priceAndGreeks({ S: spotPrice, K: strike, T: t, r, sigma, type });

    res.json({
      source: 'theoretical-black-scholes',
      mark: theo.price,
      bid: null,
      ask: null,
      last: null,
      impliedVolatility: sigma,
      delta: theo.delta,
      gamma: theo.gamma,
      theta: theo.theta,
      vega: theo.vega,
      spot: spotPrice,
      yearsToExpiration: t,
    });
  } catch (err) {
    res.status(500).json({ error: 'Pricing failed', detail: err.message });
  }
});

// Computes a P&L-at-expiration curve for an arbitrary list of option/stock legs.
// legs: [{ type: 'call'|'put'|'stock', side: 'long'|'short', strike, premium, quantity, contracts }]
app.post('/api/payoff', (req, res) => {
  try {
    const { legs, spot, range } = req.body || {};
    const invalid = payoff.validatePayoffInput({ legs, spot, range });
    if (invalid) return res.status(400).json({ error: invalid });

    res.json(payoff.computePayoff({ legs, spot, range }));
  } catch (err) {
    res.status(500).json({ error: 'Payoff computation failed', detail: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Keep every API failure JSON-shaped. express.json() otherwise answers a
// malformed body with an HTML page, which the frontend then tries to parse as
// JSON and reports as a syntax error instead of the real problem.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  res.status(err.status || 500).json({ error: 'Unexpected server error', detail: err.message });
});

module.exports = app;
