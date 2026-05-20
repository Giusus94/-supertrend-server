const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.text({ limit: '10kb', type: 'text/plain' }));
app.use(express.static('public'));

// ══════════════════════════════════════════════════════════════════════════════
// ST-EA Relay v4.1 — All-in-One edition
//
// Architettura:
//   - 1 Pine "ST-EA All-in-One" applicato su N simboli
//   - Ogni bar close significativo, il Pine manda 1 webhook /api/combined
//     che contiene: context + structure + liquidity (sempre)
//     + opzionale signal (se nuovo segnale)
//     + opzionale trade_closed (se trade chiuso)
//   - Il server mantiene state PER-SIMBOLO (Map<instrument, state>)
//   - Filtri applicati al signal usano lo state DI QUEL SIMBOLO
//
// Filtri pre-Telegram (in ordine):
//   1. Auth token
//   2. Schema (strategy=breakout_hunter, TF=M15/H1, prezzi coerenti)
//   3. Score >= MIN_SCORE
//   4. Volatility HIGH (se BLOCK_HIGH_VOL)
//   5. Context BLOCK (regime chaos / London open)
//   6. Structure conflict (long vs bias_h1=DOWN)
//   7. Liquidity sweep recente nella direzione del segnale
//
// Tracker: signal -> open trade, trade_closed -> close + Telegram + R-multiple.
// Trade expired automaticamente dopo TRADE_EXPIRY_HOURS.
// ══════════════════════════════════════════════════════════════════════════════

const VERSION          = '4.1.0-all-in-one';
const PORT             = process.env.PORT             || 3000;
const TG_TOKEN         = process.env.TG_TOKEN         || '';
const TG_CHAT_ID       = process.env.TG_CHAT_ID       || '';
const TV_WEBHOOK_TOKEN = process.env.TV_WEBHOOK_TOKEN || '';
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN      || '';

// ─── Filtri ──────────────────────────────────────────────────────────────────
const MIN_SCORE_RAW       = parseInt(process.env.MIN_SCORE, 10);
const MIN_SCORE           = Number.isFinite(MIN_SCORE_RAW) ? MIN_SCORE_RAW : 4;
const BLOCK_HIGH_VOL      = process.env.BLOCK_HIGH_VOL === 'true';
const CONTEXT_FILTER      = process.env.CONTEXT_FILTER !== 'false';
const STRUCTURE_FILTER    = process.env.STRUCTURE_FILTER !== 'false';
const LIQUIDITY_FILTER    = process.env.LIQUIDITY_FILTER !== 'false';
const CONTEXT_MAX_AGE_MIN = parseInt(process.env.CONTEXT_MAX_AGE_MIN || '60', 10);
const TRADE_EXPIRY_HOURS  = parseInt(process.env.TRADE_EXPIRY_HOURS  || '48', 10);
const SEND_CONFIRMATION   = process.env.SEND_CONFIRMATION !== 'false';

// ─── Costanti ────────────────────────────────────────────────────────────────
const SIGNAL_LOG_MAX        = 100;
const REJECTED_LOG_MAX      = 50;
const CONTEXT_LOG_MAX       = 200;     // include tutti i simboli
const CLOSED_TRADES_MAX     = 200;
const ALLOWED_VOLATILITY    = ['LOW', 'NORMAL', 'HIGH'];
const ALLOWED_VERDICT       = ['ALLOW', 'WARN', 'BLOCK'];
const ALLOWED_BIAS          = ['UP', 'DOWN', 'NEUTRAL'];
const ALLOWED_SWEEP         = ['NONE', 'LONG_STOPS', 'SHORT_STOPS'];
const CONFIRMATION_DELAY_MS = 800;

const STRATEGY_KEY  = 'breakout_hunter';
const STRATEGY_NAME = 'Breakout Hunter';
const STRATEGY_TFS  = [15, 60];

const TF_ALIASES = {
  'm5':5,'5m':5,'m15':15,'15m':15,'m30':30,'30m':30,
  'h1':60,'1h':60,'h2':120,'2h':120,'h4':240,'4h':240,
  'd':1440,'1d':1440,'d1':1440
};

// ─── Stato in-memory ─────────────────────────────────────────────────────────
const startTime = Date.now();
let signalLog    = [];
let rejectedLog  = [];
let combinedLog  = [];     // tutti i payload combined ricevuti (audit)
let openTrades   = [];
let closedTrades = [];
let nextTradeId  = 1;

// STATE PER-SIMBOLO: chiave = instrument (es. "GBPUSD")
// Ogni voce: { context, structure, liquidity }
// Ogni sotto-stato ha { ts, ... fields ... }
const symbolState = new Map();

function getSymbolState(instrument) {
  if (!symbolState.has(instrument)) {
    symbolState.set(instrument, { context: null, structure: null, liquidity: null });
  }
  return symbolState.get(instrument);
}

