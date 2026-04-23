const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ══════════════════════════════════════════════════════════════════════════════
// ST-EA Server v3 — Triplo SuperTrend Minimal
//
// Allineato all'indicator Pine ST-EA_M15_Indicator:
//   - Triplo SuperTrend (2.0/7, 3.0/14, 4.5/21) con flip 3/3 stretto
//   - Filtro ADX minimo (default 10)
//   - SL/TP suggeriti per contesto nella notifica Telegram
//   - Niente RSI, MACD, session, H1/H4, order blocks, FVG, pattern D1
//
// La logica e intenzionalmente semplice per ridurre falsi segnali dovuti
// a filtri troppo complessi che non avevano dimostrato utilita nei backtest.
// ══════════════════════════════════════════════════════════════════════════════

const PORT        = process.env.PORT       || 3000;
const TG_TOKEN    = process.env.TG_TOKEN   || '';
const TG_CHAT_ID  = process.env.TG_CHAT_ID || '';
const TD_KEY      = process.env.TD_KEY     || '';
const RENDER_URL  = process.env.RENDER_URL || '';

// ══════════════════════════════════════
// CONFIGURAZIONE SIMBOLI
// ══════════════════════════════════════
const CRYPTO = ['BTCUSD','ETHUSD','SOLUSD','XRPUSD','BNBUSD','ADAUSD'];
const METALS = ['XAUUSD','XAGUSD','WTIUSD','BRNUSD','USOIL','UKOIL'];
const FOREX  = ['EURUSD','GBPUSD','USDJPY','GBPJPY','AUDUSD','USDCAD','USDCHF','NZDUSD'];

// Configurazione per-simbolo: SL mult e ADX min ottimizzati per asset class.
// Questi valori riflettono le conclusioni dei test: niente RSI/MACD/session,
// solo SuperTrend flip + filtro ADX + risk management adeguato alla volatilita.
const SYMBOL_CONFIG = {
  // Metalli — volatili, SL largo, ADX moderato
  XAUUSD: { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: false },
  XAGUSD: { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: false },
  WTIUSD: { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  BRNUSD: { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  USOIL:  { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  UKOIL:  { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  // Forex — volatilita media, SL piu stretto
  EURUSD: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  GBPUSD: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  USDJPY: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  GBPJPY: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  AUDUSD: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  USDCAD: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  USDCHF: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  NZDUSD: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  // Crypto — volatilita alta, SL largo, ADX piu alto
  BTCUSD: { slMult: 2.0, rr: 2.0, adxMin: 15, allowLong: true, allowShort: true  },
  ETHUSD: { slMult: 2.0, rr: 2.0, adxMin: 15, allowLong: true, allowShort: true  },
  SOLUSD: { slMult: 2.0, rr: 2.0, adxMin: 15, allowLong: true, allowShort: true  },
  XRPUSD: { slMult: 2.0, rr: 2.0, adxMin: 15, allowLong: true, allowShort: true  },
  BNBUSD: { slMult: 2.0, rr: 2.0, adxMin: 15, allowLong: true, allowShort: true  }
};

function getConfig(sym) {
  return SYMBOL_CONFIG[sym] || { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true };
}

const YAHOO_MAP = {
  XAUUSD:'GC=F', XAGUSD:'SI=F',
  WTIUSD:'CL=F', BRNUSD:'BZ=F', USOIL:'CL=F', UKOIL:'BZ=F',
  EURUSD:'EURUSD=X', GBPUSD:'GBPUSD=X', USDJPY:'USDJPY=X',
  GBPJPY:'GBPJPY=X', AUDUSD:'AUDUSD=X', USDCAD:'USDCAD=X',
  USDCHF:'USDCHF=X', NZDUSD:'NZDUSD=X'
};

const TD_MAP = {
  EURUSD:'EUR/USD', GBPUSD:'GBP/USD', USDJPY:'USD/JPY',
  GBPJPY:'GBP/JPY', AUDUSD:'AUD/USD', USDCAD:'USD/CAD',
  USDCHF:'USD/CHF', NZDUSD:'NZD/USD',
  XAUUSD:'XAU/USD', XAGUSD:'XAG/USD',
  USOIL:'WTI/USD', UKOIL:'BRENT/USD', WTIUSD:'WTI/USD', BRNUSD:'BRENT/USD'
};

const PRICE_RANGES = {
  BTCUSD:[20000,200000], ETHUSD:[500,20000], SOLUSD:[10,1000],
  XRPUSD:[0.1,100], BNBUSD:[100,5000],
  XAUUSD:[1000,8000], XAGUSD:[10,100],
  WTIUSD:[40,150], BRNUSD:[40,150], USOIL:[40,150], UKOIL:[40,150],
  EURUSD:[0.8,1.6], GBPUSD:[0.9,1.8], USDJPY:[80,200],
  GBPJPY:[100,250], AUDUSD:[0.5,1.1], USDCAD:[1.0,1.8],
  USDCHF:[0.7,1.3], NZDUSD:[0.4,1.0]
};

const PIP_VALUE = {
  EURUSD:10, GBPUSD:10, USDJPY:10, GBPJPY:10,
  AUDUSD:10, USDCAD:10, USDCHF:10, NZDUSD:10,
  XAUUSD:1, XAGUSD:1,
  BTCUSD:100, ETHUSD:10, SOLUSD:1, XRPUSD:1
};

const SYMBOL_NAMES = {
  XAUUSD:'Oro', XAGUSD:'Argento',
  EURUSD:'Euro/Dollaro', GBPUSD:'Sterlina/Dollaro',
  USDJPY:'Dollaro/Yen', GBPJPY:'Sterlina/Yen',
  AUDUSD:'Aussie/Dollaro', USDCAD:'Dollaro/Cad',
  BTCUSD:'Bitcoin', ETHUSD:'Ethereum', SOLUSD:'Solana',
  WTIUSD:'Petrolio WTI', BRNUSD:'Petrolio Brent',
  USOIL:'Petrolio WTI', UKOIL:'Petrolio Brent'
};

function isValidPrice(sym, price) {
  var r = PRICE_RANGES[sym];
  return r ? price >= r[0] && price <= r[1] : true;
}

// ══════════════════════════════════════
// STATO GLOBALE
// ══════════════════════════════════════
var ENV_SYMBOLS  = process.env.DEFAULT_SYMBOLS ? process.env.DEFAULT_SYMBOLS.split(',').map(function(s){return s.trim();}) : null;
var ENV_REFRESH  = parseInt(process.env.REFRESH_SEC) || 300;
var ENV_COOLDOWN = parseInt(process.env.COOLDOWN_MIN) || 15;

const DEFAULT_SYMBOLS = ENV_SYMBOLS || ['XAUUSD','EURUSD','BTCUSD'];

var isRunning     = false;
var activeSymbols = DEFAULT_SYMBOLS.slice();
var refreshTimer  = null;
var globalStats   = { total: 0, buys: 0, sells: 0 };
var lastLoopTime  = 0;
var globalLog     = [];
var symbolState   = {};

function initSymbol(s) {
  symbolState[s] = {
    candles: [],
    lastDir: null,
    lastSignalTime: 0,
    stats: { total: 0, buys: 0, sells: 0, lastSignal: '--', lastFilter: '--' },
    log: []
  };
}
DEFAULT_SYMBOLS.forEach(initSymbol);

// ══════════════════════════════════════
// INDICATORI TECNICI
// ══════════════════════════════════════
function calcATR(c, p) {
  var t = [];
  for (var i = 1; i < c.length; i++)
    t.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close)));
  var a = [t[0]];
  for (var j = 1; j < t.length; j++) a.push((a[j-1] * (p-1) + t[j]) / p);
  return a;
}

// SuperTrend: ritorna array di { dir: +1/-1, line: number } per ogni candela.
// dir = +1 quando il prezzo e sopra la banda inferiore (bullish)
// dir = -1 quando il prezzo e sotto la banda superiore (bearish)
function calcST(c, period, mult) {
  var atrs = calcATR(c, period);
  var res = [], dir = 1, pu = 0, pl = 0;
  for (var i = 1; i < c.length; i++) {
    var atr = atrs[i-1] || atrs[0];
    var hl2 = (c[i].high + c[i].low) / 2;
    var u = hl2 + mult * atr;
    var l = hl2 - mult * atr;
    if (i > 1) {
      u = (u < pu || c[i-1].close > pu) ? u : pu;
      l = (l > pl || c[i-1].close < pl) ? l : pl;
    }
    var cl = c[i].close;
    if (dir === 1 && cl < l) dir = -1;
    else if (dir === -1 && cl > u) dir = 1;
    res.push({ dir: dir, line: dir === 1 ? l : u, atr: atr });
    pu = u;
    pl = l;
  }
  return res;
}

// ADX: misura la forza del trend (non la direzione). Sopra 25 = trend forte.
function calcADX(c, period) {
  period = period || 14;
  if (c.length < period * 2) return 0;
  var trArr = [], plusDM = [], minusDM = [];
  for (var i = 1; i < c.length; i++) {
    var tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close));
    var upMove = c[i].high - c[i-1].high;
    var downMove = c[i-1].low - c[i].low;
    trArr.push(tr);
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  var smoothTR = trArr.slice(0, period).reduce(function(a,b){return a+b;}, 0);
  var smoothPlus = plusDM.slice(0, period).reduce(function(a,b){return a+b;}, 0);
  var smoothMinus = minusDM.slice(0, period).reduce(function(a,b){return a+b;}, 0);
  var dxArr = [];
  for (var j = period; j < trArr.length; j++) {
    smoothTR = smoothTR - smoothTR/period + trArr[j];
    smoothPlus = smoothPlus - smoothPlus/period + plusDM[j];
    smoothMinus = smoothMinus - smoothMinus/period + minusDM[j];
    var plusDI = smoothTR > 0 ? (smoothPlus / smoothTR) * 100 : 0;
    var minusDI = smoothTR > 0 ? (smoothMinus / smoothTR) * 100 : 0;
    var diSum = plusDI + minusDI;
    dxArr.push(diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0);
  }
  if (!dxArr.length) return 0;
  return dxArr.slice(-period).reduce(function(a,b){return a+b;}, 0) / Math.min(period, dxArr.length);
}

