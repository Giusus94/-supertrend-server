const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ══════════════════════════════════════════════════════════════════════════════
// ST-EA Server -- Quad Bot Edition
//
// Quattro bot operativi indipendenti:
//   1. Trend Bot M15  -- Multi-Timeframe Confluence (D1+H4+H1+M15)
//   2. PA Bot D1      -- pattern candlestick + trend D1/H4 + S/R
//   3. ORB Bot        -- Opening Range Breakout su 5 indici globali
//                       (US500, US100, GER40, UK100, JP225)
//   4. Stocks Bot W1  -- Pullback in trend forte su azioni USA + ETF settoriali
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

// ══════════════════════════════════════════════════════════════════════════════
// SYMBOL CONFIG — MTF Confluence
//
// Per la nuova logica Multi-Timeframe Confluence:
//   - SL e' STRUTTURALE (swing low/high M15) — non serve piu' slMult
//   - ADX e' su H1 con soglia fissa 18 — non serve piu' adxMin per simbolo
//   - rr: target R:R per il TP (default 2.5)
//   - allowLong/allowShort: come prima, per restrizioni direzionali
// ══════════════════════════════════════════════════════════════════════════════
const SYMBOL_CONFIG = {
  // Metalli — long-only (oro/argento storicamente trend-forti al rialzo)
  XAUUSD: { rr: 2.5, allowLong: true, allowShort: false },
  XAGUSD: { rr: 2.5, allowLong: true, allowShort: false },
  // Oil — entrambe le direzioni
  WTIUSD: { rr: 2.5, allowLong: true, allowShort: true },
  BRNUSD: { rr: 2.5, allowLong: true, allowShort: true },
  USOIL:  { rr: 2.5, allowLong: true, allowShort: true },
  UKOIL:  { rr: 2.5, allowLong: true, allowShort: true },
  // Forex maggiori
  EURUSD: { rr: 2.5, allowLong: true, allowShort: true },
  GBPUSD: { rr: 2.5, allowLong: true, allowShort: true },
  USDJPY: { rr: 2.5, allowLong: true, allowShort: true },
  GBPJPY: { rr: 2.5, allowLong: true, allowShort: true },
  AUDUSD: { rr: 2.5, allowLong: true, allowShort: true },
  USDCAD: { rr: 2.5, allowLong: true, allowShort: true },
  USDCHF: { rr: 2.5, allowLong: true, allowShort: true },
  NZDUSD: { rr: 2.5, allowLong: true, allowShort: true },
  // Crypto — entrambe direzioni, ma in genere piu' rumorose
  BTCUSD: { rr: 2.5, allowLong: true, allowShort: true },
  ETHUSD: { rr: 2.5, allowLong: true, allowShort: true },
  SOLUSD: { rr: 2.5, allowLong: true, allowShort: true },
  XRPUSD: { rr: 2.5, allowLong: true, allowShort: true },
  BNBUSD: { rr: 2.5, allowLong: true, allowShort: true }
};

function getConfig(sym) {
  return SYMBOL_CONFIG[sym] || { rr: 2.5, allowLong: true, allowShort: true };
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
var ENV_COOLDOWN = parseInt(process.env.COOLDOWN_MIN) || 60;  // 60 min default per MTF

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
    candles: [],          // M15 (entry timeframe)
    candlesH1: [],        // H1 (trend operativo)
    candlesH4: [],        // H4 (struttura)
    candlesD1: [],        // D1 (contesto macro)
    lastDir: null,
    lastSignalTime: 0,
    dailyTradeCount: 0,
    dailyTradeDate: null,
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

function calcADX(c, period) {
  // ADX di Wilder: smoothing esponenziale del DX, non media mobile.
  // Restituisce l'ADX dell'ULTIMO bar disponibile in c.
  // Se vuoi l'ADX del bar chiuso, passa c.slice(0, -1).
  period = period || 14;
  if (c.length < period * 2 + 1) return 0;

  // Step 1: calcola TR, +DM, -DM per ogni bar
  var trArr = [], plusDM = [], minusDM = [];
  for (var i = 1; i < c.length; i++) {
    var tr = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i-1].close),
      Math.abs(c[i].low - c[i-1].close)
    );
    var upMove = c[i].high - c[i-1].high;
    var downMove = c[i-1].low - c[i].low;
    trArr.push(tr);
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Step 2: Wilder smoothing su TR, +DM, -DM (seed = somma primi N)
  var smTR = 0, smPlus = 0, smMinus = 0;
  for (var k = 0; k < period; k++) {
    smTR += trArr[k];
    smPlus += plusDM[k];
    smMinus += minusDM[k];
  }

  // Step 3: per ogni bar successivo, calcola DX = |+DI - -DI| / (+DI + -DI) * 100
  var dxArr = [];
  // Primo DX al bar period-esimo
  var plusDI = smTR > 0 ? (smPlus / smTR) * 100 : 0;
  var minusDI = smTR > 0 ? (smMinus / smTR) * 100 : 0;
  var diSum = plusDI + minusDI;
  dxArr.push(diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0);

  // Bar successivi con Wilder smoothing
  for (var j = period; j < trArr.length; j++) {
    smTR = smTR - smTR / period + trArr[j];
    smPlus = smPlus - smPlus / period + plusDM[j];
    smMinus = smMinus - smMinus / period + minusDM[j];
    plusDI = smTR > 0 ? (smPlus / smTR) * 100 : 0;
    minusDI = smTR > 0 ? (smMinus / smTR) * 100 : 0;
    diSum = plusDI + minusDI;
    dxArr.push(diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0);
  }

  if (dxArr.length < period) return 0;

  // Step 4: ADX = Wilder smoothing del DX (NON media mobile semplice!)
  // Seed = media dei primi `period` valori di DX
  var adx = 0;
  for (var s = 0; s < period; s++) adx += dxArr[s];
  adx = adx / period;

  // Smoothing esponenziale per i bar successivi
  for (var t = period; t < dxArr.length; t++) {
    adx = (adx * (period - 1) + dxArr[t]) / period;
  }

  return adx;
}

function calcEMA(c, p) {
  if (c.length < p) return c[c.length-1].close;
  var k = 2/(p+1), ema = 0;
  for (var i = 0; i < p; i++) ema += c[i].close;
  ema = ema/p;
  for (var j = p; j < c.length; j++) ema = c[j].close*k + ema*(1-k);
  return ema;
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: ritorna le candele garantitamente CHIUSE (esclude l'ultimo bar
// se è ancora in formazione). Determina la chiusura confrontando il timestamp
// dell'ultimo bar con (now - intervallo). Se l'intervallo non è specificato,
// lo deduce dalla differenza tra penultimo e antepenultimo timestamp.
// Questo previene segnali basati su indicatori di un bar in formazione
// che può oscillare drasticamente fino al close.
// ──────────────────────────────────────────────────────────────────────────
function confirmedCandles(c, intervalMs) {
  if (!c || c.length < 3) return c || [];

  // Auto-detect intervallo se non passato (differenza tipica tra due bar chiusi)
  if (!intervalMs) {
    intervalMs = c[c.length - 2].time - c[c.length - 3].time;
  }

  var lastBarTime = c[c.length - 1].time;
  var now = Date.now();

  // Bar è confermato se è passato (intervallo + buffer) dal suo open time
  // Buffer di 5s per gestire delay di delivery dei dati dal provider
  var buffer = 5000;
  if (now < lastBarTime + intervalMs + buffer) {
    // L'ultimo bar è ancora in formazione: rimuovilo
    return c.slice(0, -1);
  }

  return c;
}

function calcRSI(c, p) {
  p = p || 14;
  if (c.length < p + 1) return 50;
  var gains = 0, losses = 0;
  // Initial average gain/loss su primi p periodi
  for (var i = 1; i <= p; i++) {
    var diff = c[i].close - c[i-1].close;
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  var avgGain = gains / p, avgLoss = losses / p;
  // Wilder's smoothing per il resto
  for (var j = p + 1; j < c.length; j++) {
    var d = c[j].close - c[j-1].close;
    var g = d > 0 ? d : 0;
    var l = d < 0 ? Math.abs(d) : 0;
    avgGain = (avgGain * (p - 1) + g) / p;
    avgLoss = (avgLoss * (p - 1) + l) / p;
  }
  if (avgLoss === 0) return 100;
  var rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
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

  var isCrypto = CRYPTO.indexOf(sym) !== -1;

  // ─── M15 (entry timeframe) ───
  if (isCrypto) {
    await fetchOKX(sym, '15m', 200, 'candles', st);
  } else {
    var ok15 = await fetchTD(sym, '15min', 200, 'candles', st);
    if (!ok15) await fetchYahoo(sym, '15m', '5d', 'candles', st);
  }

  // ─── H1 (trend operativo: ADX, EMA20/50 alignment) ───
  if (isCrypto) {
    await fetchOKX(sym, '1H', 100, 'candlesH1', st);
  } else {
    var ok1h = await fetchTD(sym, '1h', 100, 'candlesH1', st);
    if (!ok1h) await fetchYahoo(sym, '1h', '1mo', 'candlesH1', st);
  }

  // ─── H4 (struttura: EMA20, swing detection) ───
  if (isCrypto) {
    await fetchOKX(sym, '4H', 80, 'candlesH4', st);
  } else {
    var ok4h = await fetchTD(sym, '4h', 80, 'candlesH4', st);
    if (!ok4h) await fetchYahoo(sym, '4h', '3mo', 'candlesH4', st);
  }

  // ─── D1 (contesto macro: EMA50/200 trend, RSI estremi) ───
  if (isCrypto) {
    await fetchOKX(sym, '1D', 250, 'candlesD1', st);
  } else {
    var ok1d = await fetchTD(sym, '1day', 250, 'candlesD1', st);
    if (!ok1d) await fetchYahoo(sym, '1d', '1y', 'candlesD1', st);
  }

  var last = st.candles.length ? st.candles[st.candles.length-1].close : 0;
  var src = isCrypto ? 'OKX' : 'TD';
  console.log(sym + ' @ ' + last + ' (M15:' + st.candles.length +
              ' H1:' + st.candlesH1.length + ' H4:' + st.candlesH4.length +
              ' D1:' + st.candlesD1.length + ' src=' + src + ')');
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
// GENERAZIONE SEGNALE TREND BOT — Multi-Timeframe Confluence (MTF)
//
// Multi-Timeframe Confluence (MTF):
// che richiede confluenza di evidenze prima di generare un segnale:
//
//   Layer 1 — D1 (contesto macro):     EMA50>EMA200 + RSI non estremo
//   Layer 2 — H4 (struttura):          Prezzo allineato a EMA20 H4
//   Layer 3 — H1 (trend operativo):    ADX>18 + EMA20>EMA50 alignment
//   Layer 4 — M15 (entry trigger):     pullback EMA20 + candela reversal + RSI exit
//
// Ogni layer agisce come filtro: se uno solo non passa, niente segnale.
// SL strutturale (swing low/high reali) + TP a livelli S/R + trailing su EMA50 H1.
// ══════════════════════════════════════════════════════════════════════════════

// Helper: trova swing low (BUY) o swing high (SELL) nelle ultime N candele
function findSwing(candles, lookback, isLow) {
  if (!candles || candles.length < lookback) return null;
  var slice = candles.slice(-lookback);
  var extreme = isLow ? Infinity : -Infinity;
  for (var i = 0; i < slice.length; i++) {
    var v = isLow ? slice[i].low : slice[i].high;
    if (isLow ? v < extreme : v > extreme) extreme = v;
  }
  return extreme;
}

// Helper: rileva candela di reversal sull'ultimo bar M15 confermato
//   Pattern: bullish/bearish engulfing, pin bar, marubozu direzionale
//   Ritorna: 'BUY' | 'SELL' | null
function detectReversal(c) {
  if (!c || c.length < 3) return null;
  var last = c[c.length - 1];
  var prev = c[c.length - 2];
  var range = last.high - last.low;
  if (range <= 0) return null;
  var body = Math.abs(last.close - last.open);
  var prevBody = Math.abs(prev.close - prev.open);
  var prevRange = prev.high - prev.low;
  var upperWick = last.high - Math.max(last.open, last.close);
  var lowerWick = Math.min(last.open, last.close) - last.low;

  // Bullish engulfing: prev rosso, last verde, body last copre body prev
  var bullEngulf = prev.close < prev.open && last.close > last.open &&
                   last.open <= prev.close && last.close >= prev.open &&
                   body > prevBody;
  // Bearish engulfing
  var bearEngulf = prev.close > prev.open && last.close < last.open &&
                   last.open >= prev.close && last.close <= prev.open &&
                   body > prevBody;

  // Pin bar bullish: ombra sotto > 2x body, ombra sotto > 2x ombra sopra,
  //                  body nella metà superiore della candela
  var pinBull = lowerWick > body * 2 && lowerWick > upperWick * 2 &&
                Math.min(last.open, last.close) > last.low + range * 0.5;
  // Pin bar bearish
  var pinBear = upperWick > body * 2 && upperWick > lowerWick * 2 &&
                Math.max(last.open, last.close) < last.high - range * 0.5;

  // Marubozu forte: body > 70% range, direzione marcata
  var maruBull = last.close > last.open && body > range * 0.7;
  var maruBear = last.close < last.open && body > range * 0.7;

  if (bullEngulf || pinBull || maruBull) return 'BUY';
  if (bearEngulf || pinBear || maruBear) return 'SELL';
  return null;
}

// Helper: pullback verso EMA20 negli ultimi N bar?
//   "ha toccato" = il low/high del bar è stato entro 0.3*ATR dall'EMA20
function hadRecentPullback(c, ema20, atr, lookback, isBuy) {
  if (!c || c.length < lookback) return false;
  var threshold = atr * 0.3;
  var start = c.length - lookback;
  for (var i = start; i < c.length; i++) {
    if (isBuy && c[i].low <= ema20 + threshold) return true;
    if (!isBuy && c[i].high >= ema20 - threshold) return true;
  }
  return false;
}

async function checkSignal(sym, cooldownMin) {
  try {
    var st = symbolState[sym];
    if (!st || !st.candles.length || !isRunning) return;

    var cfg = getConfig(sym);
    cooldownMin = cooldownMin || 60;

    // ─── Cooldown per simbolo ───
    if (Date.now() - st.lastSignalTime < cooldownMin * 60 * 1000) return;

    // ─── Mercato chiuso (forex weekend, ecc) ───
    var mStatus = getMarketStatus(sym);
    if (mStatus) { st.stats.lastFilter = '[CHIUSO] ' + mStatus; return; }

    // ─── Reset contatore daily se cambio giorno ───
    var today = new Date().toISOString().slice(0, 10);
    if (st.dailyTradeDate !== today) {
      st.dailyTradeDate = today;
      st.dailyTradeCount = 0;
    }
    if (st.dailyTradeCount >= 2) {
      st.stats.lastFilter = 'Max 2 trade/giorno raggiunto';
      return;
    }

    // ─── Verifica dati disponibili per tutti i timeframe ───
    if (st.candles.length < 50 || st.candlesH1.length < 60 ||
        st.candlesH4.length < 30 || st.candlesD1.length < 200) {
      st.stats.lastFilter = 'Dati MTF insufficienti (M15:' + st.candles.length +
                            ' H1:' + st.candlesH1.length +
                            ' H4:' + st.candlesH4.length +
                            ' D1:' + st.candlesD1.length + ')';
      return;
    }

    // ─── Bar chiusi per ogni TF (esclude bar in formazione) ───
    var c15 = confirmedCandles(st.candles, 15 * 60 * 1000);
    var cH1 = confirmedCandles(st.candlesH1, 60 * 60 * 1000);
    var cH4 = confirmedCandles(st.candlesH4, 4 * 60 * 60 * 1000);
    var cD1 = confirmedCandles(st.candlesD1, 24 * 60 * 60 * 1000);

    if (c15.length < 30 || cH1.length < 50 || cH4.length < 25 || cD1.length < 200) {
      st.stats.lastFilter = 'Bar chiusi insufficienti dopo confermati';
      return;
    }

    var lastM15 = c15[c15.length - 1];
    var lastH1 = cH1[cH1.length - 1];
    var lastH4 = cH4[cH4.length - 1];
    var lastD1 = cD1[cD1.length - 1];

    // ═════════════════════════════════════════════════════════════
    // LAYER 1 — D1 (contesto macro)
    // ═════════════════════════════════════════════════════════════
    var emaD1_50 = calcEMA(cD1, 50);
    var emaD1_200 = calcEMA(cD1, 200);
    var rsiD1 = calcRSI(cD1, 14);

    var d1Bull = emaD1_50 > emaD1_200 && lastD1.close > emaD1_50;
    var d1Bear = emaD1_50 < emaD1_200 && lastD1.close < emaD1_50;
    var rsiD1Ok = rsiD1 >= 25 && rsiD1 <= 75;

    if (!d1Bull && !d1Bear) {
      st.stats.lastFilter = 'D1: trend non definito (EMA50/200 non allineate)';
      return;
    }
    if (!rsiD1Ok) {
      st.stats.lastFilter = 'D1: RSI estremo (' + rsiD1.toFixed(1) + ', need 30-70)';
      return;
    }

    var biasD1 = d1Bull ? 'BUY' : 'SELL';

    // ═════════════════════════════════════════════════════════════
    // LAYER 2 — H4 (struttura)
    // ═════════════════════════════════════════════════════════════
    var emaH4_20 = calcEMA(cH4, 20);
    var h4Aligned = (biasD1 === 'BUY' && lastH4.close > emaH4_20) ||
                    (biasD1 === 'SELL' && lastH4.close < emaH4_20);

    if (!h4Aligned) {
      st.stats.lastFilter = 'H4 non allineato a bias D1 ' + biasD1;
      return;
    }

    // ═════════════════════════════════════════════════════════════
    // LAYER 3 — H1 (trend operativo)
    // ═════════════════════════════════════════════════════════════
    var adxH1 = calcADX(cH1, 14);
    if (adxH1 < 18) {
      st.stats.lastFilter = 'H1 ADX ' + adxH1.toFixed(1) + ' < 18 (no trend definito)';
      return;
    }

    var emaH1_20 = calcEMA(cH1, 20);
    var emaH1_50 = calcEMA(cH1, 50);
    var h1Aligned = (biasD1 === 'BUY' && emaH1_20 > emaH1_50) ||
                    (biasD1 === 'SELL' && emaH1_20 < emaH1_50);

    if (!h1Aligned) {
      st.stats.lastFilter = 'H1 EMA20/50 non allineate al bias';
      return;
    }

    // ═════════════════════════════════════════════════════════════
    // LAYER 4 — M15 (entry trigger)
    // ═════════════════════════════════════════════════════════════
    var emaM15_20 = calcEMA(c15, 20);
    var rsiM15 = calcRSI(c15, 14);
    var atrArr = calcATR(c15, 14);
    var atr = atrArr[atrArr.length - 1] || 0;

    // 4a. Pullback verso EMA20 nelle ultime 5 candele
    var hadPullback = hadRecentPullback(c15, emaM15_20, atr, 8, biasD1 === 'BUY');
    if (!hadPullback) {
      st.stats.lastFilter = 'M15 no pullback recente verso EMA20';
      return;
    }

    // 4b. RIMOSSO detectReversal: era il filtro killer (taglia 80% dei trade post-L3).
    // I 5 layer D1 trend + H4 align + H1 ADX + pullback + RSI sono gia' confluenti.

    // 4c. RSI esce dalla zona pullback nella direzione corretta
    //     RILASSATO: accetta se RSI sale (BUY) o scende (SELL) ed e' nella zona neutra/favorevole
    //     - BUY: RSI > prev (sta girando su) e RSI tra 35-65 (non estremo, non ipercomprato)
    //     - SELL: RSI < prev (sta girando giu) e RSI tra 35-65
    var rsiM15Prev = calcRSI(c15.slice(0, -1), 14);
    var rsiOk = false;
    if (biasD1 === 'BUY') {
      rsiOk = rsiM15 > rsiM15Prev && rsiM15 >= 35 && rsiM15 <= 65;
    } else {
      rsiOk = rsiM15 < rsiM15Prev && rsiM15 >= 35 && rsiM15 <= 65;
    }
    if (!rsiOk) {
      st.stats.lastFilter = 'M15 RSI not turning in bias direction (now: ' +
                            rsiM15.toFixed(1) + ', prev: ' + rsiM15Prev.toFixed(1) + ')';
      return;
    }

    // ═════════════════════════════════════════════════════════════
    // TUTTI I FILTRI OK — costruisci segnale
    // ═════════════════════════════════════════════════════════════
    var dir = biasD1;
    if (dir === 'BUY' && !cfg.allowLong) {
      st.stats.lastFilter = 'LONG disabilitato per ' + sym;
      return;
    }
    if (dir === 'SELL' && !cfg.allowShort) {
      st.stats.lastFilter = 'SHORT disabilitato per ' + sym;
      return;
    }
    // RIMOSSO dirRepeat: il cooldown 60min + max 2 trade/giorno gia' previene over-trading

    var price = lastM15.close;
    var dec = price > 1000 ? 2 : price > 10 ? 3 : 4;

    // ─── SL strutturale: swing low/high ultimi 10 bar M15 ± buffer ATR ───
    var swing = findSwing(c15, 10, dir === 'BUY');
    var buffer = atr * 0.3;
    var sl = dir === 'BUY' ? swing - buffer : swing + buffer;

    // Sanity: SL distance non più di 1.5% per evitare SL troppo larghi
    var slDist = Math.abs(price - sl);
    var maxSL = price * 0.015;
    if (slDist > maxSL) {
      sl = dir === 'BUY' ? price - maxSL : price + maxSL;
      slDist = maxSL;
    }

    // ─── TP: 1:2.5 di default; se vicino a livello R/S H1, usa quello ───
    var rr = cfg.rr || 2.5;
    var tp = dir === 'BUY' ? price + slDist * rr : price - slDist * rr;

    // Cerca livello S/R H1 nelle ultime 50 candele come TP1 plausibile
    var srLevel = findSwing(cH1.slice(-50), 50, dir === 'SELL');
    var tp1 = null;
    if (dir === 'BUY' && srLevel > price && srLevel < tp) tp1 = srLevel;
    if (dir === 'SELL' && srLevel < price && srLevel > tp) tp1 = srLevel;

    var name = SYMBOL_NAMES[sym] || sym;
    var nl = '\n';
    var time = new Date().toUTCString().slice(0, 25);

    var msg =
      '<b>[MTF-EA] ' + dir + ' ' + name + '</b>' + nl +
      '<b>Prezzo:</b> ' + price.toFixed(dec) + nl +
      '<b>SL:</b> ' + sl.toFixed(dec) + ' | <b>TP:</b> ' + tp.toFixed(dec) + nl +
      (tp1 ? '<b>TP1 (R/S H1):</b> ' + tp1.toFixed(dec) + ' (50% pos)' + nl : '') +
      '<b>R:R:</b> 1:' + rr.toFixed(1) + nl +
      '<b>D1:</b> ' + (d1Bull ? 'BULL' : 'BEAR') + ' RSI ' + rsiD1.toFixed(0) + nl +
      '<b>H1 ADX:</b> ' + adxH1.toFixed(1) + ' | <b>M15 RSI:</b> ' + rsiM15.toFixed(1) + nl +
      '<b>Trail:</b> chiusura M15 sotto EMA50 H1 = exit' + nl +
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
      st.dailyTradeCount++;
      st.log.unshift({
        dir: dir, price: price.toFixed(dec), time: time, sym: sym,
        sl: sl.toFixed(dec), tp: tp.toFixed(dec)
      });
      if (st.log.length > 20) st.log.pop();
      globalStats.total++;
      if (dir === 'BUY') globalStats.buys++; else globalStats.sells++;
      globalLog.unshift({ dir: dir, price: price.toFixed(dec), time: time, sym: sym, source: 'MTF' });
      if (globalLog.length > 50) globalLog.pop();
      console.log('SIGNAL: ' + sym + ' ' + dir + ' @ ' + price.toFixed(dec) +
                  ' (D1:' + (d1Bull ? 'BULL' : 'BEAR') + ' H1ADX:' + adxH1.toFixed(1) + ')');
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
  var symbolStates = {};

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

    // Calcolo stato MTF layers per dashboard analysis page.
    // Stessa logica del checkSignal ma in modalita' "snapshot" (non genera segnali,
    // dice solo qual'e' lo stato corrente di ogni layer).
    var layers = null;
    try {
      if (st.candles.length >= 50 && st.candlesH1 && st.candlesH1.length >= 60 &&
          st.candlesH4 && st.candlesH4.length >= 30 &&
          st.candlesD1 && st.candlesD1.length >= 200) {
        var c15 = confirmedCandles(st.candles, 15 * 60 * 1000);
        var cH1 = confirmedCandles(st.candlesH1, 60 * 60 * 1000);
        var cH4 = confirmedCandles(st.candlesH4, 4 * 60 * 60 * 1000);
        var cD1 = confirmedCandles(st.candlesD1, 24 * 60 * 60 * 1000);

        if (c15.length >= 30 && cH1.length >= 50 && cH4.length >= 25 && cD1.length >= 200) {
          // Layer 1 — D1
          var emaD1_50 = calcEMA(cD1, 50);
          var emaD1_200 = calcEMA(cD1, 200);
          var rsiD1 = calcRSI(cD1, 14);
          var lastD1 = cD1[cD1.length - 1];
          var d1Bull = emaD1_50 > emaD1_200 && lastD1.close > emaD1_50;
          var d1Bear = emaD1_50 < emaD1_200 && lastD1.close < emaD1_50;
          var rsiD1Ok = rsiD1 >= 25 && rsiD1 <= 75;
          var d1Pass = (d1Bull || d1Bear) && rsiD1Ok;
          var bias = d1Bull ? 'BUY' : d1Bear ? 'SELL' : 'NONE';

          // Layer 2 — H4
          var emaH4_20 = calcEMA(cH4, 20);
          var lastH4 = cH4[cH4.length - 1];
          var h4Aligned = (bias === 'BUY' && lastH4.close > emaH4_20) ||
                          (bias === 'SELL' && lastH4.close < emaH4_20);

          // Layer 3 — H1
          var adxH1 = calcADX(cH1, 14);
          var emaH1_20 = calcEMA(cH1, 20);
          var emaH1_50 = calcEMA(cH1, 50);
          var h1AdxOk = adxH1 >= 18;
          var h1EmaAligned = (bias === 'BUY' && emaH1_20 > emaH1_50) ||
                             (bias === 'SELL' && emaH1_20 < emaH1_50);
          var h1Pass = h1AdxOk && h1EmaAligned;

          // Layer 4 — M15 trigger components
          var emaM15_20 = calcEMA(c15, 20);
          var rsiM15 = calcRSI(c15, 14);
          var atrArr = calcATR(c15, 14);
          var atr = atrArr[atrArr.length - 1] || 0;

          var hadPullback = hadRecentPullback(c15, emaM15_20, atr, 8, bias === 'BUY');
          // detectReversal RIMOSSO dalla logica di trigger (era killer filtro).
          // Lo lascio calcolato qui solo per indicazione visiva nella dashboard.
          var reversal = detectReversal(c15);
          var reversalBuy = reversal === 'BUY';
          var reversalSell = reversal === 'SELL';
          var rsiM15Prev = calcRSI(c15.slice(0, -1), 14);
          var rsiOk = false;
          if (bias === 'BUY') {
            rsiOk = rsiM15 > rsiM15Prev && rsiM15 >= 35 && rsiM15 <= 65;
          } else if (bias === 'SELL') {
            rsiOk = rsiM15 < rsiM15Prev && rsiM15 >= 35 && rsiM15 <= 65;
          }

          // Trigger ora richiede solo pullback + RSI girando (no piu' reversal candle)
          var m15Trigger = hadPullback && rsiOk;

          layers = {
            bias: bias,
            d1Pass: d1Pass,
            d1Bull: d1Bull,
            d1Bear: d1Bear,
            d1Rsi: rsiD1,
            h4Aligned: h4Aligned,
            h1Pass: h1Pass,
            h1Adx: adxH1,
            h1EmaAligned: h1EmaAligned,
            m15Pullback: hadPullback,
            m15ReversalBuy: reversalBuy,
            m15ReversalSell: reversalSell,
            m15RsiOk: rsiOk,
            m15Trigger: m15Trigger
          };
        }
      }
    } catch(e) {
      console.error('MTF status calc ' + s + ': ' + e.message);
    }

    symbolStates[s] = { layers: layers };
  }

  res.json({
    isRunning: isRunning,
    activeSymbols: activeSymbols,
    paSymbols: typeof PA_SYMBOLS !== 'undefined' ? PA_SYMBOLS : [],
    orbSymbols: typeof ORB_SYMBOLS !== 'undefined' ? ORB_SYMBOLS : [],
    globalStats: globalStats,
    globalLog: globalLog.slice(0, 20),
    tgConnected: !!(TG_TOKEN && TG_CHAT_ID),
    dataConnected: !!TD_KEY,
    perSymbol: ps,
    symbolStates: symbolStates
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
    startLoop(ref || 300, cool || 60);
    await tgSend('<b>MTF-EA online</b>\nSimboli: ' + activeSymbols.join(', ') + '\nLogica: Multi-Timeframe Confluence (D1+H4+H1+M15)');
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
  var ok = await tgSend('MTF-EA Test OK!\nSimboli: ' + activeSymbols.join(', '));
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
    version: 'ST-EA Quad Bot: Trend + PA + ORB + Stocks',
    trendBot: {
      enabled: true,
      running: isRunning,
      symbols: activeSymbols,
      timeframe: 'M15',
      logic: 'Multi-Timeframe Confluence: D1 trend + H4 structure + H1 ADX/EMA align + M15 pullback reversal'
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
    stocksBot: {
      enabled: true,
      running: stocksRunning,
      symbols: STOCKS_SYMBOLS,
      timeframe: 'W1 weekly',
      logic: 'Pullback in strong trend (px>EMA50>EMA200, RSI 40-55, reversal candle)',
      scanTime: '22:00 UTC daily',
      entrySignalsOnly: 'Friday',
      cooldownWeeks: 4,
      holdingWeeks: '1-4'
    },
    dataSources: {
      forex: 'TwelveData (primary) + Yahoo (fallback)',
      metals: 'TwelveData (primary) + Yahoo (fallback)',
      crypto: 'OKX',
      indices_orb: 'TwelveData (primary) + Yahoo (fallback)',
      stocks: 'Yahoo Finance'
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

// PA Blacklist: simboli con edge non significativo dopo 5 round di backtest
//   - GBPUSD: PF 0.75 con costi (edge negativo strutturale)
//   - EURUSD: PF 1.02 con costi (rumore puro)
//   - GBPJPY: PF 1.01 con costi (rumore puro su 97 trade)
// PA opera solo su simboli con PF > 1.05: XAGUSD (1.17), BTCUSD (1.10), XAUUSD (1.08)
// Per modificare, settare env var: PA_BLACKLIST=GBPUSD,EURUSD
var PA_BLACKLIST = (process.env.PA_BLACKLIST ? process.env.PA_BLACKLIST.split(',').map(function(s){return s.trim();}) : ['GBPUSD', 'EURUSD', 'GBPJPY']);
PA_SYMBOLS = PA_SYMBOLS.filter(function(s) { return PA_BLACKLIST.indexOf(s) === -1; });
console.log('PA Bot: ' + PA_SYMBOLS.length + ' simboli attivi (blacklist: ' + PA_BLACKLIST.join(',') + ')');
var PA_COOLDOWN_HOURS = parseInt(process.env.PA_COOLDOWN_HOURS) || 24;
var PA_REFRESH_SEC = parseInt(process.env.PA_REFRESH_SEC) || 3600;
// PA risk per trade: ridotto a 1.0% (default) basato su backtest 6 mesi:
//   - Total return PA: +20.72R / Max DD: 27.68R = ratio 0.75x (rischioso)
//   - WR 33% combinato a alto DD richiede risk minore di ORB (che ha WR 52% e PF 1.77)
//   - 1.0% mantiene profittabilita' (~+€100/6mesi) con DD gestibile (~-€138 / 28% balance)
// Override via env var: PA_RISK_PCT=1.5 (vecchio default) o PA_RISK_PCT=0.5 (ultra-safe)
var PA_RISK_PCT = parseFloat(process.env.PA_RISK_PCT) || 1.0;

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
      return b + 'EUR: ' + calcLotSize(sym, b, PA_RISK_PCT, slDist) + ' lot';
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
      '<b>Lot (' + PA_RISK_PCT + '% rischio):</b>' + nl + lots + nl +
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

// ORB Bot: solo i 3 indici con edge positivo confermato dopo 5 round di backtest
//   - JP225 (Nikkei)  : PF 2.15 — Asia, momentum forte sul gap apertura
//   - GER40 (DAX)     : PF 1.63 — Europa, breakout puliti
//   - UK100 (FTSE)    : PF 1.29 — Europa, marginale ma positivo
// Disabilitati (PF < 1.1):
//   - US500 (SPX): PF 0.88 — troppo liquido, breakout falsi norma
//   - US100 (NDX): PF 1.06 — marginale
// Per riattivarli, settare ORB_SYMBOLS env var: ORB_SYMBOLS=US500,US100,GER40,UK100,JP225
var ORB_SYMBOLS = process.env.ORB_SYMBOLS ?
  process.env.ORB_SYMBOLS.split(',').map(function(s){return s.trim();}) :
  ['JP225', 'GER40', 'UK100'];

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
// ORB risk per trade: 1.5% (default) basato su backtest 6 mesi:
//   - PF 1.77 con costi (eccellente per retail)
//   - WR 52% e DD basso (2.77R) permettono risk piu' alto di PA
//   - Override: ORB_RISK_PCT=2.0 (aggressivo) o 1.0 (conservativo)
var ORB_RISK_PCT = parseFloat(process.env.ORB_RISK_PCT) || 1.5;

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

  var orbLots = [100, 500, 1000].map(function(b) {
    return b + 'EUR: ' + calcLotSize(sym, b, ORB_RISK_PCT, slDist) + ' lot';
  }).join(' | ');

  var msg =
    '<b>[ORB-EA] ' + dir + ' ' + name + '</b> (' + sym + ')' + nl +
    '<b>Entry:</b> ' + entry.toFixed(dec) + nl +
    '<b>SL (OR opposto):</b> ' + sl.toFixed(dec) + nl +
    '<b>Distanza SL:</b> ' + slDist.toFixed(dec) + ' (' + (slDist / entry * 100).toFixed(2) + '%)' + nl +
    '<b>OR Width:</b> ' + orWidth.toFixed(dec) + ' (' + (orPct * 100).toFixed(2) + '%)' + nl +
    '<b>Uscita:</b> Trailing su EMA20 M15' + nl +
    '<b>Lot (' + ORB_RISK_PCT + '% rischio):</b>' + nl + orbLots + nl +
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
// ██████████████████████████████████████████████████████████████████████████████
// STOCKS BOT -- Pullback in Strong Trend (W1 timeframe, holding 1-4 weeks)
// ██████████████████████████████████████████████████████████████████████████████
// ══════════════════════════════════════════════════════════════════════════════
//
// Bot operativo che monitora un universo di azioni USA + ETF settoriali sul
// timeframe weekly. Cerca pullback in trend forti di lungo periodo per entrare
// nella direzione del trend dominante.
//
// Strategia (timeframe W1):
//   ENTRY (BUY only - long-only su azioni):
//     1. Trend forte:  prezzo > EMA50 W1 AND EMA50 > EMA200 W1
//     2. Pullback:     RSI(14) W1 tra 40 e 55 (correzione sana)
//     3. Reversal:     candela W1 verde dopo almeno 1 candela rossa
//     4. Forza relat:  prezzo > prezzo 13 settimane fa
//     5. ADX(14) W1 >= 18 (no chop)
//     6. Volume W1 > media 10 settimane (conferma istituzionale)
//
//   EXIT:
//     - Chiusura W1 sotto EMA50 W1 (stop trailing largo)
//     - RSI W1 > 75 (overbought euforico, prendi profitto)
//     - Stop loss virtuale colpito (low W1 < SL)
//     - Take profit virtuale raggiunto (high W1 > TP)
//
// SL/TP:
//   SL = low della candela trigger - 0.5 * ATR(14) W1
//   TP = entry + (entry - SL) * 3   (R:R 1:3)
//
// Frequenza:
//   Scan giornaliera alle 22:00 UTC (dopo close NYSE), solo lun-ven.
//   Segnali generati solo il VENERDI' (W1 chiusa).
//   Cooldown 4 settimane per ticker, max 1 segnale/settimana globale.
//
// Notifiche:
//   - BUY signal con SL/TP/lot suggerito
//   - EXIT signal con motivo, P/L virtuale, holding settimane
// ══════════════════════════════════════════════════════════════════════════════

// Universo di lavoro: 12 ticker (4 stocks + 5 ETF settoriali + 3 broad ETF)
var STOCKS_SYMBOLS = (process.env.STOCKS_SYMBOLS ||
  'AAPL,MSFT,NVDA,GOOGL,XLK,XLE,XLF,XLV,XLI,SPY,QQQ,IWM').split(',').map(function(s) { return s.trim(); });

// Yahoo ticker mapping (per gli ETF il simbolo coincide, per stocks pure)
var STOCKS_YAHOO_MAP = {
  AAPL: 'AAPL', MSFT: 'MSFT', NVDA: 'NVDA', GOOGL: 'GOOGL',
  XLK: 'XLK', XLE: 'XLE', XLF: 'XLF', XLV: 'XLV', XLI: 'XLI',
  SPY: 'SPY', QQQ: 'QQQ', IWM: 'IWM'
};

// Pretty names
var STOCKS_NAMES = {
  AAPL: 'Apple', MSFT: 'Microsoft', NVDA: 'NVIDIA', GOOGL: 'Alphabet',
  XLK: 'Tech Select Sector', XLE: 'Energy Select Sector', XLF: 'Financial Select Sector',
  XLV: 'Healthcare Select Sector', XLI: 'Industrial Select Sector',
  SPY: 'S&P 500 ETF', QQQ: 'Nasdaq 100 ETF', IWM: 'Russell 2000 ETF'
};

// Stato globale
var stocksRunning = false;
var stocksWatchdog = null;
var stocksLoopHandle = null;
var lastStocksLoopTime = 0;
var stocksLog = [];                 // ultimi 50 segnali
var stocksLastGlobalSignalDate = 0; // timestamp ultimo segnale globale (anti-spam)
var stocksState = {};               // per-symbol: candles, position, stats, cooldown

function initStocksSymbol(sym) {
  stocksState[sym] = {
    name: STOCKS_NAMES[sym] || sym,
    candlesW1: [],          // ultimi ~150 candele weekly
    lastFetch: 0,
    inPosition: false,
    entryPrice: null,
    entrySL: null,
    entryTP: null,
    entryDate: null,        // timestamp candela ingresso
    entryATR: null,
    cooldownUntil: 0,       // timestamp fino a quando non si puo' rientrare
    stats: {
      total: 0, wins: 0, losses: 0,
      lastSignal: '--',
      lastFilter: '--',
      lastPnL: 0
    },
    log: []
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// FETCH WEEKLY CANDLES from Yahoo Finance
// ──────────────────────────────────────────────────────────────────────────────
async function fetchStocksW1(sym) {
  var st = stocksState[sym];
  if (!st) { initStocksSymbol(sym); st = stocksState[sym]; }

  var ticker = STOCKS_YAHOO_MAP[sym] || sym;
  // 3 anni di weekly = 156 candele, sufficienti per EMA200 W1
  var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' +
            ticker + '?interval=1wk&range=3y';

  try {
    var r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ST-EA/1.0)' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var data = await r.json();

    var chart = data && data.chart && data.chart.result && data.chart.result[0];
    if (!chart || !chart.timestamp) throw new Error('Yahoo data malformed');

    var ts = chart.timestamp;
    var q = chart.indicators.quote[0];
    var out = [];
    for (var i = 0; i < ts.length; i++) {
      if (q.open[i] != null && q.high[i] != null && q.low[i] != null && q.close[i] != null) {
        out.push({
          time: ts[i] * 1000,
          open: +q.open[i], high: +q.high[i],
          low: +q.low[i], close: +q.close[i],
          vol: +(q.volume[i] || 0)
        });
      }
    }

    if (out.length < 150) {
      console.warn('STOCKS ' + sym + ': only ' + out.length + ' weeks (need 150+)');
    }

    st.candlesW1 = out;
    st.lastFetch = Date.now();
    return out;
  } catch(e) {
    console.error('STOCKS ' + sym + ' fetch error: ' + e.message);
    throw e;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// SIGNAL CHECK per simbolo
// ──────────────────────────────────────────────────────────────────────────────
function checkStocksSignal(sym) {
  var st = stocksState[sym];
  if (!st || !st.candlesW1 || st.candlesW1.length < 150) {
    if (st) st.stats.lastFilter = 'dati insufficienti (need 150 weeks)';
    return null;
  }

  var c = st.candlesW1;
  var n = c.length;
  var last = c[n - 1];

  // ─── Calcolo indicatori W1 ───
  var ema50 = calcEMA(c, 50);
  var ema200 = calcEMA(c, 200);
  var rsi = calcRSI(c, 14);
  var atr = calcATR(c, 14);
  var atrLast = atr[atr.length - 1];
  var adxArr = calcADXSeries(c, 14);
  var adx = adxArr[adxArr.length - 1] || 0;

  // Volume avg 10 settimane
  var volSum = 0, volCount = 0;
  for (var v = Math.max(0, n - 11); v < n - 1; v++) {
    if (c[v].vol > 0) { volSum += c[v].vol; volCount++; }
  }
  var volAvg = volCount > 0 ? volSum / volCount : 0;

  // ─── EXIT logic se in posizione ───
  if (st.inPosition) {
    var exitReason = null;

    // 1. Chiusura W1 sotto EMA50 W1
    if (last.close < ema50) exitReason = 'CHIUSURA SOTTO EMA50 W1';
    // 2. RSI > 75 overbought
    else if (rsi > 75) exitReason = 'OVERBOUGHT (RSI ' + rsi.toFixed(1) + ')';
    // 3. SL virtuale colpito
    else if (last.low <= st.entrySL) exitReason = 'STOP LOSS';
    // 4. TP virtuale raggiunto
    else if (last.high >= st.entryTP) exitReason = 'TAKE PROFIT';

    if (exitReason) {
      var exitPx = exitReason === 'STOP LOSS' ? st.entrySL :
                   exitReason === 'TAKE PROFIT' ? st.entryTP : last.close;
      var pnl = exitPx - st.entryPrice;
      var pnlPct = (pnl / st.entryPrice) * 100;
      var rMult = pnl / Math.abs(st.entryPrice - st.entrySL);
      var weeksHeld = Math.round((last.time - st.entryDate) / (7 * 24 * 3600 * 1000));

      st.stats.total++;
      if (pnl > 0) st.stats.wins++; else st.stats.losses++;
      st.stats.lastPnL = pnlPct;
      st.stats.lastSignal = 'EXIT ' + exitReason;
      st.stats.lastFilter = 'EXIT inviato';

      // Cooldown 4 settimane dopo exit
      st.cooldownUntil = last.time + (4 * 7 * 24 * 3600 * 1000);

      var exitMsg = '<b>[STOCKS-EA] CHIUSURA</b> <b>' + sym + '</b> (' + st.name + ')\n' +
                    'Entry: ' + st.entryPrice.toFixed(2) + '\n' +
                    'Exit:  ' + exitPx.toFixed(2) + '\n' +
                    'Motivo: <b>' + exitReason + '</b>\n' +
                    'P/L: ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) +
                    ' (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%)\n' +
                    'R-multiple: ' + (rMult >= 0 ? '+' : '') + rMult.toFixed(2) + 'R\n' +
                    'Holding: ' + weeksHeld + ' settimane';

      var record = {
        sym: sym, dir: 'EXIT', price: exitPx.toFixed(2),
        time: new Date(last.time).toUTCString(),
        source: 'STOCKS', pnlPct: pnlPct, rMult: rMult, reason: exitReason
      };
      stocksLog.unshift(record);
      if (stocksLog.length > 50) stocksLog.length = 50;
      st.log.unshift(record);
      if (st.log.length > 20) st.log.length = 20;
      globalLog.unshift(record);
      if (globalLog.length > 100) globalLog.length = 100;

      // Reset position
      st.inPosition = false;
      st.entryPrice = null;
      st.entrySL = null;
      st.entryTP = null;
      st.entryDate = null;
      st.entryATR = null;

      tgSend(exitMsg);
      return record;
    }

    st.stats.lastFilter = 'in posizione (entry ' + st.entryPrice.toFixed(2) + ')';
    return null;
  }

  // ─── ENTRY logic se NON in posizione ───

  // Cooldown check
  if (last.time < st.cooldownUntil) {
    var weeksLeft = Math.ceil((st.cooldownUntil - last.time) / (7 * 24 * 3600 * 1000));
    st.stats.lastFilter = 'cooldown (' + weeksLeft + ' settimane)';
    return null;
  }

  // Filtro 1: Trend forte
  var trendOk = last.close > ema50 && ema50 > ema200;
  if (!trendOk) {
    st.stats.lastFilter = 'no trend (px<EMA50 o EMA50<EMA200)';
    return null;
  }

  // Filtro 2: Pullback (RSI 40-55)
  var pullbackOk = rsi >= 40 && rsi <= 55;
  if (!pullbackOk) {
    st.stats.lastFilter = 'no pullback (RSI ' + rsi.toFixed(1) + ', need 40-55)';
    return null;
  }

  // Filtro 3: Reversal (verde dopo rosso)
  var lastGreen = last.close > last.open;
  var prevRed = c[n - 2].close < c[n - 2].open;
  var reversalOk = lastGreen && prevRed;
  if (!reversalOk) {
    st.stats.lastFilter = 'no reversal (need verde dopo rosso)';
    return null;
  }

  // Filtro 4: Forza relativa (>3 mesi)
  var px13wAgo = c[n - 14] ? c[n - 14].close : null;
  if (!px13wAgo) {
    st.stats.lastFilter = 'no 13w history';
    return null;
  }
  var rsForceOk = last.close > px13wAgo;
  if (!rsForceOk) {
    var perf13w = ((last.close - px13wAgo) / px13wAgo * 100).toFixed(1);
    st.stats.lastFilter = 'forza neg 13w (' + perf13w + '%)';
    return null;
  }

  // Filtro 5: ADX
  if (adx < 18) {
    st.stats.lastFilter = 'ADX basso (' + adx.toFixed(1) + ', need 18+)';
    return null;
  }

  // Filtro 6: Volume sopra media
  if (volAvg > 0 && last.vol > 0 && last.vol < volAvg) {
    st.stats.lastFilter = 'volume sotto media (' +
      Math.round(last.vol / volAvg * 100) + '% di avg)';
    return null;
  }

  // Filtro globale: max 1 segnale/settimana
  var weekMs = 7 * 24 * 3600 * 1000;
  if (Date.now() - stocksLastGlobalSignalDate < weekMs) {
    st.stats.lastFilter = 'global cooldown (1/sett)';
    return null;
  }

  // ─── TUTTI I FILTRI OK -> GENERA SIGNAL ───
  var entry = last.close;
  var sl = last.low - 0.5 * atrLast;
  var tp = entry + (entry - sl) * 3;
  var slDist = entry - sl;
  var slPct = (slDist / entry) * 100;
  var rrTarget = ((tp - entry) / slDist).toFixed(1);
  var perf13w = ((last.close - px13wAgo) / px13wAgo * 100).toFixed(1);

  // Lot suggeriti per 100/500/1000 EUR (stock units, non lot forex)
  var risk100 = 100 * 0.03, risk500 = 500 * 0.03, risk1000 = 1000 * 0.03;
  var units100 = Math.floor(risk100 / slDist);
  var units500 = Math.floor(risk500 / slDist);
  var units1000 = Math.floor(risk1000 / slDist);

  st.inPosition = true;
  st.entryPrice = entry;
  st.entrySL = sl;
  st.entryTP = tp;
  st.entryDate = last.time;
  st.entryATR = atrLast;
  st.stats.lastSignal = 'BUY';
  st.stats.lastFilter = 'BUY inviato';
  stocksLastGlobalSignalDate = Date.now();

  var msg = '<b>[STOCKS-EA] BUY</b> <b>' + sym + '</b> (' + st.name + ')\n' +
            'Entry: <b>' + entry.toFixed(2) + '</b>\n' +
            'SL: ' + sl.toFixed(2) + ' | TP: ' + tp.toFixed(2) + '\n' +
            'Distanza SL: ' + slDist.toFixed(2) + ' (' + slPct.toFixed(2) + '%)\n' +
            'R:R target: 1:' + rrTarget + '\n' +
            'RSI: ' + rsi.toFixed(1) + ' | ADX: ' + adx.toFixed(1) +
            ' | 13w perf: +' + perf13w + '%\n' +
            'Trend: px>EMA50>EMA200 OK\n' +
            'Units suggeriti (3% risk):\n' +
            '  100EUR: ' + units100 + ' units\n' +
            '  500EUR: ' + units500 + ' units\n' +
            '  1000EUR: ' + units1000 + ' units\n' +
            'Holding atteso: 1-4 settimane';

  var record = {
    sym: sym, dir: 'BUY', price: entry.toFixed(2),
    time: new Date(last.time).toUTCString(),
    source: 'STOCKS', sl: sl, tp: tp,
    rsi: rsi, adx: adx, rs13w: parseFloat(perf13w)
  };
  stocksLog.unshift(record);
  if (stocksLog.length > 50) stocksLog.length = 50;
  st.log.unshift(record);
  if (st.log.length > 20) st.log.length = 20;
  globalLog.unshift(record);
  if (globalLog.length > 100) globalLog.length = 100;
  globalStats.total++;
  globalStats.buys++;

  tgSend(msg);
  return record;
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPER: EMA series — ritorna array EMA per ogni bar, calcolato in O(N) totale
// ──────────────────────────────────────────────────────────────────────────────
function calcEMASeries(c, period) {
  if (c.length < period) return new Array(c.length).fill(NaN);
  var k = 2 / (period + 1);
  var ema = new Array(c.length).fill(NaN);
  // Seed: SMA dei primi `period` valori
  var seed = 0;
  for (var i = 0; i < period; i++) seed += c[i].close;
  ema[period - 1] = seed / period;
  // Recursion EMA
  for (var j = period; j < c.length; j++) {
    ema[j] = c[j].close * k + ema[j-1] * (1 - k);
  }
  return ema;
}

// HELPER: RSI series — Wilder smoothing per ogni bar, O(N) totale
function calcRSISeries(c, period) {
  period = period || 14;
  if (c.length < period + 1) return new Array(c.length).fill(50);
  var rsi = new Array(c.length).fill(50);
  var gains = 0, losses = 0;
  for (var i = 1; i <= period; i++) {
    var d = c[i].close - c[i-1].close;
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  var avgG = gains / period, avgL = losses / period;
  rsi[period] = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
  for (var j = period + 1; j < c.length; j++) {
    var diff = c[j].close - c[j-1].close;
    var g = diff > 0 ? diff : 0;
    var l = diff < 0 ? Math.abs(diff) : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    rsi[j] = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
  }
  return rsi;
}

// HELPER: ATR series — Wilder smoothing per ogni bar, O(N) totale
function calcATRSeries(c, period) {
  period = period || 14;
  if (c.length < period + 1) return new Array(c.length).fill(NaN);
  var atr = new Array(c.length).fill(NaN);
  var tr = new Array(c.length);
  tr[0] = c[0].high - c[0].low;
  for (var i = 1; i < c.length; i++) {
    tr[i] = Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i-1].close),
      Math.abs(c[i].low - c[i-1].close)
    );
  }
  var seed = 0;
  for (var k = 0; k < period; k++) seed += tr[k];
  atr[period - 1] = seed / period;
  for (var j = period; j < c.length; j++) {
    atr[j] = (atr[j-1] * (period - 1) + tr[j]) / period;
  }
  return atr;
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPER: ADX series (per stocks needs to return array, non solo last value)
// ──────────────────────────────────────────────────────────────────────────────
function calcADXSeries(c, p) {
  // ADX di Wilder per ogni bar (usato da Stocks bot per ottenere serie completa).
  // Stesso algoritmo di calcADX ma ritorna l'array di ADX invece dell'ultimo valore.
  p = p || 14;
  if (c.length < p * 2 + 1) return [];

  var tr = [], pdm = [], mdm = [];
  for (var i = 1; i < c.length; i++) {
    var h = c[i].high, lo = c[i].low, ph = c[i-1].high, pl = c[i-1].low, pc = c[i-1].close;
    tr.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
    var up = h - ph, dn = pl - lo;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }

  // Wilder smoothing seed
  var st = 0, sp = 0, sm = 0;
  for (var k = 0; k < p; k++) {
    st += tr[k]; sp += pdm[k]; sm += mdm[k];
  }

  // DX series
  var dx = [];
  var pi = st > 0 ? sp / st * 100 : 0;
  var mi = st > 0 ? sm / st * 100 : 0;
  var sm2 = pi + mi;
  dx.push(sm2 > 0 ? Math.abs(pi - mi) / sm2 * 100 : 0);

  for (var j = p; j < tr.length; j++) {
    st = st - st / p + tr[j];
    sp = sp - sp / p + pdm[j];
    sm = sm - sm / p + mdm[j];
    pi = st > 0 ? sp / st * 100 : 0;
    mi = st > 0 ? sm / st * 100 : 0;
    sm2 = pi + mi;
    dx.push(sm2 > 0 ? Math.abs(pi - mi) / sm2 * 100 : 0);
  }

  if (dx.length < p) return [];

  // ADX = Wilder smoothing del DX (NON SMA!)
  var adxOut = [];
  var seed = 0;
  for (var s = 0; s < p; s++) seed += dx[s];
  var adx = seed / p;
  adxOut.push(adx);

  for (var t = p; t < dx.length; t++) {
    adx = (adx * (p - 1) + dx[t]) / p;
    adxOut.push(adx);
  }

  return adxOut;
}

// ──────────────────────────────────────────────────────────────────────────────
// LOOP STOCKS
// ──────────────────────────────────────────────────────────────────────────────
function isStocksScanTime() {
  // Scan giornaliera alle 22:00 UTC, lun-ven
  var now = new Date();
  var dow = now.getUTCDay(); // 0=dom, 1=lun, ..., 5=ven, 6=sab
  if (dow === 0 || dow === 6) return false;
  var h = now.getUTCHours();
  // Finestra 22:00-22:59 UTC (1 ora di tolleranza, basta che il loop giri ogni ora)
  return h === 22;
}

function isFridayUTC() {
  return new Date().getUTCDay() === 5;
}

async function stocksLoopOnce() {
  if (!stocksRunning) return;
  lastStocksLoopTime = Date.now();

  // Scan-time check: solo durante la finestra alle 22:00 UTC
  if (!isStocksScanTime()) {
    return;
  }

  // I segnali ENTRY sono validi solo il venerdì (W1 chiusa)
  // Gli EXIT invece sono valutati ogni giorno (per intercettare uscite veloci)
  var entryAllowed = isFridayUTC();

  console.log('[STOCKS] Scanning ' + STOCKS_SYMBOLS.length +
              ' tickers (entry=' + entryAllowed + ')');

  for (var i = 0; i < STOCKS_SYMBOLS.length; i++) {
    var sym = STOCKS_SYMBOLS[i];
    if (!stocksState[sym]) initStocksSymbol(sym);

    try {
      // Refetch solo se passate >12 ore
      var hoursSince = (Date.now() - stocksState[sym].lastFetch) / 3600000;
      if (hoursSince > 12) {
        await fetchStocksW1(sym);
      }
    } catch(e) {
      console.error('STOCKS scan ' + sym + ': ' + e.message);
      continue;
    }

    // Check EXIT sempre, ENTRY solo venerdì
    if (stocksState[sym].inPosition) {
      checkStocksSignal(sym);
    } else if (entryAllowed) {
      checkStocksSignal(sym);
    }

    // Rate limit Yahoo: 2s tra simboli
    await new Promise(function(r) { setTimeout(r, 2000); });
  }

  console.log('[STOCKS] Scan completed');
}

function startStocksLoop() {
  stopStocksLoop();
  stocksRunning = true;
  // Loop ogni ora (controlla se è scan-time, in caso scansiona)
  stocksLoopHandle = setInterval(stocksLoopOnce, 60 * 60 * 1000);

  // Watchdog 30min per restart se loop bloccato (>2h senza tick)
  if (stocksWatchdog) clearInterval(stocksWatchdog);
  stocksWatchdog = setInterval(function() {
    if (!stocksRunning) return;
    if (lastStocksLoopTime && Date.now() - lastStocksLoopTime > 2 * 3600 * 1000) {
      console.warn('[STOCKS] Watchdog: loop seems stuck, restarting');
      stocksLoopOnce().catch(function(e) { console.error(e); });
    }
  }, 30 * 60 * 1000);
}

function stopStocksLoop() {
  if (stocksLoopHandle) { clearInterval(stocksLoopHandle); stocksLoopHandle = null; }
  if (stocksWatchdog) { clearInterval(stocksWatchdog); stocksWatchdog = null; }
  stocksRunning = false;
}

// ──────────────────────────────────────────────────────────────────────────────
// API ENDPOINTS
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/stocks-status', function(req, res) {
  var stateExport = {};
  STOCKS_SYMBOLS.forEach(function(s) {
    var st = stocksState[s];
    if (!st) return;
    stateExport[s] = {
      name: st.name,
      candleCount: st.candlesW1.length,
      inPosition: st.inPosition,
      entryPrice: st.entryPrice,
      entrySL: st.entrySL,
      entryTP: st.entryTP,
      entryDate: st.entryDate,
      cooldownUntil: st.cooldownUntil,
      lastPrice: st.candlesW1.length ? st.candlesW1[st.candlesW1.length - 1].close : null,
      stats: st.stats
    };
  });

  res.json({
    stocksRunning: stocksRunning,
    stocksSymbols: STOCKS_SYMBOLS,
    state: stateExport,
    stocksLog: stocksLog,
    lastLoopTime: lastStocksLoopTime,
    lastGlobalSignalDate: stocksLastGlobalSignalDate,
    nextScanInfo: {
      scansAt: '22:00 UTC daily',
      entrySignalsOnly: 'Friday',
      currentDay: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getUTCDay()],
      isScanTime: isStocksScanTime(),
      isFriday: isFridayUTC()
    }
  });
});

app.post('/api/stocks-start', async function(req, res) {
  if (stocksRunning) { res.json({ ok: false, message: 'STOCKS bot already running' }); return; }

  STOCKS_SYMBOLS.forEach(function(s) { if (!stocksState[s]) initStocksSymbol(s); });

  // Init data fetch (sequential)
  for (var i = 0; i < STOCKS_SYMBOLS.length; i++) {
    try { await fetchStocksW1(STOCKS_SYMBOLS[i]); }
    catch(e) { console.error('STOCKS init ' + STOCKS_SYMBOLS[i] + ': ' + e.message); }
    await new Promise(function(r) { setTimeout(r, 1500); });
  }

  startStocksLoop();
  await tgSend('<b>STOCKS Bot avviato</b>\n' +
               'Tickers: ' + STOCKS_SYMBOLS.join(', ') + '\n' +
               'Scan giornaliero 22:00 UTC, segnali ven only');
  res.json({ ok: true });
});

app.post('/api/stocks-stop', async function(req, res) {
  stopStocksLoop();
  await tgSend('STOCKS Bot fermato');
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ██████████████████████████████████████████████████████████████████████████████
// BACKTEST ENGINE — simulazione storica MTF + ORB + PA su 6 mesi
// ██████████████████████████████████████████████████████████████████████████████
// ══════════════════════════════════════════════════════════════════════════════
//
// Riproduce la stessa logica dei 3 bot live ma su dati storici, per verificare
// se le strategie hanno edge statistico positivo PRIMA di operare con denaro.
//
// Workflow:
//   1. Client chiama POST /api/backtest -> avvia esecuzione asincrona
//   2. Client polla GET /api/backtest-status per progress (0-100%)
//   3. A fine simulazione, GET /api/backtest-results restituisce JSON completo
//
// Dati: scarica fino a 5000 candele/timeframe via TwelveData (~6 mesi)
// Output: 2 modi (clean = senza spread, costs = con spread Capital.com)
// ══════════════════════════════════════════════════════════════════════════════

// Stato globale del backtest
var bt = {
  running: false,
  progress: 0,
  status: 'idle',
  message: '',
  startedAt: null,
  finishedAt: null,
  results: null,
  error: null
};

// Spread realistici Capital.com (in unita' del simbolo)
var BT_SPREADS = {
  XAUUSD: 0.30, XAGUSD: 0.03,
  EURUSD: 0.00015, GBPUSD: 0.00018, USDJPY: 0.018,
  GBPJPY: 0.025, AUDUSD: 0.00018, USDCAD: 0.00020,
  USDCHF: 0.00020, NZDUSD: 0.00020,
  BTCUSD: 30.0, ETHUSD: 5.0, SOLUSD: 0.10,
  XRPUSD: 0.001, BNBUSD: 0.50,
  WTIUSD: 0.04, BRNUSD: 0.04, USOIL: 0.04, UKOIL: 0.04,
  SPX: 1.0, NDX: 2.0, DAX: 1.5, UKX: 1.5, N225: 8.0
};

// ─── Helper: fetch storico esteso da TwelveData (5000 candele) ────────────────
async function btFetchHistory(symbol, interval) {
  if (!TD_KEY) {
    console.log('[BT TD] ' + symbol + ' ' + interval + ': NO TD_KEY');
    return null;
  }
  var tdSym = (typeof ORB_TD_MAP !== 'undefined' && ORB_TD_MAP[symbol]) ||
              (typeof TD_MAP !== 'undefined' && TD_MAP[symbol]) ||
              symbol;
  var url = 'https://api.twelvedata.com/time_series?symbol=' +
            encodeURIComponent(tdSym) +
            '&interval=' + interval +
            '&outputsize=5000&order=ASC&apikey=' + TD_KEY;
  try {
    var r = await fetch(url, { headers: { 'User-Agent': 'ST-EA-Backtest/1.0' }});
    if (!r.ok) {
      console.log('[BT TD] ' + symbol + ' ' + interval + ' (' + tdSym + '): HTTP ' + r.status);
      return null;
    }
    var data = await r.json();
    if (data.status === 'error' || !data.values) {
      console.log('[BT TD] ' + symbol + ' ' + interval + ' (' + tdSym + '): ' +
                  (data.message || data.status || 'no values'));
      return null;
    }
    return data.values.map(function(v) {
      return {
        time: new Date(v.datetime + 'Z').getTime(),
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        vol: parseFloat(v.volume) || 0
      };
    }).filter(function(c) {
      return !isNaN(c.open) && !isNaN(c.high) && !isNaN(c.low) && !isNaN(c.close);
    });
  } catch(e) {
    console.error('[BT TD] ' + symbol + ' ' + interval + ': ' + e.message);
    return null;
  }
}

// Variant Yahoo per crypto e fallback
async function btFetchYahooHistory(symbol, interval) {
  // Yahoo symbol mapping (riusa pattern fetchYahoo esistente)
  var yhMap = {
    XAUUSD: 'XAUUSD=X', XAGUSD: 'XAGUSD=X',
    EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDJPY: 'USDJPY=X',
    GBPJPY: 'GBPJPY=X', AUDUSD: 'AUDUSD=X', USDCAD: 'USDCAD=X',
    USDCHF: 'USDCHF=X', NZDUSD: 'NZDUSD=X',
    BTCUSD: 'BTC-USD', ETHUSD: 'ETH-USD', SOLUSD: 'SOL-USD',
    XRPUSD: 'XRP-USD', BNBUSD: 'BNB-USD',
    SPX: '^GSPC', NDX: '^NDX', DAX: '^GDAXI', UKX: '^FTSE', N225: '^N225',
    US500: '^GSPC', US100: '^NDX', GER40: '^GDAXI', UK100: '^FTSE', JP225: '^N225'
  };
  var yhSym = yhMap[symbol] || symbol;
  var yhInterval = {'15min':'15m','1h':'1h','4h':'1h','1day':'1d','1week':'1wk'}[interval] || '1d';
  var yhRange = {'15min':'60d','1h':'730d','4h':'730d','1day':'2y','1week':'5y'}[interval] || '6mo';
  var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + yhSym +
            '?interval=' + yhInterval + '&range=' + yhRange;
  try {
    var r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }});
    if (!r.ok) {
      console.log('[BT YH] ' + symbol + ' ' + interval + ' (' + yhSym + '): HTTP ' + r.status);
      return null;
    }
    var data = await r.json();
    var chart = data && data.chart && data.chart.result && data.chart.result[0];
    if (!chart || !chart.timestamp) {
      var errMsg = data && data.chart && data.chart.error ?
                   JSON.stringify(data.chart.error) : 'no chart data';
      console.log('[BT YH] ' + symbol + ' ' + interval + ' (' + yhSym + '): ' + errMsg);
      return null;
    }
    var ts = chart.timestamp;
    var q = chart.indicators.quote[0];
    var out = [];
    for (var i = 0; i < ts.length; i++) {
      if (q.open[i] != null && q.high[i] != null && q.low[i] != null && q.close[i] != null) {
        out.push({
          time: ts[i] * 1000,
          open: +q.open[i], high: +q.high[i], low: +q.low[i], close: +q.close[i],
          vol: +(q.volume[i] || 0)
        });
      }
    }
    if (interval === '4h') out = btAggregateH1ToH4(out);
    return out;
  } catch(e) {
    return null;
  }
}

// Aggrega 4 candele H1 in una H4
function btAggregateH1ToH4(h1) {
  if (!h1.length) return [];
  var out = [];
  var bucket = null;
  for (var i = 0; i < h1.length; i++) {
    var c = h1[i];
    var d = new Date(c.time);
    // H4 boundaries: 00, 04, 08, 12, 16, 20 UTC
    var h4Start = Math.floor(d.getUTCHours() / 4) * 4;
    var bucketTime = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h4Start);
    if (!bucket || bucket.time !== bucketTime) {
      if (bucket) out.push(bucket);
      bucket = { time: bucketTime, open: c.open, high: c.high, low: c.low, close: c.close, vol: c.vol };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.vol += c.vol;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

// ─── Helper: simulazione di un singolo trade ──────────────────────────────────
// Ritorna { exitIdx, exitPrice, exitReason, barsHeld }
function btSimulateTradeOutcome(candles, entryIdx, dir, sl, tp, maxBars, trailFn) {
  var n = candles.length;
  var endIdx = Math.min(entryIdx + maxBars, n - 1);
  for (var i = entryIdx + 1; i <= endIdx; i++) {
    var h = candles[i].high, l = candles[i].low, c = candles[i].close;
    if (dir === 'BUY') {
      if (l <= sl) return { exitIdx: i, exitPrice: sl, reason: 'SL', barsHeld: i - entryIdx };
      if (h >= tp) return { exitIdx: i, exitPrice: tp, reason: 'TP', barsHeld: i - entryIdx };
      if (trailFn) {
        var tr = trailFn(i);
        if (tr !== null && !isNaN(tr) && c < tr) {
          return { exitIdx: i, exitPrice: c, reason: 'TRAIL', barsHeld: i - entryIdx };
        }
      }
    } else {
      if (h >= sl) return { exitIdx: i, exitPrice: sl, reason: 'SL', barsHeld: i - entryIdx };
      if (l <= tp) return { exitIdx: i, exitPrice: tp, reason: 'TP', barsHeld: i - entryIdx };
      if (trailFn) {
        var tr2 = trailFn(i);
        if (tr2 !== null && !isNaN(tr2) && c > tr2) {
          return { exitIdx: i, exitPrice: c, reason: 'TRAIL', barsHeld: i - entryIdx };
        }
      }
    }
  }
  return { exitIdx: endIdx, exitPrice: candles[endIdx].close, reason: 'TIMEOUT', barsHeld: endIdx - entryIdx };
}

// ─── Helper: ricerca indice HTF per timestamp M15 (ricerca binaria) ───────────
function btFindHtfIdx(htfCandles, tsMs) {
  // Ritorna l'indice dell'ultimo bar HTF chiuso al tempo tsMs (escludendo quello in formazione)
  if (!htfCandles || !htfCandles.length) return -1;
  var lo = 0, hi = htfCandles.length - 1, ans = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (htfCandles[mid].time < tsMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // -1 per stare conservativi (bar precedente, quello attuale potrebbe essere ancora aperto)
  return ans - 1;
}

// ─── Backtest Bot 2: ORB Indici ───────────────────────────────────────────────
var BT_ORB_SESSIONS = {
  // TwelveData ticker style
  SPX:  { tz: 'America/New_York', openH: 9, openM: 30 },
  NDX:  { tz: 'America/New_York', openH: 9, openM: 30 },
  DAX:  { tz: 'Europe/Berlin',    openH: 9, openM: 0  },
  UKX:  { tz: 'Europe/London',    openH: 8, openM: 0  },
  N225: { tz: 'Asia/Tokyo',       openH: 9, openM: 0  },
  // Capital.com style (matches ORB_SYMBOLS used elsewhere)
  US500: { tz: 'America/New_York', openH: 9, openM: 30 },
  US100: { tz: 'America/New_York', openH: 9, openM: 30 },
  GER40: { tz: 'Europe/Berlin',    openH: 9, openM: 0  },
  UK100: { tz: 'Europe/London',    openH: 8, openM: 0  },
  JP225: { tz: 'Asia/Tokyo',       openH: 9, openM: 0  }
};

function btGetLocalHour(tsMs, tz) {
  var d = new Date(tsMs);
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour12: false
  });
  var parts = fmt.formatToParts(d);
  var p = {};
  parts.forEach(function(x) { p[x.type] = x.value; });
  return {
    h: parseInt(p.hour) % 24,
    m: parseInt(p.minute),
    date: p.year + '-' + p.month + '-' + p.day
  };
}

function btSimulateORB(symbol, candles15, candlesH1, spread) {
  if (!candles15 || candles15.length < 100 || !candlesH1 || candlesH1.length < 50) return [];
  var sess = BT_ORB_SESSIONS[symbol];
  if (!sess) return [];

  // Pre-calcolo O(N) (era O(N^2) → causava OOM con H1 >5000 bars)
  var h1AdxArr = calcADXSeries(candlesH1, 14);
  var ema20Arr = calcEMASeries(candles15, 20);

  // Raggruppa per giornata locale
  var dayMap = {};
  for (var i = 0; i < candles15.length; i++) {
    var loc = btGetLocalHour(candles15[i].time, sess.tz);
    if (!dayMap[loc.date]) dayMap[loc.date] = [];
    dayMap[loc.date].push({ idx: i, h: loc.h, m: loc.m });
  }

  var trades = [];
  var dates = Object.keys(dayMap).sort();

  for (var d = 0; d < dates.length; d++) {
    var dayBars = dayMap[dates[d]];

    // Identifica bar OR (primi 30 min sessione)
    var orBars = [];
    for (var b = 0; b < dayBars.length; b++) {
      var bb = dayBars[b];
      if (bb.h === sess.openH && bb.m >= sess.openM && bb.m < sess.openM + 30) {
        orBars.push(bb.idx);
      }
    }
    if (orBars.length < 2) continue;

    var orHigh = -Infinity, orLow = Infinity;
    for (var oi = 0; oi < orBars.length; oi++) {
      orHigh = Math.max(orHigh, candles15[orBars[oi]].high);
      orLow = Math.min(orLow, candles15[orBars[oi]].low);
    }
    var orWidth = orHigh - orLow;
    var orPct = orHigh > 0 ? (orWidth / orHigh * 100) : 0;
    if (orPct < 0.3 || orPct > 1.5) continue;

    // Trading window: 4 ore dopo OR end
    var lastOrIdx = orBars[orBars.length - 1];
    var winEndIdx = Math.min(lastOrIdx + 16, candles15.length - 1);

    var traded = false;
    for (var idx = lastOrIdx + 1; idx <= winEndIdx && !traded; idx++) {
      var c = candles15[idx];
      var h1Idx = btFindHtfIdx(candlesH1, c.time);
      if (h1Idx < 0 || h1AdxArr[h1Idx] < 15) continue;

      var dir = null, entry = null, sl = null;
      if (c.close > orHigh) {
        dir = 'BUY'; entry = c.close + spread / 2; sl = orLow;
      } else if (c.close < orLow) {
        dir = 'SELL'; entry = c.close - spread / 2; sl = orHigh;
      }
      if (!dir) continue;

      var slDist = Math.abs(entry - sl);
      if (slDist < entry * 0.001 || slDist > entry * 0.02) continue;

      var tp = dir === 'BUY' ? entry + slDist * 5 : entry - slDist * 5;

      var trail = function(iM15) {
        if (iM15 - idx < 1) return null;
        return iM15 < ema20Arr.length ? ema20Arr[iM15] : null;
      };

      var outcome = btSimulateTradeOutcome(candles15, idx, dir, sl, tp,
                                            winEndIdx - idx, trail);
      var exitPrice = outcome.exitPrice + (dir === 'BUY' ? -spread / 2 : spread / 2);
      var pnl = dir === 'BUY' ? (exitPrice - entry) : (entry - exitPrice);
      var rMult = slDist > 0 ? pnl / slDist : 0;
      var pnlPct = (pnl / entry) * 100;

      trades.push({
        symbol: symbol, bot: 'ORB', dir: dir,
        entryTime: c.time, entryPrice: entry, sl: sl, tp: tp,
        exitTime: candles15[outcome.exitIdx].time, exitPrice: exitPrice,
        exitReason: outcome.reason, barsHeld: outcome.barsHeld,
        pnlPct: pnlPct, rMult: rMult
      });

      traded = true;
    }
  }

  return trades;
}

// ─── Backtest Bot 3: PA D1 ────────────────────────────────────────────────────
function btDetectPADayPattern(c, idx) {
  if (idx < 2) return { dir: null, name: null, score: 0 };
  var c0 = c[idx], c1 = c[idx-1], c2 = c[idx-2];
  var body0 = Math.abs(c0.close - c0.open);
  var body1 = Math.abs(c1.close - c1.open);
  var body2 = Math.abs(c2.close - c2.open);
  var range0 = c0.high - c0.low;
  var range2 = c2.high - c2.low;
  var bull0 = c0.close > c0.open, bear0 = c0.close < c0.open;
  var bull1 = c1.close > c1.open, bear1 = c1.close < c1.open;
  var bull2 = c2.close > c2.open, bear2 = c2.close < c2.open;
  var upWick = c0.high - Math.max(c0.open, c0.close);
  var loWick = Math.min(c0.open, c0.close) - c0.low;

  if (bear2 && body2 > range2 * 0.5 && body1 < body2 * 0.5 && bull0 &&
      c0.close > (c2.open + c2.close) / 2)
    return { dir: 'BUY', name: 'Morning Star', score: 4 };
  if (bull2 && body2 > range2 * 0.5 && body1 < body2 * 0.5 && bear0 &&
      c0.close < (c2.open + c2.close) / 2)
    return { dir: 'SELL', name: 'Evening Star', score: 4 };
  if (bear1 && bull0 && c0.open <= c1.close && c0.close >= c1.open && body0 > body1)
    return { dir: 'BUY', name: 'Bullish Engulfing', score: 3 };
  if (bull1 && bear0 && c0.open >= c1.close && c0.close <= c1.open && body0 > body1)
    return { dir: 'SELL', name: 'Bearish Engulfing', score: 3 };
  if (loWick > body0 * 2 && loWick > upWick * 2 &&
      Math.min(c0.open, c0.close) > c0.low + range0 * 0.66)
    return { dir: 'BUY', name: 'Pin Bar Bull', score: 3 };
  if (upWick > body0 * 2 && upWick > loWick * 2 &&
      Math.max(c0.open, c0.close) < c0.low + range0 * 0.33)
    return { dir: 'SELL', name: 'Pin Bar Bear', score: 3 };
  return { dir: null, name: null, score: 0 };
}

function btSimulatePA(symbol, candlesD1, candlesH4, spread) {
  if (!candlesD1 || candlesD1.length < 60 || !candlesH4 || candlesH4.length < 30) return [];

  // Pre-calcolo O(N) (era O(N^2))
  var d1E50Arr = calcEMASeries(candlesD1, 50);
  var h4E50Arr = calcEMASeries(candlesH4, 50);

  var trades = [];
  var lastSigIdx = -100;

  for (var k = 50; k < candlesD1.length - 1; k++) {
    if (k - lastSigIdx < 5) continue;
    var pat = btDetectPADayPattern(candlesD1, k);
    if (!pat.dir) continue;

    var d1Bull = candlesD1[k].close > d1E50Arr[k];
    var h4Idx = btFindHtfIdx(candlesH4, candlesD1[k].time);
    if (h4Idx < 50) continue;
    var h4Bull = candlesH4[h4Idx].close > h4E50Arr[h4Idx];

    var trendBull = d1Bull && h4Bull;
    var trendBear = !d1Bull && !h4Bull;
    var finalScore = pat.dir === 'BUY' ?
      pat.score + (trendBull ? 1 : (trendBear ? -1 : 0)) :
      pat.score + (trendBear ? 1 : (trendBull ? -1 : 0));
    if (finalScore < 3) continue;

    var entry = candlesD1[k+1].open + (pat.dir === 'BUY' ? spread / 2 : -spread / 2);
    var sl = pat.dir === 'BUY' ?
      Math.min(candlesD1[k].low, candlesD1[k-1].low) :
      Math.max(candlesD1[k].high, candlesD1[k-1].high);
    var slDist = Math.abs(entry - sl);
    if (slDist <= 0) continue;
    var tp = pat.dir === 'BUY' ? entry + slDist * 2.5 : entry - slDist * 2.5;

    var endIdx = Math.min(k + 1 + 30, candlesD1.length - 1);
    var exitInfo = null;
    for (var x = k + 1; x <= endIdx; x++) {
      var bar = candlesD1[x];
      if (pat.dir === 'BUY') {
        if (bar.low <= sl) { exitInfo = { idx: x, p: sl, r: 'SL' }; break; }
        if (bar.high >= tp) { exitInfo = { idx: x, p: tp, r: 'TP' }; break; }
      } else {
        if (bar.high >= sl) { exitInfo = { idx: x, p: sl, r: 'SL' }; break; }
        if (bar.low <= tp) { exitInfo = { idx: x, p: tp, r: 'TP' }; break; }
      }
    }
    if (!exitInfo) {
      exitInfo = { idx: endIdx, p: candlesD1[endIdx].close, r: 'TIMEOUT' };
    }
    var exitPrice = exitInfo.p + (pat.dir === 'BUY' ? -spread / 2 : spread / 2);
    var pnl = pat.dir === 'BUY' ? (exitPrice - entry) : (entry - exitPrice);
    var rMult = pnl / slDist;
    var pnlPct = (pnl / entry) * 100;

    trades.push({
      symbol: symbol, bot: 'PA', dir: pat.dir,
      entryTime: candlesD1[k+1].time, entryPrice: entry, sl: sl, tp: tp,
      exitTime: candlesD1[exitInfo.idx].time, exitPrice: exitPrice,
      exitReason: exitInfo.r, barsHeld: exitInfo.idx - k - 1,
      pnlPct: pnlPct, rMult: rMult, pattern: pat.name
    });
    lastSigIdx = k;
  }
  return trades;
}

// ─── Aggregator: calcola metriche da una lista trade ──────────────────────────
function btComputeMetrics(trades) {
  if (!trades.length) return {
    count: 0, wins: 0, losses: 0, winRate: 0,
    profitFactor: 0, profitFactorRaw: 0, sampleSignificant: false,
    expectancyR: 0, totalR: 0,
    avgWinR: 0, avgLossR: 0, maxDdR: 0,
    bestR: 0, worstR: 0, avgBarsHeld: 0
  };
  var rs = trades.map(function(t) { return t.rMult; });
  var wins = rs.filter(function(r) { return r > 0; });
  var losses = rs.filter(function(r) { return r <= 0; });
  var grossWin = wins.reduce(function(a, b) { return a + b; }, 0);
  var grossLossRaw = Math.abs(losses.reduce(function(a, b) { return a + b; }, 0));
  // Profit factor: solo se losses esistono. Altrimenti il valore non e' significativo.
  // Inoltre, sample size minimo per significativita' = 30 trade
  var pf;
  if (losses.length === 0) {
    pf = trades.length === 0 ? 0 : -1;  // -1 = sentinel "no losses, undefined"
  } else {
    pf = Math.round(grossWin / grossLossRaw * 100) / 100;
  }
  var cumR = 0, peak = 0, maxDd = 0;
  for (var i = 0; i < rs.length; i++) {
    cumR += rs[i];
    if (cumR > peak) peak = cumR;
    var dd = peak - cumR;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Math.round(wins.length / trades.length * 1000) / 10,
    profitFactor: pf,
    sampleSignificant: trades.length >= 30,  // soglia significativita' statistica
    expectancyR: Math.round(rs.reduce(function(a, b) { return a + b; }, 0) / rs.length * 1000) / 1000,
    totalR: Math.round(rs.reduce(function(a, b) { return a + b; }, 0) * 100) / 100,
    avgWinR: wins.length ? Math.round(grossWin / wins.length * 100) / 100 : 0,
    avgLossR: losses.length ? Math.round(losses.reduce(function(a,b){return a+b;}, 0) / losses.length * 100) / 100 : 0,
    maxDdR: Math.round(maxDd * 100) / 100,
    bestR: Math.round(Math.max.apply(null, rs) * 100) / 100,
    worstR: Math.round(Math.min.apply(null, rs) * 100) / 100,
    avgBarsHeld: Math.round(trades.reduce(function(a, t) { return a + t.barsHeld; }, 0) / trades.length * 10) / 10
  };
}

// ─── Runner asincrono ────────────────────────────────────────────────────────
async function btRun() {
  if (bt.running) return;
  bt.running = true;
  bt.progress = 0;
  bt.status = 'fetching';
  bt.message = 'Scaricamento storico esteso da TwelveData...';
  bt.startedAt = Date.now();
  bt.results = null;
  bt.error = null;

  try {
    // Simboli per i 2 bot operativi (MTF rimosso definitivamente: PF 0.37 in backtest)
    var paSymbols = (typeof PA_SYMBOLS !== 'undefined') ? PA_SYMBOLS.slice() : [];
    var orbSymbols = (typeof ORB_SYMBOLS !== 'undefined') ? ORB_SYMBOLS.slice() : [];
    var totalSymbols = paSymbols.length + orbSymbols.length;
    var done = 0;

    var historyData = {}; // sym -> { '15min', '1h', '4h', '1day' }

    // Fetch PA symbols (D1 + H4)
    for (var p = 0; p < paSymbols.length; p++) {
      var psym = paSymbols[p];
      bt.message = 'Fetch storico ' + psym + ' (PA D1)...';
      if (!historyData[psym]) historyData[psym] = {};
      var isCrypto2 = CRYPTO.indexOf(psym) !== -1;
      var fetcher2 = isCrypto2 ? btFetchYahooHistory : btFetchHistory;
      historyData[psym]['1day'] = await fetcher2(psym, '1day');
      historyData[psym]['4h'] = await fetcher2(psym, '4h');
      done++;
      bt.progress = Math.round(done / totalSymbols * 50);
      await new Promise(function(r) { setTimeout(r, 1000); });
    }

    // Fetch ORB symbols (M15 + H1) — usa Yahoo direttamente perche' TwelveData
    // ritorna prezzi non-index (ratio/yield) per cash indices con piano standard.
    // Yahoo ha dati cash indices puliti su tutti gli indici principali.
    for (var o = 0; o < orbSymbols.length; o++) {
      var osym = orbSymbols[o];
      bt.message = 'Fetch storico ' + osym + ' (ORB)...';
      historyData[osym] = historyData[osym] || {};

      // Yahoo direttamente (skip TD per indici)
      var yhRes15 = await btFetchYahooHistory(osym, '15min');
      console.log('[BT ORB] ' + osym + ' Yahoo M15: ' + (yhRes15 ? yhRes15.length + ' candele' : 'FAIL'));
      // Sanity check prezzo: scarta se fuori range plausibile per quell'indice
      if (yhRes15 && yhRes15.length && ORB_PRICE_RANGES[osym]) {
        var lastP = yhRes15[yhRes15.length - 1].close;
        var range = ORB_PRICE_RANGES[osym];
        if (lastP < range[0] || lastP > range[1]) {
          console.log('[BT ORB] ' + osym + ' Yahoo M15 prezzo ' + lastP +
                      ' fuori range [' + range[0] + ',' + range[1] + '], SCARTATO');
          yhRes15 = null;
        }
      }
      historyData[osym]['15min'] = yhRes15;

      var yhRes1h = await btFetchYahooHistory(osym, '1h');
      console.log('[BT ORB] ' + osym + ' Yahoo H1: ' + (yhRes1h ? yhRes1h.length + ' candele' : 'FAIL'));
      if (yhRes1h && yhRes1h.length && ORB_PRICE_RANGES[osym]) {
        var lastP1 = yhRes1h[yhRes1h.length - 1].close;
        var range1 = ORB_PRICE_RANGES[osym];
        if (lastP1 < range1[0] || lastP1 > range1[1]) {
          console.log('[BT ORB] ' + osym + ' Yahoo H1 prezzo ' + lastP1 +
                      ' fuori range [' + range1[0] + ',' + range1[1] + '], SCARTATO');
          yhRes1h = null;
        }
      }
      historyData[osym]['1h'] = yhRes1h;

      // Riepilogo
      var n15 = historyData[osym]['15min'] ? historyData[osym]['15min'].length : 0;
      var n1h = historyData[osym]['1h'] ? historyData[osym]['1h'].length : 0;
      console.log('[BT ORB FETCH] ' + osym + ': M15=' + n15 + ' H1=' + n1h +
                  ' (sessione TZ=' + (BT_ORB_SESSIONS[osym] ? BT_ORB_SESSIONS[osym].tz : 'UNDEFINED') + ')');
      done++;
      bt.progress = Math.round(done / totalSymbols * 50);
      await new Promise(function(r) { setTimeout(r, 1000); });
    }

    bt.status = 'simulating';
    bt.message = 'Simulazione strategie in corso...';

    // Esegui simulazioni (solo ORB + PA, MTF rimosso definitivamente)
    var results = {
      clean: { ORB: {}, PA: {} },
      costs: { ORB: {}, PA: {} }
    };

    var simStep = 0;
    var totalSims = paSymbols.length * 2 + orbSymbols.length * 2;

    // ORB
    for (var oi = 0; oi < orbSymbols.length; oi++) {
      var os = orbSymbols[oi];
      var hod = historyData[os];
      if (!hod) continue;
      bt.message = 'Simulazione ORB ' + os + '...';
      var ospread = BT_SPREADS[os] || 0;
      results.clean.ORB[os] = btSimulateORB(os, hod['15min'], hod['1h'], 0);
      results.costs.ORB[os] = btSimulateORB(os, hod['15min'], hod['1h'], ospread);
      simStep += 2;
      bt.progress = 50 + Math.round(simStep / totalSims * 50);
      await new Promise(function(r) { setTimeout(r, 100); });
      if (global.gc) global.gc();
    }

    // PA
    for (var pi = 0; pi < paSymbols.length; pi++) {
      var ps = paSymbols[pi];
      var hpd = historyData[ps];
      if (!hpd) continue;
      bt.message = 'Simulazione PA ' + ps + '...';
      var pspread = BT_SPREADS[ps] || 0;
      results.clean.PA[ps] = btSimulatePA(ps, hpd['1day'], hpd['4h'], 0);
      results.costs.PA[ps] = btSimulatePA(ps, hpd['1day'], hpd['4h'], pspread);
      simStep += 2;
      bt.progress = 50 + Math.round(simStep / totalSims * 50);
      await new Promise(function(r) { setTimeout(r, 100); });
      if (global.gc) global.gc();
    }

    // Aggrega metriche
    var summary = {
      generated: new Date().toISOString(),
      durationMs: Date.now() - bt.startedAt,
      perBot: {},
      perSymbol: {},
      total: {}
    };

    var allBots = ['ORB', 'PA'];
    var allClean = [], allCosts = [];

    allBots.forEach(function(b) {
      var bClean = [], bCosts = [];
      Object.keys(results.clean[b]).forEach(function(s) {
        bClean = bClean.concat(results.clean[b][s]);
        bCosts = bCosts.concat(results.costs[b][s]);
      });
      summary.perBot[b] = {
        clean: btComputeMetrics(bClean),
        costs: btComputeMetrics(bCosts)
      };
      // Per simbolo (solo costs per dashboard)
      Object.keys(results.costs[b]).forEach(function(s) {
        if (!summary.perSymbol[s]) summary.perSymbol[s] = {};
        summary.perSymbol[s][b] = btComputeMetrics(results.costs[b][s]);
      });
      allClean = allClean.concat(bClean);
      allCosts = allCosts.concat(bCosts);
    });

    summary.total = {
      clean: btComputeMetrics(allClean),
      costs: btComputeMetrics(allCosts)
    };

    // Verdict automatico
    var pf = summary.total.costs.profitFactor;
    var nTrades = summary.total.costs.count;
    var verdict = '';
    if (nTrades === 0) {
      verdict = 'Nessun trade generato in 6 mesi. Possibili cause: dati storici insufficienti, filtri troppo stretti, periodo storico anomalo.';
    } else if (nTrades < 30) {
      verdict = 'SAMPLE TROPPO PICCOLO - solo ' + nTrades + ' trade in 6 mesi. ' +
                'Servono almeno 30 trade per significativita statistica. ' +
                'Rilassa i filtri o estendi il periodo prima di valutare l edge.';
    } else if (pf === -1) {
      verdict = 'NESSUNA PERDITA registrata - statisticamente sospetto, ' +
                'probabilmente bias nei dati o periodo anomalo. ' + nTrades + ' trade.';
    } else if (pf >= 2.0) {
      verdict = 'ECCELLENTE - Sistema con edge solido. PF ' + pf + ' con costi reali su ' + nTrades + ' trade. Da operare.';
    } else if (pf >= 1.5) {
      verdict = 'BUONO - Sistema con edge plausibile. PF ' + pf + ' con costi su ' + nTrades + ' trade. Operabile con disciplina.';
    } else if (pf >= 1.2) {
      verdict = 'MARGINALE - PF ' + pf + ' su ' + nTrades + ' trade, sopravvive a malapena ai costi. Da ricalibrare.';
    } else if (pf >= 1.0) {
      verdict = 'PROBLEMATICO - PF ' + pf + ' su ' + nTrades + ' trade, edge troppo piccolo per essere significativo.';
    } else {
      verdict = 'PERDENTE - PF ' + pf + ' su ' + nTrades + ' trade, sistema non profittevole nel periodo testato. Strategia da rivedere.';
    }
    summary.verdict = verdict;

    // Trade list per export (limitiamo a 500 per non gonfiare la response)
    summary.tradeListSample = allCosts
      .sort(function(a, b) { return a.entryTime - b.entryTime; })
      .slice(0, 500)
      .map(function(t) {
        return {
          symbol: t.symbol, bot: t.bot, dir: t.dir,
          entryTime: new Date(t.entryTime).toISOString(),
          exitTime: new Date(t.exitTime).toISOString(),
          entryPrice: Math.round(t.entryPrice * 100000) / 100000,
          exitPrice: Math.round(t.exitPrice * 100000) / 100000,
          exitReason: t.exitReason,
          pnlPct: Math.round(t.pnlPct * 100) / 100,
          rMult: Math.round(t.rMult * 100) / 100,
          barsHeld: t.barsHeld
        };
      });

    bt.results = summary;
    bt.status = 'complete';
    bt.progress = 100;
    bt.message = 'Backtest completato';
    bt.finishedAt = Date.now();

    console.log('Backtest done in ' + ((bt.finishedAt - bt.startedAt) / 1000).toFixed(0) + 's');

  } catch(e) {
    bt.status = 'error';
    bt.error = e.message;
    bt.message = 'Errore: ' + e.message;
    console.error('Backtest error:', e);
  } finally {
    bt.running = false;
  }
}

// ─── API endpoints ────────────────────────────────────────────────────────────
app.post('/api/backtest', function(req, res) {
  if (bt.running) {
    res.json({ ok: false, message: 'Backtest gia in esecuzione', status: bt.status });
    return;
  }
  bt.results = null;
  btRun();  // fire-and-forget
  res.json({ ok: true, message: 'Backtest avviato' });
});

app.get('/api/backtest-status', function(req, res) {
  res.json({
    running: bt.running,
    progress: bt.progress,
    status: bt.status,
    message: bt.message,
    startedAt: bt.startedAt,
    finishedAt: bt.finishedAt,
    hasResults: bt.results !== null,
    error: bt.error
  });
});

app.get('/api/backtest-results', function(req, res) {
  if (!bt.results) {
    res.status(404).json({ ok: false, message: 'Nessun risultato disponibile. Lancia /api/backtest prima.' });
    return;
  }
  res.json(bt.results);
});


// ══════════════════════════════════════════════════════════════════════════════
// AVVIO SERVER (auto-start tutti i bot)
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, function() {
  console.log('ST-EA Server on port ' + PORT);
  console.log('TG: ' + (TG_TOKEN ? 'OK' : '--') + ' | TD: ' + (TD_KEY ? 'OK' : '--'));
  console.log('Trend Bot Symbols: ' + DEFAULT_SYMBOLS.join(', '));
  console.log('PA Bot Symbols: ' + PA_SYMBOLS.join(', '));
  console.log('ORB Bot Indices: ' + ORB_SYMBOLS.join(', '));
  console.log('STOCKS Bot Tickers: ' + STOCKS_SYMBOLS.join(', '));

  // MTF Trend M15: DISABILITATO di default dopo 5 round di backtest che hanno
  // mostrato PF 0.37 con costi reali (-86R su 173 trade in 2 mesi).
  // Per riattivarlo (per test/sviluppo): MTF_AUTOSTART=true
  var MTF_AUTOSTART = process.env.MTF_AUTOSTART === 'true';
  if (MTF_AUTOSTART) {
    console.log('Auto-starting Trend EA on: ' + DEFAULT_SYMBOLS.join(', '));
    activeSymbols = DEFAULT_SYMBOLS.slice();
    activeSymbols.forEach(function(s) { if (!symbolState[s]) initSymbol(s); });
    isRunning = true;
  } else {
    console.log('Trend EA NOT auto-started (PF 0.37 in backtest, set MTF_AUTOSTART=true to enable)');
    isRunning = false;
  }

  console.log('Auto-starting PA Bot on: ' + PA_SYMBOLS.join(', '));
  paRunning = true;

  console.log('Auto-starting ORB Bot');
  orbRunning = true;

  console.log('Auto-starting STOCKS Bot');
  STOCKS_SYMBOLS.forEach(function(s) { if (!stocksState[s]) initStocksSymbol(s); });
  stocksRunning = true;

  setTimeout(async function() {
    // 1. Trend bot (solo se MTF_AUTOSTART abilitato)
    if (MTF_AUTOSTART) {
      for (var i = 0; i < activeSymbols.length; i++) {
        try { await fetchCandles(activeSymbols[i]); }
        catch(e) { console.error(activeSymbols[i], e.message); }
        await new Promise(function(r) { setTimeout(r, 1000); });
      }
      startLoop(ENV_REFRESH, ENV_COOLDOWN);
      lastLoopTime = Date.now();
      console.log('Trend EA auto-started');
    } else {
      console.log('Trend EA skipped (disabled by default)');
    }

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

    // 4. STOCKS bot — fetch weekly per tutti i ticker
    for (var k = 0; k < STOCKS_SYMBOLS.length; k++) {
      try {
        await fetchStocksW1(STOCKS_SYMBOLS[k]);
      } catch(e) {
        console.error('STOCKS init ' + STOCKS_SYMBOLS[k] + ': ' + e.message);
      }
      await new Promise(function(r) { setTimeout(r, 2000); });
    }
    startStocksLoop();
    console.log('STOCKS Bot auto-started');

    await tgSend('<b>ST-EA Online</b>' +
                 '\n<b>Trend M15:</b> ' + activeSymbols.join(', ') +
                 '\n<b>PA D1:</b> ' + PA_SYMBOLS.join(', ') +
                 '\n<b>ORB:</b> ' + ORB_SYMBOLS.join(', ') +
                 '\n<b>STOCKS W1:</b> ' + STOCKS_SYMBOLS.join(', '));
  }, 5000);
});
