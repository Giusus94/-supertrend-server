const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ══════════════════════════════════════════════════════════════════════════════
// ST-EA Server -- Triple Bot Edition
//
// Tre bot operativi indipendenti:
//   1. Trend Bot M15  -- triplo SuperTrend con flip 3/3 stretto + ADX min
//   2. PA Bot D1      -- pattern candlestick + trend D1/H4 + S/R
//   3. ORB Bot        -- Opening Range Breakout su 5 indici globali
//                       (US500, US100, GER40, UK100, JP225)
// ══════════════════════════════════════════════════════════════════════════════

const PORT        = process.env.PORT       || 3000;
const TG_TOKEN    = process.env.TG_TOKEN   || '';
const TG_CHAT_ID  = process.env.TG_CHAT_ID || '';
const TD_KEY      = process.env.TD_KEY     || '';
const RENDER_URL  = process.env.RENDER_URL || '';

// ══════════════════════════════════════
// CONFIGURAZIONE SIMBOLI (Trend + PA)
// ══════════════════════════════════════
const CRYPTO = ['BTCUSD','ETHUSD','SOLUSD','XRPUSD','BNBUSD','ADAUSD'];
const METALS = ['XAUUSD','XAGUSD','WTIUSD','BRNUSD','USOIL','UKOIL'];
const FOREX  = ['EURUSD','GBPUSD','USDJPY','GBPJPY','AUDUSD','USDCAD','USDCHF','NZDUSD'];

