/* PaperLab 3.0 — single-user cloud paper trading simulator.
   Runs as a Cloudflare Worker. No brokerage endpoints, no real-money orders.
   Requires KV namespace binding PAPERLAB_KV, secrets APP_PASSWORD, TWELVE_DATA_API_KEY.
   Configure a daily cron at 23:15 UTC on weekdays after US exchanges close.
*/

export const SYMBOLS = ["SPY", "QQQ", "NVDA", "AAPL", "MSFT", "AMD", "GOOGL", "IREN"];
const STARTING_CASH = 200;
const MAX_TRADES = 120;
const MAX_LOG = 100;

export function initialState() {
  return {
    version: 3, running: false, cash: STARTING_CASH,
    positions: {}, trades: [], journal: [], equityHistory: [{date: "Start", equity: 200}],
    lastProcessedDate: null, lastCheckedAt: null, lastFetchAt: null,
    marketCache: null, marketStatus: { ok: false, message: "Market data has not been connected." },
    ranks: [], latestPrices: {}, validation: null,
    peakEquity: STARTING_CASH, benchmark: null, liquidate: false,
    strategy: "balanced"
  };
}
const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : 0));
const avg = a => a.length ? a.reduce((s,v) => s+v, 0)/a.length : 0;
const finite = n => Number.isFinite(Number(n)) ? Number(n) : NaN;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer"
  }});
}
function error(message, status = 400) { return json({ok: false, error: message}, status); }
function nowIso(now) { return now.toISOString(); }
function nyTime(now) {
  const fmt = new Intl.DateTimeFormat("en-US", {timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23"});
  const obj = Object.fromEntries(fmt.formatToParts(now).filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return {date: obj.year+"-"+obj.month+"-"+obj.day, hour: Number(obj.hour), minute: Number(obj.minute)};
}
export function parseBars(result, now = new Date()) {
  const clock = nyTime(now);
  if (!result || !Array.isArray(result.values)) return [];
  return result.values.map(x=>({
    date: String(x.datetime || "").slice(0,10), close: finite(x.close),
    open: finite(x.open), volume: finite(x.volume)
  })).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.close>0 && x.open>0)
    .filter(x => !(x.date >= clock.date && (clock.hour < 16 || (clock.hour === 16 && clock.minute < 45))))
    .sort((a,b)=>a.date.localeCompare(b.date))
    .filter((x,i,arr)=>i===0 || x.date!==arr[i-1].date).slice(-260);
}

async function readState(env) {
  if (!env.PAPERLAB_KV) throw new Error("Missing PAPERLAB_KV storage binding. Add it in Worker Settings → Bindings.");
  const old = await env.PAPERLAB_KV.get("paperlab-v3", "json");
  return old && old.version === 3 ? old : initialState();
}
async function writeState(env, state) {
  if (!env.PAPERLAB_KV) throw new Error("Missing PAPERLAB_KV storage binding.");
  await env.PAPERLAB_KV.put("paperlab-v3", JSON.stringify(state));
}
function addJournal(s, text, now) {
  s.journal.unshift({time: nowIso(now), text: text});
  s.journal = s.journal.slice(0, MAX_LOG);
}
function newestPrices(bars) {
  return Object.fromEntries(Object.entries(bars).filter(([,v])=>v?.length).map(([sym,rows])=>[sym,{price:rows.at(-1).close, date:rows.at(-1).date}]));
}
function currentEquity(s) {
  let v = s.cash;
  for (const [sym,p] of Object.entries(s.positions)) v += p.shares * (s.latestPrices[sym]?.price || p.entry);
  return money(v);
}
function positionList(s) {
  return Object.entries(s.positions).map(([symbol,p])=>{
    const last = s.latestPrices[symbol]?.price ?? p.entry;
    return {symbol, shares:Number(p.shares.toFixed(5)), cost:money(p.shares*p.entry),
      value:money(p.shares*last), pnl:money(p.shares*(last-p.entry)),
      entryDate:p.entryDate, entry:money(p.entry), lastPrice:money(last), note:p.note};
  });
}
function publicState(s, extra = {}) {
  return {ok:true, running:s.running, cash:money(s.cash), equity:currentEquity(s),
    totalReturn:money(currentEquity(s)/STARTING_CASH*100-100),
    positions:positionList(s), trades:s.trades.slice(0,25), journal:s.journal.slice(0,15),
    equityHistory:s.equityHistory.slice(-70), ranks:s.ranks, validation:s.validation,
    marketStatus:s.marketStatus, lastCheckedAt:s.lastCheckedAt, lastProcessedDate:s.lastProcessedDate,
    latestPrices:s.latestPrices, strategy:s.strategy, liquidate:s.liquidate,
    symbolCount:SYMBOLS.length, benchmark:s.benchmark, ...extra};
}

export async function fetchMarketData(env, state, opts = {}) {
  const now = opts.now || new Date();
  if (!env.TWELVE_DATA_API_KEY) throw new Error("Missing TWELVE_DATA_API_KEY. Add a Twelve Data market-data key as a Worker secret.");
  // Avoid exhausting the provider's eight-credits-per-minute free quota when buttons are clicked repeatedly.
  if (!opts.ignoreCache && state.marketCache && state.lastFetchAt && now - new Date(state.lastFetchAt) < 120000) {
    return {...state.marketCache, reused:true};
  }
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", SYMBOLS.join(","));
  u.searchParams.set("interval", "1day");
  u.searchParams.set("outputsize", "260");
  u.searchParams.set("adjust", "splits");
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 18000);
  let response;
  try {
    response = await fetch(u.toString(), {headers:{"Authorization":"apikey "+env.TWELVE_DATA_API_KEY,
      "accept":"application/json"}, signal:controller.signal});
  } catch(e) { throw new Error("The price service could not be reached. " + (e.name === "AbortError" ? "Request timed out." : "Network request failed.")); }
  finally { clearTimeout(timer); }
  if (!response.ok) {
    const body = await response.text().catch(()=>"");
    const msg = body.toLowerCase().includes("credit") ? "Market data quota exceeded. Try again after the API quota resets." :
      body.toLowerCase().includes("apikey") ? "Market-data key rejected. Check TWELVE_DATA_API_KEY." : "Market data HTTP " + response.status;
    throw new Error(msg);
  }
  let data;
  try {data = await response.json();}catch{throw new Error("Market data returned an invalid response.");}
  if (data.status === "error" || data.code) throw new Error("Market-data service: " + String(data.message || "provider rejected the request").slice(0,180));
  const bars = {}, issues=[];
  for (const sym of SYMBOLS) {
    const payload = data[sym] || (SYMBOLS.length===1 ? data : null);
    const b = parseBars(payload, now);
    if (b.length >= 135) bars[sym] = b;
    else issues.push(sym + ": " + (payload?.message || "fewer than 135 completed sessions"));
  }
  if (!bars.SPY || Object.keys(bars).length < 5) {
    throw new Error("Could not validate enough real prices ("+Object.keys(bars).length+"/"+SYMBOLS.length+"). " + issues.slice(0,3).join("; "));
  }
  const out = {bars, issues, fetchedAt:nowIso(now), provider:"Twelve Data daily OHLCV (split-adjusted)"};
  state.marketCache = out; state.lastFetchAt = nowIso(now);
  return out;
}

function returns(bars, start, count) {
  const rets = [];
  for (let i = start; i < start+count && i < bars.length; i++) {
    if (i > 0) rets.push(Math.log(bars[i].close/bars[i-1].close));
  }
  return rets;
}
function features(rows, i, spyMap) {
  if (i < 65 || i>=rows.length || rows[i].close <=0) return null;
  const c=rows[i].close;
  const r5 = c/rows[i-5].close-1;
  const r20= c/rows[i-20].close-1;
  const r60= c/rows[i-60].close-1;
  const ma20 = avg(rows.slice(i-19,i+1).map(b=>b.close));
  const vol = Math.sqrt(avg(returns(rows, i-19,20).map(r=>r*r))) * Math.sqrt(5);
  const spy=spyMap.get(rows[i].date), prev = spyMap.get(rows[i-20]?.date);
  const relative = spy && prev ? r20 - (spy/prev-1) : r20;
  return [1,clamp(r5*6,-2,2),clamp(r20*4,-2,2),clamp(r60*2,-2,2),
    clamp((c/ma20-1)*7,-2,2),clamp(vol*4,0,3),clamp(relative*4,-2,2)];
}
function solve(A, b) {
  const n=b.length, m=A.map((r,i)=>[...r,b[i]]);
  for(let k=0;k<n;k++) {
    let p=k; for(let i=k+1;i<n;i++) if(Math.abs(m[i][k])>Math.abs(m[p][k]))p=i;
    [m[k],m[p]]=[m[p],m[k]];
    let d=m[k][k];if(Math.abs(d)<1e-10)return Array(n).fill(0);
    for(let j=k;j<=n;j++)m[k][j]/=d;
    for(let i=0;i<n;i++)if(i!==k){const q=m[i][k];for(let j=k;j<=n;j++)m[i][j]-=q*m[k][j];}
  }
  return m.map(r=>r[n]);
}
function fitRidge(samples, lambda=3) {
  const dim=7, a=Array.from({length:dim},()=>Array(dim).fill(0)), b=Array(dim).fill(0);
  for(const s of samples) for(let i=0;i<dim;i++) {
    b[i]+=s.x[i]*s.y;
    for(let j=0;j<dim;j++) a[i][j]+=s.x[i]*s.x[j];
  }
  for(let i=0;i<dim;i++) a[i][i] += (i===0 ? 0.1 : lambda);
  return solve(a,b);
}
const dot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0);

