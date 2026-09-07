const path=require('node:path');
require('dotenv').config({path:path.join(__dirname,'../.env.local'),quiet:true});
const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
async function main(){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query('ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS file_url TEXT');
    await client.query('ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS storage_expired_at TIMESTAMPTZ');
    const {rows}=await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='screenshots' AND column_name IN ('blob_url','blob_path')");
    for(const name of ['blob_url','blob_path'])if(rows.some(c=>c.column_name===name))await client.query(`ALTER TABLE screenshots ALTER COLUMN ${name} DROP NOT NULL`);
    let migrated=0;
    const endpoint=process.env.R2_ENDPOINT||(process.env.R2_ACCOUNT_ID?`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`:'');
    const bases=[process.env.R2_PUBLIC_URL,endpoint&&process.env.R2_BUCKET_NAME?`${endpoint.replace(/\/$/,'')}/${process.env.R2_BUCKET_NAME}`:null].filter(Boolean).map(v=>v.replace(/\/$/,'')+'/');
    if(rows.some(c=>c.column_name==='blob_url'))for(const base of bases){const result=await client.query('UPDATE screenshots SET file_url=blob_url WHERE file_url IS NULL AND storage_expired_at IS NULL AND LEFT(blob_url,LENGTH($1))=$1 AND LENGTH(blob_url)>LENGTH($1)',[base]);migrated+=result.rowCount;}
    await client.query('COMMIT');
    const result=await client.query('SELECT COUNT(*)::int AS total,COUNT(file_url)::int AS with_r2_url FROM screenshots');
    console.log(JSON.stringify({migrated,...result.rows[0]}));
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
main().catch(e=>{console.error(e.code||e.message);process.exitCode=1;}).finally(()=>pool.end());
