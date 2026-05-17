const express = require('express');
const crypto = require('crypto');

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

const VERSION          = '3.0.1-pine-only';
const PORT             = process.env.PORT             || 3000;
const TG_TOKEN         = process.env.TG_TOKEN         || '';
const TG_CHAT_ID       = process.env.TG_CHAT_ID       || '';
const TV_WEBHOOK_TOKEN = process.env.TV_WEBHOOK_TOKEN || '';
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN      || '';

// ─── Filtri server-side opzionali (env vars) ─────────────────────────────────
// Nota: usiamo Number.isFinite per non far cadere MIN_SCORE=0 nel fallback
const MIN_SCORE_RAW  = parseInt(process.env.MIN_SCORE, 10);
const MIN_SCORE      = Number.isFinite(MIN_SCORE_RAW) ? MIN_SCORE_RAW : 3;
const BLOCK_HIGH_VOL = process.env.BLOCK_HIGH_VOL === 'true';    // skip se HIGH vol

// ─── Costanti ───────────────────────────────────────────────────────────────
const SIGNAL_LOG_MAX        = 100;
const REJECTED_LOG_MAX      = 30;
const ECHO_LOG_MAX          = 30;
const ALLOWED_VOLATILITY    = ['LOW', 'NORMAL', 'HIGH'];
const CONFIRMATION_DELAY_MS = 800;

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

// Timeframe ammessi per ogni strategia (numero in minuti).
// Riflette la spec mostrata nella dashboard:
//   Trend Rider     -> H1 / H4
//   Breakout Hunter -> M15 / H1
//   Range Scalper   -> M5 / M15
const STRATEGY_TF = {
  trend_rider:     [60, 240],
  breakout_hunter: [15, 60],
  range_scalper:   [5, 15]
};

// Alias case-insensitive per timeframe: TradingView puo' inviarlo come
// numero ("15", "60"), come stringa di Pine ("M15", "H1"), o varianti.
const TF_ALIASES = {
  'm1':   1,    '1m':  1,
  'm3':   3,    '3m':  3,
  'm5':   5,    '5m':  5,
  'm15':  15,   '15m': 15,
  'm30':  30,   '30m': 30,
  'h1':   60,   '1h':  60,
  'h2':   120,  '2h':  120,
  'h4':   240,  '4h':  240,
  'd':    1440, '1d':  1440, 'd1': 1440,
  'w':    10080,'1w':  10080
};

// Alias case-insensitive per la strategia (Pine puo' inviarla con varianti)
const STRATEGY_ALIASES = {
  'trend_rider':     'trend_rider',
  'trendrider':      'trend_rider',
  'trend-rider':     'trend_rider',
  'trend rider':     'trend_rider',
  'trend':           'trend_rider',
  'breakout_hunter': 'breakout_hunter',
  'breakouthunter':  'breakout_hunter',
  'breakout-hunter': 'breakout_hunter',
  'breakout hunter': 'breakout_hunter',
  'breakout':        'breakout_hunter',
  'range_scalper':   'range_scalper',
  'rangescalper':    'range_scalper',
  'range-scalper':   'range_scalper',
  'range scalper':   'range_scalper',
  'range':           'range_scalper'
};

// ─── Stato in-memory (no DB, sufficient per signal volume previsto) ───────────
const startTime = Date.now();
let signalLog = [];     // ultimi 100 segnali accettati
let rejectedLog = [];   // ultimi 30 rifiuti/filtri (diagnostica)
let echoLog = [];       // ultimi 30 payload ricevuti su /api/webhook/echo
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

// Confronto costante-tempo per token (mitiga timing attack)
function safeTokenCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// htf_aligned puo' arrivare come boolean true, "true", 1 o "1" da TradingView
function isTruthy(v) {
  return v === true || v === 1 || v === '1' ||
         (typeof v === 'string' && v.toLowerCase() === 'true');
}