export function trainModel(bars) {
  const spyBars=bars.SPY || [];
  const spyMap=new Map(spyBars.map(b=>[b.date,b.close]));
  const commonDate=spyBars.at(-1)?.date;
  if(!commonDate)throw new Error("S&P 500 benchmark data is missing.");
  // Signals are formed at the PREVIOUS trading close; today's close is only a simulated fill.
  const currentFillDate=commonDate;
  const marketPrevIndex=spyBars.length-2;
  const signalDate=spyBars[marketPrevIndex]?.date;
  if (!signalDate || marketPrevIndex<120) throw new Error("Not enough past sessions to train without using future data.");
  const validationStart = spyBars[Math.max(65, marketPrevIndex-45)].date;
  const valEnd = spyBars[marketPrevIndex-5].date;
  const all=[], rankedFeatures=[];
  for(const [sym,rows] of Object.entries(bars)) {
    const idx=rows.findIndex(x=>x.date===signalDate);
    if(idx<105 || idx+1>=rows.length || rows.at(-1)?.date!==currentFillDate)continue;
    const live=features(rows, idx, spyMap);
    if(!live)continue;
    rankedFeatures.push({symbol:sym, x:live, signalPrice:rows[idx].close,
      fillPrice:rows[idx+1].close, vol: live[5]/4, mom20:rows[idx].close/rows[idx-20].close-1,
      date: signalDate});
    for(let i=65;i<=idx-5;i++) {
      const x=features(rows,i,spyMap);
      if(!x)continue;
      all.push({sym,date:rows[i].date,x,y:clamp(rows[i+5].close/rows[i].close-1,-0.35,0.35)});
    }
  }
  const train=all.filter(s=>s.date<validationStart);
  const val=all.filter(s=>s.date>=validationStart && s.date<=valEnd);
  if(train.length<100 || rankedFeatures.length<5) throw new Error("Insufficient aligned historical observations to train reliably.");
  const wTrain=fitRidge(train);
  const accuracy=val.length?val.filter(s=>(dot(wTrain,s.x)>=0)===(s.y>=0)).length/val.length:null;
  const baseline=val.length?val.filter(s=>s.y>=0).length/val.length:null;
  const w=fitRidge(all);
  const ranks=rankedFeatures.map(f=>{
    const prediction=clamp(dot(w,f.x),-0.20,0.20);
    const score=prediction-0.16*f.vol;
    return {symbol:f.symbol, predicted5Day:Number((prediction*100).toFixed(2)),
      score:Number((score*100).toFixed(2)),
      momentum20:Number((f.mom20*100).toFixed(2)),
      volatility5Day:Number((f.vol*100).toFixed(2)),
      signalDate:f.date, price:f.fillPrice,
      note:score>0.003?"Positive risk-adjusted estimate":"Risk-adjusted signal not favorable"};
  }).sort((a,b)=>b.score-a.score);
  const trendMA=avg(spyBars.slice(marketPrevIndex-99,marketPrevIndex+1).map(x=>x.close));
  const riskOn=spyBars[marketPrevIndex].close>trendMA;
  return {ranks, validation:{holdoutSamples:val.length,
    accuracy:accuracy===null?null:Number((accuracy*100).toFixed(1)),
    alwaysUpBaseline:baseline===null?null:Number((baseline*100).toFixed(1)),
    trainingSamples:train.length, model:"Time-split ridge regression · five-session return target",
    warning:"Historical validation is not a guarantee of future profits."},
    riskOn, signalDate, fillDate:currentFillDate, benchmarkFill:spyBars.at(-1).close};
}

