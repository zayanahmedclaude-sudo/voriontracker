import { queryRows, invalidateColumnCache, withTransaction } from './db';
let ready: Promise<void> | null = null;
/** Upgrade installations that stored R2 URLs in the old blob_url field. */
export function ensureScreenshotR2Schema() {
  if(!ready)ready=withTransaction(async client=>{
    const {rows:columns}=await client.query("SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='screenshots' AND column_name IN ('file_url','blob_url','blob_path')");
    const alreadyUpgraded=columns.some(c=>c.column_name==='file_url');
    if(!alreadyUpgraded)await client.query('ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS file_url TEXT');
    for(const name of ['blob_url','blob_path'])if(columns.some(c=>c.column_name===name&&c.is_nullable==='NO'))await client.query(`ALTER TABLE screenshots ALTER COLUMN ${name} DROP NOT NULL`);
    // Large historical backfills run only on the first upgrade, never on every cold start.
    if(alreadyUpgraded || !columns.some(c=>c.column_name==='blob_url'))return;
    const endpoint=process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID?`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`:'');
    const bases=[process.env.R2_PUBLIC_URL,endpoint&&process.env.R2_BUCKET_NAME?`${endpoint.replace(/\/$/,'')}/${process.env.R2_BUCKET_NAME}`:null].filter((v):v is string=>!!v).map(v=>v.replace(/\/$/,'')+'/');
    for(const base of bases)await client.query(`UPDATE screenshots SET file_url=blob_url WHERE file_url IS NULL AND storage_expired_at IS NULL AND LEFT(blob_url,LENGTH($1))=$1 AND LENGTH(blob_url)>LENGTH($1)`,[base]);
  }).then(()=>{invalidateColumnCache('screenshots');}).catch(error=>{ready=null;throw error;});
  return ready;
}
