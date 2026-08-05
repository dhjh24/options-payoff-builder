# Test coverage analysis & proposal

Status: **there is no test suite.** No test runner, no test files, no `test`
script, no CI. Effective coverage across `server.js`, `lib/blackScholes.js`,
and `public/app.js` is 0%.

This document records what is untested, which real defects that has allowed,
and a priority-ordered plan for closing the gap. Every defect listed under
"Confirmed defects" was reproduced against a locally running server — none are
hypothetical.

## Current surface area

| Unit | Functions | Covered |
|---|---|---|
| `lib/blackScholes.js` | `erf`, `cdf`, `pdf`, `priceAndGreeks`, `yearsUntil` | 0 |
| `server.js` — helpers | `fetchQuote`, `fetchOptionQuote`, `round2`, `findBreakevens` | 0 |
| `server.js` — routes | `/api/quote/:symbol`, `/api/price-leg`, `/api/payoff`, `/api/health` | 0 |
| `public/app.js` | `fmtUSD`, `fmtPct`, `refreshTicker`, `renderChart`, `setStats`, `setLegReadout`, `submitLeg` | 0 |

## Structural blockers

Two things make the code hard to test as written. Both are small refactors and
both should land before (or with) the first tests.

1. **`server.js` calls `app.listen` at module load and exports nothing.** Any
   route test has to spawn a real process and bind a port. Splitting into
   `app.js` (builds and exports the Express app) and `server.js` (requires it
   and listens) makes the whole API testable in-process with `supertest`.

2. **The payoff engine lives inside the route handler.** `round2` and
   `findBreakevens` are module-private, and the curve loop is inline in the
   `/api/payoff` closure. Extracting a pure `lib/payoff.js` with
   `computePayoff({ spot, legs, range })` matches the existing convention that
   `lib/` is pure and I/O-free, and turns the highest-value math in the repo
   into something directly assertable.

A third, lower priority: `public/app.js` binds to the DOM at top level and
exports nothing, so it is only reachable through a browser. That is fine to
leave alone until the API layer is covered.

## Confirmed defects an initial suite would have caught

These are ordered by how quietly they fail. All reproduced via `curl`.

**1. Unrecognized leg types are silently priced as puts.** Both the payoff
engine and the pricer branch on `type === 'call'` and treat *everything else*
as a put:

```js
// server.js
const intrinsic = leg.type === 'call' ? Math.max(price - leg.strike, 0)
                                      : Math.max(leg.strike - price, 0);
// lib/blackScholes.js
const isCall = type === 'call';
```

A leg with `type: "CALL"` (capitalized) returns a full 200 response whose curve
is a long *put*. `POST /api/price-leg` with `type: "banana"` returns a
confident `mark: 39.80` and `delta: -0.999`. Neither route validates `type`
against a known set.

**2. Missing or non-numeric numeric fields produce `null` at HTTP 200.** A leg
missing `premium` yields `maxProfit: null, maxLoss: null, netPremium: null,`
and a curve of `{"price":60,"pl":null}` — `NaN` serialized through
`JSON.stringify`. `POST /api/price-leg` with `strike: "abc"` returns
`mark: null` with every greek `null`, also at 200. Neither route rejects the
input; the client renders `—` and the user reads it as "no data" rather than
"bad request".

**3. `iv` and `riskFreeRate` are silently dropped when sent as strings.** The
guard is `Number.isFinite(iv)`, so `iv: "0.60"` fails it and the request is
priced at the 0.45 default with `impliedVolatility: 0.45` in the response. The
caller gets no signal that their volatility input was discarded. Same for
`riskFreeRate` and its 0.045 default.

**4. `yearsToExpiration` in the response contradicts the price.** For an
expired contract the route prices with `T` floored at `1e-6`, but echoes back
the raw `yearsUntil()` value: an already-expired leg returns
`yearsToExpiration: -6.59` alongside a price computed at essentially zero time.

**5. `strike: 0` is rejected as missing.** `/api/price-leg` validates with
`if (!symbol || !strike || ...)`, so a legitimate zero strike returns
`400 "symbol, strike, expiration, type are required"`. Cosmetic today, but the
same falsy-check pattern is what would reject `spot: 0` elsewhere.

**6. Malformed JSON returns an HTML error page, and the frontend chokes on
it.** `express.json()`'s default handler responds `400 text/html`. `app.js`
does `throw new Error((await res.json()).error || ...)` on every non-OK
response, so parsing the HTML throws a `SyntaxError` and the user sees
`Could not build payoff: Unexpected token '<'` instead of the real problem.
There is no JSON error-handling middleware.

**7. An inverted `range` silently produces a descending curve.** `range: {min:
200, max: 50}` returns points running 200 → 50. Chart.js will render it, and
`findBreakevens` still reports a crossing, but every consumer that assumes
ascending price order is now wrong.

## Proposed test areas, in priority order

### P0 — `lib/blackScholes.js` (pure, no I/O, highest value per line)

This is the easiest thing in the repo to assert on and the place CLAUDE.md
already points to.

- **Put–call parity as a property test.** `c - p == S - K·e^(-rT)` holds to
  7e-15 across the parameter space — a single property covering both branches
  of the pricer and catching any sign error instantly.
- **Known-value regression** against published Black–Scholes figures, with a
  tolerance no tighter than ~1e-7: the Abramowitz–Stegun `erf` is an
  approximation and `cdf(0)` returns `0.5000000005`, not `0.5`. Pinning the
  tolerance documents that the error is expected and bounds it.
- **`cdf`/`pdf` invariants**: `cdf(-x) == 1 - cdf(x)`, monotonicity, tails
  (`cdf(-8) ≈ 6e-16`, `cdf(8) ≈ 1`), `pdf` symmetric and peaking at 0.
- **Greek signs and bounds**: call delta in `[0,1]`, put delta in `[-1,0]`,
  gamma and vega ≥ 0 and equal for a call/put pair at the same strike.
- **Degenerate inputs**, which currently return garbage rather than erroring:
  `sigma = 0` gives `gamma: Infinity`; `T = 0` gives `gamma: Infinity` and
  `theta: NaN`. Tests should pin whatever behavior is chosen — clamping,
  throwing, or documenting.
- **`yearsUntil`**: `YYYY-MM-DD` parsing, the 21:00 UTC anchor, negative
  values for past dates, and `NaN` for an unparseable string (which currently
  propagates all the way into a response).

### P0 — payoff math (after extracting `lib/payoff.js`)

The domain conventions in CLAUDE.md are exactly the things with no automated
guard:

- **The ×100 contract multiplier**, on option legs and on the stock leg's
  reuse of `strike` as entry price.
- **`side: 'short'` flips the whole leg including the premium term** — a short
  call collects premium, so `netPremium` is positive (verified: `+1000` for 2
  short contracts at 5.00).
- **`netPremium` ignores stock legs entirely.**
- **Multi-leg positions** — vertical spread, straddle, covered call — since the
  engine supports them but the UI only ever sends one leg, so nothing exercises
  that path today.
- **Breakeven accuracy and its limits.** Breakevens come from linear
  interpolation over a fixed 160 steps, so they are approximate: assert with a
  tolerance tied to step size, and cover the zero-crossing edges (flat segment
  at exactly zero, a breakeven outside the sampled window returning `[]`).
- **`maxProfit`/`maxLoss` are window bounds, not true limits.** Pin that an
  unbounded long call reports the P&L at the top of the range — this is the
  invariant the UI's `> 1e6` "Unlimited" hack depends on.
- **Range handling**: defaults of `spot*0.6`/`spot*1.6`, explicit
  `range.min`/`max`, partial range, and the inverted-range case above.

### P1 — HTTP routes (after the `app.js` / `server.js` split)

With `supertest`, in-process, no port binding:

- **Validation matrix** per route: missing fields, wrong types, empty `legs`
  array, non-array `legs`, `spot` as a string. Assert both status *and* the
  `{ error }` shape the frontend depends on.
- **Status-code contract** from CLAUDE.md: 400 malformed, 404 no quote, 422
  well-formed but unpriceable, 502 upstream failure, 5xx only for genuine
  faults. Currently only the happy paths and two 400s are exercised by hand.
- **JSON error middleware** so malformed bodies return `{ error }` rather than
  HTML (defect 6), with a test asserting the content type.
- `/api/health` returning `{ ok: true }` — trivial, but it is what the Docker
  deployment would gate on.

### P1 — the pricing fallback (mock the upstream)

CLAUDE.md calls out keeping the fallback path working, and says any pricing
change should be exercised on both branches. That is unenforceable by hand
today because the live branch needs a premium key. With `nock` or an axios
mock adapter, both branches become testable with no key and no network:

- **Live branch**: a `REALTIME_OPTIONS` fixture matching on expiration, type,
  and the `< 0.001` strike tolerance; assert `source: 'alphavantage'`.
- **Mark computation**: `(bid + ask) / 2 || last`. The `||` means a genuine
  zero mid falls through to `last` — pin whether that is intended.
- **Fallback triggers**: no match in the chain, upstream 500, upstream
  timeout, malformed payload, and a matched contract with a `NaN` mark. All
  must degrade to `source: 'theoretical-black-scholes'`, never error — the
  `catch (_)` that makes this work is invisible and easy to remove by accident.
- **422 path**: no market quote *and* no usable spot.
- **`fetchQuote` parsing**: the `'05. price'` shape, a missing-price payload
  → `null` → 404, and an upstream throw → 502.

### P2 — frontend

Lowest priority and highest setup cost, but two pieces are worth it:

- **Pure formatters** (`fmtUSD`, `fmtPct`) are testable today with no DOM if
  `app.js` gains a module export or the helpers move to a small shared file.
  They own the `—` placeholder for `null`/`NaN` that shows up all over the UI.
- **A single smoke test** with jsdom or Playwright: load the page, let the
  `DOMContentLoaded` auto-submit run, assert a chart renders and the stat strip
  populates. That covers the `currentSpot ?? strike` fallback, the `> 1e6`
  "Unlimited" threshold, and the `$(id)` bindings that break silently whenever
  `index.html` and `app.js` drift apart.

Note the known gap already documented in CLAUDE.md: `renderChart` builds an
`annotations` array for the strike and spot markers and never passes it to
Chart.js. Both the README feature list and the chart caption in `index.html`
promise those markers. A test asserting the rendered chart config would have
caught the drift.

## Tooling recommendation

Use `node:test` and `node:assert` from the standard library. The repo has no
build step, no framework, and four runtime dependencies — pulling in Jest or
Vitest would be the largest thing in it. Node 18+ is already the engine floor,
and `node --test` plus `--experimental-test-coverage` gives a runner, a watch
mode, and coverage reporting with zero new dependencies.

Dev dependencies worth adding: `supertest` for route tests and `nock` for
upstream mocking. Both are test-only.

```json
"scripts": {
  "test": "node --test",
  "test:watch": "node --test --watch",
  "test:coverage": "node --test --experimental-test-coverage"
}
```

Layout, mirroring the source tree:

```
test/blackScholes.test.js
test/payoff.test.js
test/routes.test.js
test/fixtures/alphavantage-*.json
```

## Suggested sequence

1. Extract `lib/payoff.js`; split `server.js` into `app.js` + `server.js`.
2. Add the runner and the P0 pure-math suites — no new dependencies, and this
   alone covers the domain conventions that currently have no guard.
3. Add `supertest` and the route/validation suites; fix the JSON error
   middleware alongside them.
4. Add `nock` and the fallback-path suites, covering both pricing branches.
5. Wire `npm test` into CI, and update CLAUDE.md and README.md — CLAUDE.md
   currently states there is no test suite and instructs not to claim tests
   pass, which must change when this lands.

The defects in the first section are worth fixing as part of step 2 and 3
rather than separately; each one is a test case first and a small patch second.
