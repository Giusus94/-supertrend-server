const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TD_KEY     = process.env.TD_KEY     || '';

// ═══════════════════════════════
// MULTI-SYMBOL STATE
// ═══════════════════════════════
const DEFAULT_SYMBOLS = ['XAUUSD', 'BTCUSD', 'EURUSD'];

let isRunning       = false;
let activeSymbols   = [...DEFAULT_SYMBOLS];
let refreshInterval = null;

// Per-symbol state
const symbolState = {};
DEFAULT_SYMBOLS.forEach(s => {
  symbolState[s] = {
    candles: [], candlesH1: [],
    lastDirection: null, lastSignalTime: 0,
    lastPreAlertTime: 0, lastPreAlertDir: null,
    stats: { total:0, buys:0, sells:0, lastSignal:'—', lastFilter:'—' },
    signalLog: [],
  };
});

// Global stats
let globalStats = { total:0, buys:0, sells:0 };
let globalLog   = [];

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
    t.push(Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close)));
  const a=[t[0]];
  for (let i=1;i<t.length;i++) a.push((a[i-1]*(p-1)+t[i])/p);
  return a;
}

function calcST(c, period, mult) {
  const atrs=calcATR(c,period);
  const res=[]; let dir=1,pu=0,pl=0;
  for (let i=1;i<c.length;i++) {
    const atr=atrs[i-1]||atrs[0],hl2=(c[i].high+c[i].low)/2;
    let u=hl2+mult*atr,l=hl2-mult*atr;
    if(i>1){u=(u<pu||c[i-1].close>pu)?u:pu;l=(l>pl||c[i-1].close<pl)?l:pl;}
    const cl=c[i].close;
    if(dir===1&&cl<l)dir=-1;else if(dir===-1&&cl>u)dir=1;
    res.push({dir,line:dir===1?l:u,atr});pu=u;pl=l;
  }
  return res;
}

function calcRSI(c, period=14) {
  if(c.length<period+1) return 50;
  let gains=0,losses=0;
  for(let i=c.length-period;i<c.length;i++){
    const diff=c[i].close-c[i-1].close;
    if(diff>0)gains+=diff;else losses+=Math.abs(diff);
  }
  const avgG=gains/period,avgL=losses/period;
  if(avgL===0)return 100;
  return 100-(100/(1+avgG/avgL));
}

function calcEMA(c, period) {
  if(c.length<period)return c[c.length-1].close;
  const k=2/(period+1);
  let ema=c.slice(0,period).reduce((s,x)=>s+x.close,0)/period;
  for(let i=period;i<c.length;i++) ema=c[i].close*k+ema*(1-k);
  return ema;
}

function calcAvgVolume(c, period=20) {
  return c.slice(-period).reduce((s,x)=>s+(x.vol||0),0)/period;
}

function calcSupportResistance(c, lookback=50) {
  const recent=c.slice(-lookback);
  const levels=[];
  for(let i=2;i<recent.length-2;i++){
    if(recent[i].high>recent[i-1].high&&recent[i].high>recent[i-2].high&&
       recent[i].high>recent[i+1].high&&recent[i].high>recent[i+2].high)
      levels.push({price:recent[i].high,type:'R',strength:1});
    if(recent[i].low<recent[i-1].low&&recent[i].low<recent[i-2].low&&
       recent[i].low<recent[i+1].low&&recent[i].low<recent[i+2].low)
      levels.push({price:recent[i].low,type:'S',strength:1});
  }
  const merged=[];
  levels.forEach(l=>{
    const nb=merged.find(m=>Math.abs(m.price-l.price)/l.price<0.003);
    if(nb)nb.strength++;else merged.push({...l});
  });
  return merged.sort((a,b)=>b.strength-a.strength).slice(0,6);
}

function findNearestLevels(price, levels) {
  const supports=levels.filter(l=>l.type==='S'&&l.price<price).sort((a,b)=>b.price-a.price);
  const resistances=levels.filter(l=>l.type==='R'&&l.price>price).sort((a,b)=>a.price-b.price);
  return {nearestSupport:supports[0]||null,nearestResistance:resistances[0]||null};
}

// ═══════════════════════════════
// FETCH CANDLES
// ═══════════════════════════════
async function fetchCandles(symbol) {
  const st = symbolState[symbol];
  if (!st) return;
  if(CRYPTO_SYMBOLS.includes(symbol)){
    await fetchKuCoin(symbol,'15min',120,false,st);
    await fetchKuCoin(symbol,'1hour',100,true,st);
  } else {
    await fetchTD(symbol,'15min',200,false,st);
    await fetchTD(symbol,'1h',100,true,st);
  }
}

