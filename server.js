const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT        = process.env.PORT       || 3000;
const TG_TOKEN    = process.env.TG_TOKEN   || '';
const TG_CHAT_ID  = process.env.TG_CHAT_ID || '';
const TD_KEY      = process.env.TD_KEY     || '';
const RENDER_URL  = process.env.RENDER_URL || '';

// ==============================
// SYMBOL CONFIG
// ==============================
const CRYPTO  = ['BTCUSD','ETHUSD','SOLUSD','XRPUSD','BNBUSD','ADAUSD'];
const METALS  = ['XAUUSD','XAGUSD','WTIUSD','BRNUSD','USOIL','UKOIL'];
const FOREX   = ['EURUSD','GBPUSD','USDJPY','GBPJPY','AUDUSD','USDCAD','USDCHF','NZDUSD'];

const TD_MAP = {
  EURUSD:'EUR/USD', GBPUSD:'GBP/USD', USDJPY:'USD/JPY',
  GBPJPY:'GBP/JPY', AUDUSD:'AUD/USD', USDCAD:'USD/CAD',
  USDCHF:'USD/CHF', NZDUSD:'NZD/USD',
  XAUUSD:'XAU/USD', XAGUSD:'XAG/USD'
};

const YAHOO_MAP = {
  XAUUSD:'GC=F', XAGUSD:'SI=F',
  WTIUSD:'CL=F', BRNUSD:'BZ=F',
  USOIL:'CL=F', UKOIL:'BZ=F',
  EURUSD:'EURUSD=X', GBPUSD:'GBPUSD=X', USDJPY:'USDJPY=X',
  GBPJPY:'GBPJPY=X', AUDUSD:'AUDUSD=X', USDCAD:'USDCAD=X',
  USDCHF:'USDCHF=X', NZDUSD:'NZDUSD=X'
};

const PRICE_RANGES = {
  BTCUSD:[20000,200000], ETHUSD:[500,20000], SOLUSD:[10,1000],
  XRPUSD:[0.1,100], BNBUSD:[100,5000], ADAUSD:[0.01,10],
  XAUUSD:[1000,8000], XAGUSD:[10,200],
  WTIUSD:[20,200], BRNUSD:[20,200], USOIL:[20,200], UKOIL:[20,200],
  EURUSD:[0.8,1.6], GBPUSD:[0.9,1.8], USDJPY:[80,200],
  GBPJPY:[100,250], AUDUSD:[0.5,1.1], USDCAD:[1.0,1.8],
  USDCHF:[0.7,1.3], NZDUSD:[0.4,1.0]
};

const PIP_VALUE = {
  EURUSD:10, GBPUSD:10, USDJPY:10, GBPJPY:10,
  AUDUSD:10, USDCAD:10, USDCHF:10, NZDUSD:10,
  XAUUSD:1,  XAGUSD:1,
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

// ==============================
// STATE
// ==============================
// ==============================
// DEFAULT CONFIG FROM ENV
// ==============================
// Set DEFAULT_SYMBOLS on Render Environment to persist symbols
// e.g. DEFAULT_SYMBOLS=XAUUSD,EURUSD,BTCUSD
// Set AUTO_START=true to auto-start EA on deploy
var ENV_SYMBOLS = process.env.DEFAULT_SYMBOLS ? process.env.DEFAULT_SYMBOLS.split(',').map(function(s){return s.trim();}) : null;
var AUTO_START  = process.env.AUTO_START === 'true';
var ENV_REFRESH = parseInt(process.env.REFRESH_SEC)||120;
var ENV_COOLDOWN= parseInt(process.env.COOLDOWN_MIN)||15;
var ENV_CONSENSUS= parseInt(process.env.CONSENSUS)||3;

const DEFAULT_SYMBOLS = ENV_SYMBOLS || ['XAUUSD','BTCUSD','EURUSD'];
var isRunning      = false;
var activeSymbols  = DEFAULT_SYMBOLS.slice();
var refreshTimer   = null;
var globalStats    = { total:0, buys:0, sells:0 };
var lastLoopTime   = 0;
var loopRunning    = false;
var globalLog      = [];
var symbolState    = {};

function initSymbol(s) {
  symbolState[s] = {
    candles:[], candlesH1:[], candlesM5:[],
    lastDir:null, lastSignalTime:0,
    lastPreTime:0, lastPreDir:null,
    lastSRAlertTime:0,
    stats:{ total:0, buys:0, sells:0, lastSignal:'--', lastFilter:'--' },
    log:[]
  };
}
DEFAULT_SYMBOLS.forEach(initSymbol);

// ==============================
// INDICATORS
// ==============================
function calcATR(c, p) {
  var t = [];
  for (var i = 1; i < c.length; i++)
    t.push(Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)));
  var a = [t[0]];
  for (var j = 1; j < t.length; j++) a.push((a[j-1]*(p-1)+t[j])/p);
  return a;
}

function calcST(c, period, mult) {
  var atrs = calcATR(c, period);
  var res = [], dir = 1, pu = 0, pl = 0;
  for (var i = 1; i < c.length; i++) {
    var atr = atrs[i-1]||atrs[0], hl2 = (c[i].high+c[i].low)/2;
    var u = hl2+mult*atr, l = hl2-mult*atr;
    if (i > 1) { u=(u<pu||c[i-1].close>pu)?u:pu; l=(l>pl||c[i-1].close<pl)?l:pl; }
    var cl = c[i].close;
    if (dir===1&&cl<l) dir=-1; else if (dir===-1&&cl>u) dir=1;
    res.push({ dir:dir, line:dir===1?l:u, atr:atr }); pu=u; pl=l;
  }
  return res;
}

function calcRSI(c, p) {
  p = p||14;
  if (c.length < p+1) return 50;
  var g=0, l=0;
  for (var i = c.length-p; i < c.length; i++) {
    var d = c[i].close-c[i-1].close;
    if (d>0) g+=d; else l+=Math.abs(d);
  }
  var ag=g/p, al=l/p;
  if (al===0) return 100;
  return 100-(100/(1+ag/al));
}

function calcEMA(c, p) {
  if (c.length<p) return c[c.length-1].close;
  var k=2/(p+1), ema=0;
  for (var i=0;i<p;i++) ema+=c[i].close;
  ema=ema/p;
  for (var j=p;j<c.length;j++) ema=c[j].close*k+ema*(1-k);
  return ema;
}

function calcAvgVol(c, p) {
  p=p||20;
  var s=c.slice(-p), sum=0;
  for (var i=0;i<s.length;i++) sum+=(s[i].vol||0);
  return sum/s.length;
}

function calcSR(c, lookback) {
  lookback=lookback||50;
  var r=c.slice(-lookback), levels=[];
  for (var i=2;i<r.length-2;i++) {
    if (r[i].high>r[i-1].high&&r[i].high>r[i-2].high&&r[i].high>r[i+1].high&&r[i].high>r[i+2].high)
      levels.push({price:r[i].high,type:'R',strength:1});
    if (r[i].low<r[i-1].low&&r[i].low<r[i-2].low&&r[i].low<r[i+1].low&&r[i].low<r[i+2].low)
      levels.push({price:r[i].low,type:'S',strength:1});
  }
  var merged=[];
  for (var k=0;k<levels.length;k++) {
    var lv=levels[k], nb=null;
    for (var m=0;m<merged.length;m++) {
      if (Math.abs(merged[m].price-lv.price)/lv.price<0.003) { nb=merged[m]; break; }
    }
    if (nb) nb.strength++; else merged.push({price:lv.price,type:lv.type,strength:1});
  }
  merged.sort(function(a,b){return b.strength-a.strength;});
  return merged.slice(0,8);
}

