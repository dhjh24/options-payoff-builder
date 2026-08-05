// P&L-at-expiration engine for arbitrary multi-leg positions. Pure and
// I/O-free — the routes in app.js validate a request body and hand it here.

const LEG_TYPES = ['call', 'put', 'stock'];
const SIDES = ['long', 'short'];
const STEPS = 160;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Leg `type`/`side` arrive from JSON, so accept any casing. Matching them
// exactly used to mean an unrecognized type fell through to the put branch.
function normalizeEnum(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

// Premiums and strikes are per share, quantities are in contracts. A stock
// leg is scaled by the same factor, so one "contract" of stock is 100 shares.
function legQuantity(leg) {
  return (leg.contracts || 1) * (leg.quantity || 1) * 100;
}

function legSign(leg) {
  return normalizeEnum(leg.side) === 'short' ? -1 : 1;
}

function legPlAt(leg, price) {
  const type = normalizeEnum(leg.type);
  const qty = legQuantity(leg);
  const sign = legSign(leg);

  // A stock leg reuses `strike` as its entry price.
  if (type === 'stock') return sign * (price - leg.strike) * qty;

  const intrinsic =
    type === 'call' ? Math.max(price - leg.strike, 0) : Math.max(leg.strike - price, 0);
  return sign * (intrinsic - leg.premium) * qty;
}

// Short legs collect premium, so a net credit is positive. Stock legs are
// excluded — their cost basis is in the curve, not the premium.
function netPremium(legs) {
  return round2(
    legs.reduce((sum, leg) => {
      if (normalizeEnum(leg.type) === 'stock') return sum;
      return sum + -legSign(leg) * leg.premium * legQuantity(leg);
    }, 0)
  );
}

function resolveRange(spot, range) {
  return {
    min: range && Number.isFinite(range.min) ? range.min : spot * 0.6,
    max: range && Number.isFinite(range.max) ? range.max : spot * 1.6,
  };
}

// Breakevens are linearly interpolated between adjacent sampled points, so
// their precision is tied to STEPS. They are approximate by construction.
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

// Returns a human-readable message describing the first problem found, or
// null when the input is safe to hand to computePayoff. Kept separate so the
// route can map a message to a 400 without inspecting error types.
function validatePayoffInput({ spot, legs, range }) {
  if (!Array.isArray(legs) || legs.length === 0) return 'legs array is required';
  if (!Number.isFinite(spot)) return 'spot price is required';
  if (spot <= 0) return 'spot must be greater than 0';

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const at = `legs[${i}]`;
    if (!leg || typeof leg !== 'object') return `${at} must be an object`;

    const type = normalizeEnum(leg.type);
    if (!LEG_TYPES.includes(type)) {
      return `${at}.type must be one of: ${LEG_TYPES.join(', ')}`;
    }
    if (leg.side != null && !SIDES.includes(normalizeEnum(leg.side))) {
      return `${at}.side must be one of: ${SIDES.join(', ')}`;
    }
    if (!Number.isFinite(leg.strike)) {
      const label = type === 'stock' ? 'strike (entry price)' : 'strike';
      return `${at}.${label} must be a number`;
    }
    if (type !== 'stock' && !Number.isFinite(leg.premium)) {
      return `${at}.premium must be a number`;
    }
    for (const field of ['contracts', 'quantity']) {
      if (leg[field] != null && !(Number.isFinite(leg[field]) && leg[field] > 0)) {
        return `${at}.${field} must be a positive number`;
      }
    }
  }

  if (range != null) {
    if (typeof range !== 'object' || Array.isArray(range)) return 'range must be an object';
    if (range.min != null && !Number.isFinite(range.min)) return 'range.min must be a number';
    if (range.max != null && !Number.isFinite(range.max)) return 'range.max must be a number';
    const { min, max } = resolveRange(spot, range);
    if (min >= max) return 'range.min must be less than range.max';
  }

  return null;
}

function computePayoff({ spot, legs, range }) {
  const { min: lo, max: hi } = resolveRange(spot, range);
  const points = [];

  for (let i = 0; i <= STEPS; i++) {
    const price = lo + ((hi - lo) * i) / STEPS;
    let pl = 0;
    for (const leg of legs) pl += legPlAt(leg, price);
    points.push({ price: round2(price), pl: round2(pl) });
  }

  // maxProfit/maxLoss are the bounds of the sampled window, not true limits:
  // an unbounded long call just reports the P&L at the top of the range.
  const atCurrentSpot = points.reduce((closest, p) =>
    Math.abs(p.price - spot) < Math.abs(closest.price - spot) ? p : closest
  );

  return {
    points,
    breakevens: findBreakevens(points),
    maxProfit: Math.max(...points.map((p) => p.pl)),
    maxLoss: Math.min(...points.map((p) => p.pl)),
    plAtSpot: atCurrentSpot.pl,
    netPremium: netPremium(legs),
  };
}

module.exports = {
  computePayoff,
  validatePayoffInput,
  findBreakevens,
  netPremium,
  legPlAt,
  legQuantity,
  resolveRange,
  round2,
  LEG_TYPES,
  SIDES,
  STEPS,
};
