const test = require('node:test');
const assert = require('node:assert/strict');
const payoff = require('../lib/payoff');

const { computePayoff, validatePayoffInput } = payoff;

function plAt(result, price) {
  const point = result.points.find((p) => p.price === price);
  assert.ok(point, `no sampled point at price ${price}`);
  return point.pl;
}

function longCall(overrides = {}) {
  return { type: 'call', side: 'long', strike: 100, premium: 5, contracts: 1, ...overrides };
}

test('contract scaling', async (t) => {
  await t.test('multiplies per-share premiums and strikes by 100', () => {
    const result = computePayoff({ spot: 100, legs: [longCall()] });
    // One contract, $5 premium: the most this can lose is $500, not $5.
    assert.equal(result.maxLoss, -500);
    assert.equal(plAt(result, 60), -500);
  });

  await t.test('multiplies contracts and quantity together', () => {
    assert.equal(payoff.legQuantity({ contracts: 2, quantity: 3 }), 600);
  });

  await t.test('defaults contracts and quantity to 1', () => {
    assert.equal(payoff.legQuantity({}), 100);
    assert.equal(payoff.legQuantity({ contracts: 4 }), 400);
    assert.equal(payoff.legQuantity({ quantity: 4 }), 400);
  });

  await t.test('scales the whole curve with contract count', () => {
    const one = computePayoff({ spot: 100, legs: [longCall()] });
    const three = computePayoff({ spot: 100, legs: [longCall({ contracts: 3 })] });
    assert.equal(three.maxLoss, one.maxLoss * 3);
    assert.equal(three.maxProfit, one.maxProfit * 3);
    // Breakeven is per share, so it does not move with size.
    assert.deepEqual(three.breakevens, one.breakevens);
  });
});

test('side', async (t) => {
  await t.test('defaults to long when omitted', () => {
    const explicit = computePayoff({ spot: 100, legs: [longCall()] });
    const implied = computePayoff({ spot: 100, legs: [longCall({ side: undefined })] });
    assert.deepEqual(implied.points, explicit.points);
    assert.equal(implied.netPremium, explicit.netPremium);
  });

  await t.test('flips the entire leg including the premium term', () => {
    const long = computePayoff({ spot: 100, legs: [longCall()] });
    const short = computePayoff({ spot: 100, legs: [longCall({ side: 'short' })] });
    assert.equal(short.maxProfit, -long.maxLoss);
    assert.equal(short.maxLoss, -long.maxProfit);
    assert.equal(short.netPremium, -long.netPremium);
  });

  await t.test('gives a short leg a positive net premium (a credit)', () => {
    const result = computePayoff({
      spot: 100,
      legs: [longCall({ side: 'short', contracts: 2 })],
    });
    assert.equal(result.netPremium, 1000);
    assert.equal(result.maxProfit, 1000);
  });

  await t.test('gives a long leg a negative net premium (a debit)', () => {
    assert.equal(computePayoff({ spot: 100, legs: [longCall()] }).netPremium, -500);
  });
});

test('stock legs', async (t) => {
  const stock = { type: 'stock', side: 'long', strike: 100, contracts: 1 };

  await t.test('reuse strike as the entry price and scale by 100', () => {
    const result = computePayoff({ spot: 100, legs: [stock] });
    assert.equal(plAt(result, 160), 6000);
    assert.equal(plAt(result, 100), 0);
    assert.equal(plAt(result, 60), -4000);
  });

  await t.test('are excluded from net premium entirely', () => {
    assert.equal(computePayoff({ spot: 100, legs: [stock] }).netPremium, 0);
    const covered = computePayoff({
      spot: 100,
      legs: [stock, longCall({ side: 'short', strike: 110, premium: 3 })],
    });
    // Only the short call contributes: the stock leg's basis is in the curve.
    assert.equal(covered.netPremium, 300);
  });

  await t.test('invert under a short side', () => {
    const result = computePayoff({ spot: 100, legs: [{ ...stock, side: 'short' }] });
    assert.equal(plAt(result, 160), -6000);
    assert.equal(plAt(result, 60), 4000);
  });
});

