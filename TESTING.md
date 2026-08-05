# Testing

## Running the tests

```bash
npm test              # node --test
npm run test:watch    # re-run on change
npm run test:coverage # with --experimental-test-coverage
```

Tests use the Node standard library (`node:test`, `node:assert`) — no test
framework. The repo has no build step and four runtime dependencies; a runner
like Jest or Vitest would have been the largest thing in it. Node 18+ is
already the engine floor, and `node --test` gives a runner, a watch mode, and
coverage with nothing extra.

Two test-only dependencies: `supertest` (drives the Express app in-process, no
port binding) and `nock` (intercepts the Alpha Vantage calls). **No test
touches the network** — `nock.disableNetConnect()` is on, with loopback left
open for supertest.

```
test/blackScholes.test.js   pricer + greeks + date math
test/payoff.test.js         payoff engine, domain conventions, validation
test/routes.test.js         HTTP contract, upstream mocking, both pricing branches
```

Current coverage: **99.7% of lines, 97.7% of branches.** The only uncovered
lines are the two defensive `catch → 500` blocks in `app.js`.

## What this replaced

There was previously no test suite, runner, or CI — effective coverage was 0%
across `server.js`, `lib/blackScholes.js`, and `public/app.js`. Two structural
changes made the code testable:

- **`server.js` split into `app.js` + `server.js`.** `app.js` builds and
  exports the Express app; `server.js` loads config and listens. Previously
  `app.listen` ran at module load and nothing was exported, so any route test
  needed a real process and a real port.
- **The payoff engine extracted to `lib/payoff.js`.** It was inline in the
  `/api/payoff` handler with `round2` and `findBreakevens` module-private.
  It is pure and I/O-free, matching the convention for `lib/`.

## Defects found and fixed

Each was reproduced against a running server before the fix, and each has a
regression test. They are listed in the order they were hardest to notice.

1. **Unrecognized leg types were silently priced as puts.** Both the payoff
   engine and the pricer branched on `type === 'call'` and treated everything
   else as a put, so `type: "CALL"` returned a 200 whose curve was a long
   *put*, and `type: "banana"` returned a confident `mark: 39.80,
   delta: -0.999`. Types are now validated against a known set, and normalized
   for casing so `"CALL"` prices as a call rather than being rejected.
2. **Missing or non-numeric numeric fields produced `null` at HTTP 200.** A leg
   missing `premium` returned `maxProfit: null, maxLoss: null` and a curve of
   `pl: null` — `NaN` through `JSON.stringify`. `strike: "abc"` priced with
   every greek `null`. Both routes now validate and return 400.
3. **`iv` and `riskFreeRate` were silently dropped when sent as strings.**
   `Number.isFinite("0.60")` is false, so the leg was priced at the 0.45
   default while reporting `impliedVolatility: 0.45`. Numeric fields are now
   coerced, and rejected with a 400 if they are not numeric at all.
4. **`yearsToExpiration` contradicted the price it shipped with.** An expired
   leg was priced at the `1e-6` floor but the response echoed the raw
   `yearsUntil()` value (e.g. `-6.59`). The response now reports the time
   actually used.
5. **`strike: 0` was rejected as missing** by a falsy check. Now uses an
   explicit null check; a zero strike is valid.
6. **Malformed JSON returned an HTML error page.** `express.json()`'s default
   handler answers `400 text/html`, and `public/app.js` calls `.json()` on
   every non-OK response — so the user saw `Unexpected token '<'` instead of
   the real problem. A JSON error handler now keeps every API failure
   `{ error }`-shaped, including `413` for an oversized body.
7. **An inverted `range` silently produced a descending curve.**
   `range: {min: 200, max: 50}` returned points running 200 → 50 at HTTP 200.
   Now a 400, including when a partial range inverts after the other bound is
   defaulted.

One further hardening, not a reported defect: `priceAndGreeks` returned
`gamma: Infinity` and `theta: NaN` for `sigma = 0` or `T = 0`. It now
degenerates to discounted intrinsic with finite greeks. `/api/quote/:symbol`
and `/api/price-leg` also validate the symbol format.

## What the tests pin

**`lib/blackScholes.js`** — put-call parity as a property across a
strike/spot/tenor/vol grid (holds to ~1e-15, and is the strongest single check
on both branches of the pricer); textbook values for `S=K=100, T=1, r=0.05,
sigma=0.2`; `cdf`/`pdf` symmetry, monotonicity, and tail behaviour; delta
bounds and `delta_call - delta_put = 1`; gamma and vega equal for a matched
pair; theta scaled per day and vega per vol point; monotonicity in vol and
time; degenerate inputs staying finite; and `yearsUntil`'s 21:00 UTC anchor,
365.25-day year, negative-for-past behaviour, and `NaN` for an unparseable
date.

Assertions on the pricer cannot be tighter than ~1e-7 — the Abramowitz-Stegun
`erf` is an approximation and `cdf(0)` returns `0.5000000005`.

**`lib/payoff.js`** — the ×100 contract multiplier; `side: 'short'` flipping
the whole leg including the premium term, so a short leg's `netPremium` is a
positive credit; stock legs reusing `strike` as entry price and being excluded
from `netPremium`; multi-leg positions (covered call, bull call spread,
straddle) that the UI never submits; breakevens being exact within a linear
segment but approximate when a strike kink falls between samples, and empty
when the curve never crosses zero in the window; `maxProfit`/`maxLoss` as
window bounds rather than true limits — the invariant the UI's `> 1e6`
"Unlimited" label depends on; range defaults and partial ranges; and the full
validation matrix.

**`app.js`** — the status-code contract (400 malformed, 404 no quote, 422
well-formed but unpriceable, 502 upstream); that every error response is
JSON-shaped with a non-empty `error` string, which is what `public/app.js`
reads; and both pricing branches. The fallback is covered for every way the
upstream can fail — no matching expiration, type, or strike, an empty chain, a
payload with no chain, a non-object payload, a 503, a connection error, and a
matched contract with an unusable mark. All must degrade to
`source: 'theoretical-black-scholes'` and never error; the `catch (_)` that
makes this work is invisible and easy to remove by accident.

## Not covered

**The frontend.** `public/app.js` binds to the DOM at top level and exports
nothing, so it is only reachable through a browser. Two pieces are worth doing
next:

- Extract `fmtUSD`/`fmtPct` so they are testable without a DOM. They own the
  `—` placeholder for `null`/`NaN` that appears throughout the UI.
- One jsdom or Playwright smoke test: load the page, let the `DOMContentLoaded`
  auto-submit run, assert a chart renders and the stat strip populates. That
  would cover the `currentSpot ?? strike` fallback, the `> 1e6` "Unlimited"
  threshold, and the `$(id)` bindings that break silently whenever
  `index.html` and `app.js` drift apart.

Note the gap already documented in CLAUDE.md: `renderChart` builds an
`annotations` array for the strike and spot markers and never passes it to
Chart.js, while the README and the chart caption both promise those markers. A
test asserting the rendered chart config would catch that class of drift.

**CI.** `npm test` is not wired into a workflow yet.
