const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.text({ limit: '10kb', type: 'text/plain' }));
app.use(express.static('public'));

// ══════════════════════════════════════════════════════════════════════════════
// ST-EA Pine Relay v3.0
//
// Pure webhook relay per le 3 strategie Pine:
//   1. Trend Rider     (H1/H4) — trend-following EMA stack + MACD + HTF
//   2. Breakout Hunter (M15/H1) — Donchian breakout + volume + ATR expansion
//   3. Range Scalper   (M5/M15) — mean reversion BB + RSI in regime ADX basso
//
// Il server NON calcola piu' indicatori, NON fa piu' fetch dati, NON ha piu'
// bot autonomi. TradingView (Pine) fa tutto il lavoro di analisi e invia i
// segnali via webhook. Il server li valida, filtra, relaya su Telegram, e
// mantiene log + stats per la dashboard.
// ══════════════════════════════════════════════════════════════════════════════

const PORT             = process.env.PORT             || 3000;
const TG_TOKEN         = process.env.TG_TOKEN         || '';
const TG_CHAT_ID       = process.env.TG_CHAT_ID       || '';
const TV_WEBHOOK_TOKEN = process.env.TV_WEBHOOK_TOKEN || '';

// ─── Filtri server-side opzionali (env vars) ─────────────────────────────────
const MIN_SCORE      = parseInt(process.env.MIN_SCORE) || 3;     // skip score < N
const BLOCK_HIGH_VOL = process.env.BLOCK_HIGH_VOL === 'true';    // skip se HIGH vol

// ─── Mappa nomi strategie ────────────────────────────────────────────────────
const STRATEGY_NAMES = {
  trend_rider:     'Trend Rider',
  breakout_hunter: 'Breakout Hunter',
  range_scalper:   'Range Scalper'
};
const STRATEGY_EMOJI = {
  trend_rider:     '📈',
  breakout_hunter: '💥',
  range_scalper:   '〰️'
};

// ─── Stato in-memory (no DB, sufficient per signal volume previsto) ───────────
const startTime = Date.now();
let signalLog = [];   // ultimi 100 segnali ricevuti
const stats = {
  webhook: { received: 0, accepted: 0, filtered: 0, rejectedAuth: 0, rejectedFormat: 0, telegramFailed: 0 },
  totalSignals: 0,
  perStrategy: {
    trend_rider:     { total: 0, longs: 0, shorts: 0, lastSignal: null, lastTs: null, avgScore: 0, _scoreSum: 0 },
    breakout_hunter: { total: 0, longs: 0, shorts: 0, lastSignal: null, lastTs: null, avgScore: 0, _scoreSum: 0 },
    range_scalper:   { total: 0, longs: 0, shorts: 0, lastSignal: null, lastTs: null, avgScore: 0, _scoreSum: 0 }
  },
  perInstrument: {},
  perScore: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  perDirection: { long: 0, short: 0 }
};

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return false;
  try {
    const res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: text, parse_mode: 'HTML' })
    });
    const j = await res.json();
    return !!j.ok;
  } catch(e) {
    console.error('[TG]', e.message);
    return false;
  }
}

function dec(price) {
  if (price > 1000) return 2;
  if (price > 10) return 3;
  return 5;
}

