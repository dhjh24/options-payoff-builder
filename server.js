require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const bs = require('./lib/blackScholes');

const app = express();
const PORT = process.env.PORT || 3000;
const AV_KEY = process.env.ALPHAVANTAGE_API_KEY || 'demo';
const AV_BASE = 'https://www.alphavantage.co/query';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Helpers ----------------------------------------------------------

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
  try {
    const quote = await fetchQuote(req.params.symbol.toUpperCase());
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
    const { symbol, strike, expiration, type, spot, iv, riskFreeRate } = req.body;
    if (!symbol || !strike || !expiration || !type) {
      return res.status(400).json({ error: 'symbol, strike, expiration, type are required' });
    }

    let spotPrice = spot;
    if (!spotPrice) {
      const q = await fetchQuote(symbol.toUpperCase());
      spotPrice = q ? q.price : null;
    }

    const market = await fetchOptionQuote(symbol.toUpperCase(), expiration, Number(strike), type);
    if (market && Number.isFinite(market.mark)) {
      return res.json({ ...market, spot: spotPrice });
    }

    if (!Number.isFinite(spotPrice)) {
      return res.status(422).json({ error: 'No market quote available and no spot price to theoretically price the leg.' });
    }

    const t = bs.yearsUntil(expiration);
    const sigma = Number.isFinite(iv) && iv > 0 ? iv : 0.45; // sane default IV when unknown
    const r = Number.isFinite(riskFreeRate) ? riskFreeRate : 0.045;
    const theo = bs.priceAndGreeks({ S: spotPrice, K: Number(strike), T: Math.max(t, 1e-6), r, sigma, type });

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
    const { legs, spot, range } = req.body;
    if (!Array.isArray(legs) || legs.length === 0) {
      return res.status(400).json({ error: 'legs array is required' });
    }
    if (!Number.isFinite(spot)) {
      return res.status(400).json({ error: 'spot price is required' });
    }

    const lo = range && Number.isFinite(range.min) ? range.min : spot * 0.6;
    const hi = range && Number.isFinite(range.max) ? range.max : spot * 1.6;
    const steps = 160;
    const points = [];

    for (let i = 0; i <= steps; i++) {
      const price = lo + ((hi - lo) * i) / steps;
      let pl = 0;
      for (const leg of legs) {
        const qty = (leg.contracts || 1) * (leg.quantity || 1) * 100;
        const sign = leg.side === 'short' ? -1 : 1;
        if (leg.type === 'stock') {
          pl += sign * (price - leg.strike) * qty;
          continue;
        }
        const intrinsic =
          leg.type === 'call' ? Math.max(price - leg.strike, 0) : Math.max(leg.strike - price, 0);
        const legPl = sign * (intrinsic - leg.premium) * qty;
        pl += legPl;
      }
      points.push({ price: round2(price), pl: round2(pl) });
    }

    const breakevens = findBreakevens(points);
    const maxProfit = Math.max(...points.map((p) => p.pl));
    const maxLoss = Math.min(...points.map((p) => p.pl));
    const atCurrentSpot = points.reduce((closest, p) =>
      Math.abs(p.price - spot) < Math.abs(closest.price - spot) ? p : closest
    );

    res.json({
      points,
      breakevens,
      maxProfit,
      maxLoss,
      plAtSpot: atCurrentSpot.pl,
      netPremium: legs.reduce((sum, leg) => {
        const qty = (leg.contracts || 1) * (leg.quantity || 1) * 100;
        const sign = leg.side === 'short' ? -1 : 1;
        return sum + (leg.type === 'stock' ? 0 : -sign * leg.premium * qty);
      }, 0),
    });
  } catch (err) {
    res.status(500).json({ error: 'Payoff computation failed', detail: err.message });
  }
});

function round2(n) {
  return Math.round(n * 100) / 100;
}

function findBreakevens(points) {
  const crossings = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if ((a.pl <= 0 && b.pl > 0) || (a.pl >= 0 && b.pl < 0)) {
      const t = a.pl === b.pl ? 0 : -a.pl / (b.pl - a.pl);
      crossings.push(round2(a.price + t * (b.price - a.price)));
    }
  }
  return crossings;
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Options visualizer running on http://localhost:${PORT}`);
  if (AV_KEY === 'demo') {
    console.log('Using Alpha Vantage "demo" key — live quotes/options will be limited. Set ALPHAVANTAGE_API_KEY in .env for real data.');
  }
});