const stats = {
  combined:  { received: 0, accepted: 0, rejectedAuth: 0, rejectedFormat: 0 },
  signal:    { received: 0, accepted: 0, filteredScore: 0, filteredVol: 0,
               filteredContext: 0, filteredStructure: 0, filteredLiquidity: 0,
               rejectedFormat: 0, telegramFailed: 0 },
  tradeClose:{ received: 0, matched: 0, unmatched: 0, expired: 0 },
  totalSignals: 0,
  perInstrument: {},
  perScore: { 1:0, 2:0, 3:0, 4:0, 5:0 },
  perDirection: { long: 0, short: 0 },
  trades: { totalOpened: 0, win: 0, loss: 0, expired: 0, openNow: 0,
            winRate: 0, avgR: 0, _rSum: 0 }
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
  if (s.indexOf(':') !== -1) s = s.split(':').pop();
  return s.toUpperCase();
}

function safeTokenCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isTruthy(v) {
  return v === true || v === 1 || v === '1' ||
         (typeof v === 'string' && v.toLowerCase() === 'true');
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const provided = req.get('x-admin-token') ||
                   (req.body && typeof req.body === 'object' && req.body.token) || '';
  if (!safeTokenCompare(provided, ADMIN_TOKEN)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

function normalizeTF(tf) {
  if (tf === null || tf === undefined || tf === '') return null;
  const k = String(tf).toLowerCase().trim();
  if (TF_ALIASES[k] !== undefined) return TF_ALIASES[k];
  const n = parseInt(k, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

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

function isFresh(state) {
  if (!state) return false;
  return (Date.now() - state.ts) / 60000 <= CONTEXT_MAX_AGE_MIN;
}

function starsLine(score) {
  const s = Math.max(0, Math.min(5, score));
  return '⭐'.repeat(s) + '☆'.repeat(5 - s);
}

function rMultiple(direction, entry, sl, exit) {
  const risk = Math.abs(entry - sl);
  if (risk === 0) return 0;
  const move = direction === 'long' ? (exit - entry) : (entry - exit);
  return Math.round((move / risk) * 100) / 100;
}

// ══════════════════════════════════════════════════════════════════════════════
// SUB-PROCESSORS — modifiche state per-symbol
// ══════════════════════════════════════════════════════════════════════════════

// Aggiorna state.context del simbolo. Ritorna oggetto context (o null se invalid).
function applyContext(instrument, c) {
  if (!c || typeof c !== 'object') return null;
  const regime  = String(c.regime  || 'UNKNOWN').toUpperCase();
  const session = String(c.session || 'UNKNOWN').toUpperCase();
  const verdict = String(c.verdict || 'ALLOW').toUpperCase();
  if (!ALLOWED_VERDICT.includes(verdict)) return null;
  const ctx = {
    ts: Date.now(),
    regime:    regime,
    session:   session,
    verdict:   verdict,
    adx:       finiteOrNull(c.adx),
    atr:       finiteOrNull(c.atr),
    bb_width:  finiteOrNull(c.bb_width),
    is_chaos:  isTruthy(c.is_chaos)
  };
  getSymbolState(instrument).context = ctx;
  return ctx;
}

function applyStructure(instrument, s) {
  if (!s || typeof s !== 'object') return null;
  const bias_h1 = String(s.bias_h1 || 'NEUTRAL').toUpperCase();
  const bias_h4 = String(s.bias_h4 || 'NEUTRAL').toUpperCase();
  if (!ALLOWED_BIAS.includes(bias_h1) || !ALLOWED_BIAS.includes(bias_h4)) return null;
  const str = {
    ts: Date.now(),
    bias_h1: bias_h1,
    bias_h4: bias_h4,
    last_bos:       s.last_bos ? String(s.last_bos).toUpperCase() : null,
    last_bos_price: finiteOrNull(s.last_bos_price)
  };
  getSymbolState(instrument).structure = str;
  return str;
}

function applyLiquidity(instrument, l) {
  if (!l || typeof l !== 'object') return null;
  const sweep = String(l.sweep || 'NONE').toUpperCase();
  if (!ALLOWED_SWEEP.includes(sweep)) return null;
  const liq = {
    ts: Date.now(),
    long_fuel_pct:      finiteOrNull(l.long_fuel_pct),
    short_fuel_pct:     finiteOrNull(l.short_fuel_pct),
    nearest_pool_above: finiteOrNull(l.nearest_pool_above),
    nearest_pool_below: finiteOrNull(l.nearest_pool_below),
    sweep:              sweep,
    sweep_age_bars:     finiteOrNull(l.sweep_age_bars)
  };
  getSymbolState(instrument).liquidity = liq;
  return liq;
}

// ══════════════════════════════════════════════════════════════════════════════
// SIGNAL PROCESSING — chiamato da handleCombined quando combined.signal != null
// ══════════════════════════════════════════════════════════════════════════════

async function processSignal(req, signal, instrument, timeframe) {
  stats.signal.received++;

  // Direction
  const direction = String(signal.direction || '').toLowerCase().trim();
  if (direction !== 'long' && direction !== 'short') {
    stats.signal.rejectedFormat++;
    recordRejection(req, 'invalid_direction', signal, { got: signal.direction });
    return { ok: false, reason: 'invalid_direction' };
  }

  // Prezzi
  const price = parseFloat(signal.price);
  const sl    = parseFloat(signal.sl);
  const tp    = parseFloat(signal.tp);
  if (!Number.isFinite(price) || !Number.isFinite(sl) || !Number.isFinite(tp)) {
    stats.signal.rejectedFormat++;
    recordRejection(req, 'invalid_prices', signal, { parsed: { price, sl, tp } });
    return { ok: false, reason: 'invalid_prices' };
  }
  if (direction === 'long' && (sl >= price || tp <= price)) {
    stats.signal.rejectedFormat++;
    recordRejection(req, 'sl_tp_inconsistent', signal, { side: 'long', parsed: { price, sl, tp } });
    return { ok: false, reason: 'sl_tp_inconsistent' };
  }
  if (direction === 'short' && (sl <= price || tp >= price)) {
    stats.signal.rejectedFormat++;
    recordRejection(req, 'sl_tp_inconsistent', signal, { side: 'short', parsed: { price, sl, tp } });
    return { ok: false, reason: 'sl_tp_inconsistent' };
  }

  const scoreRaw = parseFloat(signal.score);
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(5, Math.round(scoreRaw))) : 0;
  const volatilityRaw = String(signal.volatility || 'NORMAL').toUpperCase().trim();
  const volatility = ALLOWED_VOLATILITY.includes(volatilityRaw) ? volatilityRaw : 'NORMAL';

  // TF
  const tfMin = normalizeTF(timeframe);
  if (tfMin === null || !STRATEGY_TFS.includes(tfMin)) {
    stats.signal.rejectedFormat++;
    recordRejection(req, 'tf_not_allowed', signal, { tf: timeframe, allowed: STRATEGY_TFS });
    return { ok: false, reason: 'tf_not_allowed' };
  }

  // Score
  if (score < MIN_SCORE) {
    stats.signal.filteredScore++;
    recordRejection(req, 'score_below_minimum', signal, { score, minScore: MIN_SCORE, instrument });
    console.log('[SIGNAL] FILTRATO score=' + score + ' < ' + MIN_SCORE + ' (' + direction + ' ' + instrument + ')');
    return { ok: true, filtered: true, reason: 'score_below_minimum' };
  }

  // Volatility
  if (BLOCK_HIGH_VOL && volatility === 'HIGH') {
    stats.signal.filteredVol++;
    recordRejection(req, 'high_volatility', signal, { volatility, instrument });
    console.log('[SIGNAL] FILTRATO HIGH vol (' + direction + ' ' + instrument + ')');
    return { ok: true, filtered: true, reason: 'high_volatility' };
  }

  // State per-symbol per i filtri context/structure/liquidity
  const state = getSymbolState(instrument);

  // Context filter
  if (CONTEXT_FILTER && isFresh(state.context) && state.context.verdict === 'BLOCK') {
    stats.signal.filteredContext++;
    recordRejection(req, 'context_block', signal, {
      instrument, regime: state.context.regime, session: state.context.session
    });
    console.log('[SIGNAL] CONTEXT BLOCK (' + direction + ' ' + instrument + ') ' +
                state.context.regime + '/' + state.context.session);
    return { ok: true, filtered: true, reason: 'context_block',
             context: { regime: state.context.regime, session: state.context.session } };
  }

  // Structure filter
  if (STRUCTURE_FILTER && isFresh(state.structure)) {
    const bias = state.structure.bias_h1;
    const conflict = (direction === 'long' && bias === 'DOWN') ||
                     (direction === 'short' && bias === 'UP');
    if (conflict) {
      stats.signal.filteredStructure++;
      recordRejection(req, 'structure_against_htf', signal, { instrument, direction, bias_h1: bias });
      console.log('[SIGNAL] STRUCTURE BLOCK (' + direction + ' ' + instrument + ') bias_h1=' + bias);
      return { ok: true, filtered: true, reason: 'structure_against_htf',
               structure: { bias_h1: bias } };
    }
  }

  // Liquidity filter
  if (LIQUIDITY_FILTER && isFresh(state.liquidity)) {
    const sweep = state.liquidity.sweep;
    const fakeLong  = direction === 'long'  && sweep === 'LONG_STOPS';
    const fakeShort = direction === 'short' && sweep === 'SHORT_STOPS';
    if (fakeLong || fakeShort) {
      stats.signal.filteredLiquidity++;
      recordRejection(req, 'liquidity_sweep', signal, { instrument, direction, sweep });
      console.log('[SIGNAL] LIQUIDITY BLOCK (' + direction + ' ' + instrument + ') sweep=' + sweep);
      return { ok: true, filtered: true, reason: 'liquidity_sweep',
               liquidity: { sweep } };
    }
  }

  // ═════ ACCEPTED ═════
  const tradeId = nextTradeId++;
  const d   = dec(price);
  const rr  = Math.abs(price - sl) > 0 ? (Math.abs(tp - price) / Math.abs(price - sl)).toFixed(2) : '?';
  const ts  = new Date().toUTCString().slice(0, 25);
  const adxN = finiteOrNull(signal.adx);
  const rsiN = finiteOrNull(signal.rsi);
  const atrN = finiteOrNull(signal.atr);
  const htfAligned = isTruthy(signal.htf_aligned);

  // Build Telegram
  const dirArrow = direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
  let extras = '';
  if (adxN !== null) extras += '<b>ADX:</b> ' + adxN.toFixed(1) + '  ';
  if (rsiN !== null) extras += '<b>RSI:</b> ' + rsiN.toFixed(1);
  if (extras) extras += '\n';
  const volWarn  = volatility === 'HIGH' ? '⚠️ <i>HIGH volatility — size ridotta</i>\n' : '';
  const htfBadge = htfAligned ? '✅ <i>HTF aligned</i>\n' : '';

  let ctxBadge = '';
  if (isFresh(state.context)) {
    const e = state.context.verdict === 'ALLOW' ? '✅' : state.context.verdict === 'WARN' ? '⚠️' : '🛑';
    ctxBadge = e + ' <i>Context: ' + state.context.regime + ' / ' + state.context.session + '</i>\n';
  }
  let strBadge = '';
  if (isFresh(state.structure)) {
    strBadge = '🏛 <i>Structure H1: ' + state.structure.bias_h1 + ' · H4: ' + state.structure.bias_h4 + '</i>\n';
  }
  let liqBadge = '';
  if (isFresh(state.liquidity)) {
    const fuel = direction === 'long' ? state.liquidity.long_fuel_pct : state.liquidity.short_fuel_pct;
    if (fuel !== null && fuel !== undefined) {
      liqBadge = '💧 <i>Liquidity fuel: ' + Math.round(fuel) + '%</i>\n';
    }
  }

  const msg =
    '<b>💥 ' + STRATEGY_NAME + '</b> · ' + dirArrow + '\n' +
    '<b>' + instrument + '</b> · TF ' + timeframe + '  ' + starsLine(score) + '\n\n' +
    '<b>Entry:</b> <code>' + price.toFixed(d) + '</code>\n' +
    '<b>SL:</b> <code>' + sl.toFixed(d) + '</code>   <b>TP:</b> <code>' + tp.toFixed(d) + '</code>\n' +
    '<b>R:R:</b> 1:' + rr + '   <b>Trade #' + tradeId + '</b>\n' +
    extras + volWarn + htfBadge + ctxBadge + strBadge + liqBadge +
    '\n<i>' + ts + '</i>';

  const tgOk = await tgSend(msg);
  if (!tgOk) {
    stats.signal.telegramFailed++;
    recordRejection(req, 'telegram_failed', signal, { direction, instrument });
    return { ok: false, reason: 'telegram_failed' };
  }

  // Stats
  stats.signal.accepted++;
  stats.totalSignals++;
  if (!stats.perInstrument[instrument]) {
    stats.perInstrument[instrument] = { total: 0, longs: 0, shorts: 0 };
  }
  stats.perInstrument[instrument].total++;
  stats.perInstrument[instrument][direction === 'long' ? 'longs' : 'shorts']++;
  if (score >= 1 && score <= 5) stats.perScore[score]++;
  stats.perDirection[direction]++;

  // Signal log
  const record = {
    id: tradeId, ts: Date.now(), time: ts,
    instrument, direction,
    price: +price.toFixed(d), sl: +sl.toFixed(d), tp: +tp.toFixed(d),
    rr: parseFloat(rr) || 0,
    score, volatility, timeframe,
    adx: adxN, rsi: rsiN, atr: atrN, htfAligned,
    context:   isFresh(state.context)   ? { regime: state.context.regime, session: state.context.session, verdict: state.context.verdict } : null,
    structure: isFresh(state.structure) ? { bias_h1: state.structure.bias_h1, bias_h4: state.structure.bias_h4 } : null,
    liquidity: isFresh(state.liquidity) ? { sweep: state.liquidity.sweep, long_fuel: state.liquidity.long_fuel_pct, short_fuel: state.liquidity.short_fuel_pct } : null
  };
  signalLog.unshift(record);
  while (signalLog.length > SIGNAL_LOG_MAX) signalLog.pop();

  // Tracker open trade
  openTrades.push({
    id: tradeId, openedAt: Date.now(), openedTime: ts,
    instrument, direction,
    entry: +price.toFixed(d), sl: +sl.toFixed(d), tp: +tp.toFixed(d),
    score, timeframe, status: 'OPEN'
  });
  stats.trades.openNow = openTrades.length;
  stats.trades.totalOpened++;

  console.log('[SIGNAL OK] #' + tradeId + ' ' + direction.toUpperCase() + ' ' + instrument +
              ' @ ' + price.toFixed(d) + ' score=' + score);

  if (SEND_CONFIRMATION) {
    setTimeout(() => {
      tgSend('✅ <i>Trade #' + tradeId + ' aperto</i> · ' +
             (direction === 'long' ? '🟢' : '🔴') + ' ' + instrument)
        .catch(e => console.error('[TG confirm]', e.message));
    }, CONFIRMATION_DELAY_MS);
  }

  return { ok: true, accepted: true, tradeId };
}

// ══════════════════════════════════════════════════════════════════════════════
// TRADE CLOSED PROCESSING
// ══════════════════════════════════════════════════════════════════════════════

async function processTradeClosed(tc, instrument) {
  stats.tradeClose.received++;

  const direction = String(tc.direction || '').toLowerCase();
  const entry     = parseFloat(tc.entry);
  const exitPrice = parseFloat(tc.exit_price);
  const outcome   = String(tc.outcome || '').toUpperCase();

  if (!Number.isFinite(entry) || !Number.isFinite(exitPrice)) {
    return { ok: false, reason: 'invalid_prices' };
  }
  if (!['TP_HIT', 'SL_HIT'].includes(outcome)) {
    return { ok: false, reason: 'invalid_outcome' };
  }

  // Match trade aperto (tolleranza 0.5% sull'entry)
  const tol = 0.005;
  const idx = openTrades.findIndex(t =>
    t.instrument === instrument &&
    t.direction  === direction &&
    Math.abs(t.entry - entry) / Math.max(t.entry, 0.000001) < tol
  );
  if (idx === -1) {
    stats.tradeClose.unmatched++;
    console.warn('[TRADE-CLOSE] unmatched:', instrument, direction, 'entry=' + entry);
    return { ok: true, matched: false, reason: 'no_matching_open_trade' };
  }

  const t = openTrades[idx];
  const r = rMultiple(direction, t.entry, t.sl, exitPrice);
  const isWin = outcome === 'TP_HIT';
  const durationMin = Math.round((Date.now() - t.openedAt) / 60000);
  const d = dec(t.entry);

  const closed = {
    ...t,
    status: isWin ? 'WIN' : 'LOSS',
    closedAt: Date.now(),
    closedTime: new Date().toUTCString().slice(0, 25),
    exitPrice: +exitPrice.toFixed(d),
    outcome, rMultiple: r, durationMin
  };
  openTrades.splice(idx, 1);
  closedTrades.unshift(closed);
  while (closedTrades.length > CLOSED_TRADES_MAX) closedTrades.pop();

  if (isWin) stats.trades.win++; else stats.trades.loss++;
  stats.trades._rSum += r;
  stats.trades.openNow = openTrades.length;
  const totalClosed = stats.trades.win + stats.trades.loss + stats.trades.expired;
  stats.trades.winRate = totalClosed > 0 ? Math.round(stats.trades.win / totalClosed * 1000) / 10 : 0;
  stats.trades.avgR    = totalClosed > 0 ? Math.round(stats.trades._rSum / totalClosed * 100) / 100 : 0;
  stats.tradeClose.matched++;

  const emoji  = isWin ? '✅' : '❌';
  const label  = isWin ? 'WIN' : 'LOSS';
  const rTxt   = (r >= 0 ? '+' : '') + r.toFixed(2) + 'R';
  const durTxt = durationMin < 60 ? durationMin + 'm' : Math.round(durationMin / 6) / 10 + 'h';
  await tgSend(
    emoji + ' <b>Trade #' + t.id + ' ' + label + '</b>\n' +
    '<b>' + instrument + '</b> · ' + (direction === 'long' ? '🟢 LONG' : '🔴 SHORT') + '\n' +
    'Entry: <code>' + t.entry.toFixed(d) + '</code> → Exit: <code>' + exitPrice.toFixed(d) + '</code>\n' +
    '<b>Result:</b> ' + rTxt + ' · <b>Durata:</b> ' + durTxt + '\n' +
    '<i>Win rate: ' + stats.trades.winRate + '% · Avg R: ' + stats.trades.avgR + '</i>'
  );

  console.log('[TRADE-CLOSE] #' + t.id + ' ' + label + ' ' + rTxt + ' (' + durTxt + ')');
  return { ok: true, matched: true, trade: closed };
}

// ══════════════════════════════════════════════════════════════════════════════
// COMBINED HANDLER — POST /api/combined
// ══════════════════════════════════════════════════════════════════════════════
// Payload atteso:
//   {
//     "token": "...",
//     "instrument": "GBPUSD",
//     "timeframe": "15",
//     "context":   { regime, session, verdict, adx, atr, bb_width, is_chaos },
//     "structure": { bias_h1, bias_h4, last_bos, last_bos_price },
//     "liquidity": { long_fuel_pct, short_fuel_pct, sweep, sweep_age_bars,
//                    nearest_pool_above, nearest_pool_below },
//     "signal":    { direction, price, sl, tp, score, volatility, adx, rsi, atr,
//                    htf_aligned } | null,
//     "trade_closed": { direction, entry, sl, tp, exit_price, outcome } | null
//   }

async function handleCombined(req, res) {
  stats.combined.received++;

  try {
    let payload = req.body;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); }
      catch(e) {
        stats.combined.rejectedFormat++;
        const snippet = payload.slice(0, 200);
        console.error('[COMBINED] body non e JSON valido:', snippet);
        recordRejection(req, 'invalid_json', { _raw: snippet });
        return res.status(400).json({ ok: false, error: 'invalid_json' });
      }
    }

    if (!TV_WEBHOOK_TOKEN) {
      stats.combined.rejectedAuth++;
      return res.status(500).json({ ok: false, error: 'server_not_configured' });
    }
    if (!payload || !safeTokenCompare(payload.token, TV_WEBHOOK_TOKEN)) {
      stats.combined.rejectedAuth++;
      console.error('[COMBINED] token mismatch');
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const instrument = normalizeInstrument(payload.instrument);
    const timeframe  = payload.timeframe || '';

    // Apply context/structure/liquidity update (always, se presenti)
    let ctxApplied = null, strApplied = null, liqApplied = null;
    if (payload.context)   ctxApplied = applyContext(instrument, payload.context);
    if (payload.structure) strApplied = applyStructure(instrument, payload.structure);
    if (payload.liquidity) liqApplied = applyLiquidity(instrument, payload.liquidity);

    // Audit log
    combinedLog.unshift({
      ts: Date.now(), time: new Date().toISOString(),
      instrument, timeframe,
      hasContext: !!ctxApplied, hasStructure: !!strApplied, hasLiquidity: !!liqApplied,
      hasSignal:  !!(payload.signal),
      hasTradeClose: !!(payload.trade_closed)
    });
    while (combinedLog.length > CONTEXT_LOG_MAX) combinedLog.pop();

    stats.combined.accepted++;

    // Process signal se presente
    let signalResult = null;
    if (payload.signal && typeof payload.signal === 'object') {
      signalResult = await processSignal(req, payload.signal, instrument, timeframe);
    }

    // Process trade_closed se presente
    let tradeCloseResult = null;
    if (payload.trade_closed && typeof payload.trade_closed === 'object') {
      tradeCloseResult = await processTradeClosed(payload.trade_closed, instrument);
    }

    console.log('[COMBINED] ' + instrument + ' TF=' + timeframe +
                ' ctx=' + (!!ctxApplied) + ' str=' + (!!strApplied) + ' liq=' + (!!liqApplied) +
                ' signal=' + (!!signalResult) + ' close=' + (!!tradeCloseResult));

    return res.json({
      ok: true,
      instrument, timeframe,
      applied: { context: !!ctxApplied, structure: !!strApplied, liquidity: !!liqApplied },
      signal: signalResult,
      trade_closed: tradeCloseResult
    });
  } catch(e) {
    console.error('[COMBINED] eccezione:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
app.post('/api/combined', handleCombined);

// Legacy aliases (backward-compatibilità con vecchi alert eventualmente ancora attivi)
app.post('/api/webhook/pine',        handleCombined);
app.post('/api/webhook/tradingview', handleCombined);
app.post('/api/signal',              handleCombined);

// ══════════════════════════════════════════════════════════════════════════════
// CRON: expiry trade aperti > TRADE_EXPIRY_HOURS
// ══════════════════════════════════════════════════════════════════════════════
function expireOldTrades() {
  const cutoff = Date.now() - TRADE_EXPIRY_HOURS * 3600 * 1000;
  let expired = 0;
  for (let i = openTrades.length - 1; i >= 0; i--) {
    const t = openTrades[i];
    if (t.openedAt < cutoff) {
      closedTrades.unshift({
        ...t,
        status: 'EXPIRED',
        closedAt: Date.now(),
        closedTime: new Date().toUTCString().slice(0, 25),
        exitPrice: null, outcome: 'EXPIRED', rMultiple: 0,
        durationMin: Math.round((Date.now() - t.openedAt) / 60000)
      });
      while (closedTrades.length > CLOSED_TRADES_MAX) closedTrades.pop();
      openTrades.splice(i, 1);
      stats.trades.expired++;
      stats.tradeClose.expired++;
      expired++;
      console.log('[TRADE-EXPIRE] #' + t.id + ' ' + t.direction + ' ' + t.instrument);
    }
  }
  if (expired > 0) {
    stats.trades.openNow = openTrades.length;
    const totalClosed = stats.trades.win + stats.trades.loss + stats.trades.expired;
    stats.trades.winRate = totalClosed > 0 ? Math.round(stats.trades.win / totalClosed * 1000) / 10 : 0;
  }
}
setInterval(expireOldTrades, 15 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTICA
// ══════════════════════════════════════════════════════════════════════════════

app.get('/healthz', (req, res) => res.status(200).type('text/plain').send('ok'));

function filtersSummary() {
  return { MIN_SCORE, BLOCK_HIGH_VOL, CONTEXT_FILTER, STRUCTURE_FILTER, LIQUIDITY_FILTER,
           CONTEXT_MAX_AGE_MIN, TRADE_EXPIRY_HOURS };
}

function symbolStatesSnapshot() {
  const out = {};
  for (const [inst, st] of symbolState.entries()) {
    out[inst] = {
      context:   isFresh(st.context)   ? st.context   : null,
      structure: isFresh(st.structure) ? st.structure : null,
      liquidity: isFresh(st.liquidity) ? st.liquidity : null
    };
  }
  return out;
}

app.get('/api/webhook/test', (req, res) => {
  res.json({
    ok: true,
    message: 'Server raggiungibile',
    version: VERSION,
    tokenConfigured:    !!TV_WEBHOOK_TOKEN,
    telegramConfigured: !!(TG_TOKEN && TG_CHAT_ID),
    filters: filtersSummary(),
    stats: { combined: stats.combined, signal: stats.signal, tradeClose: stats.tradeClose },
    symbolsKnown: Array.from(symbolState.keys()),
    recentSignals: signalLog.slice(0, 5)
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: VERSION,
    strategy: { key: STRATEGY_KEY, name: STRATEGY_NAME, allowedTFs: STRATEGY_TFS },
    telegramConnected: !!(TG_TOKEN && TG_CHAT_ID),
    tokenConfigured:   !!TV_WEBHOOK_TOKEN,
    adminProtected:    !!ADMIN_TOKEN,
    filters: filtersSummary(),
    symbols: symbolStatesSnapshot(),
    stats: stats,
    openTrades: openTrades.slice(),
    recentClosed: closedTrades.slice(0, 20),
    signals: signalLog.slice(0, 30)
  });
});

// Per-symbol query
app.get('/api/symbols', (req, res) => {
  res.json({ ok: true, symbols: symbolStatesSnapshot() });
});
app.get('/api/symbols/:instrument', (req, res) => {
  const inst = normalizeInstrument(req.params.instrument);
  const st = symbolState.get(inst);
  if (!st) return res.json({ ok: true, instrument: inst, found: false });
  res.json({
    ok: true, instrument: inst, found: true,
    context:   isFresh(st.context)   ? st.context   : null,
    structure: isFresh(st.structure) ? st.structure : null,
    liquidity: isFresh(st.liquidity) ? st.liquidity : null
  });
});

app.get('/api/trades', (req, res) => {
  res.json({ ok: true, open: openTrades.slice(), closed: closedTrades.slice(), stats: stats.trades });
});

app.get('/api/trades/stats', (req, res) => {
  const byScore = { 3:{w:0,l:0}, 4:{w:0,l:0}, 5:{w:0,l:0} };
  const byDirection = { long:{w:0,l:0}, short:{w:0,l:0} };
  const byInstrument = {};
  for (const t of closedTrades) {
    if (t.status !== 'WIN' && t.status !== 'LOSS') continue;
    const isW = t.status === 'WIN';
    if (byScore[t.score]) byScore[t.score][isW ? 'w' : 'l']++;
    byDirection[t.direction][isW ? 'w' : 'l']++;
    if (!byInstrument[t.instrument]) byInstrument[t.instrument] = { w:0, l:0 };
    byInstrument[t.instrument][isW ? 'w' : 'l']++;
  }
  res.json({ ok: true, totals: stats.trades, byScore, byDirection, byInstrument });
});

app.get('/api/rejected', requireAdmin, (req, res) => {
  res.json({ count: rejectedLog.length, rejected: rejectedLog });
});

app.get('/api/combined/history', requireAdmin, (req, res) => {
  res.json({ count: combinedLog.length, history: combinedLog });
});

app.get('/api/signals', (req, res) => {
  let filtered = signalLog.slice();
  if (req.query.direction)   filtered = filtered.filter(s => s.direction === req.query.direction);
  if (req.query.instrument)  filtered = filtered.filter(s => s.instrument === normalizeInstrument(req.query.instrument));
  const ms = parseInt(req.query.minScore);
  if (!isNaN(ms)) filtered = filtered.filter(s => s.score >= ms);
  res.json({ count: filtered.length, signals: filtered });
});

app.post('/api/test', requireAdmin, async (req, res) => {
  const ok = await tgSend(
    '<b>🧪 ST-EA ' + VERSION + ' · Test</b>\n\n' +
    'Test message OK\n' +
    'Uptime: ' + Math.floor((Date.now() - startTime) / 1000) + 's\n' +
    'Symbols known: ' + symbolState.size + '\n' +
    'Filters: score≥' + MIN_SCORE +
    ' · ctx=' + (CONTEXT_FILTER ? 'on' : 'off') +
    ' · str=' + (STRUCTURE_FILTER ? 'on' : 'off') +
    ' · liq=' + (LIQUIDITY_FILTER ? 'on' : 'off')
  );
  res.json({ ok });
});

app.post('/api/reset', requireAdmin, (req, res) => {
  signalLog = []; rejectedLog = []; combinedLog = [];
  openTrades = []; closedTrades = []; nextTradeId = 1;
  // symbolState: lasciamo gli stati per simbolo (utile)
  stats.totalSignals = 0;
  stats.perInstrument = {};
  stats.perScore = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  stats.perDirection = { long: 0, short: 0 };
  stats.combined  = { received: 0, accepted: 0, rejectedAuth: 0, rejectedFormat: 0 };
  stats.signal    = { received: 0, accepted: 0, filteredScore: 0, filteredVol: 0,
                      filteredContext: 0, filteredStructure: 0, filteredLiquidity: 0,
                      rejectedFormat: 0, telegramFailed: 0 };
  stats.tradeClose= { received: 0, matched: 0, unmatched: 0, expired: 0 };
  stats.trades    = { totalOpened: 0, win: 0, loss: 0, expired: 0, openNow: 0,
                      winRate: 0, avgR: 0, _rSum: 0 };
  res.json({ ok: true, message: 'stats reset' });
});

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════
const server = app.listen(PORT, async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' ST-EA Relay ' + VERSION + '  ·  All-in-One Pine + per-symbol state');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' PORT:                 ' + PORT);
  console.log(' Telegram:             ' + (TG_TOKEN && TG_CHAT_ID ? 'OK' : 'NOT CONFIGURED'));
  console.log(' Webhook token:        ' + (TV_WEBHOOK_TOKEN ? 'OK' : 'NOT CONFIGURED'));
  console.log(' Admin token:          ' + (ADMIN_TOKEN ? 'OK' : 'NOT SET'));
  console.log(' Strategy:             ' + STRATEGY_NAME + ' (' + STRATEGY_TFS.join('m,') + 'm)');
  console.log(' Min score:            ' + MIN_SCORE + '/5');
  console.log(' Block HIGH vol:       ' + BLOCK_HIGH_VOL);
  console.log(' Context filter:       ' + (CONTEXT_FILTER   ? 'ON' : 'OFF'));
  console.log(' Structure filter:     ' + (STRUCTURE_FILTER ? 'ON' : 'OFF'));
  console.log(' Liquidity filter:     ' + (LIQUIDITY_FILTER ? 'ON' : 'OFF'));
  console.log(' Context max age:      ' + CONTEXT_MAX_AGE_MIN + ' min');
  console.log(' Trade expiry:         ' + TRADE_EXPIRY_HOURS + ' h');
  console.log(' Endpoints:');
  console.log('   POST /api/combined      (Pine all-in-one)');
  console.log('   GET  /api/status · /api/symbols · /api/trades · /api/trades/stats');
  console.log('═══════════════════════════════════════════════════════════');

  await tgSend(
    '<b>🚀 ST-EA Relay ' + VERSION + ' online</b>\n\n' +
    '<i>Architecture:</i> 1 Pine all-in-one per simbolo\n' +
    '<i>Strategy:</i> 💥 ' + STRATEGY_NAME + ' (M15/H1)\n\n' +
    '<i>Filters:</i>\n' +
    '• Score ≥ ' + MIN_SCORE + '/5\n' +
    '• Context filter: ' + (CONTEXT_FILTER   ? 'on' : 'off') + '\n' +
    '• Structure filter: ' + (STRUCTURE_FILTER ? 'on' : 'off') + '\n' +
    '• Liquidity filter: ' + (LIQUIDITY_FILTER ? 'on' : 'off') + '\n\n' +
    '<i>Trade tracker:</i> attivo · expiry ' + TRADE_EXPIRY_HOURS + 'h'
  );
});

function shutdown(sig) {
  console.log('[shutdown] ricevuto ' + sig);
  server.close(() => { console.log('[shutdown] exit 0'); process.exit(0); });
  setTimeout(() => { console.error('[shutdown] forced exit'); process.exit(1); }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
