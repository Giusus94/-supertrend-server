const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TD_KEY     = process.env.TD_KEY     || '';
const RENDER_URL = process.env.RENDER_URL || '';

const CRYPTO_SYMBOLS = ['BTCUSD','ETHUSD','BNBUSD','SOLUSD','XRPUSD','ADAUSD','DOTUSD','MATICUSD'];
const USA_STOCKS     = ['AAPL','TSLA','NVDA','AMZN','MSFT','GOOGL','META','NFLX','AMD','INTC'];
const EU_STOCKS      = ['ENI.MI','ENEL.MI','RACE.MI','ISP.MI','UCG.MI','SIE.DE','BMW.DE','VOW3.DE','MC.PA','TTE.PA','SHEL.L','HSBA.L'];
const STOCK_SYMBOLS  = USA_STOCKS.concat(EU_STOCKS);
const TD_MAP = {
  XAUUSD:'XAU/USD', XAGUSD:'XAG/USD',
  EURUSD:'EUR/USD', GBPUSD:'GBP/USD', USDJPY:'USD/JPY',
  GBPJPY:'GBP/JPY', AUDUSD:'AUD/USD', USDCAD:'USD/CAD',
  USDCHF:'USD/CHF', NZDUSD:'NZD/USD', EURGBP:'EUR/GBP'
};

const DEFAULT_SYMBOLS = ['XAUUSD','BTCUSD','EURUSD'];
let isRunning      = false;
let activeSymbols  = DEFAULT_SYMBOLS.slice();
let refreshInterval = null;
let globalStats    = { total:0, buys:0, sells:0 };
let globalLog      = [];
const symbolState  = {};

function initSymbol(s) {
  symbolState[s] = {
    candles:[], candlesH1:[],
    lastDirection:null, lastSignalTime:0,
    lastPreAlertTime:0, lastPreAlertDir:null,
    stats:{ total:0, buys:0, sells:0, lastSignal:'--', lastFilter:'--' },
    signalLog:[]
  };
}
DEFAULT_SYMBOLS.forEach(initSymbol);

function calcATR(c, p) {
  var t = [];
  for (var i = 1; i < c.length; i++) {
    t.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close)));
  }
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
    pu = u; pl = l;
  }
  return res;
}

