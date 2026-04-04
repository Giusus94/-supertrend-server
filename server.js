const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TD_KEY     = process.env.TD_KEY     || '';

let isRunning      = false;
let lastSignalTime = 0;
let lastDirection  = null;
let candles        = [];   // M15 candles
let candlesH1      = [];   // H1 candles
let currentSymbol  = 'XAUUSD';
let stats          = { total:0, buys:0, sells:0, lastSignal:'—', lastFilter:'—' };
let signalLog      = [];
let refreshInterval = null;

const CRYPTO_SYMBOLS = ['BTCUSD','ETHUSD','BNBUSD','SOLUSD','XRPUSD','ADAUSD','DOTUSD','MATICUSD'];
const TD_MAP = {
  XAUUSD:'XAU/USD', XAGUSD:'XAG/USD',
  EURUSD:'EUR/USD', GBPUSD:'GBP/USD', USDJPY:'USD/JPY',
  GBPJPY:'GBP/JPY', AUDUSD:'AUD/USD', USDCAD:'USD/CAD',
  USDCHF:'USD/CHF', NZDUSD:'NZD/USD', EURGBP:'EUR/GBP',
};

// ═══════════════════════════════
// INDICATORS
// ═══════════════════════════════
function calcATR(c, p) {
  const t = [];
  for (let i=1;i<c.length;i++)
    t.push(Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)));
  const a=[t[0]];
  for (let i=1;i<t.length;i++) a.push((a[i-1]*(p-1)+t[i])/p);
  return a;
}

function calcST(c, period, mult) {
  const atrs=calcATR(c,period);
  const res=[]; let dir=1, pu=0, pl=0;
  for (let i=1;i<c.length;i++) {
    const atr=atrs[i-1]||atrs[0], hl2=(c[i].high+c[i].low)/2;
    let u=hl2+mult*atr, l=hl2-mult*atr;
    if (i>1) { u=(u<pu||c[i-1].close>pu)?u:pu; l=(l>pl||c[i-1].close<pl)?l:pl; }
    const cl=c[i].close;
    if (dir===1&&cl<l) dir=-1; else if (dir===-1&&cl>u) dir=1;
    res.push({dir, line:dir===1?l:u, atr}); pu=u; pl=l;
  }
  return res;
}

function calcRSI(c, period=14) {
  if (c.length < period+1) return 50;
  let gains=0, losses=0;
  for (let i=c.length-period; i<c.length; i++) {
    const diff = c[i].close - c[i-1].close;
    if (diff>0) gains+=diff; else losses+=Math.abs(diff);
  }
  const avgGain=gains/period, avgLoss=losses/period;
  if (avgLoss===0) return 100;
  const rs=avgGain/avgLoss;
  return 100-(100/(1+rs));
}

function calcEMA(c, period) {
  if (c.length < period) return c[c.length-1].close;
  const k=2/(period+1);
  let ema=c.slice(0,period).reduce((s,x)=>s+x.close,0)/period;
  for (let i=period;i<c.length;i++) ema=c[i].close*k+ema*(1-k);
  return ema;
}

function calcAvgVolume(c, period=20) {
  const recent = c.slice(-period);
  return recent.reduce((s,x)=>s+(x.vol||x.volume||0),0)/recent.length;
}

// ═══════════════════════════════
// FETCH CANDLES
// ═══════════════════════════════
async function fetchCandles(symbol) {
  if (CRYPTO_SYMBOLS.includes(symbol)) {
    await fetchKuCoin(symbol, '15min', 120, false);
    await fetchKuCoin(symbol, '1hour', 100, true);
  } else {
    await fetchTD(symbol, '15min', 200, false);
    await fetchTD(symbol, '1h',   100, true);
  }
}

async function fetchKuCoin(symbol, interval, limit, isH1) {
  try {
    const pair = symbol.replace('USD','-USDT');
    const url = `https://api.kucoin.com/api/v1/market/candles?type=${interval}&symbol=${pair}&pageSize=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code==='200000' && Array.isArray(data.data) && data.data.length>10) {
      const parsed = data.data.reverse().map(k=>({
        open:+k[1], high:+k[3], low:+k[4], close:+k[2], vol:+k[5]
      }));
      if (isH1) candlesH1=parsed; else candles=parsed;
      return;
    }
  } catch(e) { console.log('KuCoin failed:', e.message); }
  // OKX fallback
  try {
    const pair = symbol.replace('USD','-USDT');
    const bar = isH1?'1H':'15m';
    const url = `https://www.okx.com/api/v5/market/candles?instId=${pair}&bar=${bar}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code==='0' && Array.isArray(data.data) && data.data.length>10) {
      const parsed = data.data.reverse().map(k=>({
        open:+k[1], high:+k[2], low:+k[3], close:+k[4], vol:+k[5]
      }));
      if (isH1) candlesH1=parsed; else candles=parsed;
    }
  } catch(e) { console.log('OKX failed:', e.message); }
}

