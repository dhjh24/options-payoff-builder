const $ = (id) => document.getElementById(id);
const fmtUSD = (n) =>
  n == null || Number.isNaN(n) ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtPct = (n) => (n == null || Number.isNaN(n) ? '—' : `${(n * 100).toFixed(1)}%`);

let chart;
let currentSpot = null;

async function fetchQuote(symbol) {
  const res = await fetch(`/api/quote/${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error((await res.json()).error || 'quote failed');
  return res.json();
}

async function priceLeg(payload) {
  const res = await fetch('/api/price-leg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'pricing failed');
  return res.json();
}

async function computePayoff(payload) {
  const res = await fetch('/api/payoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'payoff failed');
  return res.json();
}

async function refreshTicker(symbol) {
  $('tickerStatus').textContent = 'fetching…';
  try {
    const q = await fetchQuote(symbol);
    currentSpot = q.price;
    $('tickerSymbol').textContent = q.symbol;
    $('tickerPrice').textContent = fmtUSD(q.price);
    const up = q.change >= 0;
    const el = $('tickerChange');
    el.textContent = `${up ? '+' : ''}${q.change?.toFixed(2)} (${q.changePercent})`;
    el.className = `ticker-change ${up ? 'up' : 'down'}`;
    $('tickerStatus').textContent = 'live';
  } catch (err) {
    $('tickerStatus').textContent = 'no live quote — using manual spot';
  }
}

function renderChart(points, { strike, breakevens, spot }) {
  const labels = points.map((p) => p.price);
  const data = points.map((p) => p.pl);

  const gradientPlugin = {
    id: 'zeroLine',
    afterDraw(c) {
      const { ctx, chartArea, scales } = c;
      const y0 = scales.y.getPixelForValue(0);
      ctx.save();
      ctx.strokeStyle = 'rgba(123,131,148,0.35)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y0);
      ctx.lineTo(chartArea.right, y0);
      ctx.stroke();
      ctx.restore();
    },
  };

  if (chart) chart.destroy();
  const ctx = document.getElementById('payoffChart').getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, 0, 380);
  grad.addColorStop(0, 'rgba(61,220,132,0.35)');
  grad.addColorStop(0.5, 'rgba(61,220,132,0.03)');
  grad.addColorStop(0.5, 'rgba(255,92,92,0.03)');
  grad.addColorStop(1, 'rgba(255,92,92,0.30)');

  const annotations = [];
  if (Number.isFinite(strike)) {
    annotations.push({ x: strike, color: '#f0a868', label: `K ${strike}` });
  }
  if (Number.isFinite(spot)) {
    annotations.push({ x: spot, color: '#e8eaee', label: `spot ${spot.toFixed(2)}` });
  }

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'P&L at expiration',
          data,
          borderColor: '#e8eaee',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0,
          fill: true,
          backgroundColor: grad,
        },
      ],
    },
    options: {
      responsive: true,
      animation: { duration: 500 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#171b24',
          borderColor: '#232734',
          borderWidth: 1,
          titleColor: '#e8eaee',
          bodyColor: '#e8eaee',
          titleFont: { family: 'IBM Plex Mono' },
          bodyFont: { family: 'IBM Plex Mono' },
          callbacks: {
            title: (items) => `underlying $${items[0].label}`,
            label: (item) => `P&L  ${fmtUSD(item.raw)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          grid: { color: 'rgba(35,39,52,0.7)' },
          ticks: { color: '#7b8394', font: { family: 'IBM Plex Mono', size: 10 }, maxTicksLimit: 8 },
          title: { display: true, text: 'Underlying price at expiration', color: '#7b8394', font: { size: 11 } },
        },
        y: {
          grid: { color: 'rgba(35,39,52,0.7)' },
          ticks: { color: '#7b8394', font: { family: 'IBM Plex Mono', size: 10 } },
          title: { display: true, text: 'Profit / Loss ($)', color: '#7b8394', font: { size: 11 } },
        },
      },
    },
    plugins: [gradientPlugin],
  });
}

function setStats({ maxProfit, maxLoss, breakevens, netPremium, plAtSpot }) {
  const strip = $('statStrip');
  $('statMaxProfit').textContent = maxProfit > 1e6 ? 'Unlimited' : fmtUSD(maxProfit);
  $('statMaxLoss').textContent = fmtUSD(maxLoss);
  $('statBreakeven').textContent = breakevens.length ? breakevens.map((b) => `$${b.toFixed(2)}`).join(', ') : '—';
  $('statPremium').textContent = fmtUSD(netPremium);
  const plEl = $('statPlSpot');
  plEl.textContent = fmtUSD(plAtSpot);
  plEl.className = `stat-value ${plAtSpot >= 0 ? 'profit' : 'loss'}`;
}

function setLegReadout(leg) {
  $('legReadout').hidden = false;
  $('roMark').textContent = fmtUSD(leg.mark);
  $('roSource').textContent = leg.source === 'alphavantage' ? 'Live market' : 'Theoretical (Black–Scholes)';
  $('roIV').textContent = fmtPct(leg.impliedVolatility);
  $('roDelta').textContent = leg.delta?.toFixed(3) ?? '—';
  $('roGamma').textContent = leg.gamma?.toFixed(4) ?? '—';
  $('roTheta').textContent = leg.theta != null ? fmtUSD(leg.theta) : '—';
  $('roVega').textContent = leg.vega?.toFixed(3) ?? '—';
}

async function submitLeg(e) {
  e.preventDefault();
  const symbol = $('symbol').value.trim().toUpperCase();
  const side = $('side').value;
  const type = $('optType').value;
  const strike = parseFloat($('strike').value);
  const expiration = $('expiration').value;
  const contracts = parseInt($('contracts').value, 10) || 1;
  const premiumOverride = $('premiumOverride').value ? parseFloat($('premiumOverride').value) : null;

  const btn = e.target.querySelector('.btn-primary');
  btn.disabled = true;
  btn.textContent = 'Pricing…';

  try {
    await refreshTicker(symbol);

    let mark = premiumOverride;
    let legMeta = null;
    if (mark == null) {
      legMeta = await priceLeg({ symbol, strike, expiration, type, spot: currentSpot });
      mark = legMeta.mark;
      setLegReadout(legMeta);
    } else {
      $('legReadout').hidden = true;
    }

    const spot = currentSpot ?? strike;
    const payoff = await computePayoff({
      spot,
      legs: [{ type, side, strike, premium: mark, contracts, quantity: 1 }],
    });

    renderChart(payoff.points, { strike, breakevens: payoff.breakevens, spot });
    setStats(payoff);
  } catch (err) {
    alert(`Could not build payoff: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Price & plot';
  }
}

$('legForm').addEventListener('submit', submitLeg);

// Auto-run once on load with the NVDA example baked into the form defaults.
window.addEventListener('DOMContentLoaded', () => {
  $('legForm').dispatchEvent(new Event('submit', { cancelable: true }));
});