async function fetchKuCoin(symbol,interval,limit,isH1,st) {
  try {
    const pair=symbol.replace('USD','-USDT');
    const url=`https://api.kucoin.com/api/v1/market/candles?type=${interval}&symbol=${pair}&pageSize=${limit}`;
    const res=await fetch(url);
    const data=await res.json();
    if(data.code==='200000'&&Array.isArray(data.data)&&data.data.length>10){
      const parsed=data.data.reverse().map(k=>({open:+k[1],high:+k[3],low:+k[4],close:+k[2],vol:+k[5]}));
      if(isH1)st.candlesH1=parsed;else st.candles=parsed;
      return;
    }
  } catch(e){}
  try {
    const pair=symbol.replace('USD','-USDT');
    const bar=isH1?'1H':'15m';
    const url=`https://www.okx.com/api/v5/market/candles?instId=${pair}&bar=${bar}&limit=${limit}`;
    const res=await fetch(url);
    const data=await res.json();
    if(data.code==='0'&&Array.isArray(data.data)&&data.data.length>10){
      const parsed=data.data.reverse().map(k=>({open:+k[1],high:+k[2],low:+k[3],close:+k[4],vol:+k[5]}));
      if(isH1)st.candlesH1=parsed;else st.candles=parsed;
    }
  } catch(e){}
}

async function fetchTD(symbol,interval,limit,isH1,st) {
  if(!TD_KEY){
    let p=symbol.includes('XAU')?2340:symbol.includes('XAG')?28:1.082;
    const arr=[];
    for(let i=0;i<limit;i++){
      const ch=(Math.random()-.488)*p*.003,o=p,c=p+ch;
      arr.push({open:o,high:Math.max(o,c)*1.001,low:Math.min(o,c)*.999,close:c,vol:Math.random()*1000});
      p=c;
    }
    if(isH1)st.candlesH1=arr;else st.candles=arr;
    return;
  }
  const sym=TD_MAP[symbol]||symbol;
  const url=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${limit}&apikey=${TD_KEY}`;
  const res=await fetch(url);
  const data=await res.json();
  if(data.status==='error')throw new Error(data.message);
  const parsed=data.values.reverse().map(c=>({open:+c.open,high:+c.high,low:+c.low,close:+c.close,vol:+(c.volume||0)}));
  if(isH1)st.candlesH1=parsed;else st.candles=parsed;
}

// ═══════════════════════════════
// TELEGRAM
// ═══════════════════════════════
async function sendTelegram(text) {
  if(!TG_TOKEN||!TG_CHAT_ID)return false;
  try {
    const res=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:TG_CHAT_ID,text,parse_mode:'HTML'})
    });
    const d=await res.json();return d.ok;
  } catch(e){return false;}
}

async function sendTelegramPhoto(caption,chartUrl) {
  if(!TG_TOKEN||!TG_CHAT_ID)return false;
  try {
    const res=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:TG_CHAT_ID,photo:chartUrl,caption,parse_mode:'HTML'})
    });
    const d=await res.json();
    if(!d.ok)return sendTelegram(caption);
    return d.ok;
  } catch(e){return sendTelegram(caption);}
}

// ═══════════════════════════════
// CHART
// ═══════════════════════════════
function buildChartUrl(symbol, dir, price, sl, tp, ema50, rsi, candles) {
  const last30=candles.slice(-30);
  const closes=last30.map(c=>+c.close.toFixed(price>100?2:5));
  const labels=last30.map((_,i)=>i===29?'NOW':'');
  const dec=price>100?2:5;
  const stLines=last30.map((_,i)=>{
    const st=calcST(candles.slice(0,candles.length-29+i),14,3.0);
    return st.length?+st[st.length-1].line.toFixed(dec):null;
  });
  const ema50Line=closes.map(()=>+ema50.toFixed(dec));
  const slLine=closes.map(()=>+sl);
  const tpLine=closes.map(()=>+tp);
  const color=dir==='BUY'?'rgb(0,255,157)':'rgb(255,56,96)';
  const cfg={
    type:'line',
    data:{labels,datasets:[
      {label:'Prezzo',data:closes,borderColor:'#00d4ff',backgroundColor:'rgba(0,212,255,0.08)',borderWidth:2,pointRadius:closes.map((_,i)=>i===29?6:0),pointBackgroundColor:closes.map((_,i)=>i===29?color:'transparent'),fill:false,tension:0.1},
      {label:'SuperTrend',data:stLines,borderColor:color,borderWidth:1.5,borderDash:[4,2],pointRadius:0,fill:false},
      {label:'EMA50',data:ema50Line,borderColor:'#ffcc00',borderWidth:1,borderDash:[6,3],pointRadius:0,fill:false},
      {label:'TP',data:tpLine,borderColor:'rgba(0,255,157,0.6)',borderWidth:1,borderDash:[3,3],pointRadius:0,fill:false},
      {label:'SL',data:slLine,borderColor:'rgba(255,56,96,0.6)',borderWidth:1,borderDash:[3,3],pointRadius:0,fill:false},
    ]},
    options:{
      plugins:{
        title:{display:true,text:`${dir==='BUY'?'▲ BUY':'▼ SELL'} ${symbol} @ ${price.toFixed(dec)} | RSI:${rsi.toFixed(1)}`,color,font:{size:14,weight:'bold'}},
        legend:{labels:{color:'#9ec8de',font:{size:10}}}
      },
      scales:{x:{ticks:{color:'#2a5470'},grid:{color:'#0e2438'}},y:{ticks:{color:'#9ec8de'},grid:{color:'#0e2438'}}},
      backgroundColor:'#03070b',
    }
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(cfg))}&w=600&h=350&bkg=%2303070b`;
}