async function fetchTD(symbol, interval, limit, isH1) {
  if (!TD_KEY) {
    let p=symbol.includes('XAU')?2340:symbol.includes('XAG')?28:1.082;
    const arr=[];
    for (let i=0;i<limit;i++) {
      const ch=(Math.random()-.488)*p*.003,o=p,c=p+ch;
      arr.push({open:o,high:Math.max(o,c)*1.001,low:Math.min(o,c)*.999,close:c,vol:Math.random()*1000});
      p=c;
    }
    if (isH1) candlesH1=arr; else candles=arr;
    return;
  }
  const sym=TD_MAP[symbol]||symbol;
  const url=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${limit}&apikey=${TD_KEY}`;
  const res=await fetch(url);
  const data=await res.json();
  if (data.status==='error') throw new Error(data.message);
  const parsed=data.values.reverse().map(c=>({
    open:+c.open, high:+c.high, low:+c.low, close:+c.close, vol:+(c.volume||0)
  }));
  if (isH1) candlesH1=parsed; else candles=parsed;
}

// ═══════════════════════════════
// TELEGRAM
// ═══════════════════════════════
async function sendTelegram(text) {
  if (!TG_TOKEN||!TG_CHAT_ID) return false;
  try {
    const res=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:TG_CHAT_ID, text, parse_mode:'HTML'})
    });
    const d=await res.json(); return d.ok;
  } catch(e) { return false; }
}


// ═══════════════════════════════
// CHART GENERATION via QuickChart
// ═══════════════════════════════
function buildChartUrl(dir, price, sl, tp, stLine, ema200, rsi) {
  const last30 = candles.slice(-30);
  const closes = last30.map(c => +c.close.toFixed(2));
  const labels = last30.map((_, i) => i === 29 ? 'NOW' : '');
  const dec = price > 100 ? 2 : 5;

  // SuperTrend line
  const stLines = candles.slice(-30).map((_, i) => {
    const st = calcST(candles.slice(0, candles.length - 29 + i), 14, 3.0);
    return st.length ? +st[st.length-1].line.toFixed(dec) : null;
  });

  // EMA200 flat line
  const ema200Line = closes.map(() => +ema200.toFixed(dec));

  // SL and TP lines
  const slLine = closes.map(() => +sl);
  const tpLine = closes.map(() => +tp);

  const color = dir === 'BUY' ? 'rgb(0,255,157)' : 'rgb(255,56,96)';

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Prezzo',
          data: closes,
          borderColor: '#00d4ff',
          backgroundColor: 'rgba(0,212,255,0.08)',
          borderWidth: 2,
          pointRadius: closes.map((_, i) => i === 29 ? 6 : 0),
          pointBackgroundColor: closes.map((_, i) => i === 29 ? color : 'transparent'),
          fill: false,
          tension: 0.1,
        },
        {
          label: 'SuperTrend',
          data: stLines,
          borderColor: color,
          borderWidth: 1.5,
          borderDash: [4, 2],
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'EMA50',
          data: ema200Line,
          borderColor: '#ffcc00',
          borderWidth: 1,
          borderDash: [6, 3],
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'TP',
          data: tpLine,
          borderColor: 'rgba(0,255,157,0.6)',
          borderWidth: 1,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'SL',
          data: slLine,
          borderColor: 'rgba(255,56,96,0.6)',
          borderWidth: 1,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false,
        },
      ]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `${dir === 'BUY' ? '▲ BUY' : '▼ SELL'} ${currentSymbol} @ ${price.toFixed(dec)} | RSI: ${rsi.toFixed(1)}`,
          color: color,
          font: { size: 14, weight: 'bold' }
        },
        legend: { labels: { color: '#9ec8de', font: { size: 10 } } }
      },
      scales: {
        x: { ticks: { color: '#2a5470' }, grid: { color: '#0e2438' } },
        y: { ticks: { color: '#9ec8de' }, grid: { color: '#0e2438' } }
      },
      backgroundColor: '#03070b',
    }
  };

  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  return `https://quickchart.io/chart?c=${encoded}&w=600&h=350&bkg=%2303070b`;
}