// ==============================
// ORDER BLOCK DETECTION
// ==============================
function detectOrderBlocks(candles) {
  if (candles.length < 10) return [];
  var obs = [];

  for (var i = 2; i < candles.length-1; i++) {
    var c  = candles[i];
    var cn = candles[i+1]; // next candle
    var cp = candles[i-1]; // prev candle

    var body  = Math.abs(c.close-c.open);
    var range = c.high-c.low;
    if (range===0) continue;

    // Bullish OB: bearish candle followed by strong bullish move
    var isBear = c.close < c.open;
    var nextBull = cn.close > cn.open && Math.abs(cn.close-cn.open) > body*1.2;
    if (isBear && nextBull && body > range*0.5) {
      obs.push({
        type: 'BUY',
        high: c.high,
        low:  c.low,
        mid:  (c.high+c.low)/2,
        idx:  i,
        strength: Math.round(body/range*10)
      });
    }

    // Bearish OB: bullish candle followed by strong bearish move
    var isBull2 = c.close > c.open;
    var nextBear = cn.close < cn.open && Math.abs(cn.close-cn.open) > body*1.2;
    if (isBull2 && nextBear && body > range*0.5) {
      obs.push({
        type: 'SELL',
        high: c.high,
        low:  c.low,
        mid:  (c.high+c.low)/2,
        idx:  i,
        strength: Math.round(body/range*10)
      });
    }
  }

  // Keep only recent OBs (last 30 candles) and sort by strength
  var recent = obs.filter(function(ob){ return ob.idx >= candles.length-30; });
  recent.sort(function(a,b){ return b.strength-a.strength; });
  return recent.slice(0,4);
}

function getNearestOB(price, obs, atr) {
  var nearby = obs.filter(function(ob){
    return Math.abs(ob.mid-price) < atr*3;
  });
  nearby.sort(function(a,b){ return Math.abs(a.mid-price)-Math.abs(b.mid-price); });
  return nearby.slice(0,2);
}

// ==============================
// CHoCH - Change of Character (M15)
// Detects when price breaks above previous swing high (BUY reversal)
// or below previous swing low (SELL reversal)
// ==============================
function detectCHoCH(candles) {
  if (candles.length < 10) return null;

  var len = candles.length;
  var last = candles[len-1];

  // Find previous swing high and low in last 20 candles
  var swingHigh = 0, swingLow = 999999;
  var swingHighIdx = 0, swingLowIdx = 0;

  for (var i = len-10; i < len-1; i++) {
    if (candles[i].high > swingHigh) {
      swingHigh = candles[i].high;
      swingHighIdx = i;
    }
    if (candles[i].low < swingLow) {
      swingLow = candles[i].low;
      swingLowIdx = i;
    }
  }

  // CHoCH BUY: current candle closes above previous swing high
  // AND previous candle was bearish (confirms reversal)
  var prevBear = candles[len-2].close < candles[len-2].open;
  var prevBull = candles[len-2].close > candles[len-2].open;

  if (last.close > swingHigh && prevBear) {
    return { type: 'BUY', level: swingHigh, strength: 'strong' };
  }

  // CHoCH SELL: current candle closes below previous swing low
  if (last.close < swingLow && prevBull) {
    return { type: 'SELL', level: swingLow, strength: 'strong' };
  }

  // Weaker CHoCH: just closing above/below swing without confirmation
  if (last.close > swingHigh) return { type: 'BUY', level: swingHigh, strength: 'weak' };
  if (last.close < swingLow)  return { type: 'SELL', level: swingLow, strength: 'weak' };

  return null;
}

// ==============================
// SESSION FILTER
// Best trading sessions for each market type
// London: 08:00-12:00 UTC | NY: 13:30-17:00 UTC | Overlap: best!
// ==============================
function isOptimalSession(sym) {
  // Crypto trades 24/7 - always optimal
  if (CRYPTO.indexOf(sym) !== -1) return true;

  var now = new Date();
  var utcHour = now.getUTCHours();
  var utcMin  = now.getUTCMinutes();
  var utcTime = utcHour * 100 + utcMin;

  // London open: 07:00-12:00 UTC
  var londonOpen = utcTime >= 700 && utcTime <= 1200;
  // NY open: 13:30-17:30 UTC
  var nyOpen = utcTime >= 1330 && utcTime <= 1730;
  // Overlap (best): 13:30-16:00 UTC
  var overlap = utcTime >= 1330 && utcTime <= 1600;

  // For JPY pairs also include Tokyo session: 00:00-03:00 UTC
  var tokyoOpen = utcTime >= 0 && utcTime <= 300;
  if (sym === 'USDJPY' || sym === 'GBPJPY') {
    return londonOpen || nyOpen || tokyoOpen;
  }

  // Gold trades best during London+NY
  if (sym === 'XAUUSD' || sym === 'XAGUSD') {
    return londonOpen || nyOpen;
  }

  // All other Forex: London + NY sessions
  return londonOpen || nyOpen;
}

function getSessionName(sym) {
  var now = new Date();
  var utcTime = now.getUTCHours() * 100 + now.getUTCMinutes();
  if (utcTime >= 700  && utcTime <= 1200) return 'London';
  if (utcTime >= 1330 && utcTime <= 1600) return 'London+NY';
  if (utcTime >= 1600 && utcTime <= 1730) return 'NY';
  if (utcTime >= 0    && utcTime <= 300)  return 'Tokyo';
  return 'Off-session';
}

// ==============================
// S/R PROXIMITY CHECK
// Signal is stronger when near a key S/R level or OB
// ==============================
function isNearKeyLevel(price, dir, srLevels, obs, atr) {
  // Check S/R levels
  var relevant = srLevels.filter(function(l) {
    var dist = Math.abs(l.price - price);
    var pct  = dist / price;
    // Within 0.3% of price
    return pct < 0.003;
  });
  if (relevant.length > 0) return { confirmed: true, type: 'S/R', level: relevant[0].price };

  // Check Order Blocks
  var nearOB = obs.filter(function(ob) {
    return Math.abs(ob.mid - price) < atr * 2 &&
           ((dir === 'BUY'  && ob.type === 'BUY')  ||
            (dir === 'SELL' && ob.type === 'SELL'));
  });
  if (nearOB.length > 0) return { confirmed: true, type: 'OB', level: nearOB[0].mid };

  return { confirmed: false };
}