// ═══════════════════════════════
// CHECK SIGNALS — per symbol
// ═══════════════════════════════
const strategies=[{id:1,atr:7,mult:2.0},{id:2,atr:14,mult:3.0},{id:3,atr:21,mult:4.5}];

async function checkSignalsForSymbol(symbol, consensus=3, cooldownMin=15) {
  const st=symbolState[symbol];
  if(!st||!st.candles.length||!isRunning)return;
  if(Date.now()-st.lastSignalTime < cooldownMin*60*1000)return;

  // Step 1: SuperTrend M15
  let bv=0,sv=0;
  strategies.forEach(s=>{
    const res=calcST(st.candles,s.atr,s.mult);
    if(!res.length)return;
    if(res[res.length-1].dir===1)bv++;else sv++;
  });
  let dir=null;
  if(bv>=consensus)dir='BUY';
  else if(sv>=consensus)dir='SELL';
  if(!dir||dir===st.lastDirection)return;

  const price=st.candles[st.candles.length-1].close;

  // Step 2: H1 filter
  if(st.candlesH1.length>=2){
    const stH1=calcST(st.candlesH1,14,3.0);
    if(stH1.length){
      const h1Dir=stH1[stH1.length-1].dir===1?'BUY':'SELL';
      if(h1Dir!==dir){
        st.stats.lastFilter=`❌ H1 contro trend (H1=${h1Dir})`;
        return;
      }
    }
  }

  // Step 3: EMA50 filter
  const ema50=calcEMA(st.candles,50);
  if(dir==='BUY'&&price<ema50){st.stats.lastFilter=`❌ Prezzo sotto EMA50`;return;}
  if(dir==='SELL'&&price>ema50){st.stats.lastFilter=`❌ Prezzo sopra EMA50`;return;}

  // Step 4: RSI filter
  const rsi=calcRSI(st.candles,14);
  if(dir==='BUY'&&rsi>70){st.stats.lastFilter=`❌ RSI ipercomprato (${rsi.toFixed(1)})`;return;}
  if(dir==='SELL'&&rsi<30){st.stats.lastFilter=`❌ RSI ipervenduto (${rsi.toFixed(1)})`;return;}

  // Step 5: Volume filter
  const avgVol=calcAvgVolume(st.candles,20);
  const lastVol=st.candles[st.candles.length-1].vol||0;
  if(avgVol>0&&lastVol<avgVol*0.8){st.stats.lastFilter=`❌ Volume basso`;return;}

  // All filters passed!
  const atr=calcATR(st.candles,14)[st.candles.length-2]||0;
  const dec=price>100?2:5;
  const sl=(dir==='BUY'?price-atr*1.5:price+atr*1.5).toFixed(dec);
  const tp=(dir==='BUY'?price+atr*3.0:price-atr*3.0).toFixed(dec);
  const rr=(Math.abs(+tp-price)/Math.abs(price-+sl)).toFixed(2);
  const time=new Date().toUTCString().slice(0,25);

  // S/R levels
  const srLevels=calcSupportResistance(st.candles,50);
  const {nearestSupport,nearestResistance}=findNearestLevels(price,srLevels);
  const srText=
    (nearestResistance?`🔴 Resistenza: ${nearestResistance.price.toFixed(dec)}\n`:'')+
    (nearestSupport?`🟢 Supporto: ${nearestSupport.price.toFixed(dec)}\n`:'');

  const msg=
    `${dir==='BUY'?'🟢':'🔴'} <b>SuperTrend Signal</b>\n\n`+
    `📊 <b>Simbolo:</b> ${symbol}\n`+
    `📡 <b>Direzione:</b> <b>${dir}</b>\n`+
    `💰 <b>Prezzo:</b> ${price.toFixed(dec)}\n`+
    `🛑 <b>SL:</b> ${sl}\n`+
    `🎯 <b>TP:</b> ${tp}\n`+
    `⚖️ <b>R:R:</b> 1:${rr}\n\n`+
    `📐 <b>Livelli chiave:</b>\n`+srText+
    `\n✅ <b>Filtri:</b> ST ${Math.max(bv,sv)}/3 · H1 ✓ · EMA50 ✓ · RSI ${rsi.toFixed(1)} · Vol ✓\n`+
    `⏰ ${time} UTC\n\n`+
    `⚠️ <i>Non è consulenza finanziaria.</i>`;

  const chartUrl=buildChartUrl(symbol,dir,price,+sl,+tp,ema50,rsi,st.candles);
  const ok=await sendTelegramPhoto(msg,chartUrl);

  if(ok){
    st.stats.total++;if(dir==='BUY')st.stats.buys++;else st.stats.sells++;
    st.stats.lastSignal=dir;
    st.stats.lastFilter=`✅ Segnale inviato: ${dir} @ ${price.toFixed(dec)}`;
    st.lastSignalTime=Date.now();st.lastDirection=dir;
    st.signalLog.unshift({dir,price:price.toFixed(dec),time,symbol,rsi:rsi.toFixed(1),rr});
    if(st.signalLog.length>20)st.signalLog.pop();
    globalStats.total++;if(dir==='BUY')globalStats.buys++;else globalStats.sells++;
    globalLog.unshift({dir,price:price.toFixed(dec),time,symbol,rsi:rsi.toFixed(1)});
    if(globalLog.length>50)globalLog.pop();
    console.log(`✅ ${symbol} ${dir} @ ${price.toFixed(dec)}`);
  }
}

