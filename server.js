const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Config da variabili d'ambiente
const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TD_KEY = process.env.TD_KEY || '';

// Stato bot
let isRunning = false;
let lastSignalTime = 0;
let candles = [];
let stats = { total: 0, buys: 0, sells: 0, lastSignal: '—' };
let signalLog = [];
let refreshInterval = null;

// ═══════════════════════════════
// SUPERTREND CALC
// ═══════════════════════════════
function calcATR(c, p) {
  const t = [];
  for (let i = 1; i < c.length; i++) {
    t.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close)));
  }
  const a = [t[0]];
  for (let i = 1; i < t.length; i++) a.push((a[i-1] * (p-1) + t[i]) / p);
  return a;
}

function calcST(candles, period, mult) {
  const atrs = calcATR(candles, period);
  const res = []; let dir = 1, pu = 0, pl = 0;
  for (let i = 1; i < candles.length; i++) {
    const atr = atrs[i-1] || atrs[0];
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let u = hl2 + mult * atr, l = hl2 - mult * atr;
    if (i > 1) { u = u < pu || candles[i-1].close > pu ? u : pu; l = l > pl || candles[i-1].close < pl ? l : pl; }
    const cl = candles[i].close;
    if (dir === 1 && cl < l) dir = -1; else if (dir === -1 && cl > u) dir = 1;
    res.push({ dir, line: dir === 1 ? l : u, atr });
    pu = u; pl = l;
  }
  return res;
}

// ═══════════════════════════════
// FETCH CANDLES
// ═══════════════════════════════
const SYM_MAP = {
  XAUUSD: 'XAU/USD', EURUSD: 'EUR/USD', BTCUSD: 'BTC/USD',
  ETHUSD: 'ETH/USD', NAS100: 'IXIC', GBPJPY: 'GBP/JPY',
};

let currentSymbol = 'XAUUSD';

async function fetchCandles(symbol) {
  if (!TD_KEY) {
    // Demo candles
    let p = symbol.includes('BTC') ? 68000 : symbol.includes('XAU') ? 2340 : 1.082;
    candles = [];
    for (let i = 0; i < 120; i++) {
      const ch = (Math.random() - 0.488) * p * 0.003, o = p, c = p + ch;
      candles.push({ open: o, high: Math.max(o,c)*1.001, low: Math.min(o,c)*0.999, close: c });
      p = c;
    }
    return;
  }
  const sym = SYM_MAP[symbol] || symbol;
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=15min&outputsize=120&apikey=${TD_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'error') throw new Error(data.message);
  candles = data.values.reverse().map(c => ({ open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
}

// ═══════════════════════════════
// SEND TELEGRAM
// ═══════════════════════════════
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' })
    });
    const d = await res.json();
    return d.ok;
  } catch (e) { return false; }
}

// ═══════════════════════════════
// CHECK SIGNALS
// ═══════════════════════════════
const strategies = [
  { id: 1, atr: 7,  mult: 2.0 },
  { id: 2, atr: 14, mult: 3.0 },
  { id: 3, atr: 21, mult: 4.5 },
];

