// Entry point: loads config and starts the HTTP listener. The Express app
// itself lives in app.js so it can be exercised in-process by the tests.
require('dotenv').config();

const app = require('./app');

const PORT = process.env.PORT || 3000;
const AV_KEY = process.env.ALPHAVANTAGE_API_KEY || 'demo';

app.listen(PORT, () => {
  console.log(`Options visualizer running on http://localhost:${PORT}`);
  if (AV_KEY === 'demo') {
    console.log('Using Alpha Vantage "demo" key — live quotes/options will be limited. Set ALPHAVANTAGE_API_KEY in .env for real data.');
  }
});
