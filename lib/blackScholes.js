// Minimal Black-Scholes-Merton pricer + first-order greeks.
// Used as a fallback theoretical price when a live option quote
// isn't available (e.g. no premium market-data key configured).

function erf(x) {
  // Abramowitz-Stegun approximation
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function cdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function pdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function priceAndGreeks({ S, K, T, r, sigma, type }) {
  const isCall = type === 'call';
  const discountedK = K * Math.exp(-r * T);

  // With no time, no vol, or a degenerate underlying there is no optionality:
  // the value collapses to discounted intrinsic. Guarding here keeps the
  // division by `sigma * sqrtT` from putting Infinity/NaN into a response.
  if (!(sigma > 0) || !(T > 0) || !(S > 0) || !(K > 0)) {
    const intrinsic = isCall
      ? Math.max(S - discountedK, 0)
      : Math.max(discountedK - S, 0);
    const itm = isCall ? S > discountedK : S < discountedK;
    return {
      price: intrinsic,
      delta: itm ? (isCall ? 1 : -1) : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
    };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const price = isCall
    ? S * cdf(d1) - discountedK * cdf(d2)
    : discountedK * cdf(-d2) - S * cdf(-d1);

  const delta = isCall ? cdf(d1) : cdf(d1) - 1;
  const gamma = pdf(d1) / (S * sigma * sqrtT);
  const vega = (S * pdf(d1) * sqrtT) / 100; // per 1 vol point
  const theta = isCall
    ? (-((S * pdf(d1) * sigma) / (2 * sqrtT)) - r * discountedK * cdf(d2)) / 365
    : (-((S * pdf(d1) * sigma) / (2 * sqrtT)) + r * discountedK * cdf(-d2)) / 365;

  return {
    price: Math.max(price, 0),
    delta,
    gamma,
    theta,
    vega,
  };
}

// Expects `YYYY-MM-DD`. Returns a negative value for a past date and NaN for
// anything unparseable — callers are expected to check before pricing with it.
function yearsUntil(dateStr) {
  const target = new Date(dateStr + 'T21:00:00Z'); // approx market close
  const now = new Date();
  const ms = target.getTime() - now.getTime();
  return ms / (1000 * 60 * 60 * 24 * 365.25);
}

module.exports = { priceAndGreeks, yearsUntil, cdf, pdf };