async function sendTelegramPhoto(caption, chartUrl) {
  if (!TG_TOKEN||!TG_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        photo: chartUrl,
        caption,
        parse_mode: 'HTML'
      })
    });
    const d = await res.json();
    if (!d.ok) {
      // Fallback to text if photo fails
      return sendTelegram(caption);
    }
    return d.ok;
  } catch(e) { return sendTelegram(caption); }
}


// ═══════════════════════════════
// SUPPORT & RESISTANCE
// ═══════════════════════════════
function calcSupportResistance(c, lookback=50) {
  const recent = c.slice(-lookback);
  const levels = [];

  // Find swing highs and lows
  for (let i=2; i<recent.length-2; i++) {
    // Swing high
    if (recent[i].high > recent[i-1].high &&
        recent[i].high > recent[i-2].high &&
        recent[i].high > recent[i+1].high &&
        recent[i].high > recent[i+2].high) {
      levels.push({ price: recent[i].high, type: 'R', strength: 1 });
    }
    // Swing low
    if (recent[i].low < recent[i-1].low &&
        recent[i].low < recent[i-2].low &&
        recent[i].low < recent[i+1].low &&
        recent[i].low < recent[i+2].low) {
      levels.push({ price: recent[i].low, type: 'S', strength: 1 });
    }
  }

  // Merge nearby levels (within 0.3%)
  const merged = [];
  levels.forEach(l => {
    const nearby = merged.find(m => Math.abs(m.price-l.price)/l.price < 0.003);
    if (nearby) nearby.strength++;
    else merged.push({...l});
  });

  // Sort by strength and return top levels
  return merged.sort((a,b) => b.strength-a.strength).slice(0,6);
}

function findNearestLevels(price, levels) {
  const supports = levels.filter(l => l.type==='S' && l.price < price)
    .sort((a,b) => b.price-a.price);
  const resistances = levels.filter(l => l.type==='R' && l.price > price)
    .sort((a,b) => a.price-b.price);
  return {
    nearestSupport: supports[0]||null,
    nearestResistance: resistances[0]||null,
    allLevels: levels
  };
}

// ═══════════════════════════════
// PRE-SIGNAL ALERT
// ═══════════════════════════════
let lastPreAlertTime = 0;
let lastPreAlertDir = null;

async function checkPreSignal(consensus=3) {
  if (!candles.length || !isRunning) return;
  // Only send pre-alert every 30 min max
  if (Date.now()-lastPreAlertTime < 30*60*1000) return;

  // Count M15 votes
  let bv=0, sv=0;
  strategies.forEach(s=>{
    const st=calcST(candles,s.atr,s.mult);
    if(!st.length) return;
    if(st[st.length-1].dir===1) bv++; else sv++;
  });

  // Check H1
  let h1Dir = null;
  if (candlesH1.length>=2) {
    const stH1=calcST(candlesH1,14,3.0);
    if(stH1.length) h1Dir=stH1[stH1.length-1].dir===1?'BUY':'SELL';
  }

  const m15Dir = bv>=consensus?'BUY':sv>=consensus?'SELL':null;
  if (!m15Dir || !h1Dir) return;

  // Pre-alert: M15 has consensus but H1 is opposite — getting close
  if (m15Dir !== h1Dir && m15Dir !== lastPreAlertDir) {
    const price = candles[candles.length-1].close;
    const rsi = calcRSI(candles,14);
    const dec = price>100?2:5;

    const msg =
      `⚡ <b>Pre-Segnale — Allineamento in corso!</b>

`+
      `📊 <b>Simbolo:</b> ${currentSymbol}
`+
      `📈 <b>M15:</b> ${m15Dir} (${Math.max(bv,sv)}/3 strategie)
`+
      `⏰ <b>H1:</b> ${h1Dir} (ancora opposto)
`+
      `💰 <b>Prezzo attuale:</b> ${price.toFixed(dec)}
`+
      `📉 <b>RSI:</b> ${rsi.toFixed(1)}

`+
      `⏳ <i>Aspetta che H1 si allinei con M15 prima di entrare!</i>`;

    const ok = await sendTelegram(msg);
    if (ok) {
      lastPreAlertTime = Date.now();
      lastPreAlertDir = m15Dir;
      console.log(`⚡ Pre-alert sent: M15=${m15Dir} H1=${h1Dir}`);
    }
  }
}

