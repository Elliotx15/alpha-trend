'use strict';

/* Local AlphaTrend chart page.
   Candles + AlphaTrend/Trigger lines + trend fill + BUY/SELL markers,
   fed by GET /api/alpha?symbol=xxxxxx (app/server.py). */

const HISTORY_KEY = 'alphatrend.symbolHistory';
const HISTORY_MAX = 20;

const CANDLE_UP = '#26a69a';
const CANDLE_DOWN = '#ef5350';
const AT_COLOR = '#0022fc';
const TRIGGER_COLOR = '#fc0400';
const FILL_UP = 'rgba(0, 190, 10, 0.5)';    // Pine #00E60F
const FILL_DOWN = 'rgba(128, 0, 11, 0.4)';  // Pine #80000B

function el(id) { return document.getElementById(id); }
function fmt(v, nd) { return v === null || v === undefined ? '–' : Number(v).toFixed(nd); }

let chart, candleSeries, atSeries, triggerSeries, bandPrimitive, markersApi;
let current = null;   // last successfully loaded payload
let loading = false;

/* ---- fill band between the two indicator lines (series primitive) ---- */

class BandPrimitive {
  constructor(chart, series) {
    this._chart = chart;
    this._series = series;
    this._data = [];   // {time, hi, lo, up}
    this._pts = [];
    this._paneViews = [this];
  }

  setData(data) { this._data = data; }

  // IPaneView
  zOrder() { return 'bottom'; }
  renderer() { return this; }

  // ISeriesPrimitive: recompute pixel coordinates before each draw
  updateAllViews() {
    const ts = this._chart.timeScale();
    const pts = [];
    for (const d of this._data) {
      const x = ts.timeToCoordinate(d.time);
      const yHi = this._series.priceToCoordinate(d.hi);
      const yLo = this._series.priceToCoordinate(d.lo);
      if (x === null || yHi === null || yLo === null) continue;
      pts.push({ x, yHi, yLo, up: d.up });
    }
    this._pts = pts;
  }

  // IPaneRenderer: one trapezoid per bar pair, color by trend direction
  draw(target) {
    target.useBitmapCoordinateSpace(scope => {
      const ctx = scope.context;
      const xr = scope.horizontalPixelRatio;
      const yr = scope.verticalPixelRatio;
      const pts = this._pts;
      if (pts.length < 2) return;
      ctx.save();
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1];
        const q = pts[i];
        ctx.beginPath();
        ctx.moveTo(p.x * xr, p.yHi * yr);
        ctx.lineTo(q.x * xr, q.yHi * yr);
        ctx.lineTo(q.x * xr, q.yLo * yr);
        ctx.lineTo(p.x * xr, p.yLo * yr);
        ctx.closePath();
        ctx.fillStyle = p.up ? FILL_UP : FILL_DOWN;
        ctx.fill();
      }
      ctx.restore();
    });
  }
}

/* ---- chart ---- */

function initChart() {
  chart = LightweightCharts.createChart(el('chart'), {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: '#ffffff' },
      textColor: '#5d6470',
    },
    grid: { vertLines: { color: '#f0f3fa' }, horzLines: { color: '#f0f3fa' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#e0e3eb' },
    timeScale: { borderColor: '#e0e3eb' },
  });

  candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: CANDLE_UP, downColor: CANDLE_DOWN,
    borderUpColor: CANDLE_UP, borderDownColor: CANDLE_DOWN,
    wickUpColor: CANDLE_UP, wickDownColor: CANDLE_DOWN,
  });
  atSeries = chart.addSeries(LightweightCharts.LineSeries, {
    color: AT_COLOR, lineWidth: 3,
  });
  triggerSeries = chart.addSeries(LightweightCharts.LineSeries, {
    color: TRIGGER_COLOR, lineWidth: 3,
  });

  bandPrimitive = new BandPrimitive(chart, atSeries);
  atSeries.attachPrimitive(bandPrimitive);
  markersApi = LightweightCharts.createSeriesMarkers(candleSeries, []);

  chart.subscribeCrosshairMove(param => {
    if (!param.time || !param.seriesData) { renderLegendFromLatest(); return; }
    const c = param.seriesData.get(candleSeries);
    const a = param.seriesData.get(atSeries);
    const b = param.seriesData.get(triggerSeries);
    if (!c) { renderLegendFromLatest(); return; }
    renderLegend(c.open, c.high, c.low, c.close, a ? a.value : null, b ? b.value : null);
  });
}

function applyData(p) {
  const candles = [];
  const lineA = [];
  const lineB = [];
  const band = [];
  p.dates.forEach((t, i) => {
    const [o, h, l, c] = p.candles[i];
    candles.push({ time: t, open: o, high: h, low: l, close: c });
    const a = p.at[i];
    const b = p.at2[i];
    if (a !== null) lineA.push({ time: t, value: a });
    if (b !== null) lineB.push({ time: t, value: b });
    if (a !== null && b !== null) {
      band.push({ time: t, hi: Math.max(a, b), lo: Math.min(a, b), up: p.dir[i] === 1 });
    }
  });

  candleSeries.setData(candles);
  atSeries.setData(lineA);
  triggerSeries.setData(lineB);
  bandPrimitive.setData(band);

  const markers = p.signals.map(s => ({
    time: s.time,
    position: s.type === 'buy' ? 'belowBar' : 'aboveBar',
    color: s.type === 'buy' ? AT_COLOR : '#80000b',
    shape: s.type === 'buy' ? 'arrowUp' : 'arrowDown',
    text: s.type === 'buy' ? 'BUY' : 'SELL',
    size: 1,
  }));
  markersApi.setMarkers(markers);

  chart.timeScale().fitContent();

  el('lg-sym').textContent = `${p.symbol} · 前复权`;
  el('legend').hidden = false;
  renderLegendFromLatest();
  renderSignalTable(p.signals);
  renderLatest(p.latest, p.symbol);
}