function calcRSI(c, period) {
  period = period || 14;
  if (c.length < period + 1) return 50;
  var gains = 0, losses = 0;
  for (var i = c.length - period; i < c.length; i++) {
    var d = c[i].close - c[i-1].close;
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  var ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

function calcEMA(c, period) {
  if (c.length < period) return c[c.length-1].close;
  var k = 2 / (period + 1);
  var ema = 0;
  for (var i = 0; i < period; i++) ema += c[i].close;
  ema = ema / period;
  for (var j = period; j < c.length; j++) ema = c[j].close * k + ema * (1 - k);
  return ema;
}

function calcAvgVol(c, period) {
  period = period || 20;
  var slice = c.slice(-period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) sum += (slice[i].vol || 0);
  return sum / slice.length;
}

function calcSR(c, lookback) {
  lookback = lookback || 50;
  var r = c.slice(-lookback), levels = [];
  for (var i = 2; i < r.length - 2; i++) {
    if (r[i].high > r[i-1].high && r[i].high > r[i-2].high && r[i].high > r[i+1].high && r[i].high > r[i+2].high)
      levels.push({ price: r[i].high, type: 'R', strength: 1 });
    if (r[i].low < r[i-1].low && r[i].low < r[i-2].low && r[i].low < r[i+1].low && r[i].low < r[i+2].low)
      levels.push({ price: r[i].low, type: 'S', strength: 1 });
  }
  var merged = [];
  for (var k = 0; k < levels.length; k++) {
    var l = levels[k];
    var nb = null;
    for (var m = 0; m < merged.length; m++) {
      if (Math.abs(merged[m].price - l.price) / l.price < 0.003) { nb = merged[m]; break; }
    }
    if (nb) nb.strength++; else merged.push({ price: l.price, type: l.type, strength: 1 });
  }
  merged.sort(function(a, b) { return b.strength - a.strength; });
  return merged.slice(0, 6);
}

function getNYTime() {
  var now = new Date();
  var nyStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  var nyDate = new Date(nyStr);
  return {
    day:  nyDate.getDay(),
    time: nyDate.getHours() * 100 + nyDate.getMinutes()
  };
}

function isMarketOpen(symbol) {
  if (CRYPTO_SYMBOLS.indexOf(symbol) !== -1) return true;
  var ny = getNYTime();
  if (ny.day === 0 || ny.day === 6) return false;
  if (USA_STOCKS.indexOf(symbol) !== -1) return ny.time >= 930 && ny.time <= 1600;
  if (EU_STOCKS.indexOf(symbol) !== -1)  return ny.time >= 300 && ny.time <= 1130;
  return true;
}

function getMarketStatus(symbol) {
  if (isMarketOpen(symbol)) return null;
  var ny = getNYTime();
  if (ny.day === 0 || ny.day === 6) return 'Mercato chiuso (weekend)';
  if (USA_STOCKS.indexOf(symbol) !== -1) return 'NYSE chiusa (09:30-16:00 NY)';
  if (EU_STOCKS.indexOf(symbol) !== -1)  return 'Borsa EU chiusa (09:00-17:30 CET)';
  return 'Mercato chiuso';
}

async function fetchKuCoin(symbol, interval, limit, isH1, st) {
  try {
    var pair = symbol.replace('USD', '-USDT');
    var url = 'https://api.kucoin.com/api/v1/market/candles?type=' + interval + '&symbol=' + pair + '&pageSize=' + limit;
    var res = await fetch(url);
    var data = await res.json();
    if (data.code === '200000' && Array.isArray(data.data) && data.data.length > 10) {
      var p = data.data.reverse().map(function(k) { return { open:+k[1], high:+k[3], low:+k[4], close:+k[2], vol:+k[5] }; });
      if (isH1) st.candlesH1 = p; else st.candles = p;
      return;
    }
  } catch(e) {}
  try {
    var pair2 = symbol.replace('USD', '-USDT');
    var bar = isH1 ? '1H' : '15m';
    var url2 = 'https://www.okx.com/api/v5/market/candles?instId=' + pair2 + '&bar=' + bar + '&limit=' + limit;
    var res2 = await fetch(url2);
    var data2 = await res2.json();
    if (data2.code === '0' && Array.isArray(data2.data) && data2.data.length > 10) {
      var p2 = data2.data.reverse().map(function(k) { return { open:+k[1], high:+k[2], low:+k[3], close:+k[4], vol:+k[5] }; });
      if (isH1) st.candlesH1 = p2; else st.candles = p2;
    }
  } catch(e) {}
}

async function fetchTD(symbol, interval, limit, isH1, st) {
  if (!TD_KEY) {
    var p = symbol.indexOf('XAU') !== -1 ? 2340 : symbol.indexOf('XAG') !== -1 ? 28 : 1.082;
    var arr = [];
    for (var i = 0; i < limit; i++) {
      var ch = (Math.random() - 0.488) * p * 0.003, o = p, c = p + ch;
      arr.push({ open:o, high:Math.max(o,c)*1.001, low:Math.min(o,c)*0.999, close:c, vol:Math.random()*1000 });
      p = c;
    }
    if (isH1) st.candlesH1 = arr; else st.candles = arr;
    return;
  }
  var sym = TD_MAP[symbol] || symbol;
  var url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(sym) + '&interval=' + interval + '&outputsize=' + limit + '&apikey=' + TD_KEY;
  var res = await fetch(url);
  var data = await res.json();
  if (data.status === 'error') throw new Error(data.message);
  var parsed = data.values.reverse().map(function(c) { return { open:+c.open, high:+c.high, low:+c.low, close:+c.close, vol:+(c.volume||0) }; });
  // Validate price ranges to catch stale/wrong data
  if (parsed.length > 0) {
    var lastClose = parsed[parsed.length-1].close;
    var valid = true;
    if (symbol === 'XAUUSD' && (lastClose < 1500 || lastClose > 5000)) valid = false;
    if (symbol === 'XAGUSD' && (lastClose < 10   || lastClose > 100))  valid = false;
    if (symbol === 'EURUSD' && (lastClose < 0.8  || lastClose > 1.5))  valid = false;
    if (symbol === 'GBPUSD' && (lastClose < 0.9  || lastClose > 1.8))  valid = false;
    if (symbol === 'USDJPY' && (lastClose < 80   || lastClose > 200))  valid = false;
    if (!valid) {
      console.error('Invalid price for ' + symbol + ': ' + lastClose + ' - using demo data');
      var p2 = symbol.indexOf('XAU') !== -1 ? 3100 : symbol.indexOf('XAG') !== -1 ? 32 : 1.082;
      var arr2 = [];
      for (var k = 0; k < limit; k++) {
        var ch2 = (Math.random() - 0.488) * p2 * 0.003, o2 = p2, c2 = p2 + ch2;
        arr2.push({ open:o2, high:Math.max(o2,c2)*1.001, low:Math.min(o2,c2)*0.999, close:c2, vol:Math.random()*1000 });
        p2 = c2;
      }
      if (isH1) st.candlesH1 = arr2; else st.candles = arr2;
      return;
    }
  }
  if (isH1) st.candlesH1 = parsed; else st.candles = parsed;
}

async function fetchYahoo(symbol, interval, limit, isH1, st) {
  try {
    var range = isH1 ? '1mo' : '5d';
    var intv  = isH1 ? '1h'  : '15m';
    var url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=' + intv + '&range=' + range + '&includePrePost=false';
    var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    var data = await res.json();
    var chart = data && data.chart && data.chart.result && data.chart.result[0];
    if (!chart) throw new Error('No Yahoo data');
    var timestamps = chart.timestamp;
    var q = chart.indicators.quote[0];
    var parsed = [];
    for (var i = 0; i < timestamps.length; i++) {
      if (q.open[i] && q.high[i] && q.low[i] && q.close[i]) {
        parsed.push({ open:+q.open[i].toFixed(4), high:+q.high[i].toFixed(4), low:+q.low[i].toFixed(4), close:+q.close[i].toFixed(4), vol:q.volume[i]||0 });
      }
    }
    parsed = parsed.slice(-limit);
    if (parsed.length < 10) throw new Error('Not enough Yahoo candles');
    if (isH1) st.candlesH1 = parsed; else st.candles = parsed;
  } catch(e) {
    console.error('Yahoo error ' + symbol + ': ' + e.message);
    var p = 100;
    var arr = [];
    for (var j = 0; j < limit; j++) {
      var ch = (Math.random() - 0.488) * p * 0.01, o = p, c2 = p + ch;
      arr.push({ open:o, high:Math.max(o,c2)*1.002, low:Math.min(o,c2)*0.998, close:c2, vol:Math.random()*1000000 });
      p = c2;
    }
    if (isH1) st.candlesH1 = arr; else st.candles = arr;
  }
}

async function fetchCandles(symbol) {
  var st = symbolState[symbol];
  if (!st) return;
  if (CRYPTO_SYMBOLS.indexOf(symbol) !== -1) {
    await fetchKuCoin(symbol, '15min', 120, false, st);
    await fetchKuCoin(symbol, '1hour', 100, true, st);
  } else if (STOCK_SYMBOLS.indexOf(symbol) !== -1) {
    await fetchYahoo(symbol, '15m', 120, false, st);
    await fetchYahoo(symbol, '1h', 100, true, st);
  } else {
    await fetchTD(symbol, '15min', 200, false, st);
    await fetchTD(symbol, '1h', 100, true, st);
  }
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return false;
  try {
    var res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: text, parse_mode: 'HTML' })
    });
    var d = await res.json();
    return d.ok;
  } catch(e) { return false; }
}