test('multi-leg positions', async (t) => {
  await t.test('caps a covered call at the short strike', () => {
    const result = computePayoff({
      spot: 100,
      legs: [
        { type: 'stock', side: 'long', strike: 100, contracts: 1 },
        longCall({ type: 'call', side: 'short', strike: 110, premium: 3 }),
      ],
    });
    // Upside stops at (110 - 100 + 3) * 100 regardless of how far spot runs.
    assert.equal(plAt(result, 110), 1300);
    assert.equal(plAt(result, 160), 1300);
    assert.equal(result.maxProfit, 1300);
  });

  await t.test('bounds a bull call spread on both sides', () => {
    const result = computePayoff({
      spot: 100,
      legs: [longCall(), longCall({ side: 'short', strike: 110, premium: 2 })],
    });
    assert.equal(result.netPremium, -300); // net debit
    assert.equal(result.maxLoss, -300);
    assert.equal(result.maxProfit, 700); // (110 - 100 - 3) * 100
    assert.deepEqual(result.breakevens, [103]);
  });

  await t.test('gives a long straddle two breakevens', () => {
    const result = computePayoff({
      spot: 100,
      legs: [longCall(), { type: 'put', side: 'long', strike: 100, premium: 4, contracts: 1 }],
    });
    assert.equal(result.netPremium, -900);
    assert.deepEqual(result.breakevens, [91, 109]);
    assert.equal(result.plAtSpot, -900);
  });
});

test('breakevens', async (t) => {
  await t.test('are exact when the crossing lies inside one linear segment', () => {
    // No strike kink between the bracketing samples, so interpolation is exact.
    const result = computePayoff({ spot: 180, legs: [longCall({ strike: 220, premium: 12.5 })] });
    assert.deepEqual(result.breakevens, [232.5]);
  });

  await t.test('are approximate when a strike falls between two samples', () => {
    // 160 steps over [60, 160] is a 0.625 stride; a kink inside a segment
    // pulls the interpolated crossing off the true breakeven.
    const result = computePayoff({ spot: 100, legs: [longCall({ strike: 100.3, premium: 0.01 })] });
    const trueBreakeven = 100.31;
    assert.equal(result.breakevens.length, 1);
    assert.notEqual(result.breakevens[0], trueBreakeven);
    assert.ok(
      Math.abs(result.breakevens[0] - trueBreakeven) < 0.625,
      'error should still be bounded by the sample stride'
    );
  });

  await t.test('are empty when the curve never crosses zero in the window', () => {
    const result = computePayoff({ spot: 100, legs: [longCall({ strike: 200 })] });
    assert.deepEqual(result.breakevens, []);
    assert.equal(result.maxProfit, -500); // never profitable inside the window
  });

  await t.test('are empty for a flat zero curve rather than reporting every point', () => {
    const result = computePayoff({ spot: 100, legs: [longCall({ strike: 200, premium: 0 })] });
    assert.deepEqual(result.breakevens, []);
  });

  await t.test('interpolate linearly between adjacent points', () => {
    assert.deepEqual(
      payoff.findBreakevens([
        { price: 100, pl: -50 },
        { price: 102, pl: 50 },
      ]),
      [101]
    );
  });
});

test('window bounds', async (t) => {
  await t.test('report max profit at the top of the range, not as unbounded', () => {
    const result = computePayoff({ spot: 100, legs: [longCall()] });
    // An unbounded long call is only unbounded in theory; the engine reports
    // the sampled edge. The UI's "Unlimited" label depends on this.
    assert.equal(result.maxProfit, 5500);
    assert.equal(plAt(result, 160), 5500);
  });

  await t.test('grow max profit with a wider range', () => {
    const wide = computePayoff({ spot: 100, legs: [longCall()], range: { min: 60, max: 2e6 } });
    assert.ok(wide.maxProfit > 1e6, 'the UI treats > 1e6 as Unlimited');
  });

  await t.test('report a true max loss for a defined-risk position', () => {
    const result = computePayoff({ spot: 100, legs: [longCall()] });
    assert.equal(result.maxLoss, -500);
  });
});

