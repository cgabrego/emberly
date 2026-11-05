import http from "node:http";
import { Pool } from "pg";
import paperlab, { runCycle } from "./worker.mjs";

const pool = process.env.DATABASE_URL
  ? new Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:8000,idleTimeoutMillis:30000})
  : null;
let temporaryState=null;
const storage={
  async get(key) {
    if (!pool) return key==="paperlab-v3" ? temporaryState : null;
    const result=await pool.query("SELECT value FROM paperlab_state WHERE key=$1",[key]);
    return result.rows[0]?.value ?? null;
  },
  async put(key,value) {
    if (!pool) { temporaryState=JSON.parse(value);return; }
    await pool.query("INSERT INTO paperlab_state(key,value) VALUES($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",[key,value]);
  }
};
const env={
  PAPERLAB_KV:storage,
  APP_PASSWORD:process.env.APP_PASSWORD,
  TWELVE_DATA_API_KEY:process.env.TWELVE_DATA_API_KEY
};
if (pool) {
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS paperlab_state (key TEXT PRIMARY KEY, value JSONB NOT NULL)");
    console.log("PaperLab database ready");
  } catch(e) {
    console.error("Database initialization failed:",e.message);
    process.exit(1);
  }
} else {
  console.warn("DATABASE_URL not configured; changes are temporary. Configure database before using PaperLab.");
}
const port=Number(process.env.PORT||3000);
const server=http.createServer(async(req,res)=>{
  try {
    if(req.url==="/health") {
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
      res.end(JSON.stringify({ok:true,storage:!!pool,marketKey:!!env.TWELVE_DATA_API_KEY,passwordSet:!!env.APP_PASSWORD}));
      return;
    }
    const chunks=[];let bytes=0;
    for await (const chunk of req) {
      bytes+=chunk.length;
      if(bytes>100000) {res.writeHead(413);res.end("Request too large");return;}
      chunks.push(chunk);
    }
    const body=chunks.length?Buffer.concat(chunks):null;
    const request=new Request("https://paperlab.local"+(req.url||"/"),{
      method:req.method,headers:req.headers,...(body?{body,duplex:"half"}:{})
    });
    const result=await paperlab.fetch(request,env);
    res.writeHead(result.status,Object.fromEntries(result.headers.entries()));
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch(e) {
    console.error("Request error:",e.message);
    res.writeHead(500,{"content-type":"application/json"});
    res.end(JSON.stringify({ok:false,error:"Server error; check Render logs."}));
  }
});
server.listen(port,"0.0.0.0",()=>console.log("PaperLab listening on "+port));
let cycling=false;
setInterval(async()=>{
  if(cycling||!pool||!env.APP_PASSWORD||!env.TWELVE_DATA_API_KEY)return;
  const hour=Number(new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",hourCycle:"h23"}).format(new Date()));
  if(hour<17||hour>23)return;
  cycling=true;
  try {await runCycle(env,{now:new Date()});}
  catch(e){console.error("Scheduled paper scan failed:",e.message);}
  finally {cycling=false;}
},60*60*1000).unref();