// Middleware: se ADMIN_TOKEN e' configurato, richiede header x-admin-token
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const provided = req.get('x-admin-token') ||
                   (req.body && typeof req.body === 'object' && req.body.token) || '';
  if (!safeTokenCompare(provided, ADMIN_TOKEN)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// Normalizza nome strategia: accetta varianti di case/separatori e short form
function normalizeStrategy(s) {
  if (s === null || s === undefined) return null;
  const k = String(s).toLowerCase().trim();
  return STRATEGY_ALIASES[k] || null;
}

// Normalizza timeframe a minuti (numero). Accetta "15", "M15", "H1", ecc.
// Ritorna null se non interpretabile.
function normalizeTF(tf) {
  if (tf === null || tf === undefined || tf === '') return null;
  const k = String(tf).toLowerCase().trim();
  if (TF_ALIASES[k] !== undefined) return TF_ALIASES[k];
  const n = parseInt(k, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Numero "finito" tollerante: parseFloat che ritorna null se non valido.
// Usata per ADX/RSI/ATR cosi anche il valore 0 viene preservato.
function finiteOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Pulisce un payload prima di salvarlo nel log: rimuove il token (sensibile)
// e tronca le stringhe lunghe per evitare bloat.
function sanitizePayloadForLog(p) {
  if (p === null || p === undefined) return { _raw: null };
  if (typeof p !== 'object') return { _raw: String(p).slice(0, 500) };
  const out = {};
  for (const k of Object.keys(p)) {
    if (k === 'token') continue;
    const v = p[k];
    if (typeof v === 'string' && v.length > 200) out[k] = v.slice(0, 200) + '…';
    else out[k] = v;
  }
  return out;
}

// Registra un rifiuto/filtro per ispezione successiva via /api/rejected
function recordRejection(req, reason, payload, extra) {
  const rec = {
    ts: Date.now(),
    time: new Date().toISOString(),
    reason: reason,
    ip: (req && req.ip) || null,
    payload: sanitizePayloadForLog(payload)
  };
  if (extra && typeof extra === 'object') Object.assign(rec, extra);
  rejectedLog.unshift(rec);
  while (rejectedLog.length > REJECTED_LOG_MAX) rejectedLog.pop();
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
        const snippet = payload.slice(0, 200);
        console.error('[PINE] body non e JSON valido:', snippet);
        recordRejection(req, 'invalid_json', { _raw: snippet });
        return res.status(400).json({ ok: false, error: 'invalid_json' });
      }
    }

    // ─── Auth ───
    if (!TV_WEBHOOK_TOKEN) {
      stats.webhook.rejectedAuth++;
      console.error('[PINE] TV_WEBHOOK_TOKEN non configurato sul server');
      return res.status(500).json({ ok: false, error: 'server_not_configured' });
    }
    if (!payload || !safeTokenCompare(payload.token, TV_WEBHOOK_TOKEN)) {
      stats.webhook.rejectedAuth++;
      console.error('[PINE] token mismatch o assente');
      // Non logghiamo i payload con token errato per evitare rumore da scanner
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // ─── Validate strategy (case-insensitive + alias) ───
    const strategy = normalizeStrategy(payload.strategy);
    if (!strategy) {
      stats.webhook.rejectedFormat++;
      console.error('[PINE] strategy sconosciuta:', payload.strategy);
      recordRejection(req, 'unknown_strategy', payload, { got: payload.strategy });
      return res.status(400).json({ ok: false, error: 'unknown_strategy', got: payload.strategy });
    }

    // ─── Validate direction ───
    const direction = (payload.direction || '').toString().toLowerCase().trim();
    if (direction !== 'long' && direction !== 'short') {
      stats.webhook.rejectedFormat++;
      console.error('[PINE] direction invalida:', payload.direction);
      recordRejection(req, 'invalid_direction', payload, { got: payload.direction });
      return res.status(400).json({ ok: false, error: 'invalid_direction' });
    }

    // ─── Validate prices ───
    const price = parseFloat(payload.price);
    const sl = parseFloat(payload.sl);
    const tp = parseFloat(payload.tp);
    if (!Number.isFinite(price) || !Number.isFinite(sl) || !Number.isFinite(tp)) {
      stats.webhook.rejectedFormat++;
      console.error('[PINE] prezzi non validi:', { price, sl, tp });
      recordRejection(req, 'invalid_prices', payload, { parsed: { price, sl, tp } });
      return res.status(400).json({ ok: false, error: 'invalid_prices' });
    }

    // ─── Sanity: SL/TP coerenti con direction ───
    // long  -> sl < price < tp ;   short -> tp < price < sl
    if (direction === 'long' && (sl >= price || tp <= price)) {
      stats.webhook.rejectedFormat++;
      console.error('[PINE] SL/TP incoerenti per LONG', { price, sl, tp });
      recordRejection(req, 'sl_tp_inconsistent', payload, { side: 'long', parsed: { price, sl, tp } });
      return res.status(400).json({ ok: false, error: 'sl_tp_inconsistent' });
    }
    if (direction === 'short' && (sl <= price || tp >= price)) {
      stats.webhook.rejectedFormat++;
      console.error('[PINE] SL/TP incoerenti per SHORT', { price, sl, tp });
      recordRejection(req, 'sl_tp_inconsistent', payload, { side: 'short', parsed: { price, sl, tp } });
      return res.status(400).json({ ok: false, error: 'sl_tp_inconsistent' });
    }

    // Score: accetta sia int che float (es. 3.5 -> 4). Clamp 0-5.
    const scoreRaw = parseFloat(payload.score);
    const score = Number.isFinite(scoreRaw)
      ? Math.max(0, Math.min(5, Math.round(scoreRaw)))
      : 0;
    const volatilityRaw = (payload.volatility || 'NORMAL').toString().toUpperCase().trim();
    const volatility = ALLOWED_VOLATILITY.includes(volatilityRaw) ? volatilityRaw : 'NORMAL';
    const instrument = normalizeInstrument(payload.instrument);
    const timeframe = payload.timeframe || '';
    const htfAligned = isTruthy(payload.htf_aligned);

    // ─── Validate TF compatibile con la strategia ───
    // Trend Rider e' H1/H4, Breakout Hunter M15/H1, Range Scalper M5/M15.
    // Se Pine spara su un TF non previsto, lo scartiamo e logghiamo per
    // ispezione su /api/rejected. Cosi gli alert mal-configurati su TV
    // non finiscono su Telegram come "valid" signals.
    const tfMinutes = normalizeTF(timeframe);
    const allowedTFs = STRATEGY_TF[strategy] || [];
    if (tfMinutes === null || !allowedTFs.includes(tfMinutes)) {
      stats.webhook.rejectedFormat++;
      console.error('[PINE] TF non compatibile:',
        { strategy, tf: timeframe, tfMinutes, allowed: allowedTFs });
      recordRejection(req, 'tf_strategy_mismatch', payload, {
        strategy: strategy,
        tf: timeframe,
        tfMinutes: tfMinutes,
        allowed: allowedTFs
      });
      return res.status(400).json({
        ok: false,
        error: 'tf_strategy_mismatch',
        strategy: strategy,
        timeframe: timeframe,
        allowedTFs: allowedTFs
      });
    }

    // ─── Filtri server-side ───
    if (score < MIN_SCORE) {
      stats.webhook.filtered++;
      console.log('[PINE] FILTRATO score=' + score + ' < MIN_SCORE=' + MIN_SCORE +
                  ' (' + strategy + ' ' + direction + ' ' + instrument + ')');
      recordRejection(req, 'score_below_minimum', payload, { score, minScore: MIN_SCORE });
      return res.json({ ok: true, filtered: true, reason: 'score_below_minimum' });
    }
    if (BLOCK_HIGH_VOL && volatility === 'HIGH') {
      stats.webhook.filtered++;
      console.log('[PINE] FILTRATO HIGH vol (' + strategy + ' ' + direction + ' ' + instrument + ')');
      recordRejection(req, 'high_volatility', payload, { volatility });
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

    // ADX/RSI/ATR: usiamo finiteOrNull cosi anche valore 0 (improbabile ma
    // possibile) viene preservato invece di essere scartato come falsy.
    const adxN = finiteOrNull(payload.adx);
    const rsiN = finiteOrNull(payload.rsi);
    const atrN = finiteOrNull(payload.atr);

    let extras = '';
    if (adxN !== null) extras += '<b>ADX:</b> ' + adxN.toFixed(1) + '  ';
    if (rsiN !== null) extras += '<b>RSI:</b> ' + rsiN.toFixed(1);
    if (extras) extras += '\n';

    const volWarn = volatility === 'HIGH' ? '⚠️ <i>HIGH volatility — considera size ridotta</i>\n' : '';
    const htfBadge = htfAligned ? '✅ <i>HTF aligned</i>\n' : '';

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
      recordRejection(req, 'telegram_failed', payload, { strategy, direction, instrument });
      return res.status(500).json({ ok: false, error: 'telegram_failed' });
    }

    // ─── Update stats ───
    stats.webhook.accepted++;
    stats.totalSignals++;
    const signalNum = stats.totalSignals;

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
      adx: adxN,
      rsi: rsiN,
      atr: atrN,
      htfAligned: htfAligned
    };
    signalLog.unshift(record);
    while (signalLog.length > SIGNAL_LOG_MAX) signalLog.pop();

    console.log('[PINE OK] ' + strategy + ' ' + direction.toUpperCase() + ' ' + instrument +
                ' @ ' + price.toFixed(d) + ' score=' + score + ' vol=' + volatility);

    // Rispondi subito al webhook: non bloccare TradingView sull'ack di sistema.
    res.json({ ok: true, relayed: true });

    // ─── Conferma di ricezione (fire-and-forget) ───
    // Delay 800ms: due sendMessage consecutivi dallo stesso bot vengono a
    // volte droppati silenziosamente da Telegram (anti-flood) anche con 200 OK.
    // Disattivabile con env var: SEND_CONFIRMATION=false
    if (process.env.SEND_CONFIRMATION !== 'false') {
      setTimeout(() => {
        tgSend(
          '✅ <i>Segnale #' + signalNum + ' relayato</i> · ' +
          STRATEGY_EMOJI[strategy] + ' ' + (direction === 'long' ? '🟢' : '🔴') + ' ' + instrument
        ).catch(e => console.error('[TG confirm]', e.message));
      }, CONFIRMATION_DELAY_MS);
    }
    return;

  } catch(e) {
    console.error('[PINE WEBHOOK] eccezione:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// Endpoint primario + alias backward-compat
app.post('/api/webhook/pine', handlePineWebhook);
app.post('/api/webhook/tradingview', handlePineWebhook);

// ─── Echo endpoint: nessuna validazione, solo log. Utile per vedere ESATTAMENTE
// cosa TradingView sta inviando senza il filtro della validazione. Protetto
// dallo stesso TV_WEBHOOK_TOKEN per evitare rumore esterno.
function handleEcho(req, res) {
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); }
    catch(e) { payload = { _raw: payload.slice(0, 500), _parseError: e.message }; }
  }
  if (TV_WEBHOOK_TOKEN && (!payload || !safeTokenCompare(payload.token, TV_WEBHOOK_TOKEN))) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const clean = sanitizePayloadForLog(payload);
  const rec = {
    ts: Date.now(),
    time: new Date().toISOString(),
    ip: req.ip || null,
    headers: {
      'content-type': req.get('content-type') || null,
      'user-agent':   req.get('user-agent')   || null
    },
    payload: clean
  };
  echoLog.unshift(rec);
  while (echoLog.length > ECHO_LOG_MAX) echoLog.pop();
  console.log('[ECHO]', JSON.stringify(clean));
  return res.json({ ok: true, echoed: true, received: clean });
}
app.post('/api/webhook/echo', handleEcho);

