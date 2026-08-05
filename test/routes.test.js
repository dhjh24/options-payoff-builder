const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const nock = require('nock');
const app = require('../app');

const AV_HOST = 'https://www.alphavantage.co';

// No test may reach the real Alpha Vantage. Supertest binds a loopback port,
// so that one has to stay open.
nock.disableNetConnect();
nock.enableNetConnect('127.0.0.1');

test.beforeEach(() => nock.cleanAll());
test.after(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

function interceptQuote() {
  return nock(AV_HOST)
    .get('/query')
    .query((q) => q.function === 'GLOBAL_QUOTE');
}

function interceptOptions() {
  return nock(AV_HOST)
    .get('/query')
    .query((q) => q.function === 'REALTIME_OPTIONS');
}

function globalQuotePayload(overrides = {}) {
  return {
    'Global Quote': {
      '01. symbol': 'NVDA',
      '05. price': '181.5000',
      '08. previous close': '178.2500',
      '09. change': '3.2500',
      '10. change percent': '1.8233%',
      ...overrides,
    },
  };
}

function optionContract(overrides = {}) {
  return {
    expiration: '2026-08-12',
    type: 'call',
    strike: '220.00',
    bid: '12.00',
    ask: '13.00',
    last: '12.40',
    implied_volatility: '0.5120',
    delta: '0.4210',
    gamma: '0.0071',
    theta: '-0.0890',
    vega: '0.5530',
    ...overrides,
  };
}

const LEG = { symbol: 'NVDA', strike: 220, expiration: '2026-08-12', type: 'call' };

test('GET /api/health', async (t) => {
  await t.test('reports ok', async () => {
    const res = await request(app).get('/api/health').expect(200);
    assert.deepEqual(res.body, { ok: true });
  });
});

test('GET /api/quote/:symbol', async (t) => {
  await t.test('returns a parsed quote', async () => {
    interceptQuote().reply(200, globalQuotePayload());
    const res = await request(app).get('/api/quote/NVDA').expect(200);
    assert.deepEqual(res.body, {
      symbol: 'NVDA',
      price: 181.5,
      change: 3.25,
      changePercent: '1.8233%',
      prevClose: 178.25,
    });
  });

  await t.test('upper-cases the symbol before querying upstream', async () => {
    let sentSymbol;
    nock(AV_HOST)
      .get('/query')
      .query((q) => {
        sentSymbol = q.symbol;
        return true;
      })
      .reply(200, globalQuotePayload());
    await request(app).get('/api/quote/nvda').expect(200);
    assert.equal(sentSymbol, 'NVDA');
  });

  await t.test('404s when the payload carries no price', async () => {
    interceptQuote().reply(200, { 'Global Quote': {} });
    const res = await request(app).get('/api/quote/NVDA').expect(404);
    assert.match(res.body.error, /Quote not found/);
  });

  await t.test('404s on a rate-limit note rather than a quote', async () => {
    interceptQuote().reply(200, { Note: 'Thank you for using Alpha Vantage!' });
    await request(app).get('/api/quote/NVDA').expect(404);
  });

  await t.test('502s when the upstream fails', async () => {
    interceptQuote().reply(500, 'upstream exploded');
    const res = await request(app).get('/api/quote/NVDA').expect(502);
    assert.match(res.body.error, /Upstream quote provider error/);
  });

  await t.test('502s when the upstream connection errors', async () => {
    interceptQuote().replyWithError('ECONNRESET');
    await request(app).get('/api/quote/NVDA').expect(502);
  });

  await t.test('400s on a malformed symbol without calling upstream', async () => {
    const scope = interceptQuote().reply(200, globalQuotePayload());
    const res = await request(app).get('/api/quote/' + encodeURIComponent('not a symbol!')).expect(400);
    assert.match(res.body.error, /symbol must be/);
    assert.ok(!scope.isDone(), 'upstream should not have been called');
  });
});

test('POST /api/price-leg — validation', async (t) => {
  const cases = [
    ['missing symbol', { ...LEG, symbol: undefined }, /required/],
    ['missing expiration', { ...LEG, expiration: undefined }, /required/],
    ['missing type', { ...LEG, type: undefined }, /required/],
    ['missing strike', { ...LEG, strike: undefined }, /required/],
    ['non-numeric strike', { ...LEG, strike: 'abc' }, /required/],
    ['negative strike', { ...LEG, strike: -10 }, /strike must be 0 or greater/],
    ['unknown type', { ...LEG, type: 'banana' }, /type must be one of/],
    ['malformed expiration', { ...LEG, expiration: '08/12/2026' }, /YYYY-MM-DD/],
    ['impossible expiration', { ...LEG, expiration: '2026-13-45' }, /YYYY-MM-DD/],
    ['non-numeric iv', { ...LEG, spot: 180, iv: 'high' }, /iv must be a number/],
    ['zero iv', { ...LEG, spot: 180, iv: 0 }, /iv must be a number greater than 0/],
    ['non-numeric riskFreeRate', { ...LEG, spot: 180, riskFreeRate: 'low' }, /riskFreeRate must be a number/],
    ['non-numeric spot', { ...LEG, spot: 'high' }, /spot must be a number/],
    ['malformed symbol', { ...LEG, symbol: 'not a symbol!' }, /symbol must be/],
  ];

  for (const [label, body, expected] of cases) {
    await t.test(`400s on ${label}`, async () => {
      const res = await request(app).post('/api/price-leg').send(body).expect(400);
      assert.match(res.body.error, expected);
    });
  }

  // Regression: `!strike` treated a legitimate zero strike as missing.
  await t.test('accepts a zero strike', async () => {
    interceptOptions().reply(200, {});
    await request(app).post('/api/price-leg').send({ ...LEG, strike: 0, spot: 180 }).expect(200);
  });

  await t.test('accepts a zero risk-free rate', async () => {
    interceptOptions().reply(200, {});
    const res = await request(app)
      .post('/api/price-leg')
      .send({ ...LEG, spot: 180, riskFreeRate: 0 })
      .expect(200);
    assert.equal(res.body.source, 'theoretical-black-scholes');
  });

  // Regression: Number.isFinite("0.60") is false, so a string iv was silently
  // discarded and the leg was priced at the 0.45 default.
  await t.test('coerces a numeric string iv instead of discarding it', async () => {
    interceptOptions().reply(200, {});
    const res = await request(app)
      .post('/api/price-leg')
      .send({ ...LEG, spot: 180, iv: '0.60' })
      .expect(200);
    assert.equal(res.body.impliedVolatility, 0.6);
  });

  await t.test('coerces a numeric string strike and spot', async () => {
    interceptOptions().reply(200, {});
    const res = await request(app)
      .post('/api/price-leg')
      .send({ ...LEG, strike: '220', spot: '180' })
      .expect(200);
    assert.equal(res.body.spot, 180);
    assert.ok(Number.isFinite(res.body.mark));
  });

  await t.test('accepts a type in any casing and prices it as that type', async () => {
    interceptOptions().twice().reply(200, {});
    const upper = await request(app)
      .post('/api/price-leg')
      .send({ ...LEG, type: 'CALL', spot: 180 })
      .expect(200);
    const lower = await request(app)
      .post('/api/price-leg')
      .send({ ...LEG, type: 'call', spot: 180 })
      .expect(200);
    // The two requests are milliseconds apart, so time decay moves the mark
    // slightly — compare with a tolerance rather than exactly.
    assert.ok(
      Math.abs(upper.body.mark - lower.body.mark) < 1e-6,
      `casing changed the mark: ${upper.body.mark} vs ${lower.body.mark}`
    );
    // A call struck 40 above spot has positive delta; the old fall-through
    // priced anything unrecognized as a put.
    assert.ok(upper.body.delta > 0, `expected call delta, got ${upper.body.delta}`);
  });
});

test('POST /api/price-leg — live market branch', async (t) => {
  await t.test('returns the market quote when the contract is found', async () => {
    interceptOptions().reply(200, { data: [optionContract()] });
    const res = await request(app).post('/api/price-leg').send({ ...LEG, spot: 181.5 }).expect(200);
    assert.equal(res.body.source, 'alphavantage');
    assert.equal(res.body.mark, 12.5); // (12.00 + 13.00) / 2
    assert.equal(res.body.bid, 12);
    assert.equal(res.body.ask, 13);
    assert.equal(res.body.impliedVolatility, 0.512);
    assert.equal(res.body.delta, 0.421);
    assert.equal(res.body.spot, 181.5);
  });

  await t.test('matches a strike within the 0.001 tolerance', async () => {
    interceptOptions().reply(200, { data: [optionContract({ strike: '220.0005' })] });
    const res = await request(app).post('/api/price-leg').send({ ...LEG, spot: 181.5 }).expect(200);
    assert.equal(res.body.source, 'alphavantage');
  });

  await t.test('falls back to `last` when the mid is zero', async () => {
    // Pinning the `(bid + ask) / 2 || last` behaviour: a genuine zero mid
    // (no two-sided market) resolves to the last trade, not to 0.
    interceptOptions().reply(200, { data: [optionContract({ bid: '0', ask: '0', last: '1.25' })] });
    const res = await request(app).post('/api/price-leg').send({ ...LEG, spot: 181.5 }).expect(200);
    assert.equal(res.body.source, 'alphavantage');
    assert.equal(res.body.mark, 1.25);
  });

  await t.test('fetches spot upstream when the caller omits it', async () => {
    interceptQuote().reply(200, globalQuotePayload());
    interceptOptions().reply(200, { data: [optionContract()] });
    const res = await request(app).post('/api/price-leg').send(LEG).expect(200);
    assert.equal(res.body.spot, 181.5);
  });
});

test('POST /api/price-leg — theoretical fallback', async (t) => {
  // CLAUDE.md: the fallback is what makes the app usable without a paid key.
  // Every one of these upstream conditions must degrade, never error.
  const upstreamFailures = [
    ['no contract matches the expiration', { data: [optionContract({ expiration: '2026-09-18' })] }],
    ['no contract matches the type', { data: [optionContract({ type: 'put' })] }],
    ['no contract matches the strike', { data: [optionContract({ strike: '225.00' })] }],
    ['the chain is empty', { data: [] }],
    ['the payload has no chain', { Information: 'premium endpoint' }],
    ['the payload is not an object', 'plain text'],
  ];

  for (const [label, payload] of upstreamFailures) {
    await t.test(`falls back when ${label}`, async () => {
      interceptOptions().reply(200, payload);
      const res = await request(app).post('/api/price-leg').send({ ...LEG, spot: 181.5 }).expect(200);
      assert.equal(res.body.source, 'theoretical-black-scholes');
      assert.ok(Number.isFinite(res.body.mark));
    });
  }

  await t.test('falls back when the upstream returns an error status', async () => {
    interceptOptions().reply(503, 'unavailable');
    const res = await request(app).post('/api/price-leg').send({ ...LEG, spot: 181.5 }).expect(200);
    assert.equal(res.body.source, 'theoretical-black-scholes');
  });

  await t.test('falls back when the upstream connection errors', async () => {
    interceptOptions().replyWithError('ETIMEDOUT');
    const res = await request(app).post('/api/price-leg').send({ ...LEG, spot: 181.5 }).expect(200);
    assert.equal(res.body.source, 'theoretical-black-scholes');
  });

  await t.test('falls back when the matched contract has an unusable mark', async () => {
    interceptOptions().reply(200, {
      data: [optionContract({ bid: 'n/a', ask: 'n/a', last: 'n/a' })],
    });
    const res = await request(app).post('/api/price-leg').send({ ...LEG, spot: 181.5 }).expect(200);
    assert.equal(res.body.source, 'theoretical-black-scholes');
  });

  await t.test('returns finite greeks and the default IV', async () => {
    interceptOptions().reply(200, {});
    const res = await request(app).post('/api/price-leg').send({ ...LEG, spot: 181.5 }).expect(200);
    assert.equal(res.body.impliedVolatility, 0.45);
    assert.equal(res.body.bid, null);
    assert.equal(res.body.ask, null);
    for (const greek of ['mark', 'delta', 'gamma', 'theta', 'vega']) {
      assert.ok(Number.isFinite(res.body[greek]), `${greek} was ${res.body[greek]}`);
    }
  });

  // Regression: the response echoed the raw (negative) yearsUntil value while
  // pricing at the 1e-6 floor, so it contradicted its own mark.
  await t.test('reports the floored time actually used for an expired leg', async () => {
    interceptOptions().reply(200, {});
    const res = await request(app)
      .post('/api/price-leg')
      .send({ ...LEG, expiration: '2020-01-01', spot: 181.5 })
      .expect(200);
    assert.equal(res.body.yearsToExpiration, 1e-6);
    assert.ok(res.body.yearsToExpiration > 0, 'must never report negative time');
  });

  await t.test('422s when there is neither a market quote nor a spot price', async () => {
    interceptQuote().reply(200, { 'Global Quote': {} });
    interceptOptions().reply(200, {});
    const res = await request(app).post('/api/price-leg').send(LEG).expect(422);
    assert.match(res.body.error, /No market quote available/);
  });
});

test('POST /api/payoff', async (t) => {
  const body = {
    spot: 180,
    legs: [{ type: 'call', side: 'long', strike: 220, premium: 12.5, contracts: 1 }],
  };

  await t.test('computes a curve without touching the network', async () => {
    const res = await request(app).post('/api/payoff').send(body).expect(200);
    assert.equal(res.body.points.length, 161);
    assert.deepEqual(res.body.breakevens, [232.5]);
    assert.equal(res.body.netPremium, -1250);
    assert.equal(res.body.maxLoss, -1250);
  });

  await t.test('surfaces validation failures as a 400 with an error message', async () => {
    const cases = [
      [{ spot: 180 }, /legs array is required/],
      [{ ...body, spot: undefined }, /spot price is required/],
      [{ ...body, legs: [] }, /legs array is required/],
      [{ ...body, legs: [{ ...body.legs[0], type: 'banana' }] }, /type must be one of/],
      [{ ...body, legs: [{ ...body.legs[0], premium: undefined }] }, /premium must be a number/],
      [{ ...body, range: { min: 300, max: 100 } }, /range\.min must be less than range\.max/],
    ];
    for (const [payload, expected] of cases) {
      const res = await request(app).post('/api/payoff').send(payload).expect(400);
      assert.match(res.body.error, expected);
    }
  });

  // Regression: a leg missing `premium` returned 200 with every figure null.
  await t.test('never returns null figures at 200', async () => {
    const res = await request(app).post('/api/payoff').send(body).expect(200);
    for (const key of ['maxProfit', 'maxLoss', 'plAtSpot', 'netPremium']) {
      assert.ok(Number.isFinite(res.body[key]), `${key} was ${res.body[key]}`);
    }
  });

  await t.test('accepts a multi-leg position', async () => {
    const res = await request(app)
      .post('/api/payoff')
      .send({
        spot: 100,
        legs: [
          { type: 'stock', side: 'long', strike: 100, contracts: 1 },
          { type: 'call', side: 'short', strike: 110, premium: 3, contracts: 1 },
        ],
      })
      .expect(200);
    assert.equal(res.body.maxProfit, 1300);
    assert.equal(res.body.netPremium, 300);
  });
});

test('error handling', async (t) => {
  // Regression: express.json() answered a malformed body with an HTML page,
  // which app.js then failed to parse and reported as a syntax error.
  await t.test('returns JSON, not HTML, for a malformed request body', async () => {
    const res = await request(app)
      .post('/api/payoff')
      .set('Content-Type', 'application/json')
      .send('{"spot":100,')
      .expect(400);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.body.error, 'Malformed JSON body');
  });

  await t.test('returns JSON for an oversized request body', async () => {
    const legs = Array.from({ length: 4000 }, () => ({
      type: 'call',
      side: 'long',
      strike: 220,
      premium: 12.5,
      contracts: 1,
    }));
    const res = await request(app).post('/api/payoff').send({ spot: 180, legs }).expect(413);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.body.error, 'Request body too large');
  });

  await t.test('returns an { error } shape the frontend can read', async () => {
    for (const res of [
      await request(app).post('/api/payoff').send({}),
      await request(app).post('/api/price-leg').send({}),
      await request(app).get('/api/quote/!!'),
    ]) {
      assert.match(res.headers['content-type'], /application\/json/);
      assert.equal(typeof res.body.error, 'string');
      assert.ok(res.body.error.length > 0);
    }
  });

  await t.test('serves the static frontend', async () => {
    const res = await request(app).get('/').expect(200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /payoffChart/);
  });
});