test('sampling', async (t) => {
  await t.test('emits STEPS + 1 points', () => {
    const result = computePayoff({ spot: 100, legs: [longCall()] });
    assert.equal(result.points.length, payoff.STEPS + 1);
  });

  await t.test('defaults the range to 0.6x - 1.6x spot', () => {
    const result = computePayoff({ spot: 100, legs: [longCall()] });
    assert.equal(result.points[0].price, 60);
    assert.equal(result.points[result.points.length - 1].price, 160);
  });

  await t.test('honours an explicit range', () => {
    const result = computePayoff({ spot: 100, legs: [longCall()], range: { min: 90, max: 110 } });
    assert.equal(result.points[0].price, 90);
    assert.equal(result.points[result.points.length - 1].price, 110);
  });

  await t.test('honours a partial range and defaults the other bound', () => {
    const onlyMin = computePayoff({ spot: 100, legs: [longCall()], range: { min: 90 } });
    assert.equal(onlyMin.points[0].price, 90);
    assert.equal(onlyMin.points[onlyMin.points.length - 1].price, 160);

    const onlyMax = computePayoff({ spot: 100, legs: [longCall()], range: { max: 110 } });
    assert.equal(onlyMax.points[0].price, 60);
    assert.equal(onlyMax.points[onlyMax.points.length - 1].price, 110);
  });

  await t.test('is strictly ascending in price', () => {
    const result = computePayoff({ spot: 180, legs: [longCall({ strike: 220 })] });
    for (let i = 1; i < result.points.length; i++) {
      assert.ok(
        result.points[i].price > result.points[i - 1].price,
        `points not ascending at index ${i}`
      );
    }
  });

  await t.test('rounds prices and P&L to cents', () => {
    const result = computePayoff({ spot: 173.31, legs: [longCall({ premium: 12.345 })] });
    for (const point of result.points) {
      assert.equal(point.price, payoff.round2(point.price));
      assert.equal(point.pl, payoff.round2(point.pl));
    }
    assert.equal(result.netPremium, payoff.round2(result.netPremium));
  });

  await t.test('reports P&L at the sampled point nearest spot', () => {
    const result = computePayoff({ spot: 100, legs: [longCall()] });
    assert.equal(result.plAtSpot, -500);
  });
});

test('output is always finite', async (t) => {
  await t.test('produces no NaN for any valid leg combination', () => {
    const result = computePayoff({
      spot: 180,
      legs: [
        longCall({ strike: 220, premium: 12.5 }),
        { type: 'put', side: 'short', strike: 150, premium: 6.25, contracts: 2 },
        { type: 'stock', side: 'long', strike: 178.4, contracts: 1 },
      ],
    });
    for (const key of ['maxProfit', 'maxLoss', 'plAtSpot', 'netPremium']) {
      assert.ok(Number.isFinite(result[key]), `${key} was ${result[key]}`);
    }
    for (const point of result.points) {
      assert.ok(Number.isFinite(point.pl), `non-finite pl at price ${point.price}`);
    }
  });
});