// ══════════════════════════════════════════════════════════════════════════════
// API ENDPOINTS — diagnostica e dashboard
// ══════════════════════════════════════════════════════════════════════════════

// Liveness probe (uptime monitor / load balancer)
app.get('/healthz', (req, res) => res.status(200).type('text/plain').send('ok'));

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
    version: VERSION,
    telegramConnected: !!(TG_TOKEN && TG_CHAT_ID),
    tokenConfigured: !!TV_WEBHOOK_TOKEN,
    adminProtected: !!ADMIN_TOKEN,
    filters: { MIN_SCORE, BLOCK_HIGH_VOL },
    strategyTF: STRATEGY_TF,
    stats: stats,
    signals: signalLog.slice(0, 30)
  });
});

// Buffer dei segnali rifiutati/filtrati (per debug payload TradingView)
app.get('/api/rejected', requireAdmin, (req, res) => {
  res.json({ count: rejectedLog.length, rejected: rejectedLog });
});

// Buffer dei payload ricevuti su /api/webhook/echo
app.get('/api/echoes', requireAdmin, (req, res) => {
  res.json({ count: echoLog.length, echoes: echoLog });
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

// Test Telegram (protetto da ADMIN_TOKEN se configurato)
app.post('/api/test', requireAdmin, async (req, res) => {
  const ok = await tgSend(
    '<b>🧪 ST-EA Pine Relay · Test</b>\n\n' +
    'Test message OK\n' +
    'Uptime: ' + Math.floor((Date.now() - startTime) / 1000) + 's'
  );
  res.json({ ok });
});
app.get('/api/test', requireAdmin, async (req, res) => {
  const ok = await tgSend('<b>🧪 ST-EA Pine Relay · Test (GET)</b>\n\nTest OK');
  res.json({ ok });
});

// Reset stats (protetto da ADMIN_TOKEN se configurato)
app.post('/api/reset', requireAdmin, (req, res) => {
  signalLog = [];
  rejectedLog = [];
  echoLog = [];
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
const server = app.listen(PORT, async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' ST-EA Pine Relay ' + VERSION + '  ·  Pure webhook receiver');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' PORT:                  ' + PORT);
  console.log(' Telegram:              ' + (TG_TOKEN && TG_CHAT_ID ? 'OK' : 'NOT CONFIGURED'));
  console.log(' Webhook token:         ' + (TV_WEBHOOK_TOKEN ? 'OK' : 'NOT CONFIGURED'));
  console.log(' Admin token:           ' + (ADMIN_TOKEN ? 'OK (test/reset protetti)' : 'NOT SET (test/reset aperti — sconsigliato in produzione)'));
  console.log(' Min score filter:      ' + MIN_SCORE + '/5');
  console.log(' Block HIGH vol:        ' + BLOCK_HIGH_VOL);
  console.log(' Strategies enabled:    trend_rider, breakout_hunter, range_scalper');
  console.log(' Diagnostics:           /api/rejected · /api/echoes · POST /api/webhook/echo');
  console.log('═══════════════════════════════════════════════════════════');

  await tgSend(
    '<b>🚀 ST-EA Pine Relay ' + VERSION + ' online</b>\n\n' +
    '<i>3 Pine strategies armed:</i>\n' +
    '📈 Trend Rider  (H1/H4)\n' +
    '💥 Breakout Hunter  (M15/H1)\n' +
    '〰️ Range Scalper  (M5/M15)\n\n' +
    '<i>Min score: ' + MIN_SCORE + '/5  |  HIGH vol blocked: ' + (BLOCK_HIGH_VOL ? 'yes' : 'no') + '</i>'
  );
});

// Graceful shutdown: chiudi le connessioni HTTP prima di uscire (utile in
// container orchestrator che inviano SIGTERM prima di SIGKILL)
function shutdown(sig) {
  console.log('[shutdown] ricevuto ' + sig + ' — chiusura server HTTP');
  server.close(() => {
    console.log('[shutdown] server HTTP chiuso, exit 0');
    process.exit(0);
  });
  // hard timeout di sicurezza
  setTimeout(() => {
    console.error('[shutdown] forced exit dopo 10s');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