// Lot size calculator (mantenuto per compatibilita con la dashboard)
function calcLotSize(sym, balance, riskPct, slDist) {
  var riskAmt = balance * (riskPct / 100);
  var pipVal = PIP_VALUE[sym] || 10;
  var dec = slDist > 10 ? 2 : slDist > 1 ? 4 : 5;
  var pips = dec === 2 ? slDist : slDist / (dec === 4 ? 0.0001 : 0.00001);
  var lot = riskAmt / (pips * pipVal * 100);
  return Math.min(10, Math.max(0.01, Math.round(lot * 100) / 100));
}

// ══════════════════════════════════════
// ORARI DI MERCATO
// ══════════════════════════════════════
function getNYTime() {
  var nyStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  var ny = new Date(nyStr);
  return { day: ny.getDay(), time: ny.getHours() * 100 + ny.getMinutes() };
}

function isMarketOpen(sym) {
  if (CRYPTO.indexOf(sym) !== -1) return true;
  var ny = getNYTime();
  if (ny.day === 6) return false;                   // sabato chiuso
  if (ny.day === 0 && ny.time < 1700) return false; // dom prima delle 17:00
  if (ny.day === 5 && ny.time >= 1700) return false;// ven dopo le 17:00
  return true;
}

function getMarketStatus(sym) {
  return isMarketOpen(sym) ? null : 'Mercato chiuso (weekend)';
}

// ══════════════════════════════════════
// FETCH DATI (Yahoo, OKX, TwelveData)
// ══════════════════════════════════════
async function fetchOKX(sym, bar, limit, target, st) {
  try {
    var pair = sym.replace('USD', '-USDT');
    var url = 'https://www.okx.com/api/v5/market/candles?instId=' + pair + '&bar=' + bar + '&limit=' + limit;
    var res = await fetch(url);
    var data = await res.json();
    if (data.code === '0' && Array.isArray(data.data) && data.data.length > 10) {
      var p = data.data.reverse().map(function(k) {
        return { open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5] };
      });
      if (isValidPrice(sym, p[p.length-1].close)) { st[target] = p; return true; }
    }
  } catch(e) {}
  return false;
}

async function fetchYahoo(sym, interval, range, target, st) {
  try {
    var ticker = YAHOO_MAP[sym];
    if (!ticker) return false;
    var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
              '?interval=' + interval + '&range=' + range + '&includePrePost=false';
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    var data = await res.json();
    var chart = data && data.chart && data.chart.result && data.chart.result[0];
    if (!chart || !chart.timestamp) return false;
    var q = chart.indicators.quote[0];
    var parsed = [];
    for (var i = 0; i < chart.timestamp.length; i++) {
      if (q.open[i] && q.high[i] && q.low[i] && q.close[i]) {
        parsed.push({
          open: +q.open[i].toFixed(5),
          high: +q.high[i].toFixed(5),
          low: +q.low[i].toFixed(5),
          close: +q.close[i].toFixed(5),
          vol: q.volume[i] || 0
        });
      }
    }
    if (parsed.length < 10) return false;
    if (sym === 'XAGUSD' && parsed[parsed.length-1].close > 100) {
      parsed = parsed.map(function(c) {
        return { open: c.open/100, high: c.high/100, low: c.low/100, close: c.close/100, vol: c.vol };
      });
    }
    if (!isValidPrice(sym, parsed[parsed.length-1].close)) return false;
    st[target] = parsed;
    return true;
  } catch(e) { return false; }
}

async function fetchTD(sym, interval, outputsize, target, st) {
  if (!TD_KEY) return false;
  try {
    var mapped = TD_MAP[sym] || sym;
    var url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(mapped) +
              '&interval=' + interval + '&outputsize=' + outputsize + '&apikey=' + TD_KEY;
    var res = await fetch(url);
    var data = await res.json();
    if (data.status === 'error') return false;
    var parsed = data.values.reverse().map(function(c) {
      return { open: +c.open, high: +c.high, low: +c.low, close: +c.close, vol: +(c.volume || 0) };
    });
    if (!parsed.length || !isValidPrice(sym, parsed[parsed.length-1].close)) return false;
    st[target] = parsed;
    return true;
  } catch(e) { return false; }
}

async function fetchCandles(sym) {
  var st = symbolState[sym];
  if (!st) return;
  if (CRYPTO.indexOf(sym) !== -1) {
    // Crypto: OKX e' eccellente e gratuito, restiamo qui
    await fetchOKX(sym, '15m', 200, 'candles', st);
  } else {
    // Forex e metalli: Twelve Data come primario (piano a pagamento attivo).
    // Yahoo Finance resta come fallback automatico se Twelve Data fallisce
    // per qualunque ragione (rate limit, downtime, simbolo non disponibile).
    var ok = await fetchTD(sym, '15min', 200, 'candles', st);
    if (!ok) {
      console.log(sym + ' TD failed, fallback to Yahoo');
      await fetchYahoo(sym, '15m', '5d', 'candles', st);
    }
  }
  var last = st.candles.length ? st.candles[st.candles.length-1].close : 0;
  var src = CRYPTO.indexOf(sym) !== -1 ? 'OKX' : 'TD';
  console.log(sym + ' @ ' + last + ' (M15: ' + st.candles.length + ' candles, src=' + src + ')');
}

// ══════════════════════════════════════
// TELEGRAM
// ══════════════════════════════════════
async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return false;
  try {
    var res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: text, parse_mode: 'HTML' })
    });
    return (await res.json()).ok;
  } catch(e) { return false; }
}

// ══════════════════════════════════════════════════════════════════════════════
// GENERAZIONE SEGNALE — cuore dell'allineamento con l'indicator Pine
// ══════════════════════════════════════════════════════════════════════════════
// Questa funzione replica esattamente la logica dell'indicator:
//   1. Calcola i tre SuperTrend (2.0/7, 3.0/14, 4.5/21)
//   2. Conta quanti sono bullish (bv) e quanti bearish (sv)
//   3. Cerca il flip 3/3 stretto: richiede che sulla candela precedente
//      almeno 2/3 fossero nella direzione opposta
//   4. Accetta anche flip avvenuti una candela fa se il consenso 3/3 regge
//   5. Filtro ADX minimo per evitare mercato piatto
//   6. Rispetta allowLong/allowShort configurati per simbolo
// ══════════════════════════════════════════════════════════════════════════════
async function checkSignal(sym, cooldownMin) {
  try {
    var st = symbolState[sym];
    if (!st || !st.candles.length || !isRunning) return;

    var cfg = getConfig(sym);
    cooldownMin = cooldownMin || 15;

    // Cooldown: evita spam di segnali ravvicinati sulla stessa direzione
    if (Date.now() - st.lastSignalTime < cooldownMin * 60 * 1000) return;

    // Mercato aperto?
    var mStatus = getMarketStatus(sym);
    if (mStatus) { st.stats.lastFilter = '[CHIUSO] ' + mStatus; return; }

    // ── CALCOLO TRIPLO SUPERTREND ──
    var st1 = calcST(st.candles, 7, 2.0);
    var st2 = calcST(st.candles, 14, 3.0);
    var st3 = calcST(st.candles, 21, 4.5);
    if (!st1.length || !st2.length || !st3.length) {
      st.stats.lastFilter = 'Dati insufficienti';
      return;
    }

    // Direzione attuale (candela corrente)
    var b1 = st1[st1.length-1].dir === 1;
    var b2 = st2[st2.length-1].dir === 1;
    var b3 = st3[st3.length-1].dir === 1;
    var bv = (b1?1:0) + (b2?1:0) + (b3?1:0);
    var sv = 3 - bv;

    // Direzione sulla candela -1
    var b1p = st1.length >= 2 ? st1[st1.length-2].dir === 1 : b1;
    var b2p = st2.length >= 2 ? st2[st2.length-2].dir === 1 : b2;
    var b3p = st3.length >= 2 ? st3[st3.length-2].dir === 1 : b3;
    var bvPrev = (b1p?1:0) + (b2p?1:0) + (b3p?1:0);
    var svPrev = 3 - bvPrev;

    // Direzione sulla candela -2
    var b1p2 = st1.length >= 3 ? st1[st1.length-3].dir === 1 : b1p;
    var b2p2 = st2.length >= 3 ? st2[st2.length-3].dir === 1 : b2p;
    var b3p2 = st3.length >= 3 ? st3[st3.length-3].dir === 1 : b3p;
    var bvPrev2 = (b1p2?1:0) + (b2p2?1:0) + (b3p2?1:0);
    var svPrev2 = 3 - bvPrev2;

    // ── RILEVAMENTO FLIP ──
    // Flip stretto: serve che almeno 2/3 fossero opposti sulla candela prima
    var flippedBuy  = bv === 3 && svPrev >= 2;
    var flippedSell = sv === 3 && bvPrev >= 2;

    // Accetta flip avvenuti anche una candela fa, purche il consenso 3/3 regga
    var recentFlipBuy  = flippedBuy  || (bv === 3 && svPrev2 >= 2);
    var recentFlipSell = flippedSell || (sv === 3 && bvPrev2 >= 2);

    // Nessun flip recente? niente segnale
    if (!recentFlipBuy && !recentFlipSell) {
      st.stats.lastFilter = 'No flip (ST: ' + bv + 'B/' + sv + 'S)';
      return;
    }

    // ── DIREZIONE FINALE ──
    var dir = null;
    if (recentFlipBuy && cfg.allowLong)   dir = 'BUY';
    if (recentFlipSell && cfg.allowShort) dir = 'SELL';

    if (!dir) {
      st.stats.lastFilter = recentFlipBuy ? 'LONG disabilitato' : 'SHORT disabilitato';
      return;
    }

    // Evita doppio invio stessa direzione in successione rapida
    if (dir === st.lastDir) {
      st.stats.lastFilter = 'Cooldown: ' + dir + ' gia inviato';
      return;
    }

    // ── FILTRO ADX ──
    var adx = calcADX(st.candles, 14);
    if (adx < cfg.adxMin) {
      st.stats.lastFilter = 'ADX ' + adx.toFixed(1) + ' < ' + cfg.adxMin + ' (mercato piatto)';
      return;
    }

    // ── CALCOLO SL/TP SUGGERITI ──
    var price = st.candles[st.candles.length-1].close;
    var dec = price > 1000 ? 2 : price > 10 ? 3 : 4;
    var atrArr = calcATR(st.candles, 14);
    var atr = atrArr[atrArr.length-1] || 0;
    var slDist = Math.max(atr * cfg.slMult, price * 0.005);
    var sl = dir === 'BUY' ? price - slDist : price + slDist;
    var tp = dir === 'BUY' ? price + slDist * cfg.rr : price - slDist * cfg.rr;

    // ── INVIO NOTIFICA TELEGRAM ──
    var name = SYMBOL_NAMES[sym] || sym;
    var nl = '\n';
    var time = new Date().toUTCString().slice(0, 25);

    var msg =
      '<b>[ST-EA Minimal] ' + dir + ' ' + name + '</b>' + nl +
      '<b>Prezzo:</b> ' + price.toFixed(dec) + nl +
      '<b>SL:</b> ' + sl.toFixed(dec) + ' | <b>TP:</b> ' + tp.toFixed(dec) + nl +
      '<b>R:R:</b> 1:' + cfg.rr.toFixed(1) + nl +
      '<b>ADX:</b> ' + adx.toFixed(1) + ' | <b>ST:</b> ' + bv + 'B/' + sv + 'S' + nl +
      '<b>Lot (500EUR, 3%):</b> ' + calcLotSize(sym, 500, 3, slDist) + nl +
      '<i>' + time + ' UTC</i>';

    var ok = await tgSend(msg);
    if (ok) {
      st.stats.total++;
      if (dir === 'BUY') st.stats.buys++; else st.stats.sells++;
      st.stats.lastSignal = dir;
      st.stats.lastFilter = 'INVIATO: ' + dir + ' @ ' + price.toFixed(dec);
      st.lastSignalTime = Date.now();
      st.lastDir = dir;
      st.log.unshift({ dir: dir, price: price.toFixed(dec), time: time, sym: sym, sl: sl.toFixed(dec), tp: tp.toFixed(dec) });
      if (st.log.length > 20) st.log.pop();
      globalStats.total++;
      if (dir === 'BUY') globalStats.buys++; else globalStats.sells++;
      globalLog.unshift({ dir: dir, price: price.toFixed(dec), time: time, sym: sym });
      if (globalLog.length > 50) globalLog.pop();
      console.log('SIGNAL: ' + sym + ' ' + dir + ' @ ' + price.toFixed(dec) + ' (ADX: ' + adx.toFixed(1) + ')');
    }
  } catch(e) {
    console.error('checkSignal ' + sym + ': ' + e.message);
  }
}