function renderLegend(o, h, l, c, at, tr) {
  el('lg-ohlc').innerHTML =
    `O <b>${fmt(o, 2)}</b> H <b>${fmt(h, 2)}</b> L <b>${fmt(l, 2)}</b> ` +
    `<b style="color:${c >= o ? CANDLE_UP : CANDLE_DOWN}">${fmt(c, 2)}</b>`;
  el('lg-at').textContent = fmt(at, 3);
  el('lg-tr').textContent = fmt(tr, 3);
}

function renderLegendFromLatest() {
  if (!current) return;
  const n = current.dates.length - 1;
  renderLegendFromIndex(n);
}

function renderLegendFromIndex(i) {
  const [o, h, l, c] = current.candles[i];
  renderLegend(o, h, l, c, current.at[i], current.at2[i]);
}

/* ---- panels ---- */

function renderLatest(latest, symbol) {
  const box = el('latest');
  if (!latest) { box.hidden = true; return; }
  box.hidden = false;
  box.textContent =
    `${symbol} 最新（${latest.time}）： 收盘 ${fmt(latest.close, 2)} · ` +
    `AlphaTrend ${fmt(latest.alphatrend, 3)} · Trigger ${fmt(latest.trigger, 3)} · ` +
    `MFI ${fmt(latest.mfi, 1)}`;
}

function renderSignalTable(signals) {
  const panel = el('signal-panel');
  const body = el('signal-body');
  body.innerHTML = '';
  const newest = [...signals].reverse();
  for (const s of newest) {
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = s.time;
    const tdType = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = `tag tag-${s.type}`;
    tag.textContent = (s.type === 'buy' ? '▲ BUY' : '▼ SELL');
    tdType.appendChild(tag);
    const tdClose = document.createElement('td');
    tdClose.textContent = fmt(s.close, 2);
    tr.append(tdDate, tdType, tdClose);
    body.appendChild(tr);
  }
  el('signal-count').textContent = `（共 ${signals.length} 个，最新在前）`;
  panel.hidden = false;
}

function showStatus(msg, kind) {
  const s = el('status');
  s.textContent = msg;
  s.className = `status ${kind}`;
  s.hidden = false;
}

function hideStatus() { el('status').hidden = true; }

/* ---- symbol input history (localStorage) ---- */

function loadHistory() {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(v) ? v.filter(c => /^\d{6}$/.test(c)) : [];
  } catch { return []; }
}

function saveHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function pushHistory(code) {
  const list = loadHistory().filter(c => c !== code);
  list.unshift(code);
  saveHistory(list.slice(0, HISTORY_MAX));
  renderHistory();
}

function renderHistory() {
  const box = el('history');
  const list = loadHistory();
  box.innerHTML = '';
  for (const code of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (current && code === current.symbol ? ' active' : '');
    b.textContent = code;
    b.addEventListener('click', () => loadSymbol(code));
    box.appendChild(b);
  }
  box.hidden = list.length === 0;
}

/* ---- data loading ---- */

function setLoading(on) {
  loading = on;
  el('load-btn').disabled = on;
  el('refresh-btn').disabled = on;
}

async function loadSymbol(code, { refresh = false } = {}) {
  if (loading) return;
  setLoading(true);
  showStatus(`正在加载 ${code} …`, 'info');
  try {
    const res = await fetch(`/api/alpha?symbol=${encodeURIComponent(code)}${refresh ? '&refresh=1' : ''}`);
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error */ }
    if (!res.ok) throw new Error((body && body.detail) || `请求失败（${res.status}）`);
    current = body;
    applyData(body);
    pushHistory(code);
    renderHistory();
    hideStatus();
    document.title = `${code} · AlphaTrend`;
  } catch (e) {
    showStatus(e.message, 'error');
  } finally {
    setLoading(false);
  }
}

function init() {
  initChart();

  el('symbol-form').addEventListener('submit', e => {
    e.preventDefault();
    const code = el('symbol-input').value.trim();
    if (!/^\d{6}$/.test(code)) {
      showStatus('请输入 6 位数字的 A 股代码，例如 600030', 'error');
      return;
    }
    loadSymbol(code);
  });

  el('refresh-btn').addEventListener('click', () => {
    if (current) loadSymbol(current.symbol, { refresh: true });
  });

  renderHistory();
  const history = loadHistory();
  if (history.length) {
    el('symbol-input').value = history[0];
    loadSymbol(history[0]);
  } else {
    el('symbol-input').focus();
  }

  // debugging/verification hook
  window.__alpha = () => current && {
    symbol: current.symbol,
    bars: current.dates.length,
    signals: current.signals.length,
    latest: current.latest,
  };
  window.__chart = chart;
}

init();
