import { sql } from '@/lib/db';
import { ensureRoleFeatureSchema } from '@/lib/schema';
import UsersClient from './UsersClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function Page() {
  await ensureRoleFeatureSchema();
  const rows = await sql`
    SELECT
      p.id,
      p.full_name AS name,
      p.email,
      p.role,
      p.department_id,
      p.shift_type,
      p.employment_type,
      p.account_status,
      p.created_at,
      ca.employee_id AS assigned_employee_id,
      ca.shift_type AS assignment_shift_type,
      employee.full_name AS assigned_employee_name
    FROM public.profiles p
    LEFT JOIN client_assignments ca ON ca.client_id = p.id
    LEFT JOIN public.profiles employee ON employee.id = ca.employee_id
    ORDER BY p.full_name
  `;

  return <UsersClient initialUsers={rows} />;
}