const SYMBOL_CONFIG = {
  XAUUSD: { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: false },
  XAGUSD: { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: false },
  WTIUSD: { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  BRNUSD: { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  USOIL:  { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  UKOIL:  { slMult: 1.8, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  EURUSD: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  GBPUSD: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  USDJPY: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  GBPJPY: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  AUDUSD: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  USDCAD: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  USDCHF: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
  NZDUSD: { slMult: 1.5, rr: 2.0, adxMin: 10, allowLong: true, allowShort: true  },
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
// STATO GLOBALE TREND BOT
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
// INDICATORI TECNICI (condivisi)
// ══════════════════════════════════════
function calcATR(c, p) {
  var t = [];
  for (var i = 1; i < c.length; i++)
    t.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close)));
  var a = [t[0]];
  for (var j = 1; j < t.length; j++) a.push((a[j-1] * (p-1) + t[j]) / p);
  return a;
}

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

function calcEMA(c, p) {
  if (c.length < p) return c[c.length-1].close;
  var k = 2/(p+1), ema = 0;
  for (var i = 0; i < p; i++) ema += c[i].close;
  ema = ema/p;
  for (var j = p; j < c.length; j++) ema = c[j].close*k + ema*(1-k);
  return ema;
}

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
  if (ny.day === 6) return false;
  if (ny.day === 0 && ny.time < 1700) return false;
  if (ny.day === 5 && ny.time >= 1700) return false;
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
    await fetchOKX(sym, '15m', 200, 'candles', st);
  } else {
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
// GENERAZIONE SEGNALE TREND BOT
// ══════════════════════════════════════════════════════════════════════════════
async function checkSignal(sym, cooldownMin) {
  try {
    var st = symbolState[sym];
    if (!st || !st.candles.length || !isRunning) return;

    var cfg = getConfig(sym);
    cooldownMin = cooldownMin || 15;

    if (Date.now() - st.lastSignalTime < cooldownMin * 60 * 1000) return;

    var mStatus = getMarketStatus(sym);
    if (mStatus) { st.stats.lastFilter = '[CHIUSO] ' + mStatus; return; }

    var st1 = calcST(st.candles, 7, 2.0);
    var st2 = calcST(st.candles, 14, 3.0);
    var st3 = calcST(st.candles, 21, 4.5);
    if (!st1.length || !st2.length || !st3.length) {
      st.stats.lastFilter = 'Dati insufficienti';
      return;
    }

    var b1 = st1[st1.length-1].dir === 1;
    var b2 = st2[st2.length-1].dir === 1;
    var b3 = st3[st3.length-1].dir === 1;
    var bv = (b1?1:0) + (b2?1:0) + (b3?1:0);
    var sv = 3 - bv;

    var b1p = st1.length >= 2 ? st1[st1.length-2].dir === 1 : b1;
    var b2p = st2.length >= 2 ? st2[st2.length-2].dir === 1 : b2;
    var b3p = st3.length >= 2 ? st3[st3.length-2].dir === 1 : b3;
    var bvPrev = (b1p?1:0) + (b2p?1:0) + (b3p?1:0);
    var svPrev = 3 - bvPrev;

    var b1p2 = st1.length >= 3 ? st1[st1.length-3].dir === 1 : b1p;
    var b2p2 = st2.length >= 3 ? st2[st2.length-3].dir === 1 : b2p;
    var b3p2 = st3.length >= 3 ? st3[st3.length-3].dir === 1 : b3p;
    var bvPrev2 = (b1p2?1:0) + (b2p2?1:0) + (b3p2?1:0);
    var svPrev2 = 3 - bvPrev2;

    var flippedBuy  = bv === 3 && svPrev >= 2;
    var flippedSell = sv === 3 && bvPrev >= 2;

    var recentFlipBuy  = flippedBuy  || (bv === 3 && svPrev2 >= 2);
    var recentFlipSell = flippedSell || (sv === 3 && bvPrev2 >= 2);

    if (!recentFlipBuy && !recentFlipSell) {
      st.stats.lastFilter = 'No flip (ST: ' + bv + 'B/' + sv + 'S)';
      return;
    }

    var dir = null;
    if (recentFlipBuy && cfg.allowLong)   dir = 'BUY';
    if (recentFlipSell && cfg.allowShort) dir = 'SELL';

    if (!dir) {
      st.stats.lastFilter = recentFlipBuy ? 'LONG disabilitato' : 'SHORT disabilitato';
      return;
    }

    if (dir === st.lastDir) {
      st.stats.lastFilter = 'Cooldown: ' + dir + ' gia inviato';
      return;
    }

    var adx = calcADX(st.candles, 14);
    if (adx < cfg.adxMin) {
      st.stats.lastFilter = 'ADX ' + adx.toFixed(1) + ' < ' + cfg.adxMin + ' (mercato piatto)';
      return;
    }

    var price = st.candles[st.candles.length-1].close;
    var dec = price > 1000 ? 2 : price > 10 ? 3 : 4;
    var atrArr = calcATR(st.candles, 14);
    var atr = atrArr[atrArr.length-1] || 0;
    var slDist = Math.max(atr * cfg.slMult, price * 0.005);
    var sl = dir === 'BUY' ? price - slDist : price + slDist;
    var tp = dir === 'BUY' ? price + slDist * cfg.rr : price - slDist * cfg.rr;

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
// LOOP TREND BOT
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
// KEEPALIVE + WATCHDOG TREND
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
// API ENDPOINTS TREND BOT
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

app.post('/api/test', async function(req, res) {
  var ok = await tgSend('ST-EA Minimal - Test OK!\nSimboli: ' + activeSymbols.join(', '));
  res.json({ ok: ok });
});

app.get('/api/candles/:symbol', function(req, res) {
  var st = symbolState[req.params.symbol];
  if (!st) return res.json({ candles: [], candlesH1: [], candlesM5: [] });
  res.json({
    candles: st.candles.slice(-60),
    candlesH1: [],
    candlesM5: []
  });
});

app.get('/api/candles', function(req, res) {
  var st = symbolState[activeSymbols[0]] || { candles: [] };
  res.json({ candles: st.candles.slice(-60), candlesH1: [], candlesM5: [] });
});

app.get('/api/version', function(req, res) {
  res.json({
    version: 'ST-EA Triple Bot: Trend + PA + ORB',
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
    orbBot: {
      enabled: true,
      running: orbRunning,
      symbols: ORB_SYMBOLS,
      timeframe: 'M15 intraday',
      logic: 'Opening Range Breakout (30min) + EMA20 trailing exit',
      orMinutes: 30,
      tradingWindowMinutes: 240
    },
    dataSources: {
      forex: 'TwelveData (primary) + Yahoo (fallback)',
      metals: 'TwelveData (primary) + Yahoo (fallback)',
      crypto: 'OKX',
      indices_orb: 'TwelveData (primary) + Yahoo (fallback)'
    },
    uptimeSec: Math.floor(process.uptime())
  });
});
// ══════════════════════════════════════════════════════════════════════════════
// ██████████████████████████████████████████████████████████████████████████████
// PA BOT D1 -- Price Action su timeframe giornaliero
// ██████████████████████████████████████████████████████████████████████████████
// ══════════════════════════════════════════════════════════════════════════════

var PA_SYMBOLS = process.env.PA_SYMBOLS ? process.env.PA_SYMBOLS.split(',').map(function(s){return s.trim();}) : DEFAULT_SYMBOLS.slice();
var PA_COOLDOWN_HOURS = parseInt(process.env.PA_COOLDOWN_HOURS) || 24;
var PA_REFRESH_SEC = parseInt(process.env.PA_REFRESH_SEC) || 3600;

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
    stats: { total: 0, buys: 0, sells: 0, lastSignal: '--', lastPattern: '--' }
  };
}
PA_SYMBOLS.forEach(initPA);

async function fetchPAD1(sym) {
  var st = paState[sym];
  if (!st) return;

  if (CRYPTO.indexOf(sym) !== -1) {
    try {
      var pair = sym.replace('USD', '-USDT');
      var urlD1 = 'https://www.okx.com/api/v5/market/candles?instId=' + pair + '&bar=1D&limit=100';
      var resD1 = await fetch(urlD1);
      var dataD1 = await resD1.json();
      if (dataD1.code === '0' && Array.isArray(dataD1.data) && dataD1.data.length > 10) {
        st.candlesD1 = dataD1.data.reverse().map(function(k) {
          return { open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5] };
        });
      }
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

  if (TD_KEY) {
    try {
      var mapped = TD_MAP[sym] || sym;
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

  if (!st.candlesD1.length || !st.candlesH4.length) {
    try {
      var ticker = YAHOO_MAP[sym];
      if (ticker) {
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

  var avgRange = 0;
  for (var i = len-10; i < len; i++) {
    if (i >= 0) avgRange += (candles[i].high - candles[i].low);
  }
  avgRange = avgRange / 10;

  if (range0 < avgRange * 0.7) return [];

  var c5 = candles[len-6];
  var priorDown = c5 && c5.close > c2.open;
  var priorUp = c5 && c5.close < c2.open;

  if (priorDown && !isBull2 && body2 > avgRange * 0.5 &&
      body1 < range1 * 0.25 && range1 > 0 &&
      isBull0 && body0 > avgRange * 0.5 &&
      c0.close > (c2.open + c2.close) / 2) {
    patterns.push({ name: 'Morning Star', dir: 'BUY', strength: 4 });
  }

  if (priorUp && isBull2 && body2 > avgRange * 0.5 &&
      body1 < range1 * 0.25 && range1 > 0 &&
      !isBull0 && body0 > avgRange * 0.5 &&
      c0.close < (c2.open + c2.close) / 2) {
    patterns.push({ name: 'Evening Star', dir: 'SELL', strength: 4 });
  }

  var priorDown2 = !isBull1 && !isBull2;
  if (priorDown2 && isBull0 &&
      c0.open < c1.close && c0.close > c1.open &&
      body0 > body1 * 1.5 && body0 > avgRange * 0.6) {
    patterns.push({ name: 'Bullish Engulfing', dir: 'BUY', strength: 3 });
  }

  var priorUp2 = isBull1 && isBull2;
  if (priorUp2 && !isBull0 &&
      c0.open > c1.close && c0.close < c1.open &&
      body0 > body1 * 1.5 && body0 > avgRange * 0.6) {
    patterns.push({ name: 'Bearish Engulfing', dir: 'SELL', strength: 3 });
  }

  if (lower0 > body0 * 3 && upper0 < body0 * 0.5 && body0 > 0 && range0 > avgRange * 0.8) {
    patterns.push({ name: 'Pin Bar Bull', dir: 'BUY', strength: 3 });
  }

  if (upper0 > body0 * 3 && lower0 < body0 * 0.5 && body0 > 0 && range0 > avgRange * 0.8) {
    patterns.push({ name: 'Pin Bar Bear', dir: 'SELL', strength: 3 });
  }

  return patterns;
}

function calcPASR(candles, lookback) {
  lookback = lookback || 60;
  var r = candles.slice(-lookback);
  var levels = [];
  for (var i = 2; i < r.length - 2; i++) {
    if (r[i].high > r[i-1].high && r[i].high > r[i-2].high &&
        r[i].high > r[i+1].high && r[i].high > r[i+2].high) {
      levels.push({ price: r[i].high, type: 'R', strength: 1 });
    }
    if (r[i].low < r[i-1].low && r[i].low < r[i-2].low &&
        r[i].low < r[i+1].low && r[i].low < r[i+2].low) {
      levels.push({ price: r[i].low, type: 'S', strength: 1 });
    }
  }
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

async function checkPASignal(sym) {
  try {
    var st = paState[sym];
    if (!st || !st.candlesD1.length || !paRunning) return;

    if (Date.now() - st.lastSignalTime < PA_COOLDOWN_HOURS * 60 * 60 * 1000) return;

    var ms = getMarketStatus(sym);
    if (ms) {
      st.stats.lastPattern = '[CHIUSO] ' + ms;
      return;
    }

    var c = st.candlesD1;
    var patterns = detectPAPatterns(c);
    if (!patterns.length) {
      st.stats.lastPattern = 'Nessun pattern';
      return;
    }

    var strong = patterns.filter(function(p) { return p.strength >= 3; });
    if (!strong.length) {
      st.stats.lastPattern = 'Pattern deboli';
      return;
    }

    strong.sort(function(a, b) { return b.strength - a.strength; });
    var best = strong[0];

    var d1Trend = getD1Trend(c);
    if (d1Trend && d1Trend !== best.dir) {
      st.stats.lastPattern = 'D1 trend contro (' + d1Trend + ' vs ' + best.dir + ')';
      return;
    }

    var h4Trend = getH4Trend(st.candlesH4);
    if (h4Trend && h4Trend !== best.dir) {
      st.stats.lastPattern = 'H4 trend contro (' + h4Trend + ')';
      return;
    }

    if (best.dir === st.lastDir) {
      st.stats.lastPattern = 'Stessa direzione precedente';
      return;
    }

    var price = c[c.length-1].close;
    var dec = price > 1000 ? 2 : price > 10 ? 3 : 4;
    var atrArr = calcATR(c, 14);
    var atr = atrArr[atrArr.length-1] || 0;

    var srLevels = calcPASR(c, 60);
    if (!isPANearSR(price, srLevels, atr)) {
      st.stats.lastPattern = best.name + ' ma non su S/R';
      return;
    }

    var slDist = Math.max(atr * 2.0, price * 0.008);
    var tpDist = slDist * 2.5;
    var sl = (best.dir === 'BUY' ? price - slDist : price + slDist).toFixed(dec);
    var tp = (best.dir === 'BUY' ? price + tpDist : price - tpDist).toFixed(dec);

    var lots = [100, 500, 1000].map(function(b) {
      return b + 'EUR: ' + calcLotSize(sym, b, 3, slDist) + ' lot';
    }).join(' | ');

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

async function runPALoop() {
  lastPALoopTime = Date.now();
  for (var i = 0; i < PA_SYMBOLS.length; i++) {
    var sym = PA_SYMBOLS[i];
    try {
      await fetchPAD1(sym);
      await checkPASignal(sym);
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
  runPALoop();
  paTimer = setInterval(runPALoop, PA_REFRESH_SEC * 1000);
}

setInterval(async function() {
  if (!paRunning) return;
  var elapsed = Date.now() - lastPALoopTime;
  if (lastPALoopTime > 0 && elapsed > 2 * 60 * 60 * 1000) {
    console.log('PA Watchdog: loop bloccato, riavvio...');
    if (paTimer) clearInterval(paTimer);
    startPALoop();
    await tgSend('<i>PA Bot riavviato dal watchdog</i>');
  }
}, 10 * 60 * 1000);

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
// ORB BOT -- Opening Range Breakout su indici
// ██████████████████████████████████████████████████████████████████████████████
// ══════════════════════════════════════════════════════════════════════════════
//
// Bot operativo che monitora 5 indici globali e genera segnali su breakout
// dell'Opening Range dei primi 30 minuti dell'apertura cash di ogni mercato.
//
// Strategia:
//   1. All'apertura cash di ogni mercato (NY, EU, UK, JP), costruisce l'OR
//      con high/low dei primi 30 minuti
//   2. Quando una candela M15 chiude oltre l'OR -> entry nella direzione del
//      breakout, SL = lato opposto del range
//   3. Trailing su EMA20 M15: chiude se candela chiude oltre EMA20 contro la
//      direzione del trade
//   4. Filtri qualita: OR width tra 0.3% e 1.5%, ADX H1 >= 15, finestra
//      operativa max 4 ore post-OR, 1 trade per simbolo per sessione
//
// DST: orari di apertura sono in tz locale dell'exchange, i timestamp UTC
// vengono ricalcolati ogni giorno automaticamente via Intl.DateTimeFormat
// che gestisce il cambio ora legale per ogni timezone in modo nativo.
// ══════════════════════════════════════════════════════════════════════════════

var ORB_SYMBOLS = ['US500', 'US100', 'GER40', 'UK100', 'JP225'];

var ORB_TD_MAP = {
  US500: 'SPX', US100: 'NDX', GER40: 'DAX',
  UK100: 'UKX', JP225: 'N225'
};

var ORB_YAHOO_MAP = {
  US500: '%5EGSPC', US100: '%5ENDX', GER40: '%5EGDAXI',
  UK100: '%5EFTSE', JP225: '%5EN225'
};

var ORB_NAMES = {
  US500: 'S&P 500', US100: 'Nasdaq 100', GER40: 'DAX 40',
  UK100: 'FTSE 100', JP225: 'Nikkei 225'
};

var ORB_PRICE_RANGES = {
  US500: [3000, 10000], US100: [10000, 40000], GER40: [10000, 40000],
  UK100: [5000, 15000], JP225: [20000, 80000]
};

// Sessioni cash - orari LOCALI dell'exchange, DST gestito automaticamente
var ORB_SESSIONS = {
  US500: { localTz: 'America/New_York', openHH: 9,  openMM: 30, durationMin: 30, tradingWindowMin: 240 },
  US100: { localTz: 'America/New_York', openHH: 9,  openMM: 30, durationMin: 30, tradingWindowMin: 240 },
  GER40: { localTz: 'Europe/Berlin',    openHH: 9,  openMM: 0,  durationMin: 30, tradingWindowMin: 240 },
  UK100: { localTz: 'Europe/London',    openHH: 8,  openMM: 0,  durationMin: 30, tradingWindowMin: 240 },
  JP225: { localTz: 'Asia/Tokyo',       openHH: 9,  openMM: 0,  durationMin: 30, tradingWindowMin: 240 }
};

var ORB_REFRESH_SEC = parseInt(process.env.ORB_REFRESH_SEC) || 300;

var orbState = {};
var orbRunning = false;
var orbTimer = null;
var lastOrbLoopTime = 0;

function initORB(s) {
  orbState[s] = {
    candlesM15: [],
    candlesH1: [],
    sessionDate: null,
    orHigh: null,
    orLow: null,
    orStartTs: null,
    orEndTs: null,
    windowEndTs: null,
    orComplete: false,
    activeTrade: null,
    sessionDone: false,
    stats: { total: 0, buys: 0, sells: 0, wins: 0, losses: 0, lastSignal: '--', lastFilter: '--' },
    log: []
  };
}
ORB_SYMBOLS.forEach(initORB);

// ──────────────────────────────────────
// UTILITY DATE/ORE CON DST
// ──────────────────────────────────────
function getSessionDateInTz(tz) {
  var fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date());
}

function getUtcTimestampForLocal(dateStr, hh, mm, tz) {
  var parts = dateStr.split('-');
  var y = +parts[0], mo = +parts[1] - 1, d = +parts[2];
  var guess = new Date(Date.UTC(y, mo, d, hh, mm, 0));

  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  var localParts = fmt.formatToParts(guess);
  var lp = {};
  for (var i = 0; i < localParts.length; i++) lp[localParts[i].type] = localParts[i].value;
  var localHH = +lp.hour, localMM = +lp.minute;

  var diffMin = (hh * 60 + mm) - (localHH * 60 + localMM);
  if (diffMin > 12 * 60) diffMin -= 24 * 60;
  if (diffMin < -12 * 60) diffMin += 24 * 60;

  return guess.getTime() + diffMin * 60 * 1000;
}

function isWeekendInTz(tz) {
  var fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  var wd = fmt.format(new Date());
  return wd === 'Sat' || wd === 'Sun';
}

function isOrbValidPrice(sym, price) {
  var r = ORB_PRICE_RANGES[sym];
  return r ? price >= r[0] && price <= r[1] : true;
}

// ──────────────────────────────────────
// FETCH CANDELE INDICI
// ──────────────────────────────────────
async function fetchOrbCandles(sym, interval, target) {
  var st = orbState[sym];
  if (!st) return false;

  if (TD_KEY) {
    try {
      var mapped = ORB_TD_MAP[sym] || sym;
      var outputsize = interval === '15min' ? 200 : 100;
      var url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(mapped) +
                '&interval=' + interval + '&outputsize=' + outputsize + '&apikey=' + TD_KEY;
      var res = await fetch(url);
      var data = await res.json();
      if (data.status !== 'error' && data.values && data.values.length > 10) {
        var parsed = data.values.reverse().map(function(c) {
          return {
            time: new Date(c.datetime).getTime(),
            open: +c.open, high: +c.high, low: +c.low, close: +c.close,
            vol: +(c.volume || 0)
          };
        });
        var lastClose = parsed[parsed.length-1].close;
        if (isOrbValidPrice(sym, lastClose)) {
          st[target] = parsed;
          return true;
        }
        console.error('ORB ' + sym + ' TD: prezzo ' + lastClose + ' fuori range, fallback');
      }
    } catch(e) { console.error('ORB TD ' + sym + ': ' + e.message); }
  }

  try {
    var ticker = ORB_YAHOO_MAP[sym];
    if (!ticker) return false;
    var yahooInt = interval === '15min' ? '15m' : '1h';
    var range = interval === '15min' ? '5d' : '30d';
    var yurl = 'https://query2.finance.yahoo.com/v8/finance/chart/' +
               ticker + '?interval=' + yahooInt + '&range=' + range;
    var yres = await fetch(yurl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    var ydata = await yres.json();
    var chart = ydata && ydata.chart && ydata.chart.result && ydata.chart.result[0];
    if (!chart || !chart.timestamp) return false;
    var q = chart.indicators.quote[0];
    var parsed = [];
    for (var i = 0; i < chart.timestamp.length; i++) {
      if (q.open[i] && q.high[i] && q.low[i] && q.close[i]) {
        parsed.push({
          time: chart.timestamp[i] * 1000,
          open: +q.open[i], high: +q.high[i], low: +q.low[i], close: +q.close[i],
          vol: q.volume[i] || 0
        });
      }
    }
    if (parsed.length < 10) return false;
    var lastClose2 = parsed[parsed.length-1].close;
    if (!isOrbValidPrice(sym, lastClose2)) {
      console.error('ORB ' + sym + ' Yahoo: prezzo ' + lastClose2 + ' fuori range');
      return false;
    }
    st[target] = parsed;
    return true;
  } catch(e) { return false; }
}

// ──────────────────────────────────────
// LOGICA SESSIONE
// ──────────────────────────────────────
function checkAndResetOrbSession(sym) {
  var st = orbState[sym];
  var cfg = ORB_SESSIONS[sym];
  if (!cfg) return;

  var todayLocal = getSessionDateInTz(cfg.localTz);
  if (st.sessionDate === todayLocal) return;

  var openTs = getUtcTimestampForLocal(todayLocal, cfg.openHH, cfg.openMM, cfg.localTz);
  var endOrTs = openTs + cfg.durationMin * 60 * 1000;
  var endWindowTs = endOrTs + cfg.tradingWindowMin * 60 * 1000;

  st.sessionDate = todayLocal;
  st.orStartTs = openTs;
  st.orEndTs = endOrTs;
  st.windowEndTs = endWindowTs;
  st.orHigh = null;
  st.orLow = null;
  st.orComplete = false;
  st.activeTrade = null;
  st.sessionDone = false;
  st.stats.lastFilter = 'Sessione resettata: OR ' + cfg.openHH + ':' +
                       (cfg.openMM < 10 ? '0' : '') + cfg.openMM + ' (' + cfg.localTz + ')';
}

function buildOpeningRange(sym) {
  var st = orbState[sym];
  if (!st || !st.candlesM15.length || !st.orStartTs) return false;

  var orCandles = st.candlesM15.filter(function(c) {
    return c.time >= st.orStartTs && c.time < st.orEndTs;
  });

  if (!orCandles.length) return false;

  var hi = -Infinity, lo = Infinity;
  for (var i = 0; i < orCandles.length; i++) {
    if (orCandles[i].high > hi) hi = orCandles[i].high;
    if (orCandles[i].low < lo) lo = orCandles[i].low;
  }

  st.orHigh = hi;
  st.orLow = lo;

  var lastCandle = st.candlesM15[st.candlesM15.length - 1];
  if (lastCandle.time >= st.orEndTs - 15 * 60 * 1000) {
    st.orComplete = true;
  }
  return true;
}

// ──────────────────────────────────────
// CHECK SEGNALE BREAKOUT
// ──────────────────────────────────────
async function checkOrbSignal(sym) {
  var st = orbState[sym];
  var cfg = ORB_SESSIONS[sym];
  if (!st || !cfg || !orbRunning) return;
  if (st.sessionDone) return;
  if (st.activeTrade) return;

  if (isWeekendInTz(cfg.localTz)) {
    st.stats.lastFilter = 'Weekend';
    return;
  }

  if (!st.candlesM15.length) {
    st.stats.lastFilter = 'No dati M15';
    return;
  }

  var now = Date.now();

  if (now < st.orEndTs) {
    var minToOr = Math.round((st.orEndTs - now) / 60000);
    st.stats.lastFilter = 'OR in costruzione (-' + minToOr + 'min)';
    return;
  }

  if (now > st.windowEndTs) {
    st.stats.lastFilter = 'Finestra operativa chiusa';
    st.sessionDone = true;
    return;
  }

  if (!st.orComplete) {
    if (!buildOpeningRange(sym)) {
      st.stats.lastFilter = 'OR incompleto';
      return;
    }
  }

  if (st.orHigh === null || st.orLow === null) return;

  var lastClose = st.candlesM15[st.candlesM15.length - 1].close;
  var orWidth = st.orHigh - st.orLow;
  var orPct = orWidth / lastClose;

  if (orPct < 0.003) {
    st.stats.lastFilter = 'OR troppo stretto (' + (orPct * 100).toFixed(2) + '%)';
    return;
  }
  if (orPct > 0.015) {
    st.stats.lastFilter = 'OR troppo ampio (' + (orPct * 100).toFixed(2) + '%)';
    st.sessionDone = true;
    return;
  }

  if (st.candlesH1 && st.candlesH1.length >= 30) {
    var adxH1 = calcADX(st.candlesH1, 14);
    if (adxH1 < 15) {
      st.stats.lastFilter = 'ADX H1 troppo basso (' + adxH1.toFixed(1) + ')';
      return;
    }
  }

  var len = st.candlesM15.length;
  if (len < 2) return;
  var lastClosed = st.candlesM15[len - 2];

  if (lastClosed.time < st.orEndTs) {
    st.stats.lastFilter = 'Attesa prima candela post-OR';
    return;
  }

  var dir = null;
  if (lastClosed.close > st.orHigh) dir = 'BUY';
  else if (lastClosed.close < st.orLow) dir = 'SELL';

  if (!dir) {
    st.stats.lastFilter = 'No breakout (close ' + lastClosed.close.toFixed(2) +
                          ' tra OR ' + st.orLow.toFixed(2) + '-' + st.orHigh.toFixed(2) + ')';
    return;
  }

  var entry = lastClosed.close;
  var sl = dir === 'BUY' ? st.orLow : st.orHigh;
  var slDist = Math.abs(entry - sl);
  var dec = entry > 1000 ? 2 : entry > 10 ? 3 : 4;
  var name = ORB_NAMES[sym] || sym;
  var nl = '\n';
  var time = new Date().toUTCString().slice(0, 25);

  var msg =
    '<b>[ORB-EA] ' + dir + ' ' + name + '</b> (' + sym + ')' + nl +
    '<b>Entry:</b> ' + entry.toFixed(dec) + nl +
    '<b>SL (OR opposto):</b> ' + sl.toFixed(dec) + nl +
    '<b>Distanza SL:</b> ' + slDist.toFixed(dec) + ' (' + (slDist / entry * 100).toFixed(2) + '%)' + nl +
    '<b>OR Width:</b> ' + orWidth.toFixed(dec) + ' (' + (orPct * 100).toFixed(2) + '%)' + nl +
    '<b>Uscita:</b> Trailing su EMA20 M15' + nl +
    '<i>Sessione: ' + cfg.localTz + ' | ' + time + ' UTC</i>';

  var ok = await tgSend(msg);
  if (ok) {
    st.activeTrade = {
      dir: dir,
      entry: entry,
      sl: sl,
      openTime: now,
      currentEMA20: null,
      maxFavorable: entry,
      minFavorable: entry
    };
    st.stats.total++;
    if (dir === 'BUY') st.stats.buys++; else st.stats.sells++;
    st.stats.lastSignal = dir;
    st.stats.lastFilter = 'TRADE APERTO: ' + dir + ' @ ' + entry.toFixed(dec);
    st.log.unshift({ event: 'OPEN', dir: dir, price: entry.toFixed(dec), time: time });
    if (st.log.length > 20) st.log.pop();
    globalStats.total++;
    if (dir === 'BUY') globalStats.buys++; else globalStats.sells++;
    globalLog.unshift({ dir: dir, price: entry.toFixed(dec), time: time, sym: sym, source: 'ORB' });
    if (globalLog.length > 50) globalLog.pop();
    console.log('ORB SIGNAL: ' + sym + ' ' + dir + ' @ ' + entry.toFixed(dec));
  }
}

// ──────────────────────────────────────
// TRAILING EMA20 M15
// ──────────────────────────────────────
async function checkOrbTrailing(sym) {
  var st = orbState[sym];
  if (!st || !st.activeTrade || !st.candlesM15.length) return;

  var trade = st.activeTrade;
  var len = st.candlesM15.length;
  if (len < 21) return;

  var lastClosed = st.candlesM15[len - 2];
  var ema20 = calcEMA(st.candlesM15.slice(0, len - 1), 20);
  trade.currentEMA20 = ema20;

  if (lastClosed.high > trade.maxFavorable) trade.maxFavorable = lastClosed.high;
  if (lastClosed.low < trade.minFavorable) trade.minFavorable = lastClosed.low;

  var dec = trade.entry > 1000 ? 2 : trade.entry > 10 ? 3 : 4;
  var name = ORB_NAMES[sym] || sym;
  var nl = '\n';
  var now = Date.now();

  var slHit = false;
  if (trade.dir === 'BUY' && lastClosed.low <= trade.sl) slHit = true;
  if (trade.dir === 'SELL' && lastClosed.high >= trade.sl) slHit = true;

  var trailHit = false;
  if (trade.dir === 'BUY' && lastClosed.close < ema20) trailHit = true;
  if (trade.dir === 'SELL' && lastClosed.close > ema20) trailHit = true;

  var windowExpired = now > st.windowEndTs;

  if (!slHit && !trailHit && !windowExpired) return;

  var exitPrice = lastClosed.close;
  var exitReason = slHit ? 'STOP LOSS' : trailHit ? 'TRAILING EMA20' : 'FINE SESSIONE';
  var pnl = trade.dir === 'BUY' ? (exitPrice - trade.entry) : (trade.entry - exitPrice);
  var pnlPct = (pnl / trade.entry) * 100;
  var rMultiple = pnl / Math.abs(trade.entry - trade.sl);

  if (pnl > 0) st.stats.wins++; else st.stats.losses++;

  var msg =
    '<b>[ORB-EA] CHIUSURA ' + trade.dir + '</b> ' + name + nl +
    '<b>Entry:</b> ' + trade.entry.toFixed(dec) + nl +
    '<b>Exit:</b> ' + exitPrice.toFixed(dec) + nl +
    '<b>Motivo:</b> ' + exitReason + nl +
    '<b>P/L:</b> ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(dec) +
    ' (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%)' + nl +
    '<b>R-multiple:</b> ' + (rMultiple >= 0 ? '+' : '') + rMultiple.toFixed(2) + 'R' + nl +
    '<i>' + new Date().toUTCString().slice(0, 25) + '</i>';

  await tgSend(msg);
  console.log('ORB CLOSE: ' + sym + ' ' + trade.dir + ' ' + exitReason +
              ' P/L=' + pnl.toFixed(dec) + ' R=' + rMultiple.toFixed(2));

  st.log.unshift({
    event: 'CLOSE', dir: trade.dir,
    entry: trade.entry.toFixed(dec), exit: exitPrice.toFixed(dec),
    reason: exitReason, pnl: pnl.toFixed(dec), r: rMultiple.toFixed(2),
    time: new Date().toUTCString().slice(0, 25)
  });
  if (st.log.length > 20) st.log.pop();

  st.activeTrade = null;
  st.sessionDone = true;
  st.stats.lastFilter = 'Trade chiuso: ' + exitReason;
}

// ──────────────────────────────────────
// LOOP ORB
// ──────────────────────────────────────
async function runOrbLoop() {
  lastOrbLoopTime = Date.now();
  for (var i = 0; i < ORB_SYMBOLS.length; i++) {
    var sym = ORB_SYMBOLS[i];
    var cfg = ORB_SESSIONS[sym];
    if (!cfg) continue;

    try {
      checkAndResetOrbSession(sym);
      var st = orbState[sym];

      if (isWeekendInTz(cfg.localTz)) {
        st.stats.lastFilter = 'Weekend';
        continue;
      }

      if (st.sessionDone && !st.activeTrade) {
        st.stats.lastFilter = 'Sessione conclusa';
        continue;
      }

      var now = Date.now();
      var preOrSafetyMs = 5 * 60 * 1000;

      if (now < st.orStartTs - preOrSafetyMs) {
        var minToOpen = Math.round((st.orStartTs - now) / 60000);
        st.stats.lastFilter = 'Sessione apre tra ' + minToOpen + 'min';
        continue;
      }

      if (now > st.windowEndTs + 15 * 60 * 1000 && !st.activeTrade) {
        st.sessionDone = true;
        st.stats.lastFilter = 'Finestra operativa chiusa';
        continue;
      }

      await fetchOrbCandles(sym, '15min', 'candlesM15');
      await new Promise(function(r) { setTimeout(r, 800); });

      if (!st.candlesH1.length || st.candlesH1.length < 30) {
        await fetchOrbCandles(sym, '1h', 'candlesH1');
        await new Promise(function(r) { setTimeout(r, 800); });
      }

      if (st.activeTrade) {
        await checkOrbTrailing(sym);
      } else {
        await checkOrbSignal(sym);
      }
    } catch(e) {
      console.error('ORB Loop ' + sym + ': ' + e.message);
    }
  }
  console.log('ORB Loop completato @ ' + new Date().toUTCString().slice(17, 25));
}

function startOrbLoop() {
  if (orbTimer) clearInterval(orbTimer);
  runOrbLoop();
  orbTimer = setInterval(runOrbLoop, ORB_REFRESH_SEC * 1000);
}

setInterval(async function() {
  if (!orbRunning) return;
  var elapsed = Date.now() - lastOrbLoopTime;
  if (lastOrbLoopTime > 0 && elapsed > 30 * 60 * 1000) {
    console.log('ORB Watchdog: loop bloccato, riavvio...');
    if (orbTimer) clearInterval(orbTimer);
    startOrbLoop();
    await tgSend('<i>ORB Bot riavviato dal watchdog</i>');
  }
}, 10 * 60 * 1000);

// ──────────────────────────────────────
// API ENDPOINTS ORB BOT
// ──────────────────────────────────────
app.get('/api/orb-status', function(req, res) {
  var orbPs = {};
  for (var i = 0; i < ORB_SYMBOLS.length; i++) {
    var s = ORB_SYMBOLS[i];
    var st = orbState[s];
    if (!st) continue;
    var cfg = ORB_SESSIONS[s];
    orbPs[s] = {
      name: ORB_NAMES[s],
      sessionDate: st.sessionDate,
      sessionTz: cfg ? cfg.localTz : null,
      orHigh: st.orHigh,
      orLow: st.orLow,
      orWidth: (st.orHigh !== null && st.orLow !== null) ? +(st.orHigh - st.orLow).toFixed(4) : null,
      orComplete: st.orComplete,
      orStartTs: st.orStartTs,
      orEndTs: st.orEndTs,
      windowEndTs: st.windowEndTs,
      activeTrade: st.activeTrade,
      sessionDone: st.sessionDone,
      candleCount: st.candlesM15.length,
      stats: st.stats,
      log: st.log.slice(0, 10)
    };
  }
  res.json({
    orbRunning: orbRunning,
    symbols: ORB_SYMBOLS,
    state: orbPs,
    lastLoopTime: lastOrbLoopTime,
    orbLog: globalLog.filter(function(l){ return l.source === 'ORB'; }).slice(0, 20)
  });
});

app.post('/api/orb-start', async function(req, res) {
  orbRunning = true;
  try {
    for (var i = 0; i < ORB_SYMBOLS.length; i++) {
      var s = ORB_SYMBOLS[i];
      checkAndResetOrbSession(s);
      try {
        await fetchOrbCandles(s, '15min', 'candlesM15');
        await new Promise(function(r) { setTimeout(r, 1500); });
        await fetchOrbCandles(s, '1h', 'candlesH1');
        await new Promise(function(r) { setTimeout(r, 1500); });
      } catch(e) {
        console.error('ORB init ' + s + ': ' + e.message);
      }
    }
    startOrbLoop();
    await tgSend('<b>ORB Bot avviato</b>\nIndici: ' + ORB_SYMBOLS.join(', ') +
                 '\nOR 30min | Trailing EMA20 M15');
    res.json({ ok: true, message: 'ORB Bot avviato su ' + ORB_SYMBOLS.join(', ') });
  } catch(e) {
    res.json({ ok: false, message: e.message });
  }
});

app.post('/api/orb-stop', async function(req, res) {
  orbRunning = false;
  if (orbTimer) clearInterval(orbTimer);
  await tgSend('ORB Bot fermato');
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// AVVIO SERVER (auto-start tutti e 3 i bot)
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, function() {
  console.log('ST-EA Server on port ' + PORT);
  console.log('TG: ' + (TG_TOKEN ? 'OK' : '--') + ' | TD: ' + (TD_KEY ? 'OK' : '--'));
  console.log('Trend Bot Symbols: ' + DEFAULT_SYMBOLS.join(', '));
  console.log('PA Bot Symbols: ' + PA_SYMBOLS.join(', '));
  console.log('ORB Bot Indices: ' + ORB_SYMBOLS.join(', '));

  console.log('Auto-starting Trend EA on: ' + DEFAULT_SYMBOLS.join(', '));
  activeSymbols = DEFAULT_SYMBOLS.slice();
  activeSymbols.forEach(function(s) { if (!symbolState[s]) initSymbol(s); });
  isRunning = true;

  console.log('Auto-starting PA Bot on: ' + PA_SYMBOLS.join(', '));
  paRunning = true;

  console.log('Auto-starting ORB Bot');
  orbRunning = true;

  setTimeout(async function() {
    // 1. Trend bot
    for (var i = 0; i < activeSymbols.length; i++) {
      try { await fetchCandles(activeSymbols[i]); }
      catch(e) { console.error(activeSymbols[i], e.message); }
      await new Promise(function(r) { setTimeout(r, 1000); });
    }
    startLoop(ENV_REFRESH, ENV_COOLDOWN);
    lastLoopTime = Date.now();
    console.log('Trend EA auto-started');

    // 2. PA bot
    for (var j = 0; j < PA_SYMBOLS.length; j++) {
      try { await fetchPAD1(PA_SYMBOLS[j]); }
      catch(e) { console.error('PA init ' + PA_SYMBOLS[j] + ': ' + e.message); }
      var paDelay = CRYPTO.indexOf(PA_SYMBOLS[j]) !== -1 ? 500 : 2500;
      await new Promise(function(r) { setTimeout(r, paDelay); });
    }
    startPALoop();
    console.log('PA Bot auto-started');

    // 3. ORB bot
    for (var m = 0; m < ORB_SYMBOLS.length; m++) {
      var s = ORB_SYMBOLS[m];
      checkAndResetOrbSession(s);
      try {
        await fetchOrbCandles(s, '15min', 'candlesM15');
        await new Promise(function(r) { setTimeout(r, 2000); });
        await fetchOrbCandles(s, '1h', 'candlesH1');
      } catch(e) {
        console.error('ORB init ' + s + ': ' + e.message);
      }
      await new Promise(function(r) { setTimeout(r, 2000); });
    }
    startOrbLoop();
    console.log('ORB Bot auto-started');

    await tgSend('<b>ST-EA Online -- Triple Bot</b>' +
                 '\n<b>Trend M15:</b> ' + activeSymbols.join(', ') +
                 '\n<b>PA D1:</b> ' + PA_SYMBOLS.join(', ') +
                 '\n<b>ORB:</b> ' + ORB_SYMBOLS.join(', '));
  }, 5000);
});