function normalizeInstrument(s) {
  if (!s) return 'UNKNOWN';
  // Rimuove prefissi tipo "FX:", "OANDA:", "BINANCE:" dal ticker TradingView
  if (s.indexOf(':') !== -1) s = s.split(':').pop();
  return s.toUpperCase();
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN WEBHOOK HANDLER — POST /api/webhook/pine
// ══════════════════════════════════════════════════════════════════════════════

async function handlePineWebhook(req, res) {
  stats.webhook.received++;

  try {
    // Body parsing: TradingView puo' inviare con Content-Type application/json
    // (parsato da express.json) oppure text/plain con dentro un JSON
    let payload = req.body;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch(e) {
        stats.webhook.rejectedFormat++;
        console.error('[PINE] body non e JSON valido:', payload.slice(0, 200));
        return res.status(400).json({ ok: false, error: 'invalid_json' });
      }
    }

    // ─── Auth ───
    if (!TV_WEBHOOK_TOKEN) {
      stats.webhook.rejectedAuth++;
      console.error('[PINE] TV_WEBHOOK_TOKEN non configurato sul server');
      return res.status(500).json({ ok: false, error: 'server_not_configured' });
    }
    if (!payload || payload.token !== TV_WEBHOOK_TOKEN) {
      stats.webhook.rejectedAuth++;
      console.error('[PINE] token mismatch o assente');
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // ─── Validate strategy ───
    const strategy = payload.strategy;
    if (!STRATEGY_NAMES[strategy]) {
      stats.webhook.rejectedFormat++;
      console.error('[PINE] strategy sconosciuta:', strategy);
      return res.status(400).json({ ok: false, error: 'unknown_strategy', got: strategy });
    }

    // ─── Validate direction ───
    const direction = (payload.direction || '').toLowerCase();
    if (direction !== 'long' && direction !== 'short') {
      stats.webhook.rejectedFormat++;
      console.error('[PINE] direction invalida:', direction);
      return res.status(400).json({ ok: false, error: 'invalid_direction' });
    }

    // ─── Validate prices ───
    const price = parseFloat(payload.price);
    const sl = parseFloat(payload.sl);
    const tp = parseFloat(payload.tp);
    if (isNaN(price) || isNaN(sl) || isNaN(tp)) {
      stats.webhook.rejectedFormat++;
      console.error('[PINE] prezzi NaN:', { price, sl, tp });
      return res.status(400).json({ ok: false, error: 'invalid_prices' });
    }

    // ─── Sanity: SL/TP coerenti con direction ───
    // long  -> sl < price < tp ;   short -> tp < price < sl
    if (direction === 'long' && (sl >= price || tp <= price)) {
      stats.webhook.rejectedFormat++;
      console.error('[PINE] SL/TP incoerenti per LONG');
      return res.status(400).json({ ok: false, error: 'sl_tp_inconsistent' });
    }
    if (direction === 'short' && (sl <= price || tp >= price)) {
      stats.webhook.rejectedFormat++;
      console.error('[PINE] SL/TP incoerenti per SHORT');
      return res.status(400).json({ ok: false, error: 'sl_tp_inconsistent' });
    }

    const score = parseInt(payload.score) || 0;
    const volatility = (payload.volatility || 'NORMAL').toUpperCase();
    const instrument = normalizeInstrument(payload.instrument);
    const timeframe = payload.timeframe || '';

    // ─── Filtri server-side ───
    if (score < MIN_SCORE) {
      stats.webhook.filtered++;
      console.log('[PINE] FILTRATO score=' + score + ' < MIN_SCORE=' + MIN_SCORE +
                  ' (' + strategy + ' ' + direction + ' ' + instrument + ')');
      return res.json({ ok: true, filtered: true, reason: 'score_below_minimum' });
    }
    if (BLOCK_HIGH_VOL && volatility === 'HIGH') {
      stats.webhook.filtered++;
      console.log('[PINE] FILTRATO HIGH vol (' + strategy + ' ' + direction + ' ' + instrument + ')');
      return res.json({ ok: true, filtered: true, reason: 'high_volatility' });
    }

    // ─── Build messaggio Telegram ───
    const dirArrow = direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
    const stars = '⭐'.repeat(score) + '☆'.repeat(5 - score);
    const d = dec(price);
    const slDist = Math.abs(price - sl);
    const tpDist = Math.abs(tp - price);
    const rr = slDist > 0 ? (tpDist / slDist).toFixed(2) : '?';
    const ts = new Date().toUTCString().slice(0, 25);
    const tfLabel = timeframe ? ' · TF ' + timeframe : '';

    let extras = '';
    if (payload.adx && !isNaN(parseFloat(payload.adx))) {
      extras += '<b>ADX:</b> ' + parseFloat(payload.adx).toFixed(1) + '  ';
    }
    if (payload.rsi && !isNaN(parseFloat(payload.rsi))) {
      extras += '<b>RSI:</b> ' + parseFloat(payload.rsi).toFixed(1);
    }
    if (extras) extras += '\n';

    const volWarn = volatility === 'HIGH' ? '⚠️ <i>HIGH volatility — considera size ridotta</i>\n' : '';
    const htfBadge = payload.htf_aligned === true ? '✅ <i>HTF aligned</i>\n' : '';

    const msg =
      '<b>' + STRATEGY_EMOJI[strategy] + ' ' + STRATEGY_NAMES[strategy] + '</b> · ' + dirArrow + '\n' +
      '<b>' + instrument + '</b>' + tfLabel + '  ' + stars + '\n\n' +
      '<b>Entry:</b> <code>' + price.toFixed(d) + '</code>\n' +
      '<b>SL:</b> <code>' + sl.toFixed(d) + '</code>   <b>TP:</b> <code>' + tp.toFixed(d) + '</code>\n' +
      '<b>R:R:</b> 1:' + rr + '\n' +
      extras +
      volWarn +
      htfBadge +
      '\n<i>' + ts + '</i>';

    const tgOk = await tgSend(msg);

    if (!tgOk) {
      stats.webhook.telegramFailed++;
      console.error('[PINE] tgSend fallito');
      return res.status(500).json({ ok: false, error: 'telegram_failed' });
    }

    // ─── Update stats ───
    stats.webhook.accepted++;
    stats.totalSignals++;

    const ps = stats.perStrategy[strategy];
    ps.total++;
    ps[direction === 'long' ? 'longs' : 'shorts']++;
    ps.lastSignal = direction.toUpperCase() + ' ' + instrument;
    ps.lastTs = Date.now();
    ps._scoreSum += score;
    ps.avgScore = Math.round(ps._scoreSum / ps.total * 10) / 10;

    if (!stats.perInstrument[instrument]) {
      stats.perInstrument[instrument] = { total: 0, longs: 0, shorts: 0 };
    }
    stats.perInstrument[instrument].total++;
    stats.perInstrument[instrument][direction === 'long' ? 'longs' : 'shorts']++;

    if (score >= 1 && score <= 5) stats.perScore[score]++;
    stats.perDirection[direction]++;

    // ─── Log record ───
    const record = {
      ts: Date.now(),
      time: ts,
      strategy: strategy,
      strategyName: STRATEGY_NAMES[strategy],
      instrument: instrument,
      direction: direction,
      price: +price.toFixed(d),
      sl: +sl.toFixed(d),
      tp: +tp.toFixed(d),
      rr: parseFloat(rr) || 0,
      score: score,
      volatility: volatility,
      timeframe: timeframe,
      adx: payload.adx ? parseFloat(payload.adx) : null,
      rsi: payload.rsi ? parseFloat(payload.rsi) : null,
      atr: payload.atr ? parseFloat(payload.atr) : null,
      htfAligned: payload.htf_aligned === true
    };
    signalLog.unshift(record);
    if (signalLog.length > 100) signalLog.pop();

    console.log('[PINE OK] ' + strategy + ' ' + direction.toUpperCase() + ' ' + instrument +
                ' @ ' + price.toFixed(d) + ' score=' + score + ' vol=' + volatility);
    return res.json({ ok: true, relayed: true });

  } catch(e) {
    console.error('[PINE WEBHOOK] eccezione:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// Endpoint primario + alias backward-compat
app.post('/api/webhook/pine', handlePineWebhook);
app.post('/api/webhook/tradingview', handlePineWebhook);

// ══════════════════════════════════════════════════════════════════════════════
// API ENDPOINTS — diagnostica e dashboard
// ══════════════════════════════════════════════════════════════════════════════

// Diagnostic endpoint (browser-friendly)
app.get('/api/webhook/test', (req, res) => {
  res.json({
    ok: true,
    message: 'Webhook endpoint raggiungibile',
    tokenConfigured: !!TV_WEBHOOK_TOKEN,
    telegramConfigured: !!(TG_TOKEN && TG_CHAT_ID),
    filters: { MIN_SCORE, BLOCK_HIGH_VOL },
    stats: stats.webhook,
    recentSignals: signalLog.slice(0, 5)
  });
});

// Status completo per dashboard
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: '3.0.0-pine-only',
    telegramConnected: !!(TG_TOKEN && TG_CHAT_ID),
    tokenConfigured: !!TV_WEBHOOK_TOKEN,
    filters: { MIN_SCORE, BLOCK_HIGH_VOL },
    stats: stats,
    signals: signalLog.slice(0, 30)
  });
});