async function sendTelegramPhoto(caption, chartUrl) {
  if (!TG_TOKEN || !TG_CHAT_ID) return false;
  try {
    var res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendPhoto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, photo: chartUrl, caption: caption, parse_mode: 'HTML' })
    });
    var d = await res.json();
    if (!d.ok) return sendTelegram(caption);
    return d.ok;
  } catch(e) { return sendTelegram(caption); }
}

function buildChartUrl(symbol, dir, price, sl, tp, ema50, rsi, candles) {
  var last30 = candles.slice(-30);
  var dec = price > 100 ? 2 : price > 10 ? 3 : 4;
  var closes = last30.map(function(c) { return +c.close.toFixed(dec); });
  var labels = last30.map(function(_, i) { return i === 29 ? 'NOW' : ''; });
  var stLines = last30.map(function(_, i) {
    var st = calcST(candles.slice(0, candles.length - 29 + i), 14, 3.0);
    return st.length ? +st[st.length-1].line.toFixed(dec) : null;
  });
  var color = dir === 'BUY' ? 'rgb(0,255,157)' : 'rgb(255,56,96)';
  var ema50arr = closes.map(function() { return +ema50.toFixed(dec); });
  var slArr = closes.map(function() { return +sl; });
  var tpArr = closes.map(function() { return +tp; });
  var cfg = {
    type: 'line',
    data: { labels: labels, datasets: [
      { label:'Price', data:closes, borderColor:'#00d4ff', backgroundColor:'rgba(0,212,255,0.08)', borderWidth:2, pointRadius:closes.map(function(_,i){ return i===29?6:0; }), fill:false, tension:0.1 },
      { label:'ST', data:stLines, borderColor:color, borderWidth:1.5, borderDash:[4,2], pointRadius:0, fill:false },
      { label:'EMA50', data:ema50arr, borderColor:'#ffcc00', borderWidth:1, borderDash:[6,3], pointRadius:0, fill:false },
      { label:'TP', data:tpArr, borderColor:'rgba(0,255,157,0.6)', borderWidth:1, borderDash:[3,3], pointRadius:0, fill:false },
      { label:'SL', data:slArr, borderColor:'rgba(255,56,96,0.6)', borderWidth:1, borderDash:[3,3], pointRadius:0, fill:false }
    ]},
    options: {
      plugins: {
        title: { display:true, text:(dir==='BUY'?'BUY ':'SELL ')+symbol+' @ '+price.toFixed(dec)+' | RSI:'+rsi.toFixed(1), color:color, font:{size:14,weight:'bold'} },
        legend: { labels: { color:'#9ec8de', font:{size:10} } }
      },
      scales: {
        x: { ticks:{color:'#2a5470'}, grid:{color:'#0e2438'} },
        y: { ticks:{color:'#9ec8de'}, grid:{color:'#0e2438'} }
      },
      backgroundColor: '#03070b'
    }
  };
  return 'https://quickchart.io/chart?c=' + encodeURIComponent(JSON.stringify(cfg)) + '&w=600&h=350&bkg=%2303070b';
}