// ═══════════════════════════════
// CHECK SIGNALS — with all filters
// ═══════════════════════════════
const strategies = [
  {id:1, atr:7,  mult:2.0},
  {id:2, atr:14, mult:3.0},
  {id:3, atr:21, mult:4.5},
];

async function checkSignals(consensus=3, cooldownMin=15) {
  if (!candles.length||!isRunning) return;
  if (Date.now()-lastSignalTime < cooldownMin*60*1000) return;

  // ── STEP 1: SuperTrend consensus on M15
  let bv=0, sv=0;
  strategies.forEach(s=>{
    const st=calcST(candles,s.atr,s.mult);
    if (!st.length) return;
    if (st[st.length-1].dir===1) bv++; else sv++;
  });
  let dir=null;
  if (bv>=consensus) dir='BUY';
  else if (sv>=consensus) dir='SELL';
  if (!dir||dir===lastDirection) return;

  const price=candles[candles.length-1].close;

  // ── STEP 2: Multi-timeframe H1 confirmation
  if (candlesH1.length>=2) {
    const stH1=calcST(candlesH1,14,3.0);
    if (stH1.length) {
      const h1Dir=stH1[stH1.length-1].dir===1?'BUY':'SELL';
      if (h1Dir!==dir) {
        stats.lastFilter=`❌ H1 contro trend (H1=${h1Dir}, M15=${dir})`;
        console.log('Filtered by H1:', stats.lastFilter);
        return;
      }
    }
  }

  // ── STEP 3: EMA200 filter
  const ema200=calcEMA(candles,50); // EMA50 — più reattivo
  if (dir==='BUY'&&price<ema200) {
    stats.lastFilter=`❌ Prezzo sotto EMA50 (${price.toFixed(2)} < ${ema200.toFixed(2)})`;
    console.log('Filtered by EMA50:', stats.lastFilter);
    return;
  }
  if (dir==='SELL'&&price>ema200) {
    stats.lastFilter=`❌ Prezzo sopra EMA50 (${price.toFixed(2)} > ${ema200.toFixed(2)})`;
    console.log('Filtered by EMA50:', stats.lastFilter);
    return;
  }

  // ── STEP 4: RSI filter
  const rsi=calcRSI(candles,14);
  if (dir==='BUY'&&rsi>70) {
    stats.lastFilter=`❌ RSI ipercomprato (RSI=${rsi.toFixed(1)})`;
    console.log('Filtered by RSI:', stats.lastFilter);
    return;
  }
  if (dir==='SELL'&&rsi<30) {
    stats.lastFilter=`❌ RSI ipervenduto (RSI=${rsi.toFixed(1)})`;
    console.log('Filtered by RSI:', stats.lastFilter);
    return;
  }

  // ── STEP 5: Volume filter
  const avgVol=calcAvgVolume(candles,20);
  const lastVol=candles[candles.length-1].vol||0;
  if (avgVol>0 && lastVol < avgVol*0.8) {
    stats.lastFilter=`❌ Volume basso (${lastVol.toFixed(0)} < media ${avgVol.toFixed(0)})`;
    console.log('Filtered by volume:', stats.lastFilter);
    return;
  }

  // ── ALL FILTERS PASSED — send signal
  const atr=calcATR(candles,14)[candles.length-2]||0;
  const dec=price>100?2:5;
  const sl=(dir==='BUY'?price-atr*1.5:price+atr*1.5).toFixed(dec);
  const tp=(dir==='BUY'?price+atr*3.0:price-atr*3.0).toFixed(dec);
  const rr=(Math.abs(+tp-price)/Math.abs(price-+sl)).toFixed(2);
  const time=new Date().toUTCString().slice(0,25);

  // Calculate S/R levels
  const srLevels = calcSupportResistance(candles, 50);
  const { nearestSupport, nearestResistance } = findNearestLevels(price, srLevels);
  const dec2 = price>100?2:5;
  const srText = 
    (nearestResistance ? `🔴 Resistenza: ${nearestResistance.price.toFixed(dec2)} (forza: ${nearestResistance.strength})\n` : '') +
    (nearestSupport    ? `🟢 Supporto:   ${nearestSupport.price.toFixed(dec2)} (forza: ${nearestSupport.strength})\n` : '');

  const msg=
    `${dir==='BUY'?'🟢':'🔴'} <b>SuperTrend Signal</b>\n\n`+
    `📊 <b>Simbolo:</b> ${currentSymbol}\n`+
    `📡 <b>Direzione:</b> <b>${dir}</b>\n`+
    `💰 <b>Prezzo:</b> ${price.toFixed(dec)}\n`+
    `🛑 <b>SL:</b> ${sl}\n`+
    `🎯 <b>TP:</b> ${tp}\n`+
    `⚖️ <b>R:R:</b> 1:${rr}\n\n`+
    `📐 <b>Livelli chiave:</b>\n`+
    srText+
    `\n✅ <b>Filtri passati:</b>\n`+
    `• SuperTrend M15: ${bv>sv?bv:sv}/3\n`+
    `• H1 confermato: ✓\n`+
    `• EMA50: ✓ (prezzo ${dir==='BUY'?'sopra':'sotto'})\n`+
    `• RSI: ✓ (${rsi.toFixed(1)})\n`+
    `• Volume: ✓\n\n`+
    `⏰ <b>Ora:</b> ${time} UTC\n\n`+
    `⚠️ <i>Non è consulenza finanziaria.</i>`;

  // Build chart and send as photo
  const chartUrl = buildChartUrl(dir, price, +sl, +tp, 0, ema200, rsi);
  const ok = await sendTelegramPhoto(msg, chartUrl);
  if (ok) {
    stats.total++; if (dir==='BUY') stats.buys++; else stats.sells++;
    stats.lastSignal=dir;
    stats.lastFilter=`✅ Segnale inviato: ${dir} @ ${price.toFixed(dec)}`;
    lastSignalTime=Date.now(); lastDirection=dir;
    signalLog.unshift({dir, price:price.toFixed(dec), time, symbol:currentSymbol, rsi:rsi.toFixed(1), rr});
    if (signalLog.length>50) signalLog.pop();
    console.log(`✅ Signal sent: ${dir} ${currentSymbol} @ ${price.toFixed(dec)} RSI:${rsi.toFixed(1)}`);
  }
}