function numberSessionsHeld(bars, entryDate, signalDate) {
  if(!bars) return 0;
  return bars.filter(x=>x.date>=entryDate && x.date<=signalDate).length;
}
function trade(s,symbol,side,price,amount,date,why,now) {
  const slippage=0.001; // 0.10% price slippage each side, even with no commission.
  const fill=price*(side==="BUY"?1+slippage:1-slippage);
  if(side==="BUY") {
    const spend=Math.min(amount,s.cash);
    if(spend<2) return false;
    const qty=spend/fill;
    if(qty<=0)return false;
    s.cash=Math.max(0,s.cash-spend);
    s.positions[symbol]={shares:qty,entry:fill,entryDate:date,note:why};
    s.trades.unshift({date,symbol,side,qty:Number(qty.toFixed(5)),price:money(fill),value:money(spend),reason:why});
    addJournal(s,"Bought "+money(qty)+" shares of "+symbol+" (virtual $"+money(spend)+"). "+why,now);
  } else {
    const p=s.positions[symbol];if(!p)return false;
    const proceeds=p.shares*fill;
    s.cash+=proceeds;
    s.trades.unshift({date,symbol,side,qty:Number(p.shares.toFixed(5)),price:money(fill),value:money(proceeds),reason:why});
    delete s.positions[symbol];
    addJournal(s,"Sold "+symbol+" (virtual $"+money(proceeds)+"). "+why,now);
  }
  s.trades=s.trades.slice(0,MAX_TRADES);
  return true;
}

export function simulateTradingDay(s, model, bars, now=new Date()) {
  const {ranks, fillDate, signalDate}=model;
  const clock = nyTime(now);
  // Do not open retroactive paper positions at an already-old closing price.
  // A completed bar from an earlier date may be displayed, but not used for a new fill.
  if(fillDate!==clock.date || clock.hour<16 || (clock.hour===16&&clock.minute<45)) {
    return {changed:false,message:"Waiting for a newly completed US market session; latest verified close is "+fillDate+"."};
  }
  if(s.lastProcessedDate===fillDate) return {changed:false,message:"Already processed "+fillDate+". Waiting for a new completed market session."};
  if (s.lastProcessedDate && fillDate<=s.lastProcessedDate) return {changed:false,message:"No newer completed market session is available."};
  // Guard against missing price bars for a held position. Never silently value holdings from old data.
  for (const sym of Object.keys(s.positions)) {
    if (bars[sym]?.at(-1)?.date!==fillDate) {
      throw new Error("Missing synchronized price for owned "+sym+"; no trades were placed.");
    }
  }
  const equityBefore=currentEquity(s);
  const dd = 1-equityBefore/Math.max(s.peakEquity,1);
  const maxPositions=s.strategy==="cautious"?2:3;
  const maxAlloc=s.strategy==="cautious"?0.25:0.30;
  const reserve=s.strategy==="cautious"?0.5:0.1;
  const eligible=ranks.filter(x=>x.score>(s.strategy==="cautious"?0.9:0.35));
  const wantsCash=s.liquidate || dd>=0.15 || !model.riskOn;
  const desired = wantsCash ? [] : eligible.slice(0,maxPositions).map(x=>x.symbol);
  let executed=0;
  const rankMap=new Map(ranks.map(r=>[r.symbol,r]));
  for(const symbol of Object.keys(s.positions)) {
    const p=s.positions[symbol], q=rankMap.get(symbol);
    const signalClose=bars[symbol].find(x=>x.date===signalDate)?.close ?? q?.price;
    const held=numberSessionsHeld(bars[symbol],p.entryDate,signalDate);
    const loss=(signalClose/p.entry-1);
    const sell=s.liquidate ? "Liquidation requested in chat" :
      dd>=0.15 ? "15% portfolio drawdown protection" :
      !model.riskOn ? "Market trend risk-off" :
      loss < -0.09 ? "Prior-close loss crossed 9%" :
      held>=20 ? "20-session holding limit" :
      (!desired.includes(symbol) && held>=5) ? "Replaced by a higher-ranked opportunity" : null;
    if(sell && trade(s,symbol,"SELL",bars[symbol].at(-1).close,0,fillDate,sell,now)) executed++;
  }
  if(!s.liquidate && dd<0.15 && model.riskOn) {
    for(const symbol of desired) {
      if(s.positions[symbol])continue;
      if(Object.keys(s.positions).length>=maxPositions)break;
      const price=bars[symbol]?.at(-1)?.close;
      if(!price)continue;
      // Cap total investment and individual exposure; fractional simulated shares allowed.
      const equity=currentEquity(s);
      const invested=equity-s.cash;
      const allocation=Math.max(0,Math.min(equity*maxAlloc,equity*(1-reserve)-invested,s.cash));
      if(allocation<2)continue;
      const reason="Model score "+rankMap.get(symbol).score.toFixed(2)+"%; planned using "+signalDate+" close";
      if(trade(s,symbol,"BUY",price,allocation,fillDate,reason,now))executed++;
    }
  }
  if(s.liquidate)s.liquidate=false;
  s.lastProcessedDate=fillDate;
  s.peakEquity=Math.max(s.peakEquity,currentEquity(s));
  s.equityHistory.push({date:fillDate,equity:currentEquity(s)});
  s.equityHistory=s.equityHistory.slice(-260);
  if(s.benchmark===null) s.benchmark={date:fillDate,price:model.benchmarkFill};
  const benchmarkReturn=(model.benchmarkFill/s.benchmark.price-1)*100;
  addJournal(s, executed ? (executed+" virtual orders executed using "+fillDate+" closing prices.") :
    "No virtual orders for "+fillDate+"; "+(wantsCash?"risk controls favor cash.":"no new eligible trades needed."),now);
  return {changed:true,executed,benchmarkReturn:Number(benchmarkReturn.toFixed(2)),message:executed ? executed+" simulated trades placed." : "No trades selected; the model kept its current allocation."};
}