// ADX - Average Directional Index
// Returns ADX value (>25 = strong trend, <20 = weak/lateral)
function calcADX(c, period) {
  period = period || 14;
  if (c.length < period*2) return 0;
  var trArr=[], plusDM=[], minusDM=[];
  for (var i=1;i<c.length;i++) {
    var high = c[i].high, low = c[i].low;
    var prevHigh = c[i-1].high, prevLow = c[i-1].low, prevClose = c[i-1].close;
    var tr = Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose));
    var upMove = high-prevHigh;
    var downMove = prevLow-low;
    trArr.push(tr);
    plusDM.push(upMove>downMove && upMove>0 ? upMove : 0);
    minusDM.push(downMove>upMove && downMove>0 ? downMove : 0);
  }
  // Smooth over period
  var smoothTR=trArr.slice(0,period).reduce(function(a,b){return a+b;},0);
  var smoothPlus=plusDM.slice(0,period).reduce(function(a,b){return a+b;},0);
  var smoothMinus=minusDM.slice(0,period).reduce(function(a,b){return a+b;},0);
  var dxArr=[];
  for (var j=period;j<trArr.length;j++) {
    smoothTR = smoothTR - smoothTR/period + trArr[j];
    smoothPlus = smoothPlus - smoothPlus/period + plusDM[j];
    smoothMinus = smoothMinus - smoothMinus/period + minusDM[j];
    var plusDI = smoothTR>0 ? (smoothPlus/smoothTR)*100 : 0;
    var minusDI = smoothTR>0 ? (smoothMinus/smoothTR)*100 : 0;
    var diSum = plusDI+minusDI;
    var dx = diSum>0 ? Math.abs(plusDI-minusDI)/diSum*100 : 0;
    dxArr.push(dx);
  }
  if (!dxArr.length) return 0;
  // Final ADX = average of last period DX values
  var adx = dxArr.slice(-period).reduce(function(a,b){return a+b;},0)/Math.min(period,dxArr.length);
  return adx;
}

function calcLotSize(sym, balance, riskPct, slDist) {
  var riskAmt = balance*(riskPct/100);
  var pipVal  = PIP_VALUE[sym]||10;
  var dec     = slDist>10?2:slDist>1?4:5;
  var pips    = dec===2?slDist:slDist/(dec===4?0.0001:0.00001);
  var lot     = riskAmt/(pips*pipVal*100);
  return Math.min(10, Math.max(0.01, Math.round(lot*100)/100));
}

// ==============================
// MARKET HOURS (New York ET)
// ==============================
function getNYTime() {
  var nyStr = new Date().toLocaleString('en-US',{timeZone:'America/New_York'});
  var ny = new Date(nyStr);
  return { day:ny.getDay(), time:ny.getHours()*100+ny.getMinutes() };
}

function isMarketOpen(sym) {
  if (CRYPTO.indexOf(sym) !== -1) return true;
  var ny = getNYTime();
  if (ny.day===0||ny.day===6) return false;
  return true;
}

function getMarketStatus(sym) {
  if (isMarketOpen(sym)) return null;
  var ny = getNYTime();
  if (ny.day===0||ny.day===6) return 'Mercato chiuso (weekend)';
  return 'Mercato chiuso';
}

// ==============================
// FETCH DATA
// ==============================
async function fetchOKX(sym, bar, limit, target, st) {
  try {
    var pair = sym.replace('USD','-USDT');
    var url  = 'https://www.okx.com/api/v5/market/candles?instId='+pair+'&bar='+bar+'&limit='+limit;
    var res  = await fetch(url);
    var data = await res.json();
    if (data.code==='0'&&Array.isArray(data.data)&&data.data.length>10) {
      var p = data.data.reverse().map(function(k){return{open:+k[1],high:+k[2],low:+k[3],close:+k[4],vol:+k[5]};});
      if (isValidPrice(sym, p[p.length-1].close)) { st[target]=p; return true; }
    }
  } catch(e) {}
  return false;
}

async function fetchYahoo(sym, interval, range, target, st) {
  try {
    var ticker = YAHOO_MAP[sym];
    if (!ticker) return false;
    var url = 'https://query2.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(ticker)+'?interval='+interval+'&range='+range+'&includePrePost=false';
    var res = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'}});
    var data = await res.json();
    var chart = data&&data.chart&&data.chart.result&&data.chart.result[0];
    if (!chart||!chart.timestamp) return false;
    var q = chart.indicators.quote[0], parsed=[];
    for (var i=0;i<chart.timestamp.length;i++) {
      if (q.open[i]&&q.high[i]&&q.low[i]&&q.close[i])
        parsed.push({open:+q.open[i].toFixed(5),high:+q.high[i].toFixed(5),low:+q.low[i].toFixed(5),close:+q.close[i].toFixed(5),vol:q.volume[i]||0});
    }
    if (parsed.length<10) return false;
    if (!isValidPrice(sym, parsed[parsed.length-1].close)) return false;
    st[target]=parsed;
    return true;
  } catch(e) { return false; }
}

async function fetchTD(sym, interval, outputsize, target, st) {
  if (!TD_KEY) return false;
  try {
    var mapped = TD_MAP[sym]||sym;
    var url = 'https://api.twelvedata.com/time_series?symbol='+encodeURIComponent(mapped)+'&interval='+interval+'&outputsize='+outputsize+'&apikey='+TD_KEY;
    var res  = await fetch(url);
    var data = await res.json();
    if (data.status==='error') return false;
    var parsed = data.values.reverse().map(function(c){return{open:+c.open,high:+c.high,low:+c.low,close:+c.close,vol:+(c.volume||0)};});
    if (!parsed.length||!isValidPrice(sym,parsed[parsed.length-1].close)) return false;
    st[target]=parsed; return true;
  } catch(e) { return false; }
}

function genDemo(sym, target, st, limit) {
  var seeds = {XAUUSD:4700,XAGUSD:33,BTCUSD:67000,ETHUSD:1800,SOLUSD:130,EURUSD:1.082,GBPUSD:1.29,USDJPY:150,XRPUSD:0.5};
  var p = seeds[sym]||1.0, arr=[];
  for (var i=0;i<(limit||150);i++) {
    var ch=(Math.random()-.488)*p*.003,o=p,c=p+ch;
    arr.push({open:o,high:Math.max(o,c)*1.001,low:Math.min(o,c)*.999,close:c,vol:Math.random()*1000});
    p=c;
  }
  st[target]=arr;
}

async function fetchCandles(sym) {
  var st = symbolState[sym];
  if (!st) return;

  if (CRYPTO.indexOf(sym)!==-1) {
    if (!await fetchOKX(sym,'15m',200,'candles',st))   genDemo(sym,'candles',st,200);
    if (!await fetchOKX(sym,'1H',100,'candlesH1',st))  genDemo(sym,'candlesH1',st,100);
    if (!await fetchOKX(sym,'5m',100,'candlesM5',st))  genDemo(sym,'candlesM5',st,100);
  } else {
    // M15
    var okM15 = await fetchYahoo(sym,'15m','5d','candles',st);
    if (!okM15) if (!await fetchTD(sym,'15min',200,'candles',st)) genDemo(sym,'candles',st,200);
    await new Promise(function(r){setTimeout(r,500);});
    // H1
    var okH1 = await fetchYahoo(sym,'1h','30d','candlesH1',st);
    if (!okH1) if (!await fetchTD(sym,'1h',100,'candlesH1',st)) genDemo(sym,'candlesH1',st,100);
    await new Promise(function(r){setTimeout(r,500);});
    // M5
    var okM5 = await fetchYahoo(sym,'5m','1d','candlesM5',st);
    if (!okM5) if (!await fetchTD(sym,'5min',100,'candlesM5',st)) genDemo(sym,'candlesM5',st,100);
  }

  var last = st.candles.length?st.candles[st.candles.length-1].close:0;
  console.log(sym+' @ '+last+' (M15:'+st.candles.length+' H1:'+st.candlesH1.length+' M5:'+st.candlesM5.length+')');
}

