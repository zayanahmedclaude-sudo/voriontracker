require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

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

    const token = jwt.sign(
      { sub: user.id, role: user.role, teamId: null, name: user.full_name || 'Debug User' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' },
    );

    console.log(JSON.stringify({ user, token }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('AUTH_DEBUG_ERR', error.message);
  process.exit(1);
});