// ═══════════════════════════════
// LOOP
// ═══════════════════════════════
function startLoop(refreshSec=60, consensus=3, cooldown=15) {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval=setInterval(async()=>{
    try { await fetchCandles(currentSymbol); await checkSignals(consensus,cooldown); await checkPreSignal(consensus); }
    catch(e) { console.error('Loop error:',e.message); }
  }, refreshSec*1000);
}

// ═══════════════════════════════
// API ROUTES
// ═══════════════════════════════
app.get('/api/status',(req,res)=>{
  res.json({isRunning, stats, signalLog:signalLog.slice(0,20),
    symbol:currentSymbol, tgConnected:!!(TG_TOKEN&&TG_CHAT_ID),
    dataConnected:!!TD_KEY, candleCount:candles.length,
    lastPrice:candles.length?candles[candles.length-1].close:0});
});

app.post('/api/start',async(req,res)=>{
  const {symbol,consensus,cooldown,refresh}=req.body;
  if (symbol){currentSymbol=symbol;lastDirection=null;}
  isRunning=true;
  try {
    await fetchCandles(currentSymbol);
    startLoop(refresh||60,consensus||3,cooldown||15);
    await sendTelegram(`🤖 <b>SuperTrend EA Avviato</b>\n📊 Simbolo: ${currentSymbol}\n🔧 Filtri attivi: RSI + EMA50 + Volume + H1\n⏰ ${new Date().toUTCString().slice(0,25)}`);
    res.json({ok:true,message:'EA avviato con tutti i filtri attivi'});
  } catch(e){res.json({ok:false,message:e.message});}
});

app.post('/api/stop',async(req,res)=>{
  isRunning=false; if(refreshInterval)clearInterval(refreshInterval);
  await sendTelegram('⏹ <b>SuperTrend EA Fermato</b>');
  res.json({ok:true,message:'EA fermato'});
});

app.post('/api/test',async(req,res)=>{
  const ok=await sendTelegram('🤖 <b>SuperTrend EA — Test OK!</b>\n\nBot connesso ✅\nFiltri attivi: RSI + EMA50 + Volume + H1 MTF');
  res.json({ok,message:ok?'Messaggio inviato!':'Errore invio'});
});

app.get('/api/candles',(req,res)=>{
  res.json({candles:candles.slice(-60), candlesH1:candlesH1.slice(-50)});
});

app.listen(PORT,()=>{
  console.log(`SuperTrend EA v2 running on port ${PORT}`);
  console.log(`TG: ${TG_TOKEN?'✅':'❌'} | TD: ${TD_KEY?'✅':'❌'}`);
  fetchCandles(currentSymbol).catch(console.error);
});