// ==============================
// TELEGRAM
// ==============================
async function tgSend(text) {
  if (!TG_TOKEN||!TG_CHAT_ID) return false;
  try {
    var res = await fetch('https://api.telegram.org/bot'+TG_TOKEN+'/sendMessage',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:TG_CHAT_ID,text:text,parse_mode:'HTML'})
    });
    return (await res.json()).ok;
  } catch(e) { return false; }
}

async function tgPhoto(caption, chartUrl) {
  if (!TG_TOKEN||!TG_CHAT_ID) return false;
  try {
    var res = await fetch('https://api.telegram.org/bot'+TG_TOKEN+'/sendPhoto',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:TG_CHAT_ID,photo:chartUrl,caption:caption,parse_mode:'HTML'})
    });
    var d = await res.json();
    if (!d.ok) return tgSend(caption);
    return true;
  } catch(e) { return tgSend(caption); }
}

// ==============================
// CHART
// ==============================
function buildChart(sym, dir, price, sl, tp, ema50, rsi, candles) {
  var last30 = candles.slice(-30);
  var dec    = price>1000?2:price>10?3:4;
  var closes = last30.map(function(c){return +c.close.toFixed(dec);});
  var labels = last30.map(function(_,i){return i===29?'NOW':'';});
  var stLine = last30.map(function(_,i){
    var st = calcST(candles.slice(0,candles.length-29+i),14,3.0);
    return st.length?+st[st.length-1].line.toFixed(dec):null;
  });
  var color = dir==='BUY'?'rgb(0,255,157)':'rgb(255,56,96)';
  var cfg = {
    type:'line',
    data:{labels:labels,datasets:[
      {label:'Price',data:closes,borderColor:'#00d4ff',backgroundColor:'rgba(0,212,255,0.08)',borderWidth:2,pointRadius:closes.map(function(_,i){return i===29?6:0;}),fill:false,tension:0.1},
      {label:'ST',data:stLine,borderColor:color,borderWidth:1.5,borderDash:[4,2],pointRadius:0,fill:false},
      {label:'EMA50',data:closes.map(function(){return +ema50.toFixed(dec);}),borderColor:'#ffcc00',borderWidth:1,borderDash:[6,3],pointRadius:0,fill:false},
      {label:'TP',data:closes.map(function(){return +tp;}),borderColor:'rgba(0,255,157,0.6)',borderWidth:1,borderDash:[3,3],pointRadius:0,fill:false},
      {label:'SL',data:closes.map(function(){return +sl;}),borderColor:'rgba(255,56,96,0.6)',borderWidth:1,borderDash:[3,3],pointRadius:0,fill:false}
    ]},
    options:{
      plugins:{
        title:{display:true,text:(dir==='BUY'?'BUY ':'SELL ')+sym+' @ '+price.toFixed(dec)+' | RSI:'+rsi.toFixed(1),color:color,font:{size:14,weight:'bold'}},
        legend:{labels:{color:'#9ec8de',font:{size:10}}}
      },
      scales:{x:{ticks:{color:'#2a5470'},grid:{color:'#0e2438'}},y:{ticks:{color:'#9ec8de'},grid:{color:'#0e2438'}}},
      backgroundColor:'#03070b'
    }
  };
  return 'https://quickchart.io/chart?c='+encodeURIComponent(JSON.stringify(cfg))+'&w=600&h=350&bkg=%2303070b';
}

// ==============================
// STRATEGIES
// ==============================
var strategies = [{id:1,atr:7,mult:2.0},{id:2,atr:14,mult:3.0},{id:3,atr:21,mult:4.5}];

