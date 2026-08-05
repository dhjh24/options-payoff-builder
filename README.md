# Payoff — Options Strategy Builder

A small full-stack app for building an options position and charting its
profit/loss at expiration — in the spirit of tools like OptionStrat, built
from scratch with an original design and codebase.

Loads with a **Long Call** on **NVDA, $220 strike, expiring 2026‑08‑12**
pre-filled (decoded from the OptionStrat symbol `.NVDA260812C220`).

![stack](https://img.shields.io/badge/stack-Node%20%2F%20Express%20%2B%20vanilla%20JS-informational)

## Features

- Configure a single option leg: underlying, side (long/short), type
  (call/put), strike, expiration, contract count.
- Live underlying quote via Alpha Vantage (`GLOBAL_QUOTE`).
- Option pricing: tries a live market quote first (`REALTIME_OPTIONS`,
  requires an Alpha Vantage premium key); falls back to a **Black–Scholes**
  theoretical price + greeks (delta, gamma, theta, vega) computed
  server-side so the app is fully functional on a free key.
- Server-side payoff engine that supports arbitrary multi-leg positions
  (calls, puts, stock), even though the UI currently exposes one leg.
- Chart.js payoff diagram with a strike marker, live-spot marker, filled
  profit/loss gradient, and computed breakeven(s), max profit, max loss,
  net premium, and P&L at the current spot.

## Project structure

```
options-visualizer/
├── server.js              Express app + API routes
├── lib/blackScholes.js    Pricing/greeks fallback engine
├── public/                Static frontend (HTML/CSS/vanilla JS + Chart.js via CDN)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── .env.example
└── package.json
```

## Run it

```bash
npm install
cp .env.example .env      # add your Alpha Vantage key, or leave "demo"
npm start                 # http://localhost:3000
```

`npm run dev` uses `node --watch` for auto-restart while editing.

## API

| Route | Method | Body / Params | Purpose |
|---|---|---|---|
| `/api/quote/:symbol` | GET | — | Current underlying price |
| `/api/price-leg` | POST | `{ symbol, strike, expiration, type, spot?, iv?, riskFreeRate? }` | Prices one leg (live if available, else theoretical) with greeks |
| `/api/payoff` | POST | `{ spot, legs: [...], range? }` | Computes the P&L-at-expiration curve, breakevens, max profit/loss |
| `/api/health` | GET | — | Health check |

## Notes

- This is an independent, from-scratch implementation — it is not affiliated
  with or copied from any commercial options-analytics product; it exists to
  demonstrate the same *type* of tool (a payoff-diagram builder), not to
  reproduce anyone else's design or code.
- Educational tool only — not investment advice.
