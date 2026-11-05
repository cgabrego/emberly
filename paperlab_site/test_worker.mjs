// Node 22 test suite: fabricated prices are used ONLY in this automated test file.
// The actual Cloudflare app refuses to trade without authenticated Twelve Data market prices.
import assert from 'node:assert/strict';
import worker, {initialState,parseBars,trainModel,runCycle,handleChat,simulateTradingDay} from './worker.mjs';

const now = new Date('2026-11-05T23:30:00Z');
const syms=['SPY','QQQ','NVDA','AAPL','MSFT','AMD','GOOGL','IREN'];
function weekdays(ending,n){let d=new Date(ending+'T12:00:00Z'),out=[];for(let i=0;out.length<n;i++){const day=d.getUTCDay();if(day!==0&&day!==6)out.push(d.toISOString().slice(0,10));d.setUTCDate(d.getUTCDate()-1)}return out.reverse()}
const dates=weekdays('2026-11-05',260);
function gen(symbol, currentPriceScale=1){
  const ord=syms.indexOf(symbol);
  return dates.map((d,i)=>{
    const base=100+ord*15;
    const drift=(0.001+ord*0.00018)*i;
    const wobble=0.025*Math.sin(i/7+ord)+0.01*Math.cos(i/13 + ord*0.33);
    const close=base*Math.exp(drift+wobble)*(i===259?currentPriceScale:1);
    return {datetime:d,open:String(close*0.997),close:String(close),volume:String(1e6+1000*i+ord*1900)};
  }).reverse();
}
function mockApi(fail=false,scale=1){return async function(url){
 if(fail)throw new TypeError('network unreachable');
 const json=Object.fromEntries(syms.map(s=>[s,{meta:{symbol:s},values:gen(s,scale),status:'ok'}]));
 return new Response(JSON.stringify(json),{status:200,headers:{'Content-Type':'application/json'}});
};}
function fakeKV(){let data=new Map();return {async get(k,kind){return kind==='json'&&data.has(k)?JSON.parse(data.get(k)):data.get(k)||null},async put(k,v){data.set(k,v)}}}
const env={PAPERLAB_KV:fakeKV(),APP_PASSWORD:'test-secret-not-for-production',TWELVE_DATA_API_KEY:'test-data-key'};
const savedFetch=globalThis.fetch;
try{
 globalThis.fetch=mockApi();
 let parsed=parseBars({values:gen('SPY')},now);
 assert.equal(parsed.length,260);assert.equal(parsed.at(-1).date,'2026-11-05');
 const beforeClose=parseBars({values:gen('SPY')},new Date('2026-11-05T17:00:00Z'));
 assert.equal(beforeClose.at(-1).date,'2026-11-04');
 console.log('PASS: excludes unfinished current-session bars');

 const cached=Object.fromEntries(syms.map(s=>[s,parseBars({values:gen(s)},now)]));
 const model=trainModel(cached);
 assert.equal(model.ranks.length,8);assert.ok(model.validation.trainingSamples>100);assert.ok(model.validation.holdoutSamples>0);
 // Yesterday's decisions must be unchanged even if the "fill-day" closing price changes dramatically.
 const modified=Object.fromEntries(syms.map(s=>[s,parseBars({values:gen(s,1.8)},now)]));
 const model2=trainModel(modified);
 for(let i=0;i<8;i++){
   const a=model.ranks.find(r=>r.symbol===syms[i]),b=model2.ranks.find(r=>r.symbol===syms[i]);
   assert.equal(a.score,b.score);
   assert.equal(a.predicted5Day,b.predicted5Day);
 }
 console.log('PASS: signal training and ranking do not use fill-day future price');

 let scan=await runCycle(env,{now,shouldTrade:false});
 assert.equal(scan.ok,true);assert.equal(scan.ranks.length,8);assert.equal(scan.cash,200);
 console.log('PASS: verifies eight market symbols and trains model');

 const headers={authorization:'Bearer test-secret-not-for-production','content-type':'application/json'};
 let bad=await worker.fetch(new Request('https://paperlab.workers.dev/api/status'),env);
 assert.equal(bad.status,401);
 let auth=await worker.fetch(new Request('https://paperlab.workers.dev/api/status',{headers}),env);
 assert.equal(auth.status,200);
 console.log('PASS: password gate blocks unauthorized portfolio access');

 // The bot should understand the requested autonomous start, but may elect to hold cash.
 const cmd=await handleChat(env,'Hey, go spend the $200 and try to make a profit',now);
 assert.ok(cmd.running);assert.match(cmd.reply,/Autopilot started/i);
 assert.ok(cmd.lastProcessedDate==='2026-11-05');
 assert.ok(cmd.trades.length>=1, "synthetic positive-trend fixture should lead to virtual orders");
 let total=cmd.cash+cmd.positions.reduce((s,p)=>s+p.value,0);
 assert.ok(Math.abs(total-cmd.equity)<0.05);
 console.log('PASS: natural-language command runs real logic and simulated buy orders');

 const repeat=await runCycle(env,{now:new Date('2026-11-05T23:32:00Z')});
 assert.equal(repeat.result.changed,false);assert.equal(repeat.trades.length,cmd.trades.length);
 console.log('PASS: idempotent trades, no duplicate orders for same date');

 const explained=await handleChat(env,'Why did you buy that?',now);
 assert.ok(explained.reply.length>25);
 const cautious=await handleChat(env,'Please be more cautious',now);
 assert.equal(cautious.strategy,'cautious');
 const close=await handleChat(env,'Sell everything',now);
 assert.equal(close.liquidate,true);
 const stop=await handleChat(env,'Stop trading',now);
 assert.equal(stop.running,false);
 console.log('PASS: chat explains choices, changes risk, queues selling and pauses');

 const failenv={PAPERLAB_KV:fakeKV(),APP_PASSWORD:'p',TWELVE_DATA_API_KEY:'key'};
 globalThis.fetch=mockApi(true);
 const fail=await runCycle(failenv,{now});
 assert.equal(fail.ok,false);assert.equal(fail.cash,200);assert.equal(fail.positions.length,0);assert.equal(fail.trades.length,0);
 assert.match(fail.error,/price service|network/i);
 console.log('PASS: provider failure executes no trades and never invents prices');

 // Cron calls core handler after the auto-mode has been enabled.
 globalThis.fetch=mockApi();
 const envCron={PAPERLAB_KV:fakeKV(),APP_PASSWORD:'pw',TWELVE_DATA_API_KEY:'key'};
 let old=initialState();old.running=true;await envCron.PAPERLAB_KV.put('paperlab-v3',JSON.stringify(old));
 await worker.scheduled({scheduledTime:now.valueOf()},envCron,{});
 let cr=JSON.parse(await envCron.PAPERLAB_KV.get('paperlab-v3'));
 assert.equal(cr.lastProcessedDate,'2026-11-05');assert.ok(cr.ranks.length>=5);
 console.log('PASS: cloud scheduled handler trades independently of browser');

 let reset=await worker.fetch(new Request('https://paperlab.workers.dev/api/reset',{method:'POST',headers,body:JSON.stringify({confirm:'RESET'})}),env);
 assert.equal(reset.status,200);let rr=await reset.json();assert.equal(rr.cash,200);assert.equal(rr.trades.length,0);
 console.log('PASS: safe explicit reset restores virtual $200');
 console.log('\nAll 10 integration checks passed.');
} finally {globalThis.fetch=savedFetch;}