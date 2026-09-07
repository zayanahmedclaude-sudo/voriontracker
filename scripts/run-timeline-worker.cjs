const path=require('node:path');
require('dotenv').config({path:path.join(__dirname,'../.env.local'),quiet:true});
const base=process.env.TIMELINE_WORKER_URL || 'http://127.0.0.1:3000';
if(!process.env.CRON_SECRET)throw new Error('CRON_SECRET is required');
async function run(){
  try{const response=await fetch(`${base.replace(/\/$/,'')}/api/cron/timeline`,{headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`},signal:AbortSignal.timeout(290000)});if(!response.ok)throw new Error(`Worker returned HTTP ${response.status}`);console.log('[timeline-worker]',await response.json());}
  catch(e){console.error('[timeline-worker]',e.message);}
}
async function loop(){await run();setTimeout(loop,60000);}
void loop();