async function checkSignal(sym, consensus, cooldownMin) {
  // Use per-symbol consensus if defined, otherwise use global setting
  var symF0 = getSymbolFilters(sym);
  if (symF0.consensus) consensus = symF0.consensus;
  consensus   = consensus||3;
  cooldownMin = cooldownMin||15;
  var st = symbolState[sym];
  if (!st||!st.candles.length||!isRunning) return;
  if (Date.now()-st.lastSignalTime < cooldownMin*60*1000) return;

  // Market hours
  var mStatus = getMarketStatus(sym);
  if (mStatus) { st.stats.lastFilter='[CHIUSO] '+mStatus; return; } else {
    if (st.stats.lastFilter.indexOf('[CHIUSO]')!==-1) st.stats.lastFilter='Analisi in corso...';
  }

  // ST M15 consensus
  var bv=0, sv=0;
  for (var i=0;i<strategies.length;i++) {
    var r = calcST(st.candles,strategies[i].atr,strategies[i].mult);
    if (!r.length) continue;
    if (r[r.length-1].dir===1) bv++; else sv++;
  }
  var dir = null;
  if (bv>=consensus) dir='BUY'; else if (sv>=consensus) dir='SELL';
  // Log what blocked the signal for dashboard visibility
  if (!dir) { st.stats.lastFilter='ST consensus insufficiente (BUY:'+bv+' SELL:'+sv+' needed:'+consensus+')'; return; }
  if (!dir||dir===st.lastDir) return;

  var price = st.candles[st.candles.length-1].close;

  // H1 filter
  if (st.candlesH1.length>=2) {
    var stH1 = calcST(st.candlesH1,14,3.0);
    if (stH1.length) {
      var h1Dir = stH1[stH1.length-1].dir===1?'BUY':'SELL';
      if (h1Dir!==dir) { st.stats.lastFilter='H1 contro trend (H1='+h1Dir+')'; return; }
    }
  }

  // EMA50 filter
  var ema50 = calcEMA(st.candles,50);
  if (dir==='BUY'&&price<ema50) { st.stats.lastFilter='Prezzo sotto EMA50'; return; }
  if (dir==='SELL'&&price>ema50) { st.stats.lastFilter='Prezzo sopra EMA50'; return; }

  // RSI filter - per symbol thresholds
  var rsi = calcRSI(st.candles,14);
  var symF = getSymbolFilters(sym);
  if (dir==='BUY'&&rsi>symF.rsiMax)  { st.stats.lastFilter='RSI alto ('+rsi.toFixed(1)+' > '+symF.rsiMax+')'; return; }
  if (dir==='SELL'&&rsi<symF.rsiMin) { st.stats.lastFilter='RSI basso ('+rsi.toFixed(1)+' < '+symF.rsiMin+')'; return; }

  // Volume filter
  var avgVol=calcAvgVol(st.candles,20), lastVol=st.candles[st.candles.length-1].vol||0;
  if (avgVol>0&&lastVol<avgVol*0.8) { st.stats.lastFilter='Volume basso'; return; }

  // M5 trigger
  if (st.candlesM5.length>=10) {
    var stM5 = calcST(st.candlesM5,7,2.0);
    if (stM5.length) {
      var m5Dir = stM5[stM5.length-1].dir===1?'BUY':'SELL';
      if (m5Dir!==dir) { st.stats.lastFilter='Attesa trigger M5 (M5='+m5Dir+')'; return; }
    }
  }

  // SESSION FILTER - only trade during active market sessions
  if (CRYPTO.indexOf(sym) === -1 && !isOptimalSession(sym)) {
    st.stats.lastFilter = 'Sessione inattiva ('+getSessionName(sym)+') - aspetta London/NY';
    return;
  }

  // S/R + OB CONFIRMATION - signal stronger near key levels
  var atr0    = calcATR(st.candles,14)[st.candles.length-2]||0;
  var srCheck = calcSR(st.candles, 50);
  var obCheck = detectOrderBlocks(st.candles);
  var keyLvl  = isNearKeyLevel(price, dir, srCheck, obCheck, atr0);

  // CHoCH CHECK - detect reversal pattern for extra confirmation
  var choch   = detectCHoCH(st.candles);
  var chochOk = choch && choch.type === dir;

  // If NOT near any key level AND no CHoCH, skip weak signals in middle of range
  if (!keyLvl.confirmed && !chochOk) {
    st.stats.lastFilter = 'Nessun livello chiave vicino - segnale debole';
    return;
  }

  // ALL PASSED - build signal
  var atr     = atr0;
  var dec     = price>1000?2:price>10?3:4;
  var minDist = price*0.005;
  var slDist  = Math.max(atr*1.5,minDist);
  var tpDist  = slDist*2;
  var sl      = (dir==='BUY'?price-slDist:price+slDist).toFixed(dec);
  var tp      = (dir==='BUY'?price+tpDist:price-tpDist).toFixed(dec);

  // S/R levels
  var srLevels = calcSR(st.candles,50);
  var sup = srLevels.filter(function(l){return l.type==='S'&&l.price<price;}).sort(function(a,b){return b.price-a.price;})[0];
  var res = srLevels.filter(function(l){return l.type==='R'&&l.price>price;}).sort(function(a,b){return a.price-b.price;})[0];
  var srText = (res?'Resistenza: '+res.price.toFixed(dec)+'\n':'')+(sup?'Supporto: '+sup.price.toFixed(dec)+'\n':'');

  // Lot sizes
  var lots = [100,500,1000].map(function(b){return b+'EUR: '+calcLotSize(sym,b,3,slDist)+' lot';}).join(' | ');

  var time = new Date().toUTCString().slice(0,25);
  var name = SYMBOL_NAMES[sym]||sym;
  var msg =
    (dir==='BUY'?'[BUY]':'[SELL]')+' <b>'+name+'</b> ('+sym+')\n\n'+
    '<b>Prezzo:</b> '+price.toFixed(dec)+'\n'+
    '<b>SL:</b> '+sl+' | <b>TP:</b> '+tp+'\n'+
    '<b>R:R:</b> 1:2 | <b>RSI:</b> '+rsi.toFixed(1)+'\n\n'+
    (srText?srText+'\n':'')+
    '<b>Lot (3% rischio):</b>\n'+lots+'\n\n'+
    'ST '+Math.max(bv,sv)+'/3 | H1 | EMA50 | M5\n'+
    time+' UTC\n<i>Non consulenza finanziaria.</i>';

  // MSG 1 - Entry signal, short and immediate
  // Build context info for message
  var sessionNow = getSessionName(sym);
  var chochNow   = detectCHoCH(st.candles);
  var chochInfo  = chochNow && chochNow.type===dir ? ' | CHoCH '+chochNow.strength : '';
  var keyLvlNow  = isNearKeyLevel(price,dir,srLevels,obs,atr);
  var keyInfo    = keyLvlNow.confirmed ? ' | '+keyLvlNow.type+' '+keyLvlNow.level.toFixed(dec) : '';

  var msg1 =
    '[ST-EA] <b>'+dir+'</b> '+sym+nl+
    '<b>Prezzo:</b> '+price.toFixed(dec)+nl+
    '<b>SL:</b> '+sl+' | <b>TP:</b> '+tp+nl+
    '<b>R:R:</b> 1:2 | <b>Lot:</b> '+calcLotSize(sym,500,3,slDist)+' lot (500EUR)'+nl+
    '<b>Sessione:</b> '+sessionNow+chochInfo+keyInfo+nl+
    '<b>ENTRA ORA!</b>';

  var ok = await tgSend(msg1);
  if (ok) {
    st.stats.total++; if(dir==='BUY')st.stats.buys++;else st.stats.sells++;
    st.stats.lastSignal=dir;
    st.stats.lastFilter='SEGNALE INVIATO: '+dir+' @ '+price.toFixed(dec);
    st.lastSignalTime=Date.now(); st.lastDir=dir;
    st.log.unshift({dir:dir,price:price.toFixed(dec),time:time,sym:sym,rsi:rsi.toFixed(1),sl:sl,tp:tp});
    if(st.log.length>20) st.log.pop();
    globalStats.total++; if(dir==='BUY')globalStats.buys++;else globalStats.sells++;
    globalLog.unshift({dir:dir,price:price.toFixed(dec),time:time,sym:sym});
    if(globalLog.length>50) globalLog.pop();
    console.log('SIGNAL: '+sym+' '+dir+' @ '+price.toFixed(dec));

    // MSG 2 - Confirmation with full data after 3 minutes
    setTimeout(async function(){
      var msg2 =
        '[ST-EA] CONFERMA <b>'+dir+'</b> '+sym+nl+nl+
        '<b>Filtri:</b>'+nl+
        'ST '+Math.max(bv,sv)+'/3 | H1: '+dir+nl+
        'ADX: '+calcADX(st.candles,14).toFixed(1)+' | EMA50: '+(dir==='BUY'?'SOPRA':'SOTTO')+nl+
        'RSI: '+rsi.toFixed(1)+' | Volume: OK'+nl+nl+
        (srText?'<b>Livelli chiave:</b>'+nl+srText+nl:'')+
        '<b>Lot size (rischio 3%):</b>'+nl+lots+nl+nl+
        time+' UTC';
      await tgPhoto(msg2, buildChart(sym,dir,price,+sl,+tp,ema50,rsi,st.candles));
    }, 3*60*1000); // 3 minutes delay
  }
}

async function checkPreSignal(sym, consensus) {
  consensus=consensus||3;
  var st=symbolState[sym];
  if(!st||!st.candles.length||!isRunning) return;
  if(getMarketStatus(sym)) return;
  if(Date.now()-st.lastPreTime<30*60*1000) return;

  var bv=0,sv=0;
  for(var i=0;i<strategies.length;i++){
    var r=calcST(st.candles,strategies[i].atr,strategies[i].mult);
    if(!r.length)continue;
    if(r[r.length-1].dir===1)bv++;else sv++;
  }
  var h1Dir=null;
  if(st.candlesH1.length>=2){
    var sh=calcST(st.candlesH1,14,3.0);
    if(sh.length)h1Dir=sh[sh.length-1].dir===1?'BUY':'SELL';
  }
  var m15Dir=bv>=consensus?'BUY':sv>=consensus?'SELL':null;
  if(!m15Dir||m15Dir===st.lastPreDir) return;

  var price=st.candles[st.candles.length-1].close;
  var dec=price>1000?2:price>10?3:4;
  var name=SYMBOL_NAMES[sym]||sym;
  var nl='\n';
  var rsi=calcRSI(st.candles,14);
  var adx=calcADX(st.candles,14);
  var avgVol=calcAvgVol(st.candles,20);
  var lastVol=st.candles[st.candles.length-1].vol||0;
  var volPct=avgVol>0&&lastVol>0?(lastVol/avgVol*100).toFixed(0)+'%':'N/A (Forex)';

  // Pre-alert only when H1 is already aligned AND ADX strong AND volume ok
  var preF = getSymbolFilters(sym);
  if (m15Dir===h1Dir && adx>=preF.adx*0.8 && (avgVol===0||lastVol===0||lastVol>=avgVol*0.7)) {
    var ok=await tgSend(
      '[ST-EA] PREPARATI - <b>'+name+'</b>'+nl+
      'Direzione: <b>'+m15Dir+'</b>'+nl+
      'Prezzo: '+price.toFixed(dec)+nl+
      'H1: '+h1Dir+' | ADX: '+adx.toFixed(1)+' | Vol: '+volPct+'%'+nl+
      'RSI: '+rsi.toFixed(1)+nl+
      'Apri Capital.com ORA'+nl+
      '<i>Segnale in arrivo...</i>'
    );
    if(ok){st.lastPreTime=Date.now();st.lastPreDir=m15Dir;}
  }
}

