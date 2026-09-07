require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query(`
      SELECT id, full_name, role
      FROM public.profiles
      WHERE role IN ('superadmin', 'admin', 'hr', 'executive', 'qa_manager', 'qa_lead', 'qa', 'client', 'employee')
      ORDER BY
        CASE role
          WHEN 'superadmin' THEN 0
          WHEN 'admin' THEN 1
          WHEN 'hr' THEN 2
          WHEN 'executive' THEN 3
          WHEN 'qa_manager' THEN 4
          WHEN 'qa_lead' THEN 5
          WHEN 'qa' THEN 6
          WHEN 'client' THEN 7
          ELSE 8
        END,
        full_name
      LIMIT 1
    `);

    const user = result.rows[0];
    if (!user) {
      console.error('NO_USER');
      process.exit(1);
    }

    // Keep this diagnostic read-only. Printing a signed bearer credential makes
    // it persist in terminal scrollback, CI output, and collected debug logs.
    console.log(JSON.stringify({ user, credentialGenerated: false }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('AUTH_DEBUG_ERR', error.message);
  process.exit(1);
});