// ══════════════════════════════════════
// LOOP PRINCIPALE
// ══════════════════════════════════════
function startLoop(refreshSec, cooldown) {
  refreshSec = refreshSec || ENV_REFRESH;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async function() {
    lastLoopTime = Date.now();
    for (var i = 0; i < activeSymbols.length; i++) {
      var sym = activeSymbols[i];
      var st = symbolState[sym];
      try {
        var ms = getMarketStatus(sym);
        if (ms) {
          if (st) st.stats.lastFilter = '[CHIUSO] ' + ms;
          if (st && !st.candles.length) await fetchCandles(sym);
          continue;
        }
        await fetchCandles(sym);
        await checkSignal(sym, cooldown);
        await new Promise(function(r) { setTimeout(r, 1000); });
      } catch(e) {
        console.error('Loop ' + sym + ': ' + e.message);
      }
    }
  }, refreshSec * 1000);
}

// ══════════════════════════════════════
// KEEPALIVE + WATCHDOG
// ══════════════════════════════════════
if (RENDER_URL) {
  setInterval(async function() {
    try { await fetch(RENDER_URL + '/api/status'); } catch(e) {}
  }, 14 * 60 * 1000);
}

setInterval(async function() {
  if (!isRunning) return;
  var elapsed = Date.now() - lastLoopTime;
  if (lastLoopTime > 0 && elapsed > 20 * 60 * 1000) {
    console.log('Watchdog: loop stuck, restarting...');
    if (refreshTimer) clearInterval(refreshTimer);
    startLoop(ENV_REFRESH, ENV_COOLDOWN);
    await tgSend('Watchdog: loop riavviato automaticamente');
  }
}, 5 * 60 * 1000);

// ══════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════
app.get('/api/status', function(req, res) {
  var ps = {};
  for (var i = 0; i < activeSymbols.length; i++) {
    var s = activeSymbols[i];
    var st = symbolState[s];
    if (!st) continue;
    ps[s] = {
      stats: st.stats,
      lastPrice: st.candles.length ? st.candles[st.candles.length-1].close : 0,
      candleCount: st.candles.length,
      log: st.log.slice(0, 5)
    };
  }
  res.json({
    isRunning: isRunning,
    activeSymbols: activeSymbols,
    globalStats: globalStats,
    globalLog: globalLog.slice(0, 20),
    tgConnected: !!(TG_TOKEN && TG_CHAT_ID),
    dataConnected: !!TD_KEY,
    perSymbol: ps
  });
});

app.post('/api/start', async function(req, res) {
  var syms = req.body.symbols;
  var cool = req.body.cooldown;
  var ref  = req.body.refresh;
  if (syms && Array.isArray(syms)) {
    activeSymbols = syms.slice(0, 6);
    activeSymbols.forEach(function(s) { if (!symbolState[s]) initSymbol(s); });
  }
  isRunning = true;
  try {
    for (var j = 0; j < activeSymbols.length; j++) {
      await fetchCandles(activeSymbols[j]);
      await new Promise(function(r) { setTimeout(r, 1000); });
    }
    startLoop(ref || 300, cool || 15);
    await tgSend('<b>ST-EA Minimal online</b>\nSimboli: ' + activeSymbols.join(', ') + '\nLogica: triplo ST + flip 3/3 + ADX min');
    res.json({ ok: true, message: 'EA avviato su ' + activeSymbols.join(', ') });
  } catch(e) {
    res.json({ ok: false, message: e.message });
  }
});

app.post('/api/stop', async function(req, res) {
  isRunning = false;
  if (refreshTimer) clearInterval(refreshTimer);
  await tgSend('EA fermato');
  res.json({ ok: true });
});

app.get('/api/test', async function(req, res) {
  var ok = await tgSend('Test OK! EA: ' + (isRunning ? 'RUNNING' : 'STOPPED') + ' | Simboli: ' + activeSymbols.join(', '));
  res.json({ ok: ok });
});

// Endpoint diagnostico per verificare con certezza quale versione del server
// sta effettivamente girando in produzione. Utile per evitare confusioni
// di deploy: chiamando questo URL si vede subito la versione attiva.
app.get('/api/version', function(req, res) {
  res.json({
    version: 'ST-EA v3.3.1 (Triple Bot: Trend + PA + Macro — Macro hotfix)',
    hotfix: 'v3.3.1 rimuove Twelve Data dal Macro Monitor (ticker sbagliati causavano dati corrotti). Ora solo Yahoo Finance con validazione range prezzi.',
    trendBot: {
      enabled: true,
      running: isRunning,
      symbols: activeSymbols,
      timeframe: 'M15',
      logic: 'triple SuperTrend + flip 3/3 strict + ADX min filter'
    },
    paBot: {
      enabled: true,
      running: paRunning,
      symbols: PA_SYMBOLS,
      timeframe: 'D1',
      logic: 'candle patterns + D1/H4 trend alignment + S/R proximity',
      cooldownHours: PA_COOLDOWN_HOURS
    },
    macroMonitor: {
      enabled: true,
      running: macroRunning,
      instruments: MACRO_INSTRUMENTS.length,
      warnPct: MACRO_WARN_PCT,
      alertPct: MACRO_ALERT_PCT,
      weeklyBrief: MACRO_BRIEF_ENABLED,
      briefDay: MACRO_BRIEF_DAY,
      briefHourUTC: MACRO_BRIEF_HOUR,
      dataSource: 'Yahoo Finance only with price range validation'
    },
    dataSources: {
      forex: 'TwelveData (primary) + Yahoo (fallback)',
      metals: 'TwelveData (primary) + Yahoo (fallback)',
      crypto: 'OKX (only)',
      indices_macro: 'Yahoo Finance only (validated)'
    },
    uptimeSec: Math.floor(process.uptime())
  });
});

app.post('/api/test', async function(req, res) {
  var ok = await tgSend('ST-EA Minimal - Test OK!\nSimboli: ' + activeSymbols.join(', '));
  res.json({ ok: ok });
});

app.get('/api/candles/:symbol', function(req, res) {
  var st = symbolState[req.params.symbol];
  if (!st) return res.json({ candles: [], candlesH1: [], candlesM5: [] });
  res.json({
    candles: st.candles.slice(-60),
    candlesH1: [],  // compatibilita dashboard
    candlesM5: []   // compatibilita dashboard
  });
});

app.get('/api/candles', function(req, res) {
  var st = symbolState[activeSymbols[0]] || { candles: [] };
  res.json({ candles: st.candles.slice(-60), candlesH1: [], candlesM5: [] });
});

// ══════════════════════════════════════════════════════════════════════════════
// ██████████████████████████████████████████████████████████████████████████████
// PA BOT D1 — Price Action su timeframe giornaliero
// ██████████████████████████████████████████████████████████████████████████████
// ══════════════════════════════════════════════════════════════════════════════
//
// Modulo autonomo che gira in parallelo al trend bot M15. Monitora pattern
// di candele su timeframe D1 (giornaliero) e segnala setup di price action
// confermati da allineamento trend D1 + H4 e prossimita a livelli S/R.
//
// Caratteristiche:
//   - Timeframe D1 per pattern, H4 per trend di conferma
//   - Pattern: Morning Star, Evening Star, Engulfing, Pin Bar
//   - Richiede pattern forte (strength >=3) + allineamento D1 e H4 + S/R
//   - Cooldown 24h per simbolo per evitare spam di segnali giornalieri
//   - Dati: Twelve Data (primario) + Yahoo (fallback) + OKX (crypto)
//   - ADX differenziato per asset class come il trend bot
//   - Notifiche Telegram con tag [PA-EA] distintivo
//   - Loop ogni ora (3600 sec), sufficiente per timeframe D1
//
// Architettura: modulo autonomo con stato separato (paState) e loop separato
// (paTimer). Condivide solo le funzioni di calcolo indicatori (calcATR,
// calcEMA, calcADX, calcSR) con il trend bot, nel rispetto del principio DRY.
// ══════════════════════════════════════════════════════════════════════════════

// Configurazione PA Bot: simboli monitorati e cooldown
var PA_SYMBOLS = process.env.PA_SYMBOLS ? process.env.PA_SYMBOLS.split(',').map(function(s){return s.trim();}) : DEFAULT_SYMBOLS.slice();
var PA_COOLDOWN_HOURS = parseInt(process.env.PA_COOLDOWN_HOURS) || 24;
var PA_REFRESH_SEC = parseInt(process.env.PA_REFRESH_SEC) || 3600;

// Stato per ciascun simbolo PA
var paState = {};
var paRunning = false;
var paTimer = null;
var lastPALoopTime = 0;

function initPA(s) {
  paState[s] = {
    candlesD1: [],
    candlesH4: [],
    lastDir: null,
    lastSignalTime: 0,
    stats: {
      total: 0,
      buys: 0,
      sells: 0,
      lastSignal: '--',
      lastPattern: '--'
    }
  };
}
PA_SYMBOLS.forEach(initPA);

// ══════════════════════════════════════
// FETCH DATI D1 E H4 PER PA BOT
// ══════════════════════════════════════
// Segue la stessa logica del trend bot: Twelve Data primario, Yahoo fallback,
// OKX per crypto. L'unica differenza e che qui scarichiamo candele D1 e H4
// invece che M15, e popoliamo paState invece che symbolState.

async function fetchPAD1(sym) {
  var st = paState[sym];
  if (!st) return;

  // Crypto: usa OKX per D1 e 4H
  if (CRYPTO.indexOf(sym) !== -1) {
    try {
      var pair = sym.replace('USD', '-USDT');
      // D1
      var urlD1 = 'https://www.okx.com/api/v5/market/candles?instId=' + pair + '&bar=1D&limit=100';
      var resD1 = await fetch(urlD1);
      var dataD1 = await resD1.json();
      if (dataD1.code === '0' && Array.isArray(dataD1.data) && dataD1.data.length > 10) {
        st.candlesD1 = dataD1.data.reverse().map(function(k) {
          return { open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5] };
        });
      }
      // H4
      var urlH4 = 'https://www.okx.com/api/v5/market/candles?instId=' + pair + '&bar=4H&limit=60';
      var resH4 = await fetch(urlH4);
      var dataH4 = await resH4.json();
      if (dataH4.code === '0' && Array.isArray(dataH4.data) && dataH4.data.length > 10) {
        st.candlesH4 = dataH4.data.reverse().map(function(k) {
          return { open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5] };
        });
      }
    } catch(e) {
      console.error('PA OKX ' + sym + ': ' + e.message);
    }
    return;
  }

  // Forex e metalli: Twelve Data primario
  if (TD_KEY) {
    try {
      var mapped = TD_MAP[sym] || sym;
      // D1
      var urlTD1 = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(mapped) +
                   '&interval=1day&outputsize=100&apikey=' + TD_KEY;
      var resTD1 = await fetch(urlTD1);
      var dataTD1 = await resTD1.json();
      if (dataTD1.status !== 'error' && dataTD1.values) {
        var parsedD1 = dataTD1.values.reverse().map(function(c) {
          return { open: +c.open, high: +c.high, low: +c.low, close: +c.close, vol: +(c.volume || 0) };
        });
        if (parsedD1.length > 10 && isValidPrice(sym, parsedD1[parsedD1.length-1].close)) {
          st.candlesD1 = parsedD1;
        }
      }
      await new Promise(function(r) { setTimeout(r, 500); });

      // H4
      var urlTH4 = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(mapped) +
                   '&interval=4h&outputsize=60&apikey=' + TD_KEY;
      var resTH4 = await fetch(urlTH4);
      var dataTH4 = await resTH4.json();
      if (dataTH4.status !== 'error' && dataTH4.values) {
        var parsedH4 = dataTH4.values.reverse().map(function(c) {
          return { open: +c.open, high: +c.high, low: +c.low, close: +c.close, vol: +(c.volume || 0) };
        });
        if (parsedH4.length > 10 && isValidPrice(sym, parsedH4[parsedH4.length-1].close)) {
          st.candlesH4 = parsedH4;
        }
      }
    } catch(e) {
      console.error('PA TD ' + sym + ': ' + e.message);
    }
  }

  // Fallback Yahoo se Twelve Data ha fallito per uno o entrambi i timeframe
  if (!st.candlesD1.length || !st.candlesH4.length) {
    try {
      var ticker = YAHOO_MAP[sym];
      if (ticker) {
        // D1 se mancante
        if (!st.candlesD1.length) {
          var urlYD1 = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
                       '?interval=1d&range=6mo';
          var resYD1 = await fetch(urlYD1, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          var dataYD1 = await resYD1.json();
          var chartD1 = dataYD1 && dataYD1.chart && dataYD1.chart.result && dataYD1.chart.result[0];
          if (chartD1 && chartD1.timestamp) {
            var q = chartD1.indicators.quote[0];
            var parsed = [];
            for (var i = 0; i < chartD1.timestamp.length; i++) {
              if (q.open[i] && q.high[i] && q.low[i] && q.close[i]) {
                parsed.push({
                  open: +q.open[i].toFixed(5),
                  high: +q.high[i].toFixed(5),
                  low: +q.low[i].toFixed(5),
                  close: +q.close[i].toFixed(5),
                  vol: q.volume[i] || 0
                });
              }
            }
            if (parsed.length > 10) st.candlesD1 = parsed;
          }
        }
        // H4 ricostruito da H1 di Yahoo (che non ha H4 nativo)
        if (!st.candlesH4.length) {
          await new Promise(function(r) { setTimeout(r, 500); });
          var urlYH4 = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
                       '?interval=1h&range=60d';
          var resYH4 = await fetch(urlYH4, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          var dataYH4 = await resYH4.json();
          var chartH4 = dataYH4 && dataYH4.chart && dataYH4.chart.result && dataYH4.chart.result[0];
          if (chartH4 && chartH4.timestamp) {
            var qH = chartH4.indicators.quote[0];
            var h1cands = [];
            for (var j = 0; j < chartH4.timestamp.length; j++) {
              if (qH.open[j] && qH.high[j] && qH.low[j] && qH.close[j]) {
                h1cands.push({
                  open: +qH.open[j].toFixed(5),
                  high: +qH.high[j].toFixed(5),
                  low: +qH.low[j].toFixed(5),
                  close: +qH.close[j].toFixed(5),
                  vol: qH.volume[j] || 0
                });
              }
            }
            // Raggruppa H1 in H4 (ogni 4 candele)
            var h4cands = [];
            for (var k = 0; k + 3 < h1cands.length; k += 4) {
              var g = h1cands.slice(k, k + 4);
              h4cands.push({
                open: g[0].open,
                high: Math.max.apply(null, g.map(function(c){return c.high;})),
                low: Math.min.apply(null, g.map(function(c){return c.low;})),
                close: g[g.length-1].close,
                vol: g.reduce(function(s,c){return s + (c.vol||0);}, 0)
              });
            }
            if (h4cands.length > 10) st.candlesH4 = h4cands;
          }
        }
      }
    } catch(e) {
      console.error('PA Yahoo ' + sym + ': ' + e.message);
    }
  }

  var srcD1 = st.candlesD1.length ? 'OK' : 'EMPTY';
  var srcH4 = st.candlesH4.length ? 'OK' : 'EMPTY';
  console.log('PA ' + sym + ' D1:' + srcD1 + '/' + st.candlesD1.length + ' H4:' + srcH4 + '/' + st.candlesH4.length);
}

// ══════════════════════════════════════
// TREND FILTERS D1 E H4
// ══════════════════════════════════════
// getD1Trend usa EMA50 su D1 come riferimento di lungo periodo.
// getH4Trend usa EMA20 su H4 come riferimento di medio periodo.
// Un pattern D1 e valido solo se entrambi i trend sono allineati nella
// direzione del pattern (filtro anti-controtrend).

function getD1Trend(candles) {
  if (!candles || candles.length < 50) return null;
  var ema50 = calcEMA(candles, 50);
  var last = candles[candles.length-1].close;
  return last > ema50 ? 'BUY' : 'SELL';
}

function getH4Trend(candles) {
  if (!candles || candles.length < 20) return null;
  var ema20 = calcEMA(candles, 20);
  var last = candles[candles.length-1].close;
  return last > ema20 ? 'BUY' : 'SELL';
}

// ══════════════════════════════════════
// PATTERN DETECTION — candlestick D1
// ══════════════════════════════════════
// Strict pattern detection: solo setup di alta qualita contano.
// Richiediamo che la candela corrente abbia range > 70% della media
// delle ultime 10 candele, cosi filtriamo giorni di basso movimento.

function detectPAPatterns(candles) {
  if (candles.length < 6) return [];
  var patterns = [];
  var len = candles.length;
  var c0 = candles[len-1];
  var c1 = candles[len-2];
  var c2 = candles[len-3];

  var body0 = Math.abs(c0.close - c0.open);
  var body1 = Math.abs(c1.close - c1.open);
  var body2 = Math.abs(c2.close - c2.open);
  var range0 = c0.high - c0.low;
  var range1 = c1.high - c1.low;
  var isBull0 = c0.close > c0.open;
  var isBull1 = c1.close > c1.open;
  var isBull2 = c2.close > c2.open;
  var upper0 = c0.high - Math.max(c0.open, c0.close);
  var lower0 = Math.min(c0.open, c0.close) - c0.low;

  // Range medio delle ultime 10 candele per filtrare giorni piatti
  var avgRange = 0;
  for (var i = len-10; i < len; i++) {
    if (i >= 0) avgRange += (candles[i].high - candles[i].low);
  }
  avgRange = avgRange / 10;

  // Candela troppo piccola: nessun pattern significativo
  if (range0 < avgRange * 0.7) return [];

  // Contesto: serve una candela a distanza 5 per valutare se c'era trend precedente
  var c5 = candles[len-6];
  var priorDown = c5 && c5.close > c2.open;
  var priorUp = c5 && c5.close < c2.open;

  // MORNING STAR: 3 candele dopo downtrend
  // c2 bearish forte, c1 doji/piccola, c0 bullish forte che chiude sopra meta di c2
  if (priorDown && !isBull2 && body2 > avgRange * 0.5 &&
      body1 < range1 * 0.25 && range1 > 0 &&
      isBull0 && body0 > avgRange * 0.5 &&
      c0.close > (c2.open + c2.close) / 2) {
    patterns.push({ name: 'Morning Star', dir: 'BUY', strength: 4 });
  }

  // EVENING STAR: 3 candele dopo uptrend (speculare a Morning Star)
  if (priorUp && isBull2 && body2 > avgRange * 0.5 &&
      body1 < range1 * 0.25 && range1 > 0 &&
      !isBull0 && body0 > avgRange * 0.5 &&
      c0.close < (c2.open + c2.close) / 2) {
    patterns.push({ name: 'Evening Star', dir: 'SELL', strength: 4 });
  }

  // BULLISH ENGULFING: c0 bullish che engloba completamente c1 bearish dopo downtrend
  var priorDown2 = !isBull1 && !isBull2;
  if (priorDown2 && isBull0 &&
      c0.open < c1.close && c0.close > c1.open &&
      body0 > body1 * 1.5 && body0 > avgRange * 0.6) {
    patterns.push({ name: 'Bullish Engulfing', dir: 'BUY', strength: 3 });
  }

  // BEARISH ENGULFING: speculare a Bullish Engulfing
  var priorUp2 = isBull1 && isBull2;
  if (priorUp2 && !isBull0 &&
      c0.open > c1.close && c0.close < c1.open &&
      body0 > body1 * 1.5 && body0 > avgRange * 0.6) {
    patterns.push({ name: 'Bearish Engulfing', dir: 'SELL', strength: 3 });
  }

  // PIN BAR BULLISH: wick inferiore 3x body, upper wick piccolo
  if (lower0 > body0 * 3 && upper0 < body0 * 0.5 && body0 > 0 && range0 > avgRange * 0.8) {
    patterns.push({ name: 'Pin Bar Bull', dir: 'BUY', strength: 3 });
  }

  // PIN BAR BEARISH: speculare
  if (upper0 > body0 * 3 && lower0 < body0 * 0.5 && body0 > 0 && range0 > avgRange * 0.8) {
    patterns.push({ name: 'Pin Bar Bear', dir: 'SELL', strength: 3 });
  }

  return patterns;
}

// ══════════════════════════════════════
// S/R PROXIMITY PER PA
// ══════════════════════════════════════
// Funzione locale per calcolare livelli S/R dalle candele D1
// (simile a calcSR del trend bot ma ottimizzata per D1)

function calcPASR(candles, lookback) {
  lookback = lookback || 60;
  var r = candles.slice(-lookback);
  var levels = [];
  for (var i = 2; i < r.length - 2; i++) {
    // Swing high
    if (r[i].high > r[i-1].high && r[i].high > r[i-2].high &&
        r[i].high > r[i+1].high && r[i].high > r[i+2].high) {
      levels.push({ price: r[i].high, type: 'R', strength: 1 });
    }
    // Swing low
    if (r[i].low < r[i-1].low && r[i].low < r[i-2].low &&
        r[i].low < r[i+1].low && r[i].low < r[i+2].low) {
      levels.push({ price: r[i].low, type: 'S', strength: 1 });
    }
  }
  // Consolidamento livelli vicini (entro 0.4%)
  var merged = [];
  for (var k = 0; k < levels.length; k++) {
    var lv = levels[k];
    var nb = null;
    for (var m = 0; m < merged.length; m++) {
      if (Math.abs(merged[m].price - lv.price) / lv.price < 0.004) {
        nb = merged[m];
        break;
      }
    }
    if (nb) nb.strength++;
    else merged.push({ price: lv.price, type: lv.type, strength: 1 });
  }
  merged.sort(function(a, b) { return b.strength - a.strength; });
  return merged.slice(0, 8);
}

function isPANearSR(price, srLevels, atr) {
  for (var i = 0; i < srLevels.length; i++) {
    if (Math.abs(srLevels[i].price - price) < atr * 1.5) return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// CHECK PA SIGNAL — il cuore del PA Bot
// ══════════════════════════════════════════════════════════════════════════════
// Processo di validazione in cascata: se un controllo fallisce, il segnale
// non viene emesso. Questo garantisce che solo setup con TUTTI i filtri
// passati arrivino fino all'utente via Telegram.
// 1. Cooldown 24h
// 2. Mercato aperto
// 3. Pattern rilevato con strength >= 3
// 4. Trend D1 allineato
// 5. Trend H4 allineato
// 6. Prezzo vicino a livello S/R
// 7. Direzione diversa dall'ultimo segnale (evita duplicati direzionali)

async function checkPASignal(sym) {
  try {
    var st = paState[sym];
    if (!st || !st.candlesD1.length || !paRunning) return;

    // 1. Cooldown
    if (Date.now() - st.lastSignalTime < PA_COOLDOWN_HOURS * 60 * 60 * 1000) return;

    // 2. Mercato aperto
    var ms = getMarketStatus(sym);
    if (ms) {
      st.stats.lastPattern = '[CHIUSO] ' + ms;
      return;
    }

    var c = st.candlesD1;

    // 3. Pattern detection
    var patterns = detectPAPatterns(c);
    if (!patterns.length) {
      st.stats.lastPattern = 'Nessun pattern';
      return;
    }

    // Filtra solo pattern forti (>= 3)
    var strong = patterns.filter(function(p) { return p.strength >= 3; });
    if (!strong.length) {
      st.stats.lastPattern = 'Pattern deboli';
      return;
    }

    strong.sort(function(a, b) { return b.strength - a.strength; });
    var best = strong[0];

    // 4. D1 trend
    var d1Trend = getD1Trend(c);
    if (d1Trend && d1Trend !== best.dir) {
      st.stats.lastPattern = 'D1 trend contro (' + d1Trend + ' vs ' + best.dir + ')';
      return;
    }

    // 5. H4 trend
    var h4Trend = getH4Trend(st.candlesH4);
    if (h4Trend && h4Trend !== best.dir) {
      st.stats.lastPattern = 'H4 trend contro (' + h4Trend + ')';
      return;
    }

    // 6. Evita ripetizione stessa direzione
    if (best.dir === st.lastDir) {
      st.stats.lastPattern = 'Stessa direzione precedente';
      return;
    }

    var price = c[c.length-1].close;
    var dec = price > 1000 ? 2 : price > 10 ? 3 : 4;
    var atrArr = calcATR(c, 14);
    var atr = atrArr[atrArr.length-1] || 0;

    // 7. Vicinanza a S/R
    var srLevels = calcPASR(c, 60);
    if (!isPANearSR(price, srLevels, atr)) {
      st.stats.lastPattern = best.name + ' ma non su S/R';
      return;
    }

    // Tutti i filtri passati: calcolo SL/TP e invio notifica
    // SL basato su ATR D1 moltiplicato per 2.0 (pattern D1 richiede piu respiro)
    // Floor minimo 0.8% per evitare SL ridicolmente stretti in giorni piatti
    var slDist = Math.max(atr * 2.0, price * 0.008);
    var tpDist = slDist * 2.5; // Risk/Reward 1:2.5
    var sl = (best.dir === 'BUY' ? price - slDist : price + slDist).toFixed(dec);
    var tp = (best.dir === 'BUY' ? price + tpDist : price - tpDist).toFixed(dec);

    // Lot size su diversi bankroll al 3% rischio
    var lots = [100, 500, 1000].map(function(b) {
      return b + 'EUR: ' + calcLotSize(sym, b, 3, slDist) + ' lot';
    }).join(' | ');

    // S/R nelle vicinanze per contesto nel messaggio
    var nearbySR = srLevels.filter(function(l) { return Math.abs(l.price - price) < atr * 3; })
                           .map(function(l) { return l.type + ': ' + l.price.toFixed(dec); })
                           .join(' | ');

    var name = SYMBOL_NAMES[sym] || sym;
    var time = new Date().toUTCString().slice(0, 25);
    var nl = '\n';

    var msg =
      '<b>[PA-EA] ' + (best.dir === 'BUY' ? '[BUY]' : '[SELL]') + ' ' + name + '</b>' + nl +
      'Pattern D1: <b>' + best.name + '</b> (' + best.strength + '/4)' + nl +
      '<b>Prezzo:</b> ' + price.toFixed(dec) + nl +
      '<b>SL:</b> ' + sl + ' | <b>TP:</b> ' + tp + nl +
      '<b>R:R:</b> 1:2.5' + nl +
      'Trend D1: ' + (d1Trend || '--') + ' | H4: ' + (h4Trend || '--') + nl +
      (nearbySR ? 'S/R vicini: ' + nearbySR + nl : '') +
      '<b>Lot (3% rischio):</b>' + nl + lots + nl +
      '<i>' + time + ' UTC</i>';

    var ok = await tgSend(msg);
    if (ok) {
      st.stats.total++;
      if (best.dir === 'BUY') st.stats.buys++; else st.stats.sells++;
      st.stats.lastSignal = best.dir;
      st.stats.lastPattern = best.name + ' @ ' + price.toFixed(dec);
      st.lastSignalTime = Date.now();
      st.lastDir = best.dir;
      globalStats.total++;
      if (best.dir === 'BUY') globalStats.buys++; else globalStats.sells++;
      globalLog.unshift({
        dir: best.dir, price: price.toFixed(dec), time: time,
        sym: sym, pattern: best.name, source: 'PA'
      });
      if (globalLog.length > 50) globalLog.pop();
      console.log('PA SIGNAL: ' + sym + ' ' + best.dir + ' ' + best.name + ' @ ' + price.toFixed(dec));
    }
  } catch(e) {
    console.error('checkPASignal ' + sym + ': ' + e.message);
  }
}

// ══════════════════════════════════════
// PA LOOP
// ══════════════════════════════════════

async function runPALoop() {
  lastPALoopTime = Date.now();
  for (var i = 0; i < PA_SYMBOLS.length; i++) {
    var sym = PA_SYMBOLS[i];
    try {
      await fetchPAD1(sym);
      await checkPASignal(sym);
      // Delay tra simboli per non saturare le API
      var delay = CRYPTO.indexOf(sym) !== -1 ? 500 : 2000;
      await new Promise(function(r) { setTimeout(r, delay); });
    } catch(e) {
      console.error('PA Loop ' + sym + ': ' + e.message);
    }
  }
  console.log('PA Loop completato @ ' + new Date().toUTCString().slice(17, 25));
}

function startPALoop() {
  if (paTimer) clearInterval(paTimer);
  runPALoop(); // esecuzione immediata
  paTimer = setInterval(runPALoop, PA_REFRESH_SEC * 1000);
}

// Watchdog PA: riavvia se il loop e bloccato da oltre 2 ore
setInterval(async function() {
  if (!paRunning) return;
  var elapsed = Date.now() - lastPALoopTime;
  if (lastPALoopTime > 0 && elapsed > 2 * 60 * 60 * 1000) {
    console.log('PA Watchdog: loop bloccato da ' + Math.round(elapsed/60000) + 'min, riavvio...');
    if (paTimer) clearInterval(paTimer);
    startPALoop();
    await tgSend('<i>PA Bot riavviato dal watchdog</i>');
  }
}, 10 * 60 * 1000);

// ══════════════════════════════════════
// API ENDPOINTS PA BOT
// ══════════════════════════════════════

app.get('/api/pa-status', function(req, res) {
  var paPs = {};
  for (var i = 0; i < PA_SYMBOLS.length; i++) {
    var st = paState[PA_SYMBOLS[i]];
    if (st) {
      paPs[PA_SYMBOLS[i]] = {
        stats: st.stats,
        candlesD1Count: st.candlesD1.length,
        candlesH4Count: st.candlesH4.length,
        lastPrice: st.candlesD1.length ? st.candlesD1[st.candlesD1.length-1].close : 0
      };
    }
  }
  res.json({
    paRunning: paRunning,
    paSymbols: PA_SYMBOLS,
    cooldownHours: PA_COOLDOWN_HOURS,
    refreshSec: PA_REFRESH_SEC,
    lastLoopTime: lastPALoopTime,
    state: paPs,
    paLog: globalLog.filter(function(l){ return l.source === 'PA'; }).slice(0, 20)
  });
});

app.post('/api/pa-start', async function(req, res) {
  paRunning = true;
  startPALoop();
  await tgSend('<b>PA Bot D1 avviato</b>\nSimboli: ' + PA_SYMBOLS.join(', ') + '\nCooldown: ' + PA_COOLDOWN_HOURS + 'h');
  res.json({ ok: true, message: 'PA Bot avviato su ' + PA_SYMBOLS.join(', ') });
});

app.post('/api/pa-stop', async function(req, res) {
  paRunning = false;
  if (paTimer) clearInterval(paTimer);
  await tgSend('PA Bot D1 fermato');
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ██████████████████████████████████████████████████████████████████████████████
// FINE MODULO PA BOT D1
// ██████████████████████████████████████████████████████████████████████████████
// ══════════════════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════════════════════
// ██████████████████████████████████████████████████████████████████████████████
// MACRO MONITOR — alert di drawdown + briefing settimanale
// ██████████████████████████████████████████████████████████████████════════════
// ══════════════════════════════════════════════════════════════════════════════
//
// Terzo modulo del sistema. Non e un bot di trading, e un sistema di
// monitoraggio del contesto macro che serve due scopi complementari:
//
//   1. ALERT DI DRAWDOWN: manda notifica Telegram quando un indice o asset
//      scende significativamente dai suoi massimi recenti. Due soglie:
//      warning -5% dal max 3 mesi, alert -10% dal max 6 mesi.
//      Cooldown per evitare spam se l'asset rimane in zona warning.
//
//   2. BRIEFING SETTIMANALE: ogni lunedi mattina alle 9 UTC invia un report
//      completo sullo stato di tutti i 9 strumenti monitorati, con stato
//      attuale, drawdown dai massimi, valutazione sintetica del regime.
//
// Il modulo e progettato per chi vuole fare investimento di lungo periodo
// (ETF, indici, azioni) senza dover monitorare i mercati ogni giorno.
// Logica di fondo: comprare quando c'e paura (drawdown significativi),
// mantenere informazione di contesto senza distrazione quotidiana.
//
// Architettura: modulo autonomo con stato separato (macroState), loop di
// monitoraggio ogni ora (macroTimer), scheduler separato per briefing
// settimanale (macroBriefTimer). Nessuna dipendenza dai bot di trading.
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════
// CONFIGURAZIONE STRUMENTI MACRO
// ══════════════════════════════════════
// Ogni strumento ha: nome completo, simbolo Twelve Data (se disponibile),
// simbolo Yahoo come fallback, e categoria per organizzare il briefing.
// Note tecniche: usiamo Yahoo Finance come fonte primaria per il Macro Monitor
// perche ha ticker standard documentati per tutti gli indici, il VIX e i bond.
// I ticker yahoo sono con carattere ^ URL-encoded come %5E.
// Ogni strumento ha un range di prezzo valido: dati fuori range vengono
// rifiutati come corrotti. Questo protegge dal bug v3.3 dove ticker sbagliati
// producevano dati crypto casuali presentati come indici.

var MACRO_INSTRUMENTS = [
  { id: 'SPX',    name: 'S&P 500',           category: 'US_EQUITY',
    yahoo: '%5EGSPC',    minPrice: 2000, maxPrice: 15000 },
  { id: 'NDX',    name: 'Nasdaq 100',        category: 'US_EQUITY',
    yahoo: '%5ENDX',     minPrice: 5000, maxPrice: 50000 },
  { id: 'SX5E',   name: 'Euro Stoxx 50',     category: 'EU_EQUITY',
    yahoo: '%5ESTOXX50E', minPrice: 2000, maxPrice: 10000 },
  { id: 'FTSEMIB',name: 'FTSE MIB',          category: 'EU_EQUITY',
    yahoo: 'FTSEMIB.MI', minPrice: 15000, maxPrice: 80000 },
  { id: 'DAX',    name: 'DAX',               category: 'EU_EQUITY',
    yahoo: '%5EGDAXI',   minPrice: 8000, maxPrice: 40000 },
  { id: 'XAUUSD', name: 'Oro',               category: 'SAFE_HAVEN',
    yahoo: 'GC=F',       minPrice: 1000, maxPrice: 10000 },
  { id: 'WTI',    name: 'Petrolio WTI',      category: 'COMMODITY',
    yahoo: 'CL=F',       minPrice: 20, maxPrice: 200 },
  { id: 'VIX',    name: 'VIX (volatilita USA)', category: 'VOLATILITY',
    yahoo: '%5EVIX',     minPrice: 8, maxPrice: 100 },
  { id: 'US10Y',  name: 'US Treasury 10Y',   category: 'BOND',
    yahoo: '%5ETNX',     minPrice: 0.5, maxPrice: 10 }
];

// Soglie di drawdown configurabili via env
var MACRO_WARN_PCT = parseFloat(process.env.MACRO_WARN_PCT) || 5.0;   // -5% dal max 3 mesi
var MACRO_ALERT_PCT = parseFloat(process.env.MACRO_ALERT_PCT) || 10.0; // -10% dal max 6 mesi
var MACRO_REFRESH_SEC = parseInt(process.env.MACRO_REFRESH_SEC) || 3600; // 1 ora
var MACRO_COOLDOWN_HOURS = parseInt(process.env.MACRO_COOLDOWN_HOURS) || 24; // anti-spam
var MACRO_BRIEF_ENABLED = process.env.MACRO_BRIEF_ENABLED !== 'false'; // default on
var MACRO_BRIEF_DAY = parseInt(process.env.MACRO_BRIEF_DAY) || 1; // 1=lunedi
var MACRO_BRIEF_HOUR = parseInt(process.env.MACRO_BRIEF_HOUR) || 9; // 9 UTC

// ══════════════════════════════════════
// STATO MACRO
// ══════════════════════════════════════
var macroState = {};
var macroRunning = false;
var macroTimer = null;
var macroBriefTimer = null;
var lastMacroLoopTime = 0;
var lastBriefSent = 0; // timestamp ultimo briefing inviato

function initMacro(instr) {
  macroState[instr.id] = {
    instrument: instr,
    candlesD1: [],           // ultimi 180 giorni
    currentPrice: 0,
    max3m: 0,                // massimo ultimi 60 giorni di trading
    max6m: 0,                // massimo ultimi 120 giorni di trading
    drawdown3m: 0,           // % sotto max 3m
    drawdown6m: 0,           // % sotto max 6m
    lastAlertTime: 0,        // timestamp ultimo alert inviato
    lastAlertLevel: null,    // 'warn' | 'alert' | null
    lastUpdateTime: 0,
    status: 'init'           // init | ok | warn | alert | no_data
  };
}
MACRO_INSTRUMENTS.forEach(initMacro);

// ══════════════════════════════════════
// FETCH DATI MACRO — Yahoo Finance con validazione range
// ══════════════════════════════════════
// Dopo il bug della v3.3 (dove ticker Twelve Data sbagliati hanno causato
// fetch di dati casuali presentati come indici), abbiamo semplificato:
// una sola fonte dati (Yahoo Finance), ticker standard e ben documentati,
// e validazione di sanita obbligatoria su ogni dato ricevuto.
//
// La validazione confronta il prezzo di chiusura ricevuto con il range
// minPrice/maxPrice definito nella configurazione dello strumento. Se il
// prezzo e fuori range, TUTTI i dati vengono scartati e lo strumento resta
// in stato 'no_data' invece di essere aggiornato con dati corrotti.

async function fetchMacroData(instr) {
  var st = macroState[instr.id];
  if (!st) return false;

  try {
    var urlY = 'https://query2.finance.yahoo.com/v8/finance/chart/' + instr.yahoo +
               '?interval=1d&range=6mo';
    var resY = await fetch(urlY, { headers: { 'User-Agent': 'Mozilla/5.0' } });

    if (!resY.ok) {
      console.error('Macro Yahoo ' + instr.id + ': HTTP ' + resY.status);
      return false;
    }

    var dataY = await resY.json();
    var chart = dataY && dataY.chart && dataY.chart.result && dataY.chart.result[0];
    if (!chart || !chart.timestamp) {
      console.error('Macro Yahoo ' + instr.id + ': no chart data');
      return false;
    }

    var q = chart.indicators.quote[0];
    var parsed = [];
    for (var i = 0; i < chart.timestamp.length; i++) {
      if (q.open[i] && q.high[i] && q.low[i] && q.close[i]) {
        parsed.push({
          open: +q.open[i].toFixed(4),
          high: +q.high[i].toFixed(4),
          low: +q.low[i].toFixed(4),
          close: +q.close[i].toFixed(4),
          vol: q.volume[i] || 0
        });
      }
    }

    // Servono almeno 30 candele per calcoli significativi
    if (parsed.length < 30) {
      console.error('Macro ' + instr.id + ': too few candles (' + parsed.length + ')');
      return false;
    }

    // ── VALIDAZIONE DI SANITA ──
    // Verifico che il prezzo piu recente sia nel range plausibile. Questo
    // protegge contro: ticker sbagliati che restituiscono asset casuali,
    // errori decimali (es. Yahoo che ritorna prezzi in cents), dati corrotti.
    var latestClose = parsed[parsed.length-1].close;
    if (latestClose < instr.minPrice || latestClose > instr.maxPrice) {
      console.error('Macro ' + instr.id + ': price ' + latestClose +
                    ' OUT OF RANGE [' + instr.minPrice + ', ' + instr.maxPrice + '] — data rejected');
      return false;
    }

    // Verifico anche il massimo storico della serie sia plausibile
    var maxInSeries = 0;
    for (var k = 0; k < parsed.length; k++) {
      if (parsed[k].high > maxInSeries) maxInSeries = parsed[k].high;
    }
    if (maxInSeries < instr.minPrice || maxInSeries > instr.maxPrice * 2) {
      console.error('Macro ' + instr.id + ': max ' + maxInSeries + ' implausible — data rejected');
      return false;
    }

    // Dati validi: salva
    st.candlesD1 = parsed;
    console.log('Macro ' + instr.id + ': ' + parsed.length + ' candles, last=' + latestClose.toFixed(2));
    return true;

  } catch(e) {
    console.error('Macro Yahoo ' + instr.id + ': ' + e.message);
    return false;
  }
}

// ══════════════════════════════════════
// CALCOLO DRAWDOWN E STATO
// ══════════════════════════════════════
// Per ogni strumento calcoliamo il massimo degli ultimi N giorni di trading
// e confrontiamo con il prezzo attuale. Utilizziamo candlesD1[-N:] che nei
// mercati azionari corrisponde a circa N/20 mesi di calendario (20 giorni
// di trading per mese approssimativi).

function updateMacroStats(instrId) {
  var st = macroState[instrId];
  if (!st || !st.candlesD1.length) {
    if (st) st.status = 'no_data';
    return;
  }

  var candles = st.candlesD1;
  var current = candles[candles.length-1].close;
  st.currentPrice = current;
  st.lastUpdateTime = Date.now();

  // Massimo 3 mesi (ultimi 60 giorni di trading)
  var slice3m = candles.slice(-60);
  var max3m = 0;
  for (var i = 0; i < slice3m.length; i++) {
    if (slice3m[i].high > max3m) max3m = slice3m[i].high;
  }
  st.max3m = max3m;
  st.drawdown3m = max3m > 0 ? ((current - max3m) / max3m) * 100 : 0;

  // Massimo 6 mesi (ultimi 120 giorni di trading, o tutto se meno)
  var slice6m = candles.slice(-120);
  var max6m = 0;
  for (var j = 0; j < slice6m.length; j++) {
    if (slice6m[j].high > max6m) max6m = slice6m[j].high;
  }
  st.max6m = max6m;
  st.drawdown6m = max6m > 0 ? ((current - max6m) / max6m) * 100 : 0;

  // Classificazione stato
  // Nota: il VIX si comporta al contrario. Qui applichiamo la logica ai prezzi
  // normali (drawdown negativo = male). Per il VIX interpretiamo separatamente
  // nel briefing (VIX alto = paura = potenziale opportunita di acquisto).
  if (st.drawdown6m <= -MACRO_ALERT_PCT) {
    st.status = 'alert';
  } else if (st.drawdown3m <= -MACRO_WARN_PCT) {
    st.status = 'warn';
  } else {
    st.status = 'ok';
  }
}

// ══════════════════════════════════════
// INVIO ALERT DRAWDOWN
// ══════════════════════════════════════
// Logica anti-spam: se lo stesso strumento era gia in alert livello 'alert'
// non rimandiamo un altro 'alert' prima di MACRO_COOLDOWN_HOURS. Mandiamo
// pero un alert se passiamo da warn ad alert (escalation). Non mandiamo
// alert se passiamo da alert a warn (de-escalation), solo log interno.

async function checkMacroAlert(instrId) {
  var st = macroState[instrId];
  if (!st || st.status === 'init' || st.status === 'no_data' || st.status === 'ok') return;

  var instr = st.instrument;
  var now = Date.now();
  var cooldownMs = MACRO_COOLDOWN_HOURS * 60 * 60 * 1000;

  // Escalation warn->alert: invia sempre (importante)
  var escalation = st.status === 'alert' && st.lastAlertLevel === 'warn';

  // Nuovo alert o nuovo warn: verifica cooldown
  var isRepeat = st.lastAlertLevel === st.status;
  if (isRepeat && (now - st.lastAlertTime) < cooldownMs) return;

  // Il VIX invertito: non e un drawdown, e un SPIKE. Skip dall'alert normale.
  if (instr.id === 'VIX') return;

  var nl = '\n';
  var level = st.status === 'alert' ? 'ALERT' : 'WARNING';
  var emoji = st.status === 'alert' ? '🔴' : '🟡';
  var pct = st.status === 'alert' ? st.drawdown6m : st.drawdown3m;
  var maxLabel = st.status === 'alert' ? '6 mesi' : '3 mesi';
  var maxVal = st.status === 'alert' ? st.max6m : st.max3m;

  var dec = st.currentPrice > 100 ? 2 : 4;
  var tg = st.currentPrice > 100 ? 2 : 4;

  var msg =
    '<b>[MACRO ' + level + '] ' + emoji + ' ' + instr.name + '</b>' + nl +
    'Drawdown: <b>' + pct.toFixed(2) + '%</b> dal max ' + maxLabel + nl +
    'Prezzo attuale: <b>' + st.currentPrice.toFixed(dec) + '</b>' + nl +
    'Max ' + maxLabel + ': ' + maxVal.toFixed(tg) + nl +
    (escalation ? '<i>Escalation da warning ad alert</i>' + nl : '') +
    '<i>' + (st.status === 'alert' ?
      'Drawdown significativo. Valutare accumulo graduale.' :
      'Primo segnale di debolezza. Monitorare evoluzione.') + '</i>';

  var ok = await tgSend(msg);
  if (ok) {
    st.lastAlertTime = now;
    st.lastAlertLevel = st.status;
    console.log('MACRO ' + level + ': ' + instr.id + ' drawdown ' + pct.toFixed(2) + '%');
  }
}

// ══════════════════════════════════════
// LOOP MONITORAGGIO MACRO
// ══════════════════════════════════════

async function runMacroLoop() {
  lastMacroLoopTime = Date.now();
  for (var i = 0; i < MACRO_INSTRUMENTS.length; i++) {
    var instr = MACRO_INSTRUMENTS[i];
    try {
      var fetchOk = await fetchMacroData(instr);
      if (fetchOk) {
        updateMacroStats(instr.id);
        await checkMacroAlert(instr.id);
      }
      // Delay per non saturare le API
      await new Promise(function(r) { setTimeout(r, 1500); });
    } catch(e) {
      console.error('Macro Loop ' + instr.id + ': ' + e.message);
    }
  }
  console.log('Macro Loop completato @ ' + new Date().toUTCString().slice(17,25));
}

function startMacroLoop() {
  if (macroTimer) clearInterval(macroTimer);
  runMacroLoop(); // esecuzione immediata
  macroTimer = setInterval(runMacroLoop, MACRO_REFRESH_SEC * 1000);
}

// ══════════════════════════════════════════════════════════════════════════════
// BRIEFING SETTIMANALE
// ══════════════════════════════════════════════════════════════════════════════
// Ogni lunedi alle 9 UTC invia un report completo dello stato dei mercati.
// Raggruppato per categoria: US Equity, EU Equity, Safe Haven, Commodity,
// Volatilita, Bond. Valutazione sintetica del regime generale.
// Schedule: il timer si attiva ogni ora per verificare se e il momento giusto.

function isTimeForBrief() {
  if (!MACRO_BRIEF_ENABLED) return false;
  var now = new Date();
  var day = now.getUTCDay(); // 0=dom, 1=lun
  var hour = now.getUTCHours();
  var minute = now.getUTCMinutes();
  // Matchiamo solo nella finestra 9:00-9:59 del giorno target per essere sicuri
  // che anche se il server riavvia non perdiamo il briefing
  if (day !== MACRO_BRIEF_DAY) return false;
  if (hour !== MACRO_BRIEF_HOUR) return false;
  // Anti-duplicazione: se ne abbiamo mandato uno nelle ultime 23 ore, skip
  if (Date.now() - lastBriefSent < 23 * 60 * 60 * 1000) return false;
  return true;
}

function classifyRegime() {
  // Valutazione euristica del regime attuale basata su VIX, drawdown US, oro.
  // VIX < 15 e US equity ok = euphoric/risk-on
  // VIX 15-25 e nessun alert = normal
  // VIX > 25 o drawdown alert su US = risk-off / fear
  var vix = macroState['VIX'];
  var spx = macroState['SPX'];
  var gold = macroState['XAUUSD'];

  var vixPrice = vix && vix.currentPrice ? vix.currentPrice : null;
  var spxStatus = spx ? spx.status : 'no_data';
  var goldStatus = gold ? gold.status : 'no_data';

  var regime = 'Neutro';
  var reasoning = '';

  if (vixPrice !== null) {
    if (vixPrice > 25 || spxStatus === 'alert') {
      regime = 'Risk-Off (paura)';
      reasoning = 'VIX elevato e/o crollo significativo su azioni USA.';
    } else if (vixPrice < 15 && spxStatus === 'ok') {
      regime = 'Risk-On (euforia)';
      reasoning = 'VIX basso e azioni USA in condizioni normali/rialziste.';
    } else if (vixPrice >= 15 && vixPrice <= 25 && spxStatus !== 'alert') {
      regime = 'Normale';
      reasoning = 'VIX in range tipico, nessun drawdown critico.';
    }
  }

  return { regime: regime, reasoning: reasoning };
}

async function sendWeeklyBrief() {
  var now = new Date();
  var dateStr = now.toUTCString().slice(0, 16);
  var nl = '\n';

  // Classificazione regime
  var regimeInfo = classifyRegime();

  // Raggruppa strumenti per categoria
  var categories = {
    'US_EQUITY': { title: '🇺🇸 Azioni USA', items: [] },
    'EU_EQUITY': { title: '🇪🇺 Azioni Europa', items: [] },
    'SAFE_HAVEN': { title: '🏛️ Beni Rifugio', items: [] },
    'COMMODITY': { title: '🛢️ Commodities', items: [] },
    'VOLATILITY': { title: '📊 Volatilita', items: [] },
    'BOND': { title: '🏦 Obbligazioni', items: [] }
  };

  for (var i = 0; i < MACRO_INSTRUMENTS.length; i++) {
    var instr = MACRO_INSTRUMENTS[i];
    var st = macroState[instr.id];
    if (!st || !st.currentPrice) continue;

    var dec = st.currentPrice > 100 ? 2 : 4;
    var icon = st.status === 'alert' ? '🔴' :
               st.status === 'warn' ? '🟡' : '🟢';

    // Interpretazione VIX speciale
    var interpretation = '';
    if (instr.id === 'VIX') {
      if (st.currentPrice > 30) interpretation = ' (paura elevata — possibile opportunita)';
      else if (st.currentPrice > 20) interpretation = ' (paura moderata)';
      else if (st.currentPrice < 15) interpretation = ' (compiacenza)';
      else interpretation = ' (normale)';
      icon = st.currentPrice > 25 ? '🔴' : st.currentPrice > 20 ? '🟡' : '🟢';
    }

    var ddText = '';
    if (instr.id !== 'VIX') {
      ddText = ' | DD: <b>' + st.drawdown6m.toFixed(1) + '%</b>';
    }

    var line = icon + ' <b>' + instr.name + '</b>: ' + st.currentPrice.toFixed(dec) + ddText + interpretation;
    if (categories[instr.category]) {
      categories[instr.category].items.push(line);
    }
  }

  // Costruisci messaggio
  var msg = '<b>[MACRO] Briefing Settimanale</b>' + nl + '<i>' + dateStr + ' UTC</i>' + nl + nl +
            '<b>Regime attuale: ' + regimeInfo.regime + '</b>' + nl;
  if (regimeInfo.reasoning) {
    msg += '<i>' + regimeInfo.reasoning + '</i>' + nl;
  }
  msg += nl;

  Object.keys(categories).forEach(function(cat) {
    var c = categories[cat];
    if (c.items.length) {
      msg += '<b>' + c.title + '</b>' + nl;
      msg += c.items.join(nl) + nl + nl;
    }
  });

  // Sintesi opportunita: strumenti in alert per possibili acquisti
  var opportunities = MACRO_INSTRUMENTS
    .map(function(instr) { return macroState[instr.id]; })
    .filter(function(st) { return st && st.instrument.id !== 'VIX' &&
                                  (st.status === 'alert' || st.status === 'warn'); })
    .sort(function(a, b) { return a.drawdown6m - b.drawdown6m; });

  if (opportunities.length > 0) {
    msg += '<b>💡 Opportunita da monitorare</b>' + nl;
    opportunities.forEach(function(st) {
      msg += '• ' + st.instrument.name + ' a <b>' + st.drawdown6m.toFixed(1) + '%</b> dai massimi 6m' + nl;
    });
    msg += nl + '<i>Valutare ingressi scaglionati, non tutto in una volta.</i>';
  } else {
    msg += '<i>Nessun drawdown significativo in corso. Fase di mercato tranquilla.</i>';
  }

  var ok = await tgSend(msg);
  if (ok) {
    lastBriefSent = Date.now();
    console.log('MACRO briefing settimanale inviato');
  }
}

// Scheduler briefing: verifica ogni ora
function startBriefScheduler() {
  if (macroBriefTimer) clearInterval(macroBriefTimer);
  macroBriefTimer = setInterval(async function() {
    if (isTimeForBrief()) {
      await sendWeeklyBrief();
    }
  }, 60 * 60 * 1000); // ogni ora
}

// Watchdog Macro: riavvia loop se bloccato oltre 3 ore
setInterval(async function() {
  if (!macroRunning) return;
  var elapsed = Date.now() - lastMacroLoopTime;
  if (lastMacroLoopTime > 0 && elapsed > 3 * 60 * 60 * 1000) {
    console.log('Macro Watchdog: loop bloccato da ' + Math.round(elapsed/60000) + 'min, riavvio...');
    if (macroTimer) clearInterval(macroTimer);
    startMacroLoop();
    await tgSend('<i>Macro Monitor riavviato dal watchdog</i>');
  }
}, 15 * 60 * 1000);

// ══════════════════════════════════════
// API ENDPOINTS MACRO
// ══════════════════════════════════════

app.get('/api/macro-status', function(req, res) {
  var state = {};
  MACRO_INSTRUMENTS.forEach(function(instr) {
    var st = macroState[instr.id];
    if (!st) return;
    state[instr.id] = {
      name: instr.name,
      category: instr.category,
      currentPrice: st.currentPrice,
      max3m: st.max3m,
      max6m: st.max6m,
      drawdown3m: st.drawdown3m,
      drawdown6m: st.drawdown6m,
      status: st.status,
      candleCount: st.candlesD1.length,
      lastUpdateTime: st.lastUpdateTime,
      lastAlertLevel: st.lastAlertLevel,
      lastAlertTime: st.lastAlertTime
    };
  });
  res.json({
    macroRunning: macroRunning,
    instruments: MACRO_INSTRUMENTS.map(function(i) { return i.id; }),
    warnPct: MACRO_WARN_PCT,
    alertPct: MACRO_ALERT_PCT,
    refreshSec: MACRO_REFRESH_SEC,
    briefEnabled: MACRO_BRIEF_ENABLED,
    lastLoopTime: lastMacroLoopTime,
    lastBriefSent: lastBriefSent,
    state: state,
    regime: classifyRegime()
  });
});

app.post('/api/macro-start', async function(req, res) {
  macroRunning = true;
  startMacroLoop();
  startBriefScheduler();
  await tgSend('<b>Macro Monitor avviato</b>\n' +
               'Strumenti: ' + MACRO_INSTRUMENTS.length + '\n' +
               'Soglie: warn ' + MACRO_WARN_PCT + '% / alert ' + MACRO_ALERT_PCT + '%\n' +
               'Briefing settimanale: ' + (MACRO_BRIEF_ENABLED ? 'attivo lunedi 9 UTC' : 'disattivo'));
  res.json({ ok: true, message: 'Macro Monitor avviato' });
});

app.post('/api/macro-stop', async function(req, res) {
  macroRunning = false;
  if (macroTimer) clearInterval(macroTimer);
  if (macroBriefTimer) clearInterval(macroBriefTimer);
  await tgSend('Macro Monitor fermato');
  res.json({ ok: true });
});

// Endpoint per forzare l'invio del briefing manualmente (per test)
app.post('/api/macro-brief-now', async function(req, res) {
  await sendWeeklyBrief();
  res.json({ ok: true, message: 'Briefing inviato manualmente' });
});

// ══════════════════════════════════════════════════════════════════════════════
// ██████████████████████████████████████████████████████████████████████████████
// FINE MODULO MACRO MONITOR
// ██████████████████████████████████████████████████████████████████████████████
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════
// AVVIO SERVER
// ══════════════════════════════════════
app.listen(PORT, function() {
  console.log('ST-EA v3.3 Server on port ' + PORT);
  console.log('TG: ' + (TG_TOKEN ? 'OK' : '--') + ' | TD: ' + (TD_KEY ? 'OK' : '--'));
  console.log('Trend Bot Symbols: ' + DEFAULT_SYMBOLS.join(', '));
  console.log('PA Bot Symbols: ' + PA_SYMBOLS.join(', '));
  console.log('Macro Monitor Instruments: ' + MACRO_INSTRUMENTS.length);

  // Auto-start trend bot
  console.log('Auto-starting Trend EA on: ' + DEFAULT_SYMBOLS.join(', '));
  activeSymbols = DEFAULT_SYMBOLS.slice();
  activeSymbols.forEach(function(s) { if (!symbolState[s]) initSymbol(s); });
  isRunning = true;

  // Auto-start PA bot
  console.log('Auto-starting PA Bot on: ' + PA_SYMBOLS.join(', '));
  paRunning = true;

  // Auto-start Macro Monitor
  console.log('Auto-starting Macro Monitor');
  macroRunning = true;

  setTimeout(async function() {
    // 1. Trend bot init
    for (var i = 0; i < activeSymbols.length; i++) {
      try { await fetchCandles(activeSymbols[i]); }
      catch(e) { console.error(activeSymbols[i], e.message); }
      await new Promise(function(r) { setTimeout(r, 1000); });
    }
    startLoop(ENV_REFRESH, ENV_COOLDOWN);
    lastLoopTime = Date.now();
    console.log('Trend EA auto-started');

    // 2. PA bot init
    for (var j = 0; j < PA_SYMBOLS.length; j++) {
      try { await fetchPAD1(PA_SYMBOLS[j]); }
      catch(e) { console.error('PA init ' + PA_SYMBOLS[j] + ': ' + e.message); }
      var paDelay = CRYPTO.indexOf(PA_SYMBOLS[j]) !== -1 ? 500 : 2500;
      await new Promise(function(r) { setTimeout(r, paDelay); });
    }
    startPALoop();
    console.log('PA Bot auto-started');

    // 3. Macro Monitor init
    startMacroLoop();
    startBriefScheduler();
    console.log('Macro Monitor auto-started');

    await tgSend('<b>ST-EA v3.3 Online — Triple Bot</b>' +
                 '\n<b>Trend M15:</b> ' + activeSymbols.join(', ') +
                 '\n<b>PA D1:</b> ' + PA_SYMBOLS.join(', ') +
                 '\n<b>Macro:</b> ' + MACRO_INSTRUMENTS.length + ' strumenti monitorati' +
                 '\nBriefing settimanale: lunedi ' + MACRO_BRIEF_HOUR + ':00 UTC');
  }, 5000);
});
