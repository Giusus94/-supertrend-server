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
    version: 'ST-EA Minimal v3.1',
    dataPrimary: { forex: 'TwelveData', metals: 'TwelveData', crypto: 'OKX' },
    dataFallback: { forex: 'Yahoo', metals: 'Yahoo', crypto: 'none' },
    logic: 'triple SuperTrend + flip 3/3 strict + ADX min filter',
    activeSymbols: activeSymbols,
    isRunning: isRunning,
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

// ══════════════════════════════════════
// AVVIO SERVER
// ══════════════════════════════════════
app.listen(PORT, function() {
  console.log('ST-EA Minimal Server on port ' + PORT);
  console.log('TG: ' + (TG_TOKEN ? 'OK' : '--') + ' | TD: ' + (TD_KEY ? 'OK' : '--'));
  console.log('Symbols: ' + DEFAULT_SYMBOLS.join(', '));

  // Auto-start all'avvio
  console.log('Auto-starting EA on: ' + DEFAULT_SYMBOLS.join(', '));
  activeSymbols = DEFAULT_SYMBOLS.slice();
  activeSymbols.forEach(function(s) { if (!symbolState[s]) initSymbol(s); });
  isRunning = true;

  setTimeout(async function() {
    for (var i = 0; i < activeSymbols.length; i++) {
      try { await fetchCandles(activeSymbols[i]); }
      catch(e) { console.error(activeSymbols[i], e.message); }
      await new Promise(function(r) { setTimeout(r, 1000); });
    }
    startLoop(ENV_REFRESH, ENV_COOLDOWN);
    lastLoopTime = Date.now();
    console.log('EA auto-started');
    await tgSend('<b>ST-EA Minimal v3.1 Online</b>\nSimboli: ' + activeSymbols.join(', ') + '\nLogica: triplo SuperTrend + flip 3/3 + ADX minimo\nDati: TwelveData (forex/metalli) + OKX (crypto)');
  }, 5000);
});