export async function runCycle(env, options={}) {
  const now=options.now||new Date();
  const state=await readState(env);
  const shouldTrade=options.shouldTrade!==false && state.running;
  try {
    const data=await fetchMarketData(env,state,{now});
    const model=trainModel(data.bars);
    state.latestPrices=newestPrices(data.bars);
    state.ranks=model.ranks;state.validation=model.validation;
    state.lastCheckedAt=nowIso(now);
    const fullFreshDate=model.fillDate;
    state.marketStatus={ok:true,message:"Verified completed daily bars: "+Object.keys(data.bars).length+"/"+SYMBOLS.length+" symbols. "+(data.issues.length ? "Unavailable: "+data.issues.slice(0,3).join("; "):""),
      provider:data.provider, priceDate:fullFreshDate, fetchedAt:data.fetchedAt,
      freshness:Math.round((now - new Date(data.fetchedAt))/60000),
      riskOn:model.riskOn, signalDate:model.signalDate};
    let tradeResult={changed:false,message:"Scanner updated. Autopilot is paused."};
    if (shouldTrade) tradeResult=simulateTradingDay(state,model,data.bars,now);
    await writeState(env,state);
    return {...publicState(state), result:tradeResult};
  } catch(e) {
    state.lastCheckedAt=nowIso(now);
    state.marketStatus={ok:false,message:e.message||String(e),fetchedAt:nowIso(now)};
    await writeState(env,state);
    return {...publicState(state),ok:false,error:e.message||String(e), result:{changed:false,message:"No trades executed: market data or model unavailable."}};
  }
}