var strategies = [
  { id:1, atr:7,  mult:2.0 },
  { id:2, atr:14, mult:3.0 },
  { id:3, atr:21, mult:4.5 }
];

async function checkSignalsForSymbol(symbol, consensus, cooldownMin) {
  consensus   = consensus   || 3;
  cooldownMin = cooldownMin || 15;
  var st = symbolState[symbol];
  if (!st || !st.candles.length || !isRunning) return;
  if (Date.now() - st.lastSignalTime < cooldownMin * 60 * 1000) return;

  var marketStatus = getMarketStatus(symbol);
  if (marketStatus) { st.stats.lastFilter = marketStatus; return; }

  var bv = 0, sv = 0;
  for (var i = 0; i < strategies.length; i++) {
    var r = calcST(st.candles, strategies[i].atr, strategies[i].mult);
    if (!r.length) continue;
    if (r[r.length-1].dir === 1) bv++; else sv++;
  }
  var dir = null;
  if (bv >= consensus) dir = 'BUY';
  else if (sv >= consensus) dir = 'SELL';
  if (!dir || dir === st.lastDirection) return;

  var price = st.candles[st.candles.length-1].close;

  if (st.candlesH1.length >= 2) {
    var stH1 = calcST(st.candlesH1, 14, 3.0);
    if (stH1.length) {
      var h1Dir = stH1[stH1.length-1].dir === 1 ? 'BUY' : 'SELL';
      if (h1Dir !== dir) { st.stats.lastFilter = 'H1 contro trend (H1=' + h1Dir + ')'; return; }
    }
  }

  var ema50 = calcEMA(st.candles, 50);
  if (dir === 'BUY' && price < ema50) { st.stats.lastFilter = 'Prezzo sotto EMA50'; return; }
  if (dir === 'SELL' && price > ema50) { st.stats.lastFilter = 'Prezzo sopra EMA50'; return; }

  var rsi = calcRSI(st.candles, 14);
  if (dir === 'BUY' && rsi > 70)  { st.stats.lastFilter = 'RSI ipercomprato (' + rsi.toFixed(1) + ')'; return; }
  if (dir === 'SELL' && rsi < 30) { st.stats.lastFilter = 'RSI ipervenduto (' + rsi.toFixed(1) + ')'; return; }

  var avgVol  = calcAvgVol(st.candles, 20);
  var lastVol = st.candles[st.candles.length-1].vol || 0;
  if (avgVol > 0 && lastVol < avgVol * 0.8) { st.stats.lastFilter = 'Volume basso'; return; }

  var atr = calcATR(st.candles, 14)[st.candles.length-2] || 0;
  var dec = price > 100 ? 2 : price > 10 ? 3 : 4;
  var minDist = price * 0.005;
  var slDist  = Math.max(atr * 1.5, minDist);
  var tpDist  = slDist * 2;
  var sl = (dir === 'BUY' ? price - slDist : price + slDist).toFixed(dec);
  var tp = (dir === 'BUY' ? price + tpDist : price - tpDist).toFixed(dec);

  var srLevels   = calcSR(st.candles, 50);
  var supports   = srLevels.filter(function(l) { return l.type === 'S' && l.price < price; }).sort(function(a,b) { return b.price - a.price; });
  var resistances = srLevels.filter(function(l) { return l.type === 'R' && l.price > price; }).sort(function(a,b) { return a.price - b.price; });
  var srText = (resistances[0] ? 'Resistenza: ' + resistances[0].price.toFixed(dec) + '\n' : '') +
               (supports[0]    ? 'Supporto: '   + supports[0].price.toFixed(dec)    + '\n' : '');

  var time = new Date().toUTCString().slice(0, 25);
  var msg =
    (dir === 'BUY' ? '[BUY]' : '[SELL]') + ' <b>SuperTrend Signal</b>\n\n' +
    '[S] <b>Simbolo:</b> ' + symbol + '\n' +
    '[D] <b>Direzione:</b> <b>' + dir + '</b>\n' +
    '[P] <b>Prezzo:</b> ' + price.toFixed(dec) + '\n' +
    '[SL] <b>SL:</b> ' + sl + '\n' +
    '[TP] <b>TP:</b> ' + tp + '\n' +
    '[RR] <b>R:R:</b> 1:2\n\n' +
    (srText ? '[LV] <b>Livelli:</b>\n' + srText + '\n' : '') +
    '[OK] ST ' + Math.max(bv,sv) + '/3 | H1 | EMA50 | RSI ' + rsi.toFixed(1) + ' | Vol\n' +
    '[T] ' + time + ' UTC\n\n' +
    '<i>Non consulenza finanziaria.</i>';

  var chartUrl = buildChartUrl(symbol, dir, price, +sl, +tp, ema50, rsi, st.candles);
  var ok = await sendTelegramPhoto(msg, chartUrl);
  if (ok) {
    st.stats.total++;
    if (dir === 'BUY') st.stats.buys++; else st.stats.sells++;
    st.stats.lastSignal = dir;
    st.stats.lastFilter = 'Segnale inviato: ' + dir + ' @ ' + price.toFixed(dec);
    st.lastSignalTime   = Date.now();
    st.lastDirection    = dir;
    st.signalLog.unshift({ dir:dir, price:price.toFixed(dec), time:time, symbol:symbol, rsi:rsi.toFixed(1) });
    if (st.signalLog.length > 20) st.signalLog.pop();
    globalStats.total++;
    if (dir === 'BUY') globalStats.buys++; else globalStats.sells++;
    globalLog.unshift({ dir:dir, price:price.toFixed(dec), time:time, symbol:symbol });
    if (globalLog.length > 50) globalLog.pop();
    console.log('Signal: ' + symbol + ' ' + dir + ' @ ' + price.toFixed(dec));
  }
}

async function checkPreSignalForSymbol(symbol, consensus) {
  consensus = consensus || 3;
  var st = symbolState[symbol];
  if (!st || !st.candles.length || !isRunning) return;
  if (Date.now() - st.lastPreAlertTime < 30 * 60 * 1000) return;
  var bv = 0, sv = 0;
  for (var i = 0; i < strategies.length; i++) {
    var r = calcST(st.candles, strategies[i].atr, strategies[i].mult);
    if (!r.length) continue;
    if (r[r.length-1].dir === 1) bv++; else sv++;
  }
  var h1Dir = null;
  if (st.candlesH1.length >= 2) {
    var stH1 = calcST(st.candlesH1, 14, 3.0);
    if (stH1.length) h1Dir = stH1[stH1.length-1].dir === 1 ? 'BUY' : 'SELL';
  }
  var m15Dir = bv >= consensus ? 'BUY' : sv >= consensus ? 'SELL' : null;
  if (!m15Dir || !h1Dir || m15Dir === h1Dir || m15Dir === st.lastPreAlertDir) return;
  var price = st.candles[st.candles.length-1].close;
  var rsi   = calcRSI(st.candles, 14);
  var dec   = price > 100 ? 2 : price > 10 ? 3 : 4;
  var ok = await sendTelegram(
    '[!] <b>Pre-Segnale ' + symbol + '</b>\n' +
    'M15: ' + m15Dir + ' (' + Math.max(bv,sv) + '/3)\n' +
    'H1: ' + h1Dir + ' (opposto)\n' +
    'Prezzo: ' + price.toFixed(dec) + ' | RSI: ' + rsi.toFixed(1) + '\n' +
    '<i>Aspetta allineamento H1!</i>'
  );
  if (ok) { st.lastPreAlertTime = Date.now(); st.lastPreAlertDir = m15Dir; }
}