// Pre-signal alert per symbol
async function checkPreSignalForSymbol(symbol, consensus=3) {
  const st=symbolState[symbol];
  if(!st||!st.candles.length||!isRunning)return;
  if(Date.now()-st.lastPreAlertTime<30*60*1000)return;

  let bv=0,sv=0;
  strategies.forEach(s=>{
    const res=calcST(st.candles,s.atr,s.mult);
    if(!res.length)return;
    if(res[res.length-1].dir===1)bv++;else sv++;
  });

  let h1Dir=null;
  if(st.candlesH1.length>=2){
    const stH1=calcST(st.candlesH1,14,3.0);
    if(stH1.length)h1Dir=stH1[stH1.length-1].dir===1?'BUY':'SELL';
  }

  const m15Dir=bv>=consensus?'BUY':sv>=consensus?'SELL':null;
  if(!m15Dir||!h1Dir)return;

  if(m15Dir!==h1Dir&&m15Dir!==st.lastPreAlertDir){
    const price=st.candles[st.candles.length-1].close;
    const rsi=calcRSI(st.candles,14);
    const dec=price>100?2:5;
    const msg=
      `⚡ <b>Pre-Segnale — ${symbol}</b>\n\n`+
      `📈 M15: ${m15Dir} (${Math.max(bv,sv)}/3)\n`+
      `⏰ H1: ${h1Dir} (opposto)\n`+
      `💰 Prezzo: ${price.toFixed(dec)}\n`+
      `📉 RSI: ${rsi.toFixed(1)}\n\n`+
      `⏳ <i>Aspetta allineamento H1!</i>`;
    const ok=await sendTelegram(msg);
    if(ok){st.lastPreAlertTime=Date.now();st.lastPreAlertDir=m15Dir;}
  }
}