export async function handleChat(env,textInput,now=new Date()) {
  const text=String(textInput||"").trim().slice(0,500), lower=text.toLowerCase();
  if(!text)throw new Error("Please write a message.");
  let s=await readState(env), reply="";
  const start=/(start|begin|go ahead|autopilot|trade for me|invest|spend|use the \$?200|buy.*for me|make.*profit)/i.test(lower)
    && !/(stop|pause|don't|do not|not yet|why|how|what if)/i.test(lower);
  if(/^(stop|pause|halt|turn off|don't trade|do not trade)/i.test(lower)) {
    s.running=false;addJournal(s,"Autopilot paused by chat.",now);
    await writeState(env,s); reply="Paused. I won't place any more virtual orders until you restart me. Holdings stay in the simulated portfolio.";
  } else if(/(sell everything|sell all|liquidate|close all|go to cash)/i.test(lower)) {
    s.liquidate=true;addJournal(s,"Queued close-all request; executes only on a new verified session.",now);
    await writeState(env,s);reply="I queued a virtual liquidation. It will execute only when a new completed market session is available, using the next verified prices. No real orders are possible.";
  } else if(/(safer|conservative|careful|less risk|cautious)/i.test(lower)) {
    s.strategy="cautious";addJournal(s,"Changed simulation to cautious risk settings.",now);
    await writeState(env,s);reply="Switched to cautious mode: at most 2 holdings, 25% each, and at least 50% reserved as virtual cash. Changes take effect at the next trading decision.";
  } else if(/(balanced|normal risk|default strategy)/i.test(lower)) {
    s.strategy="balanced";await writeState(env,s);
    reply="Switched to balanced mode: at most 3 positions, capped at 30% each, with a cash reserve and drawdown guard.";
  } else if(start) {
    s.running=true;await writeState(env,s);
    const result=await runCycle(env,{now,shouldTrade:true});
    reply=result.ok ? ("Autopilot started with $200 in virtual funds. " + result.result.message + " I checked " + result.ranks.length + " markets using data through " + result.marketStatus.priceDate + ". I choose whether to invest or hold cash based on risk-adjusted estimates."):
      ("Autopilot enabled, but no simulated orders were placed because market data failed: "+result.error+". Configure the market-data secret or check provider limits.");
    s=await readState(env);
  } else if(/(scan|research|check markets|look at stocks|find opportunities)/i.test(lower)) {
    const r=await runCycle(env,{now,shouldTrade:false});
    reply=r.ok ? "Scan finished. Top candidates: "+r.ranks.slice(0,3).map(x=>x.symbol+" (score "+x.score.toFixed(2)+"%)").join(", ")+". These are model estimates, not guaranteed gains." : "Scan could not run: "+r.error;
    s=await readState(env);
  } else if(/(why|explain|reason)/i.test(lower)) {
    const symbol=(SYMBOLS.find(x=>lower.includes(x.toLowerCase())));
    const last=s.trades.find(t=>!symbol||t.symbol===symbol);
    reply=last ? "Most recent relevant order: "+last.side+" "+last.symbol+" on "+last.date+" for $"+last.value.toFixed(2)+" (virtual). Reason: "+last.reason+". Signals used only the prior session's market data." :
      "No matching virtual trade yet. Use 'scan the market' to see the model's current rankings and estimates.";
  } else if(/(how long|when.*sell|hold for|holding period|exit rule|when.*exit)/i.test(lower)) {
    reply="The bot chooses exits using the previous completed trading session: it may sell on a weak market trend, a 9% loss signal, a stronger replacement after 5 sessions, or a maximum 20-session holding period. It never knows the best future sell date in advance. All fills are simulated at the next verified daily close.";
  } else if(/(holdings|positions|portfolio|own|what did you buy|what have you bought)/i.test(lower)) {
    const v=positionList(s);
    reply=v.length ? "Virtual holdings: "+v.map(p=>p.symbol+" $"+p.value.toFixed(2)+" (P/L $"+p.pnl.toFixed(2)+")").join("; ")+". Cash: $"+s.cash.toFixed(2)+". Total estimated account value: $"+currentEquity(s).toFixed(2)+"." :
      "No virtual shares held. Cash is $"+s.cash.toFixed(2)+". I may hold cash when the model has no positive risk-adjusted opportunities.";
  } else if(/(performance|profit|money|gain|loss|return|how am i doing)/i.test(lower)) {
    reply="The virtual portfolio is at $"+currentEquity(s).toFixed(2)+", a "+(currentEquity(s)-200>=0?"gain":"loss")+" of $"+Math.abs(currentEquity(s)-200).toFixed(2)+" since it started at $200. Prices are from the latest verified daily bars, not live execution quotes.";
  } else if(/(learn|train|model|accuracy|prediction)/i.test(lower)) {
    const v=s.validation;
    reply=v ? "I use a time-split ridge-regression model trained on past momentum, trend, volatility, and relative strength. The historical holdout directional accuracy is "+v.accuracy+"%, versus "+v.alwaysUpBaseline+"% for always predicting up. Neither number guarantees profit." :
      "The model has not trained successfully yet. I need verified historical OHLCV data before I can calculate or validate any predictions.";
  } else if(/(help|what can you do|commands)/i.test(lower)) {
    reply="Try: 'Start trading my $200', 'Scan the market', 'What did you buy?', 'Why did you buy NVDA?', 'Be more cautious', 'Pause', or 'Sell everything'. All orders are virtual; I cannot make real trades.";
  } else {
    reply="I understand a set of trading-simulation instructions, but I'm not a general-purpose chat model. Try 'Start trading my $200', 'Scan the market', 'What do I own?', 'Why did you buy it?', or 'Pause'. I won't pretend to understand an unsupported command.";
  }
  return {...publicState(s),reply};
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname==="/" || url.pathname==="/index.html")return new Response(HTML,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}});
    if(!url.pathname.startsWith("/api/"))return error("Not found",404);
    if(!env.APP_PASSWORD) return error("Setup incomplete: add APP_PASSWORD as a Cloudflare Worker secret.",503);
    const authorization=request.headers.get("authorization")||"";
    if(authorization!=="Bearer "+env.APP_PASSWORD) return error("Wrong app password. Check the APP_PASSWORD secret.",401);
    try {
      if(request.method==="GET" && url.pathname==="/api/status") {
        const s=await readState(env);
        return json(publicState(s,{setup:{marketKeyConfigured:!!env.TWELVE_DATA_API_KEY, storageConfigured:!!env.PAPERLAB_KV}}));
      }
      if(request.method!=="POST")return error("Use POST",405);
      const body=await request.json().catch(()=>({}));
      const now=new Date();
      if(url.pathname==="/api/chat")return json(await handleChat(env,body.message,now));
      if(url.pathname==="/api/scan")return json(await runCycle(env,{now,shouldTrade:false}));
      if(url.pathname==="/api/start"){
        let s=await readState(env);s.running=true;await writeState(env,s);
        return json(await runCycle(env,{now,shouldTrade:true}));
      }
      if(url.pathname==="/api/pause"){
        let s=await readState(env);s.running=false;await writeState(env,s);
        return json(publicState(s,{reply:"Paper bot paused. No future simulated orders until restarted."}));
      }
      if(url.pathname==="/api/reset"){
        if(body.confirm!=="RESET")return error("To reset, send confirm: RESET.");
        const s=initialState(); await writeState(env,s);
        return json(publicState(s,{reply:"Reset to $200 virtual cash. Previous simulated trade history cleared."}));
      }
      return error("Unknown endpoint",404);
    } catch(e) {return error(e.message||String(e),500);}
  },
  async scheduled(controller,env,ctx) {
    // Cron runs once daily after US market close. No user browser is required.
    if(!env.PAPERLAB_KV || !env.TWELVE_DATA_API_KEY)return;
    const s=await readState(env);
    if(!s.running)return;
    const output=await runCycle(env,{now:new Date(controller.scheduledTime||Date.now()),shouldTrade:true});
    if(!output.ok) console.warn("PaperLab scheduled scan failed:",output.error);
  }
};

const HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PaperLab 3 · AI Autopilot</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f1f3ff;background:#080b15;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(900px 500px at 8% 0%,#17234766,transparent),#080b15}button,input{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible{outline:2px solid #8f94ff;outline-offset:3px}.shell{max-width:1330px;margin:auto;padding:26px 25px 90px}.header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:space-between;margin-bottom:26px}.brand{display:flex;align-items:center;gap:13px;font-weight:800;letter-spacing:-.5px;font-size:23px}.logo{display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:linear-gradient(135deg,#565dff,#ad74fb);box-shadow:0 10px 40px #6860fc33}.logo svg{width:25px}.sub{font-size:12px;color:#838eac;margin-top:4px;font-weight:500;letter-spacing:0}.status{display:flex;gap:9px;align-items:center;color:#aeb8d3;background:#131a2b;border:1px solid #29304a;border-radius:40px;padding:10px 14px;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:#f4c46b}.dot.live{background:#57dda8;box-shadow:0 0 12px #45d29d77}.hero{display:flex;justify-content:space-between;align-items:end;gap:20px;flex-wrap:wrap;margin:22px 0}.eyebrow{color:#99a6c5;text-transform:uppercase;letter-spacing:2px;font-size:11px;font-weight:700}.hero h1{font-size:clamp(27px,4vw,45px);line-height:1.1;letter-spacing:-1.8px;margin:7px 0 10px}.desc{color:#97a3bf;max-width:670px;line-height:1.6;font-size:14px}.actions{display:flex;gap:10px;flex-wrap:wrap}.btn{background:#1c2540;border:1px solid #313a56;color:#e6eafd;padding:12px 17px;border-radius:12px;font-weight:700;font-size:13px;transition:.15s}.btn:hover{border-color:#7b89d3}.btn.primary{background:linear-gradient(135deg,#6c69f6,#9471e9);border-color:transparent;color:#fff;box-shadow:0 6px 30px #7362e72f}.btn.danger{background:#2e1e2b;color:#ffc1ce;border-color:#57313b}.grid{display:grid;grid-template-columns:1fr 375px;gap:18px}.left{display:grid;gap:18px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.panel,.metric{background:linear-gradient(160deg,#141b2d,#101522);border:1px solid #252e44;border-radius:19px;box-shadow:0 8px 24px #0000001c}.metric{padding:18px 20px;min-width:0}.metric .name{font-size:11px;color:#8e9bb8;letter-spacing:.2px;font-weight:700}.metric .num{font-size:27px;font-weight:800;letter-spacing:-1px;margin-top:10px;white-space:nowrap}.metric .foot{font-size:11px;color:#7886a5;margin-top:6px}.green{color:#52dbab}.red{color:#ff8299}.panel{padding:19px}.panelhead{display:flex;gap:15px;align-items:center;justify-content:space-between;margin-bottom:14px}.paneltitle{font-size:15px;font-weight:800;letter-spacing:-.3px}.muted{color:#96a2be;font-size:12px;line-height:1.55}.tag{border-radius:40px;padding:5px 9px;background:#1f2944;color:#afbbe4;font-size:10px;font-weight:700}.chart{height:210px;width:100%;display:block;margin:9px 0 0}.cols{display:grid;grid-template-columns:1fr 1fr;gap:18px}.table{width:100%;border-collapse:collapse;font-size:12px}.table th{text-transform:uppercase;letter-spacing:.6px;font-size:10px;color:#7f8eae;text-align:left;font-weight:750;padding:11px 5px;border-bottom:1px solid #26324a}.table td{padding:12px 5px;border-bottom:1px solid #20293e}.table tr:last-child td{border-bottom:0}.right{display:flex;flex-direction:column;gap:18px}.chat{display:flex;flex-direction:column;height:530px;padding:0;overflow:hidden}.chathead{padding:20px;border-bottom:1px solid #283149;display:flex;gap:12px;align-items:center}.avatar{width:38px;height:38px;border-radius:13px;display:grid;place-items:center;background:#353968;color:#e1ddff;font-size:21px}.chatfeed{flex:1;min-height:0;overflow:auto;padding:16px 17px;display:flex;flex-direction:column;gap:12px}.bubble{max-width:94%;padding:12px 13px;border-radius:15px;background:#202940;color:#e6ebff;font-size:12px;line-height:1.65;align-self:flex-start;white-space:pre-wrap}.bubble.user{background:#514caf;align-self:flex-end}.chatinput{border-top:1px solid #26334a;display:flex;padding:12px;gap:8px}.chatinput input,.password{background:#0c1221;border:1px solid #303e5a;color:#f3f6ff;border-radius:10px;outline:none;padding:12px;min-width:0;flex:1;font-size:13px}.chatinput button{width:42px;border-radius:10px;background:#635fec;border:0;color:white;font-size:18px}.hint{border-top:1px solid #26334a;padding:12px 16px;color:#8492b0;font-size:11px}.logline{padding:11px 0;border-bottom:1px solid #242d44;font-size:12px;line-height:1.6;color:#adbad3}.logline:last-child{border:0}.warning{background:#2b211c;border:1px solid #655035;color:#f2c99a;border-radius:13px;padding:13px 16px;font-size:12px;line-height:1.6;margin-bottom:15px}.notice{background:#122439;border:1px solid #28536c;color:#b4dff4;border-radius:13px;padding:13px 15px;font-size:12px;line-height:1.6;margin-top:12px}.hidden{display:none!important}.login{max-width:480px;margin:13vh auto;background:#141b2d;border:1px solid #303858;padding:28px;border-radius:20px}.login h2{margin:8px 0}.login input{width:100%;margin:15px 0}.login button{width:100%}.mini{font-size:10px;color:#8491ae}.pill{display:inline-flex;align-items:center;gap:7px}.separator{height:1px;background:#28334b;margin:13px 0}.footer{margin-top:25px;font-size:11px;color:#687795;text-align:center}#alerts{margin-bottom:12px}.loading{opacity:.55}#activity{max-height:265px;overflow:auto}@media(max-width:1070px){.grid{grid-template-columns:1fr}.right{display:grid;grid-template-columns:1fr 1fr}.chat{height:500px}}@media(max-width:700px){.shell{padding:15px}.metrics{grid-template-columns:1fr 1fr}.cols,.right{grid-template-columns:1fr}.metric .num{font-size:24px}.chat{height:450px}.panel{padding:15px}.table{font-size:11px}}
</style></head><body><div class="shell"><header class="header"><div class="brand"><div class="logo">✦</div><div>PaperLab <span style="color:#9a91ff">AI</span><div class="sub">AUTOPILOT · PAPER TRADING ONLY</div></div></div><div class="status"><span id="statusDot" class="dot"></span><span id="statusText">Not connected</span></div></header>
<section id="login" class="login"><div class="eyebrow">SECURE WORKSPACE</div><h2>Connect to your paper bot</h2><p class="muted">Enter the app password you configured in Cloudflare. It is kept in this browser tab only.</p><input id="pwd" type="password" class="password" autocomplete="off" placeholder="App password"><button class="btn primary" id="loginBtn">Open my simulator</button><p id="loginError" class="muted"></p></section>
<main id="app" class="hidden"><div id="alerts"></div><section class="hero"><div><div class="eyebrow">VIRTUAL CAPITAL · REAL DAILY MARKET DATA</div><h1>Your goal. <span style="color:#a49afa">The model's decisions.</span></h1><p class="desc">Give the assistant a goal, and it scans available markets, trains a small predictive model, and places simulated orders using risk limits. It can also decide not to buy.</p></div><div class="actions"><button class="btn primary" id="startBtn">▶ Start autopilot</button><button class="btn" id="scanBtn">⟳ Scan market</button><button class="btn danger" id="pauseBtn">Ⅱ Pause</button></div></section>
<div class="grid"><div class="left"><section class="metrics"><div class="metric"><div class="name">PORTFOLIO VALUE</div><div class="num" id="equity">$200.00</div><div class="foot">Simulated · started with $200</div></div><div class="metric"><div class="name">TOTAL RETURN</div><div class="num" id="return">0.00%</div><div class="foot">Unrealized + realized</div></div><div class="metric"><div class="name">AVAILABLE CASH</div><div class="num" id="cash">$200.00</div><div class="foot">Can remain uninvested</div></div><div class="metric"><div class="name">BOT MODE</div><div class="num" style="font-size:20px" id="mode">Paused</div><div class="foot" id="modeNote">Not scheduling orders</div></div></section>
<section class="panel"><div class="panelhead"><div><div class="paneltitle">Portfolio journey</div><div class="muted" id="chartNote">No completed daily trading decisions yet.</div></div><span class="tag" id="sourceTag">DATA: NOT CONNECTED</span></div><svg id="curve" class="chart" viewBox="0 0 680 210" preserveAspectRatio="none" role="img" aria-label="Virtual portfolio equity history"></svg><div class="muted" id="dataAge">No historical data loaded.</div></section>
<div class="cols"><section class="panel"><div class="panelhead"><div class="paneltitle">My positions</div><span class="tag">FRACTIONAL SHARES</span></div><div id="positions" class="muted">Your virtual portfolio is empty.</div></section><section class="panel"><div class="panelhead"><div class="paneltitle">Best model scores</div><span class="tag">8 STOCKS & ETFs</span></div><div id="ranks" class="muted">Press Scan market to train and rank opportunities.</div></section></div>
<section class="panel"><div class="panelhead"><div class="paneltitle">Simulated trade history</div><span class="tag">AUDIT LOG</span></div><div id="trades" class="muted">No simulated orders yet.</div></section></div>
<div class="right"><section class="panel chat"><div class="chathead"><div class="avatar">✦</div><div><div class="paneltitle">Talk to your bot</div><div class="muted">Goal-based commands · no brokerage access</div></div></div><div id="chatfeed" class="chatfeed"><div class="bubble">I'm your $200 virtual portfolio assistant. Say: “Start trading my $200 and try to make a profit.” I'll scan verified market data and decide whether to buy or stay in cash.</div></div><form id="chatForm" class="chatinput"><input id="message" autocomplete="off" maxlength="500" placeholder="Tell your bot what to do..."><button type="submit" aria-label="Send message">➤</button></form><div class="hint">Try “Why did you buy it?” · “What do I own?” · “Be more cautious”</div></section><section class="panel"><div class="panelhead"><div class="paneltitle">Decision transparency</div><span class="tag">HISTORICAL HOLDOUT</span></div><div id="modelInfo" class="muted">The model hasn't been trained yet.</div><div class="separator"></div><div class="paneltitle">Activity</div><div id="activity" class="muted">Waiting for a market scan.</div></section><section class="panel"><div class="paneltitle">Controls</div><p class="muted">This system has no real-money broker connection. Liquidation is queued for the next completed price session. Reset deletes the demo account history.</p><div class="actions"><button class="btn" id="sellBtn">Queue sell-all</button><button class="btn danger" id="resetBtn">Reset demo</button></div></section></div></div>
<div class="footer">PaperLab 3 · Virtual simulation only · End-of-day stock bars · No guaranteed returns · Not a real-money trading service</div></main></div>
<script>
(function(){
  var token=sessionStorage.getItem('paperlab3key')||'';var busy=false;var state=null;
  var $=function(id){return document.getElementById(id)};
  function escapeHtml(v){return String(v==null?'':v).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]})}
  function fmt(v){return '$'+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
  function pct(v){return (Number(v)>=0?'+':'')+Number(v||0).toFixed(2)+'%'}
  function notice(msg, bad){$('alerts').innerHTML='<div class="'+(bad?'warning':'notice')+'">'+escapeHtml(msg)+'</div>'}
  function loading(x){busy=x;['startBtn','scanBtn','pauseBtn','sellBtn','resetBtn'].forEach(function(id){$(id).disabled=x});$('statusText').textContent=x?'Working on real data...':state&&state.running?'Autopilot running':'Autopilot paused'}
  async function call(path,body){
    var resp=await fetch('/api/'+path,{method:path==='status'?'GET':'POST',headers:{'authorization':'Bearer '+token,'content-type':'application/json'},body:path==='status'?undefined:JSON.stringify(body||{})});
    var data=await resp.json().catch(function(){return {ok:false,error:'Server returned invalid JSON.'}});
    if(resp.status===401)throw new Error('Wrong app password. Open the app and enter the correct password.');
    if(!resp.ok)throw new Error(data.error||'Request failed: '+resp.status);
    return data;
  }
  function draw(data){
    var a=data&&data.length?data:[{date:'Start',equity:200}],values=a.map(function(v){return Number(v.equity)});
    var min=Math.min.apply(null,values.concat([195])),max=Math.max.apply(null,values.concat([205]));var range=Math.max(1,max-min);
    var pts=a.map(function(v,i){return (20+(a.length>1?i/(a.length-1):0)*640).toFixed(1)+','+(190-((v.equity-min)/range)*160).toFixed(1)}).join(' ');
    $('curve').innerHTML='<defs><linearGradient id="glow" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#786aff" stop-opacity=".35"/><stop offset="100%" stop-color="#786aff" stop-opacity="0"/></linearGradient></defs>'+[0,1,2,3].map(function(i){return '<line x1="10" x2="675" y1="'+(35+i*49)+'" y2="'+(35+i*49)+'" stroke="#303950" stroke-dasharray="3 5"/>'}).join('')+(a.length>1?'<polygon fill="url(#glow)" points="20,197 '+pts+' 660,197"/>':'')+'<polyline fill="none" stroke="#9082ff" stroke-width="3" stroke-linejoin="round" points="'+pts+'"/><circle cx="'+pts.split(' ').at(-1).split(',')[0]+'" cy="'+pts.split(' ').at(-1).split(',')[1]+'" r="5" fill="#bcb1ff"/>';
  }
  function table(head,rows){return '<table class="table"><thead><tr>'+head.map(function(c){return '<th>'+escapeHtml(c)+'</th>'}).join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table>'}
  function render(s){state=s;$('app').classList.remove('hidden');$('login').classList.add('hidden');
    $('statusDot').className='dot'+(s.running?' live':'');$('statusText').textContent=s.running?'Autopilot running':'Autopilot paused';
    $('equity').textContent=fmt(s.equity);$('cash').textContent=fmt(s.cash);$('return').textContent=pct(s.totalReturn);$('return').className='num '+(s.totalReturn>=0?'green':'red');$('mode').textContent=s.running?'On':'Paused';$('modeNote').textContent=s.running?'Runs on the configured cloud schedule':'Manual scans are still available';
    var m=s.marketStatus||{};$('sourceTag').textContent=m.ok?'VERIFIED DAILY BARS':'NO VERIFIED FEED';
    $('chartNote').textContent='Daily closing-value history · '+s.equityHistory.length+' points';
    $('dataAge').textContent=m.ok?'Price date: '+m.priceDate+' · Source: '+m.provider+' · Last checked: '+(s.lastCheckedAt||'not yet'):'Market data: '+(m.message||'Not connected');
    draw(s.equityHistory);
    $('positions').innerHTML=s.positions.length?table(['Asset','Value','Profit / loss'],s.positions.map(function(p){return '<tr><td><strong>'+escapeHtml(p.symbol)+'</strong><div class="mini">'+p.shares+' shares</div></td><td>'+fmt(p.value)+'</td><td class="'+(p.pnl>=0?'green':'red')+'">'+fmt(p.pnl)+'</td></tr>'})):'No holdings yet. The model can choose cash.';
    $('ranks').innerHTML=s.ranks.length?table(['Stock','Model score','5-day est.'],s.ranks.slice(0,8).map(function(r){return '<tr><td><strong>'+escapeHtml(r.symbol)+'</strong><div class="mini">20-day trend '+pct(r.momentum20)+'</div></td><td class="'+(r.score>0?'green':'red')+'">'+pct(r.score)+'</td><td>'+pct(r.predicted5Day)+'</td></tr>'})):'No trained rankings yet.';
    $('trades').innerHTML=s.trades.length?table(['Date','Action','Stock','Notional'],s.trades.slice(0,12).map(function(t){return '<tr><td>'+escapeHtml(t.date)+'</td><td class="'+(t.side==='BUY'?'green':'red')+'">'+escapeHtml(t.side)+'</td><td>'+escapeHtml(t.symbol)+'</td><td>'+fmt(t.value)+'</td></tr>'})):'No simulated trades yet.';
    var v=s.validation;$('modelInfo').innerHTML=v?'<strong>'+escapeHtml(v.model)+'</strong><p class="muted">Holdout direction accuracy: '+v.accuracy+'% · Always-up baseline: '+v.alwaysUpBaseline+'% · '+v.holdoutSamples+' test observations. These are historical model checks, not guaranteed profits.</p><p class="mini">Last signal date: '+escapeHtml((m.signalDate||'n/a'))+' · Risk filter: '+(m.riskOn?'normal':'cautious (SPY below trend)')+'</p>':'Model not trained. Connect a market-data API key and scan.';
    $('activity').innerHTML=s.journal.length?s.journal.slice(0,8).map(function(v){return '<div class="logline">'+escapeHtml(v.text)+'<div class="mini">'+escapeHtml(v.time)+'</div></div>'}).join(''):'No activity.';
    if(!m.ok&&s.lastCheckedAt)notice(m.message,true);else if(!s.setup?.marketKeyConfigured && s.setup)notice('Add TWELVE_DATA_API_KEY as a Cloudflare Worker secret before scanning.',true);else $('alerts').innerHTML='';
  }
  function append(text,user){var d=document.createElement('div');d.className='bubble'+(user?' user':'');d.textContent=text;$('chatfeed').appendChild(d);$('chatfeed').scrollTop=$('chatfeed').scrollHeight}
  async function action(which,body){if(busy)return;loading(true);try{var r=await call(which,body);render(r);if(r.reply)append(r.reply,false);if(r.result)append(r.result.message,false);if(r.ok===false&&r.error)notice(r.error,true)}catch(e){notice(e.message,true);append(e.message,false)}finally{loading(false)}}
  $('loginBtn').addEventListener('click',async function(){token=$('pwd').value.trim();if(!token)return;$('loginError').textContent='Checking access...';try{var r=await call('status');sessionStorage.setItem('paperlab3key',token);render(r);$('loginError').textContent=''}catch(e){$('loginError').textContent=e.message}});
  $('pwd').addEventListener('keydown',function(e){if(e.key==='Enter')$('loginBtn').click()});
  $('startBtn').onclick=function(){action('start')};$('scanBtn').onclick=function(){action('scan')};$('pauseBtn').onclick=function(){action('pause')};
  $('sellBtn').onclick=function(){if(confirm('Queue a sell-all instruction for the next new verified market close?'))action('chat',{message:'sell everything'})};
  $('resetBtn').onclick=function(){if(confirm('Reset your entire simulated portfolio to $200 and delete all trade history?'))action('reset',{confirm:'RESET'})};
  $('chatForm').onsubmit=async function(e){e.preventDefault();if(busy)return;var msg=$('message').value.trim();if(!msg)return;$('message').value='';append(msg,true);loading(true);try{var r=await call('chat',{message:msg});render(r);append(r.reply,false)}catch(e){append('Error: '+e.message,false);notice(e.message,true)}finally{loading(false)}};
  if(token)call('status').then(render).catch(function(){sessionStorage.removeItem('paperlab3key');token='' });
  setInterval(function(){if(token&&!busy&&state&&state.running)call('status').then(render).catch(function(){});},60000);
})();
</script></body></html>`;