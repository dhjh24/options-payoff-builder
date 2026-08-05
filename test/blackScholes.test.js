const test = require('node:test');
const assert = require('node:assert/strict');
const bs = require('../lib/blackScholes');

// The Abramowitz-Stegun erf approximation is accurate to ~1e-7, so nothing
// here may assert tighter than that. cdf(0) returns 0.5000000005, not 0.5.
const ERF_TOLERANCE = 1e-7;

function close(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message || `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

test('cdf', async (t) => {
  await t.test('is 0.5 at the mean, within approximation error', () => {
    close(bs.cdf(0), 0.5, ERF_TOLERANCE);
  });

  await t.test('is symmetric: cdf(-x) === 1 - cdf(x)', () => {
    for (const x of [0.1, 0.5, 1, 1.96, 2.5, 4]) {
      close(bs.cdf(-x), 1 - bs.cdf(x), ERF_TOLERANCE, `symmetry broken at x=${x}`);
    }
  });

  await t.test('matches known normal quantiles', () => {
    close(bs.cdf(1), 0.8413447, ERF_TOLERANCE);
    close(bs.cdf(1.644854), 0.95, ERF_TOLERANCE);
    close(bs.cdf(1.959964), 0.975, ERF_TOLERANCE);
  });

  await t.test('is monotonically increasing', () => {
    let prev = bs.cdf(-5);
    for (let x = -4.9; x <= 5; x += 0.1) {
      const current = bs.cdf(x);
      assert.ok(current >= prev, `cdf decreased at x=${x}`);
      prev = current;
    }
  });

  await t.test('saturates in the tails without going out of bounds', () => {
    for (const x of [-40, -8, 8, 40]) {
      const p = bs.cdf(x);
      assert.ok(p >= 0 && p <= 1, `cdf(${x}) = ${p} is outside [0, 1]`);
    }
    close(bs.cdf(-8), 0, ERF_TOLERANCE);
    close(bs.cdf(8), 1, ERF_TOLERANCE);
  });
});

test('pdf', async (t) => {
  await t.test('peaks at zero with the standard normal height', () => {
    close(bs.pdf(0), 1 / Math.sqrt(2 * Math.PI), 1e-12);
  });

  await t.test('is symmetric and decays away from the mean', () => {
    for (const x of [0.5, 1, 2, 3]) {
      close(bs.pdf(-x), bs.pdf(x), 1e-12, `pdf asymmetric at x=${x}`);
      assert.ok(bs.pdf(x) < bs.pdf(x - 0.5), `pdf did not decay at x=${x}`);
    }
  });
});

test('priceAndGreeks', async (t) => {
  await t.test('matches published Black-Scholes values', () => {
    // S=100, K=100, T=1, r=0.05, sigma=0.2 is the standard textbook case:
    // call 10.4506, put 5.5735.
    const args = { S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2 };
    close(bs.priceAndGreeks({ ...args, type: 'call' }).price, 10.4506, 1e-4);
    close(bs.priceAndGreeks({ ...args, type: 'put' }).price, 5.5735, 1e-4);
  });

  await t.test('satisfies put-call parity across the parameter space', () => {
    for (const S of [50, 100, 180]) {
      for (const K of [80, 100, 220]) {
        for (const T of [0.01, 0.25, 1, 3]) {
          for (const sigma of [0.1, 0.45, 1.2]) {
            const r = 0.045;
            const call = bs.priceAndGreeks({ S, K, T, r, sigma, type: 'call' }).price;
            const put = bs.priceAndGreeks({ S, K, T, r, sigma, type: 'put' }).price;
            // c - p = S - K*e^(-rT), the arbitrage-free relationship. This is
            // the single strongest check on both branches of the pricer.
            close(
              call - put,
              S - K * Math.exp(-r * T),
              1e-6,
              `parity broken at S=${S} K=${K} T=${T} sigma=${sigma}`
            );
          }
        }
      }
    }
  });

  await t.test('keeps delta within its theoretical bounds', () => {
    for (const S of [40, 100, 300]) {
      const args = { S, K: 100, T: 0.5, r: 0.045, sigma: 0.45 };
      const call = bs.priceAndGreeks({ ...args, type: 'call' });
      const put = bs.priceAndGreeks({ ...args, type: 'put' });
      assert.ok(call.delta >= 0 && call.delta <= 1, `call delta ${call.delta} out of [0,1]`);
      assert.ok(put.delta >= -1 && put.delta <= 0, `put delta ${put.delta} out of [-1,0]`);
      // delta_call - delta_put = 1 for a matched pair.
      close(call.delta - put.delta, 1, 1e-9);
    }
  });

  await t.test('gives a call and put on the same strike identical gamma and vega', () => {
    const args = { S: 180, K: 220, T: 1.02, r: 0.045, sigma: 0.45 };
    const call = bs.priceAndGreeks({ ...args, type: 'call' });
    const put = bs.priceAndGreeks({ ...args, type: 'put' });
    close(call.gamma, put.gamma, 1e-12);
    close(call.vega, put.vega, 1e-12);
    assert.ok(call.gamma > 0, 'gamma should be positive');
    assert.ok(call.vega > 0, 'vega should be positive');
  });

  await t.test('scales theta per day and vega per vol point', () => {
    const args = { S: 100, K: 100, T: 1, r: 0.045, sigma: 0.45, type: 'call' };
    const { theta, vega } = bs.priceAndGreeks(args);
    // A ~45% vol ATM year-out call loses cents, not dollars, per day.
    assert.ok(theta < 0 && theta > -1, `theta ${theta} is not a per-day figure`);
    // Vega per point is ~1/100th of the raw S*pdf(d1)*sqrt(T) figure.
    assert.ok(vega > 0 && vega < 1, `vega ${vega} is not per vol point`);
  });

  await t.test('never returns a negative price', () => {
    const deepOtm = bs.priceAndGreeks({ S: 100, K: 1, T: 1, r: 0.045, sigma: 0.45, type: 'put' });
    assert.ok(deepOtm.price >= 0);
  });

  await t.test('is monotonic in volatility and in time', () => {
    const base = { S: 100, K: 100, r: 0.045, type: 'call' };
    const lowVol = bs.priceAndGreeks({ ...base, T: 1, sigma: 0.2 }).price;
    const highVol = bs.priceAndGreeks({ ...base, T: 1, sigma: 0.6 }).price;
    assert.ok(highVol > lowVol, 'more vol should be worth more');

    const nearDated = bs.priceAndGreeks({ ...base, T: 0.1, sigma: 0.45 }).price;
    const farDated = bs.priceAndGreeks({ ...base, T: 2, sigma: 0.45 }).price;
    assert.ok(farDated > nearDated, 'more time should be worth more');
  });

  // Regression: these used to return gamma: Infinity and theta: NaN, which
  // JSON.stringify turns into null in an otherwise successful API response.
  await t.test('degenerates cleanly to intrinsic when there is no optionality', () => {
    const cases = [
      { label: 'sigma = 0', args: { S: 100, K: 90, T: 1, r: 0, sigma: 0 } },
      { label: 'T = 0', args: { S: 100, K: 90, T: 0, r: 0, sigma: 0.45 } },
      { label: 'negative sigma', args: { S: 100, K: 90, T: 1, r: 0, sigma: -0.2 } },
      { label: 'S = 0', args: { S: 0, K: 90, T: 1, r: 0, sigma: 0.45 } },
      { label: 'K = 0', args: { S: 100, K: 0, T: 1, r: 0, sigma: 0.45 } },
    ];
    for (const { label, args } of cases) {
      for (const type of ['call', 'put']) {
        const result = bs.priceAndGreeks({ ...args, type });
        for (const [greek, value] of Object.entries(result)) {
          assert.ok(
            Number.isFinite(value),
            `${label} (${type}) produced non-finite ${greek}: ${value}`
          );
        }
        assert.ok(result.price >= 0, `${label} (${type}) produced a negative price`);
      }
    }
  });

  await t.test('prices to intrinsic at expiry', () => {
    const expired = { S: 120, K: 100, T: 0, r: 0.045, sigma: 0.45 };
    assert.equal(bs.priceAndGreeks({ ...expired, type: 'call' }).price, 20);
    assert.equal(bs.priceAndGreeks({ ...expired, type: 'put' }).price, 0);
    assert.equal(bs.priceAndGreeks({ ...expired, type: 'call' }).delta, 1);
    assert.equal(bs.priceAndGreeks({ ...expired, type: 'put' }).delta, 0);
  });
});

test('yearsUntil', async (t) => {
  await t.test('anchors to 21:00 UTC on the given date', () => {
    const expected = (Date.parse('2030-06-15T21:00:00Z') - Date.now()) / (1000 * 60 * 60 * 24 * 365.25);
    close(bs.yearsUntil('2030-06-15'), expected, 1e-6);
  });

  await t.test('measures in years of 365.25 days', () => {
    const oneYear = bs.yearsUntil('2031-01-01') - bs.yearsUntil('2030-01-01');
    close(oneYear, 365 / 365.25, 1e-9);
  });

  await t.test('is negative for a date in the past', () => {
    assert.ok(bs.yearsUntil('2020-01-01') < 0);
  });

  await t.test('returns NaN for an unparseable date', () => {
    // Callers must check this before pricing — it used to reach the pricer
    // and surface as a null mark in a 200 response.
    assert.ok(Number.isNaN(bs.yearsUntil('not-a-date')));
    assert.ok(Number.isNaN(bs.yearsUntil('08/12/2026')));
  });
});