// ═══════════════════════════════
// LOOP — all symbols
// ═══════════════════════════════
function startLoop(refreshSec=60, consensus=3, cooldown=15) {
  if(refreshInterval)clearInterval(refreshInterval);
  refreshInterval=setInterval(async()=>{
    for(const symbol of activeSymbols){
      try {
        await fetchCandles(symbol);
        await checkSignalsForSymbol(symbol,consensus,cooldown);
        await checkPreSignalForSymbol(symbol,consensus);
        // Small delay between symbols to avoid rate limiting
        await new Promise(r=>setTimeout(r,2000));
      } catch(e){console.error(`Error ${symbol}:`,e.message);}
    }
  }, refreshSec*1000);
}

// ═══════════════════════════════
// API ROUTES
// ═══════════════════════════════
app.get('/api/status',(req,res)=>{
  const perSymbol={};
  activeSymbols.forEach(s=>{
    const st=symbolState[s];
    perSymbol[s]={
      stats:st.stats,
      lastPrice:st.candles.length?st.candles[st.candles.length-1].close:0,
      candleCount:st.candles.length,
      signalLog:st.signalLog.slice(0,5),
    };
  });
  res.json({
    isRunning, activeSymbols, globalStats,
    globalLog:globalLog.slice(0,20),
    tgConnected:!!(TG_TOKEN&&TG_CHAT_ID),
    dataConnected:!!TD_KEY,
    perSymbol,
  });
});

app.post('/api/start',async(req,res)=>{
  const{symbols,consensus,cooldown,refresh}=req.body;
  if(symbols&&Array.isArray(symbols)){
    activeSymbols=symbols;
    // Init state for new symbols
    symbols.forEach(s=>{
      if(!symbolState[s])symbolState[s]={candles:[],candlesH1:[],lastDirection:null,lastSignalTime:0,lastPreAlertTime:0,lastPreAlertDir:null,stats:{total:0,buys:0,sells:0,lastSignal:'—',lastFilter:'—'},signalLog:[]};
    });
  }
  isRunning=true;
  try {
    // Fetch all symbols
    for(const s of activeSymbols){await fetchCandles(s);await new Promise(r=>setTimeout(r,1000));}
    startLoop(refresh||60,consensus||3,cooldown||15);
    await sendTelegram(`🤖 <b>SuperTrend EA Avviato</b>\n📊 Simboli: ${activeSymbols.join(', ')}\n🔧 Filtri: RSI + EMA50 + Volume + H1\n⏰ ${new Date().toUTCString().slice(0,25)}`);
    res.json({ok:true,message:`EA avviato su ${activeSymbols.join(', ')}`});
  } catch(e){res.json({ok:false,message:e.message});}
});

app.post('/api/stop',async(req,res)=>{
  isRunning=false;if(refreshInterval)clearInterval(refreshInterval);
  await sendTelegram('⏹ <b>SuperTrend EA Fermato</b>');
  res.json({ok:true,message:'EA fermato'});
});

app.post('/api/test',async(req,res)=>{
  const ok=await sendTelegram('🤖 <b>SuperTrend EA — Test OK!</b>\n\nBot connesso ✅\nMonitora: '+activeSymbols.join(', '));
  res.json({ok,message:ok?'Messaggio inviato!':'Errore invio'});
});

app.get('/api/candles/:symbol',(req,res)=>{
  const st=symbolState[req.params.symbol];
  if(!st)return res.json({candles:[],candlesH1:[]});
  res.json({candles:st.candles.slice(-60),candlesH1:st.candlesH1.slice(-50)});
});

app.get('/api/candles',(req,res)=>{
  const first=activeSymbols[0];
  const st=symbolState[first]||{candles:[],candlesH1:[]};
  res.json({candles:st.candles.slice(-60),candlesH1:st.candlesH1.slice(-50)});
});

app.listen(PORT,()=>{
  console.log(`SuperTrend EA Multi-Symbol on port ${PORT}`);
  console.log(`TG: ${TG_TOKEN?'✅':'❌'} | TD: ${TD_KEY?'✅':'❌'}`);
  console.log(`Symbols: ${DEFAULT_SYMBOLS.join(', ')}`);
  // Fetch all on start
  (async()=>{
    for(const s of DEFAULT_SYMBOLS){
      try{await fetchCandles(s);}catch(e){console.error(s,e.message);}
      await new Promise(r=>setTimeout(r,1500));
    }
  })();
});