test('validatePayoffInput', async (t) => {
  const valid = { spot: 100, legs: [longCall()] };

  await t.test('accepts a well-formed request', () => {
    assert.equal(validatePayoffInput(valid), null);
  });

  await t.test('rejects a missing or empty legs array', () => {
    assert.match(validatePayoffInput({ spot: 100 }), /legs array is required/);
    assert.match(validatePayoffInput({ spot: 100, legs: [] }), /legs array is required/);
    assert.match(validatePayoffInput({ spot: 100, legs: 'call' }), /legs array is required/);
  });

  await t.test('rejects a missing or non-numeric spot', () => {
    assert.match(validatePayoffInput({ legs: [longCall()] }), /spot price is required/);
    assert.match(validatePayoffInput({ ...valid, spot: '100' }), /spot price is required/);
    assert.match(validatePayoffInput({ ...valid, spot: 0 }), /spot must be greater than 0/);
  });

  // Regression: an unrecognized type used to fall through to the put branch,
  // so `type: "CALL"` silently returned a long put curve at HTTP 200.
  await t.test('rejects an unrecognized leg type instead of pricing it as a put', () => {
    assert.match(
      validatePayoffInput({ ...valid, legs: [longCall({ type: 'banana' })] }),
      /legs\[0\]\.type must be one of/
    );
    assert.match(
      validatePayoffInput({ ...valid, legs: [longCall({ type: undefined })] }),
      /legs\[0\]\.type must be one of/
    );
  });

  await t.test('accepts a leg type in any casing and prices it correctly', () => {
    assert.equal(validatePayoffInput({ ...valid, legs: [longCall({ type: 'CALL' })] }), null);
    const upper = computePayoff({ spot: 100, legs: [longCall({ type: 'CALL' })] });
    const lower = computePayoff({ spot: 100, legs: [longCall()] });
    assert.deepEqual(upper.points, lower.points);
  });

  await t.test('accepts a side in any casing', () => {
    assert.equal(validatePayoffInput({ ...valid, legs: [longCall({ side: 'SHORT' })] }), null);
    const upper = computePayoff({ spot: 100, legs: [longCall({ side: 'SHORT' })] });
    const lower = computePayoff({ spot: 100, legs: [longCall({ side: 'short' })] });
    assert.deepEqual(upper.points, lower.points);
  });

  await t.test('rejects an unrecognized side', () => {
    assert.match(
      validatePayoffInput({ ...valid, legs: [longCall({ side: 'sideways' })] }),
      /legs\[0\]\.side must be one of/
    );
  });

  // Regression: these used to produce NaN, serialized as null, at HTTP 200.
  await t.test('rejects a missing or non-numeric premium', () => {
    assert.match(
      validatePayoffInput({ ...valid, legs: [longCall({ premium: undefined })] }),
      /legs\[0\]\.premium must be a number/
    );
    assert.match(
      validatePayoffInput({ ...valid, legs: [longCall({ premium: '5' })] }),
      /legs\[0\]\.premium must be a number/
    );
  });

  await t.test('rejects a missing or non-numeric strike', () => {
    assert.match(
      validatePayoffInput({ ...valid, legs: [longCall({ strike: undefined })] }),
      /legs\[0\]\.strike must be a number/
    );
    assert.match(
      validatePayoffInput({ ...valid, legs: [longCall({ strike: 'abc' })] }),
      /legs\[0\]\.strike must be a number/
    );
  });

  await t.test('does not require a premium on a stock leg', () => {
    assert.equal(
      validatePayoffInput({ spot: 100, legs: [{ type: 'stock', side: 'long', strike: 100 }] }),
      null
    );
  });

  await t.test('accepts a zero strike', () => {
    assert.equal(validatePayoffInput({ ...valid, legs: [longCall({ strike: 0 })] }), null);
  });

  await t.test('rejects a non-positive contract or quantity count', () => {
    for (const field of ['contracts', 'quantity']) {
      assert.match(
        validatePayoffInput({ ...valid, legs: [longCall({ [field]: 0 })] }),
        new RegExp(`legs\\[0\\]\\.${field} must be a positive number`)
      );
      assert.match(
        validatePayoffInput({ ...valid, legs: [longCall({ [field]: -2 })] }),
        new RegExp(`legs\\[0\\]\\.${field} must be a positive number`)
      );
    }
  });

  await t.test('reports the index of the offending leg', () => {
    assert.match(
      validatePayoffInput({ ...valid, legs: [longCall(), longCall({ premium: null })] }),
      /legs\[1\]\.premium/
    );
  });

  await t.test('rejects a non-object leg', () => {
    assert.match(validatePayoffInput({ ...valid, legs: [null] }), /legs\[0\] must be an object/);
    assert.match(validatePayoffInput({ ...valid, legs: ['call'] }), /legs\[0\] must be an object/);
  });

  // Regression: an inverted range used to return a descending curve at 200.
  await t.test('rejects an inverted range', () => {
    assert.match(
      validatePayoffInput({ ...valid, range: { min: 200, max: 50 } }),
      /range\.min must be less than range\.max/
    );
  });

  await t.test('rejects a range inverted only after defaulting the other bound', () => {
    // min above the default 1.6x max.
    assert.match(
      validatePayoffInput({ ...valid, range: { min: 500 } }),
      /range\.min must be less than range\.max/
    );
  });

  await t.test('rejects non-numeric range bounds', () => {
    assert.match(validatePayoffInput({ ...valid, range: { min: 'low' } }), /range\.min must be a number/);
    assert.match(validatePayoffInput({ ...valid, range: { max: 'high' } }), /range\.max must be a number/);
  });

  await t.test('allows an omitted range', () => {
    assert.equal(validatePayoffInput({ ...valid, range: undefined }), null);
    assert.equal(validatePayoffInput({ ...valid, range: null }), null);
  });
});