// Signals filtrati (per esplorazione dashboard)
app.get('/api/signals', (req, res) => {
  let filtered = signalLog.slice();
  const strategy = req.query.strategy;
  if (strategy) filtered = filtered.filter(s => s.strategy === strategy);
  const direction = req.query.direction;
  if (direction) filtered = filtered.filter(s => s.direction === direction);
  const minScore = parseInt(req.query.minScore);
  if (!isNaN(minScore)) filtered = filtered.filter(s => s.score >= minScore);
  const instrument = req.query.instrument;
  if (instrument) filtered = filtered.filter(s => s.instrument === instrument.toUpperCase());
  res.json({ count: filtered.length, signals: filtered });
});

// Test Telegram
app.post('/api/test', async (req, res) => {
  const ok = await tgSend(
    '<b>🧪 ST-EA Pine Relay · Test</b>\n\n' +
    'Test message OK\n' +
    'Uptime: ' + Math.floor((Date.now() - startTime) / 1000) + 's'
  );
  res.json({ ok });
});
app.get('/api/test', async (req, res) => {
  const ok = await tgSend('<b>🧪 ST-EA Pine Relay · Test (GET)</b>\n\nTest OK');
  res.json({ ok });
});

// Reset stats (utile in fase test)
app.post('/api/reset', (req, res) => {
  signalLog = [];
  stats.totalSignals = 0;
  Object.keys(stats.perStrategy).forEach(k => {
    stats.perStrategy[k] = { total: 0, longs: 0, shorts: 0, lastSignal: null, lastTs: null, avgScore: 0, _scoreSum: 0 };
  });
  stats.perInstrument = {};
  stats.perScore = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  stats.perDirection = { long: 0, short: 0 };
  stats.webhook = { received: 0, accepted: 0, filtered: 0, rejectedAuth: 0, rejectedFormat: 0, telegramFailed: 0 };
  res.json({ ok: true, message: 'stats reset' });
});

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' ST-EA Pine Relay v3.0  ·  Pure webhook receiver');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' PORT:                  ' + PORT);
  console.log(' Telegram:              ' + (TG_TOKEN && TG_CHAT_ID ? 'OK' : 'NOT CONFIGURED'));
  console.log(' Webhook token:         ' + (TV_WEBHOOK_TOKEN ? 'OK' : 'NOT CONFIGURED'));
  console.log(' Min score filter:      ' + MIN_SCORE + '/5');
  console.log(' Block HIGH vol:        ' + BLOCK_HIGH_VOL);
  console.log(' Strategies enabled:    trend_rider, breakout_hunter, range_scalper');
  console.log('═══════════════════════════════════════════════════════════');

  await tgSend(
    '<b>🚀 ST-EA Pine Relay v3 online</b>\n\n' +
    '<i>3 Pine strategies armed:</i>\n' +
    '📈 Trend Rider  (H1/H4)\n' +
    '💥 Breakout Hunter  (M15/H1)\n' +
    '〰️ Range Scalper  (M5/M15)\n\n' +
    '<i>Min score: ' + MIN_SCORE + '/5  |  HIGH vol blocked: ' + (BLOCK_HIGH_VOL ? 'yes' : 'no') + '</i>'
  );
});
