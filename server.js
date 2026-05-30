const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.text({ limit: '10kb', type: 'text/plain' }));
app.use(express.static('public'));

// ══════════════════════════════════════════════════════════════════════════════
// ST-EA Relay v4.2 — All-in-One + Quality Score + TP multi-livello
//
// Novita' v4.2 (backward-compatible con Pine v4.1):
//   - Quality Score 0-100 con grade A/B/C (sostituisce score 1-5)
//   - TP1/TP2/TP3 con position partitioning (1/3 ognuno)
//   - Break-even tracker (SL = entry dopo TP1 hit)
//   - classifyClosedTrade: WIN = TP1 reached, indipendentemente da come ha chiuso
//   - R-multiple calcolato come somma pesata 1/3 × R per ogni TP raggiunto
//   - BE saves (sub-counter delle vittorie chiuse a break-even)
//   - Quality breakdown nel Telegram (mostra perche' il segnale ha quel score)
//   - Backward-compat: se Pine vecchio manda score+tp, server li accetta e mappa
//
// Architettura (invariata da v4.1):
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
//   2. Schema (TF=M15/H1, prezzi coerenti)
//   3. Quality >= MIN_QUALITY (fallback score >= MIN_SCORE se quality mancante)
//   4. Volatility HIGH (se BLOCK_HIGH_VOL)
//   5. Context BLOCK (regime chaos / session block)
//   6. Structure conflict (long vs bias_h1=DOWN)
//   7. Liquidity sweep recente nella direzione del segnale
//
// Tracker: signal -> open trade (tp1/tp2/tp3), trade_closed -> classify + R + Telegram.
// Trade expired automaticamente dopo TRADE_EXPIRY_HOURS.
// ══════════════════════════════════════════════════════════════════════════════

const VERSION          = '4.4.0-multi-strategy';
const PORT             = process.env.PORT             || 3000;
const TG_TOKEN         = process.env.TG_TOKEN         || '';
const TG_CHAT_ID       = process.env.TG_CHAT_ID       || '';
const TV_WEBHOOK_TOKEN = process.env.TV_WEBHOOK_TOKEN || '';
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN      || '';

// ─── Filtri ──────────────────────────────────────────────────────────────────
// MIN_QUALITY (0-100) e' il filtro primario. MIN_SCORE (1-5) e' fallback solo
// per payload Pine v4.1 che non mandano ancora il campo 'quality'.
// Default 55 = grade B e A passano, grade C bloccato.
const MIN_QUALITY_RAW     = parseInt(process.env.MIN_QUALITY, 10);
const MIN_QUALITY         = Number.isFinite(MIN_QUALITY_RAW) ? MIN_QUALITY_RAW : 55;
const MIN_SCORE_RAW       = parseInt(process.env.MIN_SCORE, 10);
const MIN_SCORE           = Number.isFinite(MIN_SCORE_RAW) ? MIN_SCORE_RAW : 4;
const BLOCK_HIGH_VOL      = process.env.BLOCK_HIGH_VOL === 'true';
const CONTEXT_FILTER      = process.env.CONTEXT_FILTER !== 'false';
const STRUCTURE_FILTER    = process.env.STRUCTURE_FILTER !== 'false';
const LIQUIDITY_FILTER    = process.env.LIQUIDITY_FILTER !== 'false';
// Default 300 min (5h): allineato con heartbeat Pine ogni 4h + margine.
// Se troppo basso (es. 60), i simboli appaiono stale per 3h tra un heartbeat e l'altro.
const CONTEXT_MAX_AGE_MIN = parseInt(process.env.CONTEXT_MAX_AGE_MIN || '300', 10);
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
const ALLOWED_OUTCOMES      = ['TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'SL_HIT', 'BE_STOP_OUT', 'FLIP', 'TP_HIT'];
const ALLOWED_GRADES        = ['A', 'B', 'C'];
const CONFIRMATION_DELAY_MS = 800;

// Quality Score thresholds (allineati a Synapse Trail Pro)
const GRADE_A_THRESHOLD = 75;
const GRADE_B_THRESHOLD = 55;

// v4.4: catalogo strategie. breakout_hunter e mean_reversion sono ortogonali.
// Ogni signal ha un campo "strategy" che identifica il sistema che lo ha generato.
// Default = breakout_hunter (per backward compat con payload v4.3 che non mandano strategy).
const ALLOWED_STRATEGIES = ['breakout_hunter', 'mean_reversion'];
const STRATEGY_META = {
  breakout_hunter: { name: 'Breakout Hunter',  emoji: '💥', defaultStrategy: true },
  mean_reversion:  { name: 'Mean Reversion',   emoji: '🌊', defaultStrategy: false }
};

const STRATEGY_KEY  = 'breakout_hunter';  // legacy, manteneduto per /api/status
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
  signal:    { received: 0, accepted: 0, filteredScore: 0, filteredQuality: 0, filteredVol: 0,
               filteredContext: 0, filteredStructure: 0, filteredLiquidity: 0,
               rejectedFormat: 0, telegramFailed: 0 },
  tradeClose:{ received: 0, matched: 0, unmatched: 0, expired: 0 },
  totalSignals: 0,
  perInstrument: {},
  perScore: { 1:0, 2:0, 3:0, 4:0, 5:0 },
  perGrade: { A:0, B:0, C:0 },        // signals tally by grade
  perDirection: { long: 0, short: 0 },
  trades: { totalOpened: 0, win: 0, loss: 0, expired: 0, openNow: 0,
            winRate: 0, avgR: 0, _rSum: 0,
            beSaves: 0,
            tp1Hits: 0, tp2Hits: 0, tp3Hits: 0 },
  // NEW v4.3: stats di CHIUSURA separate per grade.
  // _rSum e' per calcolare avgR. winRate e avgR sono computati on-demand.
  tradesByGrade: {
    A: { win: 0, loss: 0, beSaves: 0, _rSum: 0 },
    B: { win: 0, loss: 0, beSaves: 0, _rSum: 0 },
    C: { win: 0, loss: 0, beSaves: 0, _rSum: 0 }
  },
  // NEW v4.4: stats per strategia (per confronto Breakout vs Mean Reversion).
  // signalsGenerated tracker il count di signal accepted; trades sono win/loss.
  tradesByStrategy: {
    breakout_hunter: { signalsGenerated: 0, win: 0, loss: 0, beSaves: 0, _rSum: 0 },
    mean_reversion:  { signalsGenerated: 0, win: 0, loss: 0, beSaves: 0, _rSum: 0 }
  },
  // NEW v4.3: rolling 7-day buffer per il weekly digest.
  // Ogni trade chiuso aggiunge un record con ts. Il cron filtra per ts > now - 7d.
  closedTrades7d: []   // [{ts, grade, isWin, isBeSave, rMultiple, instrument, direction, strategy}]
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

// ─── Quality Score helpers ───────────────────────────────────────────────────

// Mappa score 1-5 vecchio (Pine v4.1) -> quality 0-100 (Pine v4.2).
// Per backward compatibility quando Pine vecchio manda solo score.
function scoreToQuality(score) {
  const s = Math.max(0, Math.min(5, score | 0));
  // 5→90 (A), 4→70 (B alto), 3→50 (B basso), 2→30 (C), 1→10 (C basso)
  return [0, 10, 30, 50, 70, 90][s];
}

// Calcola grade da quality.
function gradeFromQuality(q) {
  if (!Number.isFinite(q)) return 'C';
  if (q >= GRADE_A_THRESHOLD) return 'A';
  if (q >= GRADE_B_THRESHOLD) return 'B';
  return 'C';
}

// Mappa quality -> emoji per Telegram (visual quick-read)
function gradeEmoji(grade) {
  return grade === 'A' ? '🥇' : grade === 'B' ? '🥈' : '🥉';
}

// ─── classifyClosedTrade ─────────────────────────────────────────────────────
// Logica WIN/LOSS/R-multiple basata sul Pine professionista Synapse Trail Pro.
//
// Regola: TP1 reached = WIN (indipendentemente da come ha chiuso poi).
//         TP1 NON reached = LOSS.
//
// R-multiple (partizione 1/3 ad ogni TP):
//   r1 = (1/3) × tp1Mult se tp1_reached
//   r2 = (1/3) × tp2Mult se tp2_reached
//   r3 = (1/3) × tp3Mult se tp3_reached
//   LOSS: -1R flat
//
// be_active=true alla chiusura SL = BE save (subset di WIN, contatore diagnostico)
//
// Input atteso:
//   trade: { entry, sl, tp1, tp2, tp3, ... }
//   closeData: { outcome, exit_price, tp1_reached, tp2_reached, tp3_reached, be_active, r_multiple? }
//
// Returns: { isWin, isBeSave, rMultiple, label }
function classifyClosedTrade(trade, closeData) {
  const tp1Reached = !!closeData.tp1_reached;
  const tp2Reached = !!closeData.tp2_reached;
  const tp3Reached = !!closeData.tp3_reached;
  const beActive   = !!closeData.be_active;
  const outcome    = String(closeData.outcome || '').toUpperCase();

  // Se Pine ha gia' calcolato R-multiple, usalo (autorita' del Pine sul partitioning)
  const rFromPine = parseFloat(closeData.r_multiple);
  if (Number.isFinite(rFromPine)) {
    const isWin = tp1Reached;
    return {
      isWin,
      isBeSave: isWin && (outcome === 'BE_STOP_OUT' || (outcome === 'SL_HIT' && beActive)),
      rMultiple: Math.round(rFromPine * 100) / 100,
      label: isWin ? 'WIN' : 'LOSS'
    };
  }

  // Altrimenti calcola server-side basandosi su tp*_reached
  // Calcolo i moltiplicatori in R per ogni TP partendo da entry/sl
  const risk = Math.abs(trade.entry - trade.sl);
  if (risk === 0) {
    return { isWin: false, isBeSave: false, rMultiple: 0, label: 'LOSS' };
  }
  const tp1Mult = trade.tp1 ? Math.abs(trade.tp1 - trade.entry) / risk : 0;
  const tp2Mult = trade.tp2 ? Math.abs(trade.tp2 - trade.entry) / risk : 0;
  const tp3Mult = trade.tp3 ? Math.abs(trade.tp3 - trade.entry) / risk : 0;

  let r = 0;
  let isWin = false;
  if (tp1Reached) {
    isWin = true;
    const r1 = (1/3) * tp1Mult;
    const r2 = tp2Reached ? (1/3) * tp2Mult : 0;
    const r3 = tp3Reached ? (1/3) * tp3Mult : 0;
    r = r1 + r2 + r3;
  } else {
    // LOSS: -1R (Pine professional convention)
    r = -1;
  }

  return {
    isWin,
    isBeSave: isWin && (outcome === 'BE_STOP_OUT' || (outcome === 'SL_HIT' && beActive)),
    rMultiple: Math.round(r * 100) / 100,
    label: isWin ? 'WIN' : 'LOSS'
  };
}

// Format percentuale da entry (per Telegram labels)
function pctFromEntry(level, entry) {
  if (!Number.isFinite(level) || !Number.isFinite(entry) || entry === 0) return '';
  const pct = (level - entry) / entry * 100;
  const sign = pct >= 0 ? '+' : '';
  return ' (' + sign + pct.toFixed(2) + '%)';
}

// Format R-multiple da entry/sl per Telegram labels (es. "+1.0R")
function rFromLevel(level, entry, sl, direction) {
  const risk = Math.abs(entry - sl);
  if (risk === 0 || !Number.isFinite(level)) return '';
  const move = direction === 'long' ? (level - entry) : (entry - level);
  const r = move / risk;
  return (r >= 0 ? '+' : '') + r.toFixed(1) + 'R';
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

  // v4.4: strategy field — default "breakout_hunter" per backward compat con Pine v1.8.
  const strategyRaw = String(signal.strategy || 'breakout_hunter').toLowerCase().trim();
  const strategy = ALLOWED_STRATEGIES.includes(strategyRaw) ? strategyRaw : 'breakout_hunter';

  // Direction
  const direction = String(signal.direction || '').toLowerCase().trim();
  if (direction !== 'long' && direction !== 'short') {
    stats.signal.rejectedFormat++;
    recordRejection(req, 'invalid_direction', signal, { got: signal.direction });
    return { ok: false, reason: 'invalid_direction' };
  }

  // Prezzi: entry e SL sempre richiesti
  const price = parseFloat(signal.price);
  const sl    = parseFloat(signal.sl);
  if (!Number.isFinite(price) || !Number.isFinite(sl)) {
    stats.signal.rejectedFormat++;
    recordRejection(req, 'invalid_prices', signal, { parsed: { price, sl } });
    return { ok: false, reason: 'invalid_prices' };
  }

  // TP multi-livello: cerca tp1/tp2/tp3 nel payload v4.2.
  // Fallback v4.1: se manca tp1 ma c'e' 'tp', usalo come tp1 e calcola tp2/tp3 a 2R/3R.
  let tp1 = parseFloat(signal.tp1);
  let tp2 = parseFloat(signal.tp2);
  let tp3 = parseFloat(signal.tp3);
  if (!Number.isFinite(tp1) && Number.isFinite(parseFloat(signal.tp))) {
    // Backward compat: Pine v4.1 manda solo 'tp'
    tp1 = parseFloat(signal.tp);
    // Genera tp2 e tp3 a 2R e 3R (assumendo il vecchio tp era ~2R)
    const risk = Math.abs(price - sl);
    tp2 = direction === 'long' ? price + risk * 2 : price - risk * 2;
    tp3 = direction === 'long' ? price + risk * 3 : price - risk * 3;
  }
  if (!Number.isFinite(tp1)) {
    stats.signal.rejectedFormat++;
    recordRejection(req, 'missing_tp', signal, { parsed: { price, sl, tp1 } });
    return { ok: false, reason: 'missing_tp' };
  }
  if (!Number.isFinite(tp2)) tp2 = tp1;  // se mancano, collapse a tp1
  if (!Number.isFinite(tp3)) tp3 = tp1;

  // Coerenza prezzi
  if (direction === 'long' && (sl >= price || tp1 <= price)) {
    stats.signal.rejectedFormat++;
    recordRejection(req, 'sl_tp_inconsistent', signal, { side: 'long', parsed: { price, sl, tp1 } });
    return { ok: false, reason: 'sl_tp_inconsistent' };
  }
  if (direction === 'short' && (sl <= price || tp1 >= price)) {
    stats.signal.rejectedFormat++;
    recordRejection(req, 'sl_tp_inconsistent', signal, { side: 'short', parsed: { price, sl, tp1 } });
    return { ok: false, reason: 'sl_tp_inconsistent' };
  }

  // ─── Quality Score (v4.2) con fallback su score 1-5 (v4.1) ──────────────────
  const qualityRaw = parseFloat(signal.quality);
  const scoreRaw   = parseFloat(signal.score);
  let quality, score, grade;
  if (Number.isFinite(qualityRaw)) {
    // Pine v4.2: quality e' fornito
    quality = Math.max(0, Math.min(100, Math.round(qualityRaw)));
    score   = Math.round(quality / 20);  // mappa a 1-5 per backward compat dei log
    if (score < 1) score = 1;
    if (score > 5) score = 5;
    // Grade puo' essere fornito dal Pine o ricalcolato
    const gradeRaw = String(signal.grade || '').toUpperCase().trim();
    grade = ALLOWED_GRADES.includes(gradeRaw) ? gradeRaw : gradeFromQuality(quality);
  } else if (Number.isFinite(scoreRaw)) {
    // Pine v4.1: solo score
    score = Math.max(0, Math.min(5, Math.round(scoreRaw)));
    quality = scoreToQuality(score);
    grade = gradeFromQuality(quality);
  } else {
    score = 0;
    quality = 0;
    grade = 'C';
  }

  // Quality breakdown opzionale (per Telegram)
  const breakdown = signal.quality_breakdown && typeof signal.quality_breakdown === 'object'
    ? signal.quality_breakdown : null;

  // Preset informativo
  const preset = String(signal.preset || 'Balanced').slice(0, 32);

  const volatilityRaw = String(signal.volatility || 'NORMAL').toUpperCase().trim();
  const volatility = ALLOWED_VOLATILITY.includes(volatilityRaw) ? volatilityRaw : 'NORMAL';

  // TF
  const tfMin = normalizeTF(timeframe);
  if (tfMin === null || !STRATEGY_TFS.includes(tfMin)) {
    stats.signal.rejectedFormat++;
    recordRejection(req, 'tf_not_allowed', signal, { tf: timeframe, allowed: STRATEGY_TFS });
    return { ok: false, reason: 'tf_not_allowed' };
  }

  // ─── FILTRO PRIMARIO: Quality (v4.2) ────────────────────────────────────────
  // Se Pine manda quality, usa quello. Altrimenti fallback su score (v4.1).
  if (Number.isFinite(qualityRaw)) {
    if (quality < MIN_QUALITY) {
      stats.signal.filteredQuality++;
      recordRejection(req, 'quality_below_minimum', signal, { quality, grade, minQuality: MIN_QUALITY, instrument });
      console.log('[SIGNAL] FILTRATO quality=' + quality + ' grade=' + grade +
                  ' < ' + MIN_QUALITY + ' (' + direction + ' ' + instrument + ')');
      return { ok: true, filtered: true, reason: 'quality_below_minimum' };
    }
  } else {
    // Fallback v4.1: filtro score 1-5
    if (score < MIN_SCORE) {
      stats.signal.filteredScore++;
      recordRejection(req, 'score_below_minimum', signal, { score, minScore: MIN_SCORE, instrument });
      console.log('[SIGNAL] FILTRATO score=' + score + ' < ' + MIN_SCORE + ' (' + direction + ' ' + instrument + ')');
      return { ok: true, filtered: true, reason: 'score_below_minimum' };
    }
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
  // R:R massimo (TP3) per visualizzazione
  const rrMax = Math.abs(price - sl) > 0 ? (Math.abs(tp3 - price) / Math.abs(price - sl)).toFixed(1) : '?';
  const rrTp1 = Math.abs(price - sl) > 0 ? (Math.abs(tp1 - price) / Math.abs(price - sl)).toFixed(1) : '?';
  const ts  = new Date().toUTCString().slice(0, 25);
  const adxN = finiteOrNull(signal.adx);
  const rsiN = finiteOrNull(signal.rsi);
  const atrN = finiteOrNull(signal.atr);
  const htfAligned = isTruthy(signal.htf_aligned);

  // Build Telegram v4.2
  const dirArrow = direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const grEmoji  = gradeEmoji(grade);

  // Breakdown del Quality Score (se fornito dal Pine)
  let breakdownTxt = '';
  if (breakdown) {
    const htfP    = Number.isFinite(parseFloat(breakdown.htf))    ? parseFloat(breakdown.htf)    : null;
    const volP    = Number.isFinite(parseFloat(breakdown.volume)) ? parseFloat(breakdown.volume) : null;
    const rsiP    = Number.isFinite(parseFloat(breakdown.rsi))    ? parseFloat(breakdown.rsi)    : null;
    const regP    = Number.isFinite(parseFloat(breakdown.regime)) ? parseFloat(breakdown.regime) : null;
    const brkP    = Number.isFinite(parseFloat(breakdown.break))  ? parseFloat(breakdown.break)  : null;
    let bdLines = [];
    if (htfP !== null) bdLines.push((htfP >= 25 ? '✅' : htfP >= 10 ? '🔵' : '❌') + ' HTF ' + (htfP === 30 ? 'aligned' : htfP === 0 ? 'against' : 'neutral') + '  +' + htfP.toFixed(0));
    if (volP !== null) bdLines.push((volP >= 15 ? '✅' : '🔵') + ' Volume ' + (volP === 20 ? 'confirmed' : 'off') + '  +' + volP.toFixed(0));
    if (rsiP !== null) bdLines.push((rsiP >= 15 ? '✅' : '❌') + ' RSI momentum  +' + rsiP.toFixed(0));
    if (regP !== null) bdLines.push((regP >= 12 ? '✅' : '🔵') + ' Regime score  +' + regP.toFixed(1));
    if (brkP !== null) bdLines.push((brkP >= 5  ? '✅' : '🔵') + ' Break strength  +' + brkP.toFixed(1));
    if (bdLines.length > 0) {
      breakdownTxt = '\n<b>Score breakdown:</b>\n' + bdLines.map(l => '<code>' + l + '</code>').join('\n') + '\n';
    }
  }

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

  // Header (v4.4: usa strategia per emoji + nome)
  const stratMeta = STRATEGY_META[strategy] || STRATEGY_META.breakout_hunter;
  const headerLine = '<b>' + stratMeta.emoji + ' ' + stratMeta.name + '</b> · ' + dirArrow + ' · ' + grEmoji + ' <b>' + grade + '</b>\n';
  const subLine = '<b>' + instrument + '</b> · M' + tfMin + ' · Quality <b>' + quality + '/100</b>\n\n';

  // Prezzi con R-multiple
  const r1Txt = rFromLevel(tp1, price, sl, direction);
  const r2Txt = rFromLevel(tp2, price, sl, direction);
  const r3Txt = rFromLevel(tp3, price, sl, direction);
  const pricesBlock =
    '<b>Entry:</b> <code>' + price.toFixed(d) + '</code>\n' +
    '<b>SL:</b> <code>' + sl.toFixed(d) + '</code>' + pctFromEntry(sl, price) + '\n' +
    '<b>TP1:</b> <code>' + tp1.toFixed(d) + '</code> (' + r1Txt + ')\n' +
    '<b>TP2:</b> <code>' + tp2.toFixed(d) + '</code> (' + r2Txt + ')\n' +
    '<b>TP3:</b> <code>' + tp3.toFixed(d) + '</code> (' + r3Txt + ')\n';

  const msg =
    headerLine + subLine +
    pricesBlock +
    breakdownTxt +
    '\n' + extras + volWarn + htfBadge + ctxBadge + strBadge + liqBadge +
    '\n<b>Trade #' + tradeId + '</b> · R:R max 1:' + rrMax + ' · Preset: ' + preset +
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
  if (stats.perGrade[grade] !== undefined) stats.perGrade[grade]++;
  stats.perDirection[direction]++;

  // Signal log
  const record = {
    id: tradeId, ts: Date.now(), time: ts,
    instrument, direction, strategy,    // v4.4: includo strategia nel log
    price: +price.toFixed(d), sl: +sl.toFixed(d),
    tp1: +tp1.toFixed(d), tp2: +tp2.toFixed(d), tp3: +tp3.toFixed(d),
    rrTp1: parseFloat(rrTp1) || 0, rrMax: parseFloat(rrMax) || 0,
    quality, grade, score, preset,
    volatility, timeframe,
    adx: adxN, rsi: rsiN, atr: atrN, htfAligned,
    context:   isFresh(state.context)   ? { regime: state.context.regime, session: state.context.session, verdict: state.context.verdict } : null,
    structure: isFresh(state.structure) ? { bias_h1: state.structure.bias_h1, bias_h4: state.structure.bias_h4 } : null,
    liquidity: isFresh(state.liquidity) ? { sweep: state.liquidity.sweep, long_fuel: state.liquidity.long_fuel_pct, short_fuel: state.liquidity.short_fuel_pct } : null
  };
  signalLog.unshift(record);
  while (signalLog.length > SIGNAL_LOG_MAX) signalLog.pop();

  // Tracker open trade v4.2 (con tp1/tp2/tp3)
  openTrades.push({
    id: tradeId, openedAt: Date.now(), openedTime: ts,
    instrument, direction, strategy,    // v4.4
    entry: +price.toFixed(d), sl: +sl.toFixed(d),
    tp1: +tp1.toFixed(d), tp2: +tp2.toFixed(d), tp3: +tp3.toFixed(d),
    quality, grade, score, preset,
    timeframe, status: 'OPEN'
  });
  stats.trades.openNow = openTrades.length;
  stats.trades.totalOpened++;

  // v4.4: incrementa counter per strategia
  if (stats.tradesByStrategy[strategy]) {
    stats.tradesByStrategy[strategy].signalsGenerated++;
  }

  console.log('[SIGNAL OK] #' + tradeId + ' ' + strategy + ' ' + direction.toUpperCase() + ' ' + instrument +
              ' @ ' + price.toFixed(d) + ' quality=' + quality + ' grade=' + grade);

  if (SEND_CONFIRMATION) {
    setTimeout(() => {
      tgSend('✅ <i>Trade #' + tradeId + ' aperto</i> · ' +
             (direction === 'long' ? '🟢' : '🔴') + ' ' + instrument + ' · ' + grade)
        .catch(e => console.error('[TG confirm]', e.message));
    }, CONFIRMATION_DELAY_MS);
  }

  return { ok: true, accepted: true, tradeId, quality, grade };
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
  // v4.2: accetta tutti i nuovi outcome. Backward compat con TP_HIT/SL_HIT.
  if (!ALLOWED_OUTCOMES.includes(outcome)) {
    return { ok: false, reason: 'invalid_outcome', got: outcome };
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
  const durationMin = Math.round((Date.now() - t.openedAt) / 60000);
  const d = dec(t.entry);

  // Classify usando logica centralizzata (Pine Synapse Trail Pro pattern)
  // Backward compat: se Pine vecchio manda TP_HIT, assume tp1_reached=true
  const closeData = {
    outcome,
    exit_price: exitPrice,
    tp1_reached: outcome === 'TP_HIT' || !!tc.tp1_reached || outcome === 'TP1_HIT' || outcome === 'TP2_HIT' || outcome === 'TP3_HIT',
    tp2_reached: !!tc.tp2_reached || outcome === 'TP2_HIT' || outcome === 'TP3_HIT',
    tp3_reached: !!tc.tp3_reached || outcome === 'TP3_HIT',
    be_active:   !!tc.be_active   || outcome === 'BE_STOP_OUT',
    r_multiple:  tc.r_multiple
  };

  // Trade in legacy format (con solo .tp): converti per classifyClosedTrade
  const tradeForClassify = {
    entry: t.entry,
    sl: t.sl,
    tp1: t.tp1 != null ? t.tp1 : t.tp,
    tp2: t.tp2 != null ? t.tp2 : t.tp,
    tp3: t.tp3 != null ? t.tp3 : t.tp
  };

  const cls = classifyClosedTrade(tradeForClassify, closeData);
  const r = cls.rMultiple;
  const isWin = cls.isWin;
  const isBeSave = cls.isBeSave;

  // Counter per-TP
  if (closeData.tp1_reached) stats.trades.tp1Hits++;
  if (closeData.tp2_reached) stats.trades.tp2Hits++;
  if (closeData.tp3_reached) stats.trades.tp3Hits++;

  const closed = {
    ...t,
    status: cls.label,
    closedAt: Date.now(),
    closedTime: new Date().toUTCString().slice(0, 25),
    exitPrice: +exitPrice.toFixed(d),
    outcome,
    tp1_reached: closeData.tp1_reached,
    tp2_reached: closeData.tp2_reached,
    tp3_reached: closeData.tp3_reached,
    be_active: closeData.be_active,
    be_save: isBeSave,
    rMultiple: r,
    durationMin
  };
  openTrades.splice(idx, 1);
  closedTrades.unshift(closed);
  while (closedTrades.length > CLOSED_TRADES_MAX) closedTrades.pop();

  if (isWin) {
    stats.trades.win++;
    if (isBeSave) stats.trades.beSaves++;
  } else {
    stats.trades.loss++;
  }
  stats.trades._rSum += r;
  stats.trades.openNow = openTrades.length;
  const totalClosed = stats.trades.win + stats.trades.loss + stats.trades.expired;
  stats.trades.winRate = totalClosed > 0 ? Math.round(stats.trades.win / totalClosed * 1000) / 10 : 0;
  stats.trades.avgR    = totalClosed > 0 ? Math.round(stats.trades._rSum / totalClosed * 100) / 100 : 0;
  stats.tradeClose.matched++;

  // NEW v4.3: Stats per-grade — usa grade salvato sull'open trade.
  // Se trade aperto senza grade (legacy), defaulta a "C" per non perdere i dati.
  const tradeGrade = (t.grade && stats.tradesByGrade[t.grade]) ? t.grade : 'C';
  const gradeStats = stats.tradesByGrade[tradeGrade];
  if (isWin) {
    gradeStats.win++;
    if (isBeSave) gradeStats.beSaves++;
  } else {
    gradeStats.loss++;
  }
  gradeStats._rSum += r;

  // NEW v4.4: Stats per-strategy — usa strategy salvata sull'open trade.
  // Trade legacy senza strategy → defaulta a 'breakout_hunter'.
  const tradeStrategy = (t.strategy && stats.tradesByStrategy[t.strategy]) ? t.strategy : 'breakout_hunter';
  const strategyStats = stats.tradesByStrategy[tradeStrategy];
  if (isWin) {
    strategyStats.win++;
    if (isBeSave) strategyStats.beSaves++;
  } else {
    strategyStats.loss++;
  }
  strategyStats._rSum += r;

  // NEW v4.3: aggiungi al rolling 7d buffer (per weekly digest)
  stats.closedTrades7d.push({
    ts: Date.now(),
    grade: tradeGrade,
    strategy: tradeStrategy,    // v4.4
    isWin, isBeSave,
    rMultiple: r,
    instrument: t.instrument,
    direction: t.direction,
    outcome
  });
  // Pruning: mantieni solo gli ultimi 7 giorni (con margine: 8 giorni)
  const cutoff8d = Date.now() - 8 * 24 * 60 * 60 * 1000;
  stats.closedTrades7d = stats.closedTrades7d.filter(x => x.ts >= cutoff8d);

  // ─── Build Telegram message v4.2 ────────────────────────────────────────────
  let emoji, label;
  if (isWin) {
    emoji = isBeSave ? '🛡️' : (closeData.tp3_reached ? '🏆' : '✅');
    label = isBeSave ? 'BE SAVE' : (closeData.tp3_reached ? 'TP3 WIN' : closeData.tp2_reached ? 'TP2 WIN' : 'TP1 WIN');
  } else {
    emoji = '❌';
    label = outcome === 'FLIP' ? 'FLIP LOSS' : 'LOSS';
  }
  const rTxt   = (r >= 0 ? '+' : '') + r.toFixed(2) + 'R';
  const durTxt = durationMin < 60 ? durationMin + 'm' : Math.round(durationMin / 6) / 10 + 'h';

  // Build "TP progress" string
  let tpProgress = '';
  if (isWin) {
    const ticks = [];
    if (closeData.tp1_reached) ticks.push('TP1 ✓');
    if (closeData.tp2_reached) ticks.push('TP2 ✓');
    if (closeData.tp3_reached) ticks.push('TP3 ✓');
    tpProgress = '\n<i>' + ticks.join(' · ') + '</i>';
  }

  const gradeLine = t.grade ? ' · <b>' + t.grade + '</b>' : '';
  const stratEmoji = (STRATEGY_META[tradeStrategy] || STRATEGY_META.breakout_hunter).emoji;

  await tgSend(
    emoji + ' <b>Trade #' + t.id + ' ' + label + '</b> · ' + stratEmoji + '\n' +
    '<b>' + instrument + '</b> · ' + (direction === 'long' ? '🟢 LONG' : '🔴 SHORT') + gradeLine + '\n' +
    'Entry: <code>' + t.entry.toFixed(d) + '</code> → Exit: <code>' + exitPrice.toFixed(d) + '</code>\n' +
    '<b>Result:</b> ' + rTxt + ' · <b>Durata:</b> ' + durTxt +
    tpProgress +
    '\n<i>Win rate: ' + stats.trades.winRate + '% · Avg R: ' + stats.trades.avgR +
    (stats.trades.beSaves > 0 ? ' · BE saves: ' + stats.trades.beSaves : '') + '</i>'
  );

  console.log('[TRADE-CLOSE] #' + t.id + ' ' + tradeStrategy + ' ' + cls.label + ' ' + rTxt + ' (' + durTxt + ') outcome=' + outcome);
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

// ──────────────────────────────────────────────────────────────────────────────
// WEEKLY DIGEST (v4.3)
// Ogni domenica alle 22:00 UTC manda un riassunto settimanale via Telegram.
// Implementazione: setInterval di 1 minuto + check se "domenica 22:00 UTC esatto".
// Per evitare double-send, ricordiamo l'ultimo timestamp inviato.
// ──────────────────────────────────────────────────────────────────────────────

let lastWeeklyDigestTs = 0;

async function sendWeeklyDigest() {
  const d = buildWeeklyDigestData();
  const lines = [];
  lines.push('<b>📊 ST-EA · Report settimanale</b>');
  lines.push('<i>Ultimi 7 giorni · ' + new Date().toUTCString().slice(0, 16) + '</i>');
  lines.push('');
  if (d.total7 === 0) {
    lines.push('<i>Nessun trade chiuso questa settimana.</i>');
    lines.push('Possibili cause: mercati lateral, filtri stretti, festivita\'.');
  } else {
    lines.push('<b>Totale chiusi:</b> ' + d.total7 + ' (' + d.wins7 + 'W · ' + d.losses7 + 'L)');
    lines.push('<b>Win rate:</b> ' + d.winRate7 + '%');
    lines.push('<b>Avg R:</b> ' + (d.avgR7 >= 0 ? '+' : '') + d.avgR7.toFixed(2) + 'R');
    if (d.beSaves7 > 0) lines.push('<b>BE saves:</b> ' + d.beSaves7);
    lines.push('');
    // Per-grade breakdown
    lines.push('<b>Per grade:</b>');
    for (const g of ['A', 'B', 'C']) {
      const gs = d.grade7[g];
      const tot = gs.w + gs.l;
      if (tot > 0) {
        const wr = Math.round(gs.w / tot * 1000) / 10;
        const ar = Math.round(gs.r / tot * 100) / 100;
        const emoji = g === 'A' ? '🥇' : g === 'B' ? '🥈' : '🥉';
        lines.push('  ' + emoji + ' ' + g + ': ' + gs.w + 'W ' + gs.l + 'L · ' + wr + '% · ' + (ar >= 0 ? '+' : '') + ar.toFixed(2) + 'R');
      }
    }
    // Top simboli
    const symEntries = Object.entries(d.sym7)
      .filter(([_, s]) => (s.w + s.l) > 0)
      .sort((a, b) => (b[1].r) - (a[1].r))
      .slice(0, 5);
    if (symEntries.length > 0) {
      lines.push('');
      lines.push('<b>Top simboli (per R cumulativo):</b>');
      for (const [sym, s] of symEntries) {
        const ar = Math.round(s.r * 100) / 100;
        lines.push('  ' + sym + ': ' + s.w + 'W ' + s.l + 'L · ' + (ar >= 0 ? '+' : '') + ar.toFixed(2) + 'R');
      }
    }
    lines.push('');
    // Interpretazione automatica
    if (d.avgR7 >= 0.5 && d.winRate7 >= 50) {
      lines.push('✅ <i>Sistema in profitto, continua cosi\'.</i>');
    } else if (d.avgR7 < -0.3 && d.total7 >= 5) {
      lines.push('⚠️ <i>Avg R negativo: rivedere filtri o preset.</i>');
    } else if (d.total7 < 3) {
      lines.push('ℹ️ <i>Pochi trade: dati insufficienti per valutare.</i>');
    } else {
      lines.push('🔄 <i>Performance neutra, continua a raccogliere dati.</i>');
    }
  }
  lines.push('');
  lines.push('<i>Cumulativo dall\'avvio: W/L ' + stats.trades.win + '/' + stats.trades.loss + ' · WR ' + stats.trades.winRate + '% · AvgR ' + (stats.trades.avgR >= 0 ? '+' : '') + stats.trades.avgR.toFixed(2) + 'R</i>');

  await tgSend(lines.join('\n'));
  lastWeeklyDigestTs = Date.now();
  console.log('[WEEKLY-DIGEST] inviato, total7=' + d.total7);
}

// Check ogni minuto se e' tempo del weekly digest.
// Trigger: domenica (getUTCDay()==0) alle 22:00 UTC (sweet-spot fine settimana,
// prima del riapertura mercati). Cooldown 23h per evitare doppi invii.
function weeklyDigestTick() {
  const now = new Date();
  const isSunday22UTC = now.getUTCDay() === 0 && now.getUTCHours() === 22 && now.getUTCMinutes() === 0;
  const sinceLast = Date.now() - lastWeeklyDigestTs;
  if (isSunday22UTC && sinceLast > 23 * 60 * 60 * 1000) {
    sendWeeklyDigest().catch(e => console.error('[WEEKLY-DIGEST]', e.message));
  }
}
setInterval(weeklyDigestTick, 60 * 1000);

// Endpoint manuale per triggerare il digest a richiesta (utile per testing)
app.post('/api/digest/send', requireAdmin, async (req, res) => {
  try {
    await sendWeeklyDigest();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTICA
// ══════════════════════════════════════════════════════════════════════════════

app.get('/healthz', (req, res) => res.status(200).type('text/plain').send('ok'));

function filtersSummary() {
  return { MIN_QUALITY, MIN_SCORE, BLOCK_HIGH_VOL, CONTEXT_FILTER, STRUCTURE_FILTER, LIQUIDITY_FILTER,
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

// NEW v4.3: stats di performance separate per grade A/B/C.
// Risponde alla domanda chiave "il grade A vale davvero piu' del B?".
app.get('/api/stats/by-grade', (req, res) => {
  const result = {};
  for (const g of ['A', 'B', 'C']) {
    const s = stats.tradesByGrade[g];
    const total = s.win + s.loss;
    result[g] = {
      win: s.win,
      loss: s.loss,
      beSaves: s.beSaves,
      total,
      winRate: total > 0 ? Math.round(s.win / total * 1000) / 10 : 0,
      avgR:    total > 0 ? Math.round(s._rSum / total * 100) / 100 : 0,
      signalsGenerated: stats.perGrade[g]
    };
  }
  res.json({
    ok: true,
    byGrade: result,
    interpretation: {
      A: result.A.total >= 5 ? (result.A.winRate >= 60 ? 'STRONG' : result.A.winRate >= 45 ? 'OK' : 'WEAK') : 'NEED_MORE_DATA',
      B: result.B.total >= 10 ? (result.B.winRate >= 55 ? 'STRONG' : result.B.winRate >= 40 ? 'OK' : 'WEAK') : 'NEED_MORE_DATA',
      C: result.C.total >= 10 ? (result.C.winRate >= 50 ? 'STRONG' : result.C.winRate >= 35 ? 'OK' : 'WEAK') : 'NEED_MORE_DATA'
    },
    note: 'Per giudicare la validita\' statistica servono almeno 10-15 trade chiusi per grade'
  });
});

// v4.4: stats per strategia (per confronto Breakout vs Mean Reversion)
app.get('/api/stats/by-strategy', (req, res) => {
  const result = {};
  for (const k of ALLOWED_STRATEGIES) {
    const s = stats.tradesByStrategy[k];
    const total = s.win + s.loss;
    result[k] = {
      name: STRATEGY_META[k].name,
      emoji: STRATEGY_META[k].emoji,
      signalsGenerated: s.signalsGenerated,
      win: s.win,
      loss: s.loss,
      beSaves: s.beSaves,
      total,
      winRate: total > 0 ? Math.round(s.win / total * 1000) / 10 : 0,
      avgR:    total > 0 ? Math.round(s._rSum / total * 100) / 100 : 0
    };
  }
  res.json({ ok: true, byStrategy: result,
    note: 'Per confronto Breakout vs Mean Reversion. Servono 10+ trade per strategia per giudicare.' });
});

// NEW v4.3: digest delle ultime 7 days, on-demand.
// Anche usato dal cron weekly per il Telegram digest.
function buildWeeklyDigestData() {
  const now = Date.now();
  const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;
  const last7d = stats.closedTrades7d.filter(x => x.ts >= cutoff7d);
  const total7 = last7d.length;
  const wins7  = last7d.filter(x => x.isWin).length;
  const losses7= total7 - wins7;
  const beSaves7 = last7d.filter(x => x.isBeSave).length;
  const rSum7 = last7d.reduce((a, x) => a + (x.rMultiple || 0), 0);
  const winRate7 = total7 > 0 ? Math.round(wins7 / total7 * 1000) / 10 : 0;
  const avgR7    = total7 > 0 ? Math.round(rSum7 / total7 * 100) / 100 : 0;
  // Per-grade nelle ultime 7d
  const grade7 = { A: {w:0, l:0, r:0}, B: {w:0, l:0, r:0}, C: {w:0, l:0, r:0} };
  // Per-symbol nelle ultime 7d
  const sym7 = {};
  for (const x of last7d) {
    const g = grade7[x.grade] || grade7.C;
    if (x.isWin) g.w++; else g.l++;
    g.r += (x.rMultiple || 0);
    if (!sym7[x.instrument]) sym7[x.instrument] = { w:0, l:0, r:0 };
    if (x.isWin) sym7[x.instrument].w++; else sym7[x.instrument].l++;
    sym7[x.instrument].r += (x.rMultiple || 0);
  }
  return { total7, wins7, losses7, beSaves7, winRate7, avgR7, grade7, sym7 };
}

app.get('/api/stats/weekly', (req, res) => {
  res.json({ ok: true, ...buildWeeklyDigestData() });
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
    'Filters: quality≥' + MIN_QUALITY + ' (fallback score≥' + MIN_SCORE + ')' +
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
  console.log(' Min quality:          ' + MIN_QUALITY + '/100 (grade ' + gradeFromQuality(MIN_QUALITY) + '+)');
  console.log(' Min score (fallback): ' + MIN_SCORE + '/5');
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
    '<i>Strategy:</i> 💥 ' + STRATEGY_NAME + ' (M15/H1)\n' +
    '<i>Risk:</i> TP1/TP2/TP3 con BE auto · Quality 0-100\n\n' +
    '<i>Filters:</i>\n' +
    '• Quality ≥ ' + MIN_QUALITY + '/100 (grade ' + gradeFromQuality(MIN_QUALITY) + '+)\n' +
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