// ==============================
// LOOP
// ==============================
function startLoop(refreshSec, consensus, cooldown) {
  refreshSec=refreshSec||600;
  if(refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async function() {
    lastLoopTime = Date.now();
    for(var i=0;i<activeSymbols.length;i++) {
      var sym=activeSymbols[i], st=symbolState[sym];
      try {
        var ms=getMarketStatus(sym);
        if(ms) {
          if(st) st.stats.lastFilter='[CHIUSO] '+ms;
          if(st&&!st.candles.length) await fetchCandles(sym);
          continue;
        }
        await fetchCandles(sym);
        await checkSignal(sym,consensus,cooldown);
        await checkPreSignal(sym,consensus);
        await new Promise(function(r){setTimeout(r,1000);});
      } catch(e){console.error('Loop '+sym+': '+e.message);}
    }
    loopRunning = false;
  }, refreshSec*1000);
}


// ==============================
// BOT 2 - PRICE ACTION D1
// ==============================
var PA_SYMBOLS = ['XAUUSD','XAGUSD','EURUSD','GBPUSD','USDJPY','GBPJPY','AUDUSD','USDCAD','BTCUSD','ETHUSD','SOLUSD'];
var paState = {};
var paRunning = false;
var paTimer = null;

function initPA(s) {
  paState[s] = {
    candlesD1:[], candlesH4:[],
    lastDir:null, lastSignalTime:0,
    stats:{ total:0, buys:0, sells:0, lastSignal:'--', lastPattern:'--' }
  };
}
PA_SYMBOLS.forEach(initPA);

// FETCH D1 candles
async function fetchD1(sym) {
  var st = paState[sym];
  if (!st) return;
  if (CRYPTO.indexOf(sym)!==-1) {
    try {
      var pair=sym.replace('USD','-USDT');
      var url='https://www.okx.com/api/v5/market/candles?instId='+pair+'&bar=1D&limit=100';
      var res=await fetch(url);
      var data=await res.json();
      if(data.code==='0'&&Array.isArray(data.data)&&data.data.length>10){
        st.candlesD1=data.data.reverse().map(function(k){return{open:+k[1],high:+k[2],low:+k[3],close:+k[4],vol:+k[5]};});
      }
      // H4 for trend filter
      var url4='https://www.okx.com/api/v5/market/candles?instId='+pair+'&bar=4H&limit=50';
      var res4=await fetch(url4);
      var data4=await res4.json();
      if(data4.code==='0'&&Array.isArray(data4.data)&&data4.data.length>10){
        st.candlesH4=data4.data.reverse().map(function(k){return{open:+k[1],high:+k[2],low:+k[3],close:+k[4],vol:+k[5]};});
      }
    }catch(e){console.error('PA D1 OKX '+sym+': '+e.message);}
  } else {
    try {
      var ticker=YAHOO_MAP[sym];
      if(!ticker) return;
      // D1
      var url=('https://query2.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(ticker)+'?interval=1d&range=6mo&includePrePost=false');
      var res=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'}});
      var data=await res.json();
      var chart=data&&data.chart&&data.chart.result&&data.chart.result[0];
      if(chart&&chart.timestamp){
        var q=chart.indicators.quote[0];
        var parsed=[];
        for(var i=0;i<chart.timestamp.length;i++){
          if(q.open[i]&&q.high[i]&&q.low[i]&&q.close[i])
            parsed.push({open:+q.open[i].toFixed(5),high:+q.high[i].toFixed(5),low:+q.low[i].toFixed(5),close:+q.close[i].toFixed(5),vol:q.volume[i]||0});
        }
        if(parsed.length>10) st.candlesD1=parsed;
      }
    }catch(e){console.error('PA D1 Yahoo '+sym+': '+e.message);}
  }
}

// ==============================
// CANDLESTICK PATTERNS
// ==============================
// D1 trend via EMA200
function getD1Trend(candles) {
  if (!candles||candles.length<50) return null;
  var ema50 = calcEMA(candles,50);
  var last = candles[candles.length-1].close;
  return last > ema50 ? 'BUY' : 'SELL';
}

// H4 trend via EMA20
function getH4Trend(candles) {
  if (!candles||candles.length<20) return null;
  var ema20 = calcEMA(candles,20);
  var last = candles[candles.length-1].close;
  return last > ema20 ? 'BUY' : 'SELL';
}

// Strict pattern detection - only high quality setups
function detectPatterns(candles) {
  if (candles.length < 5) return [];
  var patterns = [];
  var c0 = candles[candles.length-1];
  var c1 = candles[candles.length-2];
  var c2 = candles[candles.length-3];

  var body0 = Math.abs(c0.close-c0.open);
  var body1 = Math.abs(c1.close-c1.open);
  var body2 = Math.abs(c2.close-c2.open);
  var range0 = c0.high-c0.low;
  var range1 = c1.high-c1.low;
  var range2 = c2.high-c2.low;
  var isBull0 = c0.close > c0.open;
  var isBull1 = c1.close > c1.open;
  var isBull2 = c2.close > c2.open;
  var upper0 = c0.high - Math.max(c0.open,c0.close);
  var lower0 = Math.min(c0.open,c0.close) - c0.low;

  // Avg range for context (last 10 candles)
  var avgRange = 0;
  for (var i=candles.length-10;i<candles.length;i++) avgRange+=(candles[i].high-candles[i].low);
  avgRange=avgRange/10;

  // Only signal if current candle is significant (> 70% avg range)
  if (range0 < avgRange*0.7) return [];

  // MORNING STAR - strict: 3 specific candles + must be after downtrend
  var priorDown = candles[candles.length-6] && candles[candles.length-6].close > c2.open;
  if (priorDown && !isBull2 && body2>avgRange*0.5 &&
      body1<range1*0.25 && range1>0 &&
      isBull0 && body0>avgRange*0.5 &&
      c0.close > (c2.open+c2.close)/2)
    patterns.push({name:'Morning Star', dir:'BUY', strength:4});

  // EVENING STAR - strict: must be after uptrend
  var priorUp = candles[candles.length-6] && candles[candles.length-6].close < c2.open;
  if (priorUp && isBull2 && body2>avgRange*0.5 &&
      body1<range1*0.25 && range1>0 &&
      !isBull0 && body0>avgRange*0.5 &&
      c0.close < (c2.open+c2.close)/2)
    patterns.push({name:'Evening Star', dir:'SELL', strength:4});

  // BULLISH ENGULFING - strict: must engulf fully + prior downtrend
  var priorDown2 = !isBull1 && !isBull2;
  if (priorDown2 && !isBull1 && isBull0 &&
      c0.open < c1.close && c0.close > c1.open &&
      body0 > body1*1.5 && body0 > avgRange*0.6)
    patterns.push({name:'Bullish Engulfing', dir:'BUY', strength:3});

  // BEARISH ENGULFING - strict
  var priorUp2 = isBull1 && isBull2;
  if (priorUp2 && isBull1 && !isBull0 &&
      c0.open > c1.close && c0.close < c1.open &&
      body0 > body1*1.5 && body0 > avgRange*0.6)
    patterns.push({name:'Bearish Engulfing', dir:'SELL', strength:3});

  // PIN BAR - strict: wick must be 3x body, small upper wick
  if (lower0 > body0*3 && upper0 < body0*0.5 && body0 > 0 && range0 > avgRange*0.8)
    patterns.push({name:'Pin Bar Bull', dir:'BUY', strength:3});
  if (upper0 > body0*3 && lower0 < body0*0.5 && body0 > 0 && range0 > avgRange*0.8)
    patterns.push({name:'Pin Bar Bear', dir:'SELL', strength:3});

  return patterns;
}

// Check if pattern forms near S/R level
function isNearSR(price, srLevels, atr) {
  for (var i=0;i<srLevels.length;i++) {
    if (Math.abs(srLevels[i].price - price) < atr*1.5) return true;
  }
  return false;
}

// Check Price Action signal - STRICT version
async function checkPASignal(sym) {
  var COOLDOWN_HOURS = 24; // 24 hour cooldown
  var st = paState[sym];
  if (!st||!st.candlesD1.length||!paRunning) return;
  if (Date.now()-st.lastSignalTime < COOLDOWN_HOURS*60*60*1000) return;

  var ms = getMarketStatus(sym);
  if (ms) { st.stats.lastPattern='[CHIUSO] '+ms; return; }

  var c = st.candlesD1;
  var patterns = detectPatterns(c);

  if (!patterns.length) {
    st.stats.lastPattern='Nessun pattern valido';
    return;
  }

  // Only take strength >= 3
  var strong = patterns.filter(function(p){return p.strength>=3 && p.dir!=='NEUTRAL';});
  if (!strong.length) { st.stats.lastPattern='Pattern debole - skip'; return; }
  strong.sort(function(a,b){return b.strength-a.strength;});
  var best = strong[0];

  // D1 trend must align
  var d1Trend = getD1Trend(c);
  if (d1Trend && d1Trend !== best.dir) {
    st.stats.lastPattern='D1 trend contro ('+d1Trend+' vs '+best.dir+')';
    return;
  }

  // H4 trend must align
  var h4Trend = getH4Trend(st.candlesH4);
  if (h4Trend && h4Trend !== best.dir) {
    st.stats.lastPattern='H4 trend contro ('+h4Trend+')';
    return;
  }

  // Avoid repeating same direction
  if (best.dir === st.lastDir) {
    st.stats.lastPattern='Stessa direzione precedente - skip';
    return;
  }

  var price = c[c.length-1].close;
  var dec = price>1000?2:price>10?3:4;
  var atrs = calcATR(c,14);
  var atr = atrs[atrs.length-1]||0;

  // Check if near S/R
  var srLevels = calcSR(c,100);
  var nearSR = isNearSR(price, srLevels, atr);
  if (!nearSR) {
    st.stats.lastPattern='Non su S/R - skip ('+best.name+')';
    return;
  }

  // SL = ATR x2 for D1 swing (realistic)
  var slDist = Math.max(atr*2.0, price*0.008); // min 0.8%
  var tpDist = slDist*2.5; // R:R 1:2.5
  var sl = (best.dir==='BUY'?price-slDist:price+slDist).toFixed(dec);
  var tp = (best.dir==='BUY'?price+tpDist:price-tpDist).toFixed(dec);

  var lots = [100,500,1000].map(function(b){
    return b+'EUR: '+calcLotSize(sym,b,3,slDist)+' lot';
  }).join(' | ');

  var time = new Date().toUTCString().slice(0,25);
  var name = SYMBOL_NAMES[sym]||sym;
  var nl='\n';
  var srInfo = srLevels.filter(function(l){return Math.abs(l.price-price)<atr*3;})
    .map(function(l){return l.type+': '+l.price.toFixed(dec);}).join(' | ');

  var msg='[PA-EA] '+(best.dir==='BUY'?'[BUY]':'[SELL]')+' <b>'+name+'</b> ('+sym+')'+nl+nl+
    '<b>Pattern D1:</b> '+best.name+' ('+best.strength+'/4)'+nl+
    '<b>Prezzo:</b> '+price.toFixed(dec)+nl+
    '<b>SL:</b> '+sl+nl+
    '<b>TP:</b> '+tp+nl+
    '<b>R:R:</b> 1:2.5'+nl+nl+
    '<b>Trend D1:</b> '+(d1Trend||'--')+nl+
    '<b>Trend H4:</b> '+(h4Trend||'--')+nl+
    (srInfo?'<b>S/R zona:</b> '+srInfo+nl:'')+nl+
    '<b>Lot (3%):</b>'+nl+lots+nl+nl+
    time+' UTC'+nl+'<i>Non consulenza finanziaria.</i>';

  var ok = await tgSend(msg);
  if (ok) {
    st.stats.total++; if(best.dir==='BUY')st.stats.buys++;else st.stats.sells++;
    st.stats.lastSignal=best.dir;
    st.stats.lastPattern=best.name+' @ '+price.toFixed(dec);
    st.lastSignalTime=Date.now(); st.lastDir=best.dir;
    globalStats.total++; if(best.dir==='BUY')globalStats.buys++;else globalStats.sells++;
    globalLog.unshift({dir:best.dir,price:price.toFixed(dec),time:time,sym:sym,pattern:best.name});
    if(globalLog.length>50)globalLog.pop();
    console.log('PA SIGNAL: '+sym+' '+best.dir+' '+best.name+' @ '+price.toFixed(dec));
  }
}

// PA LOOP
function startPALoop(refreshSec) {
  refreshSec = refreshSec||3600; // hourly for D1
  if (paTimer) clearInterval(paTimer);
  paTimer = setInterval(async function() {
    for (var i=0;i<PA_SYMBOLS.length;i++) {
      var sym=PA_SYMBOLS[i];
      try {
        await fetchD1(sym);
        await checkPASignal(sym);
        await new Promise(function(r){setTimeout(r,800);});
      } catch(e){console.error('PA Loop '+sym+': '+e.message);}
    }
  }, refreshSec*1000);
}

// ==============================
// KEEP-ALIVE + WATCHDOG
// ==============================
if(RENDER_URL) {
  setInterval(async function(){
    try{await fetch(RENDER_URL+'/api/status');}catch(e){}
  }, 14*60*1000);
}

// Watchdog: restart loop if stuck
setInterval(async function(){
  if (!isRunning) return;
  var elapsed = Date.now() - lastLoopTime;
  if (lastLoopTime > 0 && elapsed > 15*60*1000) {
    console.log('Watchdog: loop stalled '+Math.round(elapsed/60000)+' min, restarting...');
    loopRunning = false;
    if (refreshTimer) clearInterval(refreshTimer);
    startLoop(ENV_REFRESH, ENV_CONSENSUS, ENV_COOLDOWN);
    await tgSend('Watchdog: loop riavviato');
  }
  // Force start if never ran
  if (lastLoopTime === 0 && isRunning) {
    console.log('Watchdog: loop never started, forcing start...');
    startLoop(ENV_REFRESH, ENV_CONSENSUS, ENV_COOLDOWN);
  }
}, 3*60*1000);

// ==============================
// WATCHDOG - restart loop if stuck
// ==============================
setInterval(async function() {
  if (!isRunning) return;
  var now = Date.now();
  // If loop hasn't run in 20 minutes, restart it
  if (lastLoopTime > 0 && now - lastLoopTime > 20*60*1000) {
    console.log('WATCHDOG: Loop stuck! Restarting...');
    loopRunning = false;
    if (refreshTimer) clearInterval(refreshTimer);
    startLoop(ENV_REFRESH, ENV_CONSENSUS, ENV_COOLDOWN);
    await tgSend('Watchdog: EA loop riavviato automaticamente');
  }
  // If loop was never started but isRunning=true, start it
  if (lastLoopTime === 0 && isRunning) {
    console.log('WATCHDOG: Loop never started, starting now...');
    for (var i=0;i<activeSymbols.length;i++) {
      try { await fetchCandles(activeSymbols[i]); } catch(e) {}
      await new Promise(function(r){setTimeout(r,800);});
    }
    startLoop(ENV_REFRESH, ENV_CONSENSUS, ENV_COOLDOWN);
  }
}, 5*60*1000); // check every 5 minutes

// ==============================
// API
// ==============================
app.get('/api/status', function(req,res) {
  var ps={};
  for(var i=0;i<activeSymbols.length;i++){
    var s=activeSymbols[i],st=symbolState[s];
    ps[s]={stats:st.stats,lastPrice:st.candles.length?st.candles[st.candles.length-1].close:0,candleCount:st.candles.length,log:st.log.slice(0,5)};
  }
  var paPs={};
  for(var j=0;j<PA_SYMBOLS.length;j++){var ps2=paState[PA_SYMBOLS[j]];if(ps2)paPs[PA_SYMBOLS[j]]={stats:ps2.stats,candleCount:ps2.candlesD1.length};}
  res.json({isRunning:isRunning,activeSymbols:activeSymbols,globalStats:globalStats,globalLog:globalLog.slice(0,20),tgConnected:!!(TG_TOKEN&&TG_CHAT_ID),dataConnected:!!TD_KEY,perSymbol:ps,paRunning:paRunning,paSymbols:PA_SYMBOLS,paState:paPs});
});

app.post('/api/start', async function(req,res) {
  var syms=req.body.symbols,cons=req.body.consensus,cool=req.body.cooldown,ref=req.body.refresh;
  if(syms&&Array.isArray(syms)){
    activeSymbols=syms.slice(0,6);
    activeSymbols.forEach(function(s){if(!symbolState[s])initSymbol(s);});
  }
  isRunning=true;
  try{
    for(var j=0;j<activeSymbols.length;j++){
      await fetchCandles(activeSymbols[j]);
      await new Promise(function(r){setTimeout(r,1000);});
    }
    startLoop(ref||600,cons||3,cool||15);
    // Start PA bot too
    paRunning=true;
    (async function(){for(var k=0;k<PA_SYMBOLS.length;k++){try{await fetchD1(PA_SYMBOLS[k]);}catch(e){}await new Promise(function(r){setTimeout(r,500);});}}());
    startPALoop(3600);
    await tgSend('SuperTrend EA v1 Avviato\nSimbolii: '+activeSymbols.join(', ')+'\nFiltri: ST(3TF)+H1+EMA50+RSI+VOL+M5\n'+new Date().toUTCString().slice(0,25));
    res.json({ok:true,message:'EA v1 avviato su '+activeSymbols.join(', ')});
  }catch(e){res.json({ok:false,message:e.message});}
});

app.post('/api/stop', async function(req,res) {
  isRunning=false; paRunning=false; if(refreshTimer)clearInterval(refreshTimer); if(paTimer)clearInterval(paTimer);
  await tgSend('EA v1 Fermato');
  res.json({ok:true});
});

app.get('/api/test', async function(req,res) {
  var ok=await tgSend('Test OK! EA: '+(isRunning?'RUNNING':'STOPPED')+' Simboli: '+activeSymbols.join(', '));
  res.json({ok:ok, message:ok?'Inviato!':'Errore TG'});
});

app.post('/api/test', async function(req,res) {
  var ok=await tgSend('SuperTrend EA v1 - Test OK!\nSimbolii: '+activeSymbols.join(', ')+'\nTG connesso!');
  res.json({ok:ok});
});

app.get('/api/candles/:symbol', function(req,res) {
  var st=symbolState[req.params.symbol];
  if(!st) return res.json({candles:[],candlesH1:[],candlesM5:[]});
  res.json({candles:st.candles.slice(-60),candlesH1:st.candlesH1.slice(-50),candlesM5:(st.candlesM5||[]).slice(-30)});
});

app.get('/api/candles', function(req,res) {
  var st=symbolState[activeSymbols[0]]||{candles:[],candlesH1:[],candlesM5:[]};
  res.json({candles:st.candles.slice(-60),candlesH1:st.candlesH1.slice(-50),candlesM5:(st.candlesM5||[]).slice(-30)});
});

app.get('/api/pa-status', function(req,res) {
  var paPs={};
  for(var i=0;i<PA_SYMBOLS.length;i++){var st=paState[PA_SYMBOLS[i]];if(st)paPs[PA_SYMBOLS[i]]={stats:st.stats,candleCount:st.candlesD1.length};}
  res.json({paRunning:paRunning,symbols:PA_SYMBOLS,state:paPs,globalLog:globalLog.filter(function(l){return l.pattern;}).slice(0,20)});
});

app.listen(PORT, function(){
  console.log('SuperTrend EA v1 on port '+PORT);
  console.log('TG:'+(TG_TOKEN?'OK':'--')+' TD:'+(TD_KEY?'OK':'--'));
  console.log('Symbols: '+DEFAULT_SYMBOLS.join(', ')+' | AutoStart: '+AUTO_START);
  // Auto-start EA if AUTO_START=true in environment
  // Always auto-start regardless of AUTO_START env
  console.log('Auto-starting EA on: '+DEFAULT_SYMBOLS.join(', '));
  activeSymbols = DEFAULT_SYMBOLS.slice();
  activeSymbols.forEach(function(s){if(!symbolState[s])initSymbol(s);});
  isRunning = true;
  paRunning = true;
  setTimeout(async function(){
    for(var i=0;i<activeSymbols.length;i++){
      try{await fetchCandles(activeSymbols[i]);}catch(e){console.error(activeSymbols[i],e.message);}
      await new Promise(function(r){setTimeout(r,1000);});
    }
    startLoop(ENV_REFRESH, ENV_CONSENSUS, ENV_COOLDOWN);
    startPALoop(3600);
    lastLoopTime = Date.now();
    console.log('EA auto-started!');
    await tgSend('SuperTrend EA v1 Online - Simboli: '+activeSymbols.join(', '));
  }, 5000);
  (async function(){
    for(var i=0;i<DEFAULT_SYMBOLS.length;i++){
      try{await fetchCandles(DEFAULT_SYMBOLS[i]);}catch(e){console.error(DEFAULT_SYMBOLS[i],e.message);}
      await new Promise(function(r){setTimeout(r,1500);});
    }
  })();
});
