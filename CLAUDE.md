# CLAUDE.md

Guidance for Claude Code (and other AI assistants) working in this repository.

## What this project is

**Payoff — Options Strategy Builder.** A small full-stack app that prices an
options leg and charts its profit/loss at expiration. Express serves both a
JSON API and a static vanilla-JS frontend from the same process — there is no
build step, no framework, and no bundler.

The app is educational/demo software. It is not investment advice, and it does
not place trades or talk to a broker.

## Stack and layout

Node >= 18 (CI/dev currently on Node 22; Docker image is `node:20-alpine`),
CommonJS (`"type": "commonjs"` — use `require`, not `import`).

```
server.js              Entry point: loads dotenv, starts the listener
app.js                 Express app: all routes, upstream fetch helpers (exported, not listening)
lib/blackScholes.js    Black-Scholes-Merton pricer + first-order greeks (pure, no I/O)
lib/payoff.js          P&L-at-expiration engine + request validation (pure, no I/O)
test/                  node:test suites; see TESTING.md
public/index.html      Single page; all element IDs the frontend binds to live here
public/app.js          Vanilla DOM code, fetch calls, Chart.js config
public/style.css       Dark theme; all colors are CSS custom properties in :root
Dockerfile             Single-stage node:20-alpine image
docker-compose.yml     Publishes host 3100 -> container 3000
.env.example           ALPHAVANTAGE_API_KEY, PORT
```

`server.js` is deliberately thin: it exists so `app.js` can be required by the
tests without binding a port. Add routes to `app.js`, not `server.js`.

Dependencies: `express`, `axios`, `cors`, `dotenv`; `supertest` and `nock` are
test-only. Chart.js is loaded from a
CDN in `index.html` (v4.4.4), not from npm — the frontend is not self-hosted
and needs network access to render the chart.

## Running it

```bash
npm install
cp .env.example .env    # optional; "demo" key works, with reduced data
npm start               # http://localhost:3000
npm run dev             # node --watch, auto-restart on edit
```

Docker:

```bash
docker compose up --build -d   # http://localhost:3100
```

Quick manual smoke test (no live-data key needed — `/api/payoff` is pure math):

```bash
curl -s localhost:3000/api/health
curl -s -X POST localhost:3000/api/payoff -H 'Content-Type: application/json' \
  -d '{"spot":180,"legs":[{"type":"call","side":"long","strike":220,"premium":12.5,"contracts":1}]}'
```

## Tests

```bash
npm test                # node --test
npm run test:watch
npm run test:coverage
```

`node:test` + `node:assert` from the standard library, with `supertest` and
`nock` as the only test-only dependencies. No test touches the network. Server
and pure-math changes must keep `npm test` green — run it, and do not claim it
passed without doing so. **There is still no linter or formatter configured**,
and the frontend (`public/app.js`) has no coverage — verify UI work by loading
the page in a browser. See `TESTING.md` for what is pinned and what is not.

## API surface

| Route | Method | Body / Params | Notes |
|---|---|---|---|
| `/api/quote/:symbol` | GET | — | Alpha Vantage `GLOBAL_QUOTE`. 404 if no price, 502 on upstream error. |
| `/api/price-leg` | POST | `{ symbol, strike, expiration, type, spot?, iv?, riskFreeRate? }` | Live quote if available, else theoretical. 422 if neither is possible. |
| `/api/payoff` | POST | `{ spot, legs: [...], range? }` | Pure computation, no network. 400 on an invalid body. |
| `/api/health` | GET | — | `{ ok: true }` |

Every route validates its body up front and every failure — including a
malformed JSON body, which Express would otherwise answer with HTML — comes
back as `{ error }` JSON. `public/app.js` reads that shape on every non-OK
response, so keep it.

Request bodies are validated strictly but numeric fields are coerced, so
`strike: "220"` is accepted while `strike: "abc"` is a 400. `type` and `side`
are matched case-insensitively against a known set — an unrecognized value is
a 400, never a silent fall-through to the other branch.

## Domain conventions that matter

These are easy to get wrong. Each one now has a regression test in
`test/payoff.test.js` — if you change the behavior, change the test knowingly.

- **Premiums and strikes are per share; quantities are in contracts.**
  `lib/payoff.js` multiplies by 100 (`(contracts || 1) * (quantity || 1) * 100`).
  Never pre-multiply a premium by 100 on the client.
- **A `stock` leg reuses the `strike` field as its entry price**, and it is
  also scaled by the same `* 100` factor — so one "contract" of stock means
  100 shares. Net premium ignores stock legs entirely.
- **`side: 'short'` flips the sign** of the whole leg P&L, including the
  premium term. Short legs collect premium (positive `netPremium`).
- **The payoff engine already supports arbitrary multi-leg positions**
  (calls, puts, stock, mixed) even though the UI only ever submits one leg.
  Prefer extending the UI to send more legs over changing the engine.
- **Curve resolution is a fixed 160 steps** over `[spot*0.6, spot*1.6]` unless
  `range.min`/`range.max` are supplied. Breakevens come from linear
  interpolation between adjacent sampled points, so they are approximate and
  their precision is tied to that step count.
- **`maxProfit`/`maxLoss` are bounds of the sampled window, not true limits.**
  An unbounded long call just reports the P&L at the top of the range; the UI
  fakes "Unlimited" with a `> 1e6` threshold in `public/app.js`.
- **Unknown leg types are rejected, not coerced.** `type` must be one of
  `call`, `put`, `stock` — matching only `'call'` and letting everything else
  fall through to the put branch was a real bug.

## Market data and the pricing fallback

`ALPHAVANTAGE_API_KEY` defaults to `demo`. Alpha Vantage's `REALTIME_OPTIONS`
endpoint requires a **premium** key, so on a free/demo key `fetchOptionQuote`
returns `null` and `/api/price-leg` falls back to Black-Scholes with:

- `iv` default **0.45** when the caller does not supply one,
- `riskFreeRate` default **0.045**,
- `T` floored at `1e-6` so expired/same-day inputs do not divide by zero.

The response carries `source: 'alphavantage'` or
`source: 'theoretical-black-scholes'`; the UI surfaces this in the leg readout.
**Keep that fallback path working** — it is what makes the app usable without a
paid key. `test/routes.test.js` exercises both branches with `nock`, including
every way the upstream can fail; run it after any pricing change.

`yearsToExpiration` in the response is the floored value actually used to
price, so it is never negative even for an expired contract.

`yearsUntil()` assumes expiration is `YYYY-MM-DD` and anchors to 21:00 UTC
(approximate US market close); it returns `NaN` for anything else, so the route
validates the format first. Greeks are scaled for display: theta is per day
(`/365`), vega is per 1 vol point (`/100`). `priceAndGreeks` degenerates to
discounted intrinsic with finite greeks when `sigma` or `T` is zero rather than
returning `Infinity`/`NaN`.

Failures in `fetchOptionQuote` are swallowed by design (`catch (_)`) so a bad
upstream response degrades to theoretical pricing rather than erroring.

## Frontend conventions

(`app.js` in this section means `public/app.js`, not the Express app at the
repo root.)

- `app.js` binds to element IDs from `index.html` via a `$(id)` helper. Adding
  a field means touching both files; there is no templating.
- The form auto-submits on `DOMContentLoaded`, so the page renders a chart on
  load with the pre-filled NVDA example (`.NVDA260812C220` → NVDA, 2026-08-12,
  call, strike 220).
- If the quote fetch fails, `currentSpot` stays `null` and `submitLeg` falls
  back to using the strike as spot — the chart still renders.
- Errors are reported with `alert()`. Match that if you extend it, or replace
  it consistently across the file.
- Colors live in `:root` in `style.css`, but Chart.js options in `app.js`
  hardcode the same hex values. Change both when adjusting the theme.
- Known gap: `renderChart` builds an `annotations` array for the strike and
  spot markers but never passes it to Chart.js. Only the dashed zero line
  (the `zeroLine` plugin) is actually drawn, so the chart caption in
  `index.html` currently overpromises. Wiring these up is a good small task —
  it needs a custom plugin or `chartjs-plugin-annotation`.

## Conventions for changes

- Match the existing style: 2-space indent, single quotes, semicolons, arrow
  functions, `async/await` with `try/catch` per route.
- Comments are sparse and explain *why* (e.g. why the fallback exists). Do not
  add narration comments over obvious code.
- Keep `lib/` pure and I/O-free; network calls belong in `app.js`.
- Validate request bodies at the top of each route and return a 4xx with a
  short `{ error }` message, as the existing routes do. Reserve 5xx for
  genuine failures, `502` for upstream problems, `422` for "well-formed but
  unpriceable". Prefer pushing validation into a pure `validate*` function in
  `lib/` that returns a message or `null`, as `lib/payoff.js` does — it keeps
  the route thin and the rules directly testable.
- Add a test alongside a behavior change, and run `npm test` before claiming
  anything passes.
- Never commit `.env` or a real API key. `.env` is gitignored; document new
  variables in `.env.example` instead.
- If you add a file the container needs, add it to the `COPY` lines in the
  `Dockerfile` — it copies specific paths, not the whole tree.
- Update `README.md` alongside behavior changes; its API table and feature
  list are the user-facing contract.

## Git workflow

Default branch is `main`. Work on a feature branch and push with
`git push -u origin <branch>`. Do not open a pull request unless explicitly
asked.