function startLoop(refreshSec, consensus, cooldown) {
  refreshSec = refreshSec || 300;
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(async function() {
    for (var i = 0; i < activeSymbols.length; i++) {
      var symbol = activeSymbols[i];
      try {
        var st = symbolState[symbol];
        if (st) {
          var mStatus = getMarketStatus(symbol);
          if (mStatus) {
            st.stats.lastFilter = '[MERCATO CHIUSO] ' + mStatus;
            console.log(symbol + ': ' + mStatus);
            if (!st.candles.length) {
              try { await fetchCandles(symbol); } catch(e) {}
            }
            continue;
          } else {
            // Clear closed message when market reopens
            if (st.stats.lastFilter.indexOf('MERCATO CHIUSO') !== -1) {
              st.stats.lastFilter = 'Mercato aperto - analisi in corso...';
            }
          }
        }
        await fetchCandles(symbol);
        await checkSignalsForSymbol(symbol, consensus, cooldown);
        await checkPreSignalForSymbol(symbol, consensus);
        await new Promise(function(r) { setTimeout(r, 5000); });
      } catch(e) { console.error('Loop error ' + symbol + ': ' + e.message); }
    }
  }, refreshSec * 1000);
}

if (RENDER_URL) {
  setInterval(async function() {
    try { await fetch(RENDER_URL + '/api/status'); console.log('Keep-alive OK'); }
    catch(e) { console.log('Keep-alive failed'); }
  }, 14 * 60 * 1000);
}

app.get('/api/status', function(req, res) {
  var perSymbol = {};
  for (var i = 0; i < activeSymbols.length; i++) {
    var s = activeSymbols[i];
    var st = symbolState[s];
    perSymbol[s] = {
      stats: st.stats,
      lastPrice: st.candles.length ? st.candles[st.candles.length-1].close : 0,
      candleCount: st.candles.length,
      signalLog: st.signalLog.slice(0, 5)
    };
  }
  res.json({ isRunning:isRunning, activeSymbols:activeSymbols, globalStats:globalStats,
    globalLog:globalLog.slice(0,20), tgConnected:!!(TG_TOKEN&&TG_CHAT_ID),
    dataConnected:!!TD_KEY, perSymbol:perSymbol });
});

app.post('/api/start', async function(req, res) {
  var symbols   = req.body.symbols;
  var consensus = req.body.consensus;
  var cooldown  = req.body.cooldown;
  var refresh   = req.body.refresh;
  if (symbols && Array.isArray(symbols)) {
    activeSymbols = symbols.slice(0, 5);
    for (var i = 0; i < activeSymbols.length; i++) {
      if (!symbolState[activeSymbols[i]]) initSymbol(activeSymbols[i]);
    }
  }
  isRunning = true;
  try {
    for (var j = 0; j < activeSymbols.length; j++) {
      await fetchCandles(activeSymbols[j]);
      await new Promise(function(r) { setTimeout(r, 3000); });
    }
    startLoop(refresh || 300, consensus || 3, cooldown || 15);
    await sendTelegram('SuperTrend EA Avviato\nSimbolii: ' + activeSymbols.join(', ') + '\nFiltri: RSI + EMA50 + Vol + H1\n' + new Date().toUTCString().slice(0,25));
    res.json({ ok:true, message:'EA avviato su ' + activeSymbols.join(', ') });
  } catch(e) { res.json({ ok:false, message:e.message }); }
});

app.post('/api/stop', async function(req, res) {
  isRunning = false;
  if (refreshInterval) clearInterval(refreshInterval);
  await sendTelegram('EA Fermato');
  res.json({ ok:true });
});

app.post('/api/test', async function(req, res) {
  var ok = await sendTelegram('Test OK! Monitora: ' + activeSymbols.join(', '));
  res.json({ ok:ok, message:ok ? 'Inviato!' : 'Errore' });
});

app.get('/api/candles/:symbol', function(req, res) {
  var st = symbolState[req.params.symbol];
  if (!st) return res.json({ candles:[], candlesH1:[] });
  res.json({ candles:st.candles.slice(-60), candlesH1:st.candlesH1.slice(-50) });
});

app.get('/api/candles', function(req, res) {
  var st = symbolState[activeSymbols[0]] || { candles:[], candlesH1:[] };
  res.json({ candles:st.candles.slice(-60), candlesH1:st.candlesH1.slice(-50) });
});

app.listen(PORT, function() {
  console.log('SuperTrend EA on port ' + PORT);
  (async function() {
    for (var i = 0; i < DEFAULT_SYMBOLS.length; i++) {
      try { await fetchCandles(DEFAULT_SYMBOLS[i]); } catch(e) { console.error(DEFAULT_SYMBOLS[i], e.message); }
      await new Promise(function(r) { setTimeout(r, 4000); });
    }
  })();
});