async function checkSignals(consensus = 3, cooldownMin = 15) {
  if (!candles.length || !isRunning) return;
  const cooldown = cooldownMin * 60 * 1000;
  if (Date.now() - lastSignalTime < cooldown) return;

  let bv = 0, sv = 0, bs = [], ss = [];
  strategies.forEach(s => {
    const st = calcST(candles, s.atr, s.mult);
    if (!st.length) return;
    const last = st[st.length - 1], prev = st[st.length - 2] || last;
    if (last.dir === 1 && prev.dir === -1) { bv++; bs.push(s); }
    else if (last.dir === -1 && prev.dir === 1) { sv++; ss.push(s); }
  });

  let dir = null, strats = [];
  if (bv >= consensus) { dir = 'BUY'; strats = bs; }
  else if (sv >= consensus) { dir = 'SELL'; strats = ss; }
  if (!dir) return;

  const price = candles[candles.length - 1].close;
  const atr = calcATR(candles, 14)[candles.length - 2] || 0;
  const dec = price > 100 ? 2 : 5;
  const sl = (dir === 'BUY' ? price - atr * 1.5 : price + atr * 1.5).toFixed(dec);
  const tp = (dir === 'BUY' ? price + atr * 3.0 : price - atr * 3.0).toFixed(dec);
  const time = new Date().toUTCString().slice(0, 25);

  const msg = `${dir === 'BUY' ? '🟢' : '🔴'} <b>SuperTrend Signal</b>\n\n📊 <b>Simbolo:</b> ${currentSymbol}\n📡 <b>Direzione:</b> <b>${dir}</b>\n💰 <b>Prezzo:</b> ${price.toFixed(dec)}\n🛑 <b>SL:</b> ${sl}\n🎯 <b>TP:</b> ${tp}\n⏰ <b>Ora:</b> ${time} UTC\n\n⚠️ <i>Non è consulenza finanziaria.</i>`;

  const ok = await sendTelegram(msg);
  if (ok) {
    stats.total++; 
    if (dir === 'BUY') stats.buys++; else stats.sells++;
    stats.lastSignal = dir;
    lastSignalTime = Date.now();
    signalLog.unshift({ dir, price: price.toFixed(dec), time, symbol: currentSymbol });
    if (signalLog.length > 50) signalLog.pop();
    console.log(`✅ Signal sent: ${dir} ${currentSymbol} @ ${price.toFixed(dec)}`);
  }
}

// ═══════════════════════════════
// LOOP
// ═══════════════════════════════
function startLoop(refreshSec = 60, consensus = 3, cooldown = 15) {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(async () => {
    try {
      await fetchCandles(currentSymbol);
      await checkSignals(consensus, cooldown);
    } catch (e) { console.error('Loop error:', e.message); }
  }, refreshSec * 1000);
}

// ═══════════════════════════════
// API ROUTES
// ═══════════════════════════════
app.get('/api/status', (req, res) => {
  res.json({
    isRunning, stats, signalLog: signalLog.slice(0, 20),
    symbol: currentSymbol, tgConnected: !!(TG_TOKEN && TG_CHAT_ID),
    dataConnected: !!TD_KEY, candleCount: candles.length,
    lastPrice: candles.length ? candles[candles.length-1].close : 0
  });
});

app.post('/api/start', async (req, res) => {
  const { symbol, consensus, cooldown, refresh } = req.body;
  if (symbol) currentSymbol = symbol;
  isRunning = true;
  try {
    await fetchCandles(currentSymbol);
    startLoop(refresh || 60, consensus || 3, cooldown || 15);
    await sendTelegram(`🤖 <b>SuperTrend EA Avviato</b>\n📊 Simbolo: ${currentSymbol}\n⏰ ${new Date().toUTCString().slice(0,25)}`);
    res.json({ ok: true, message: 'EA avviato' });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

app.post('/api/stop', async (req, res) => {
  isRunning = false;
  if (refreshInterval) clearInterval(refreshInterval);
  await sendTelegram('⏹ <b>SuperTrend EA Fermato</b>');
  res.json({ ok: true, message: 'EA fermato' });
});

app.post('/api/test', async (req, res) => {
  const ok = await sendTelegram('🤖 <b>SuperTrend EA — Test OK!</b>\n\nBot connesso correttamente ✅\nI segnali BUY/SELL arriveranno qui.');
  res.json({ ok, message: ok ? 'Messaggio inviato!' : 'Errore invio' });
});

app.get('/api/candles', (req, res) => {
  res.json({ candles: candles.slice(-60) });
});

// ═══════════════════════════════
// START SERVER
// ═══════════════════════════════
app.listen(PORT, () => {
  console.log(`SuperTrend EA running on port ${PORT}`);
  console.log(`TG: ${TG_TOKEN ? '✅' : '❌'} | TD: ${TD_KEY ? '✅' : '❌'}`);
  // Auto-fetch candles on start
  fetchCandles(currentSymbol).catch(console.error);
});
