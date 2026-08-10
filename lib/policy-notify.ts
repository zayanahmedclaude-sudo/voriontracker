// The payload has no policy data. Agents fetch their own effective policy after
// receiving it, so an employee cannot learn another employee's scoped rules.
import { emitSocketEvent } from '@/lib/socket';

export type PolicyInvalidation = {
  policyType: 'policy' | 'blocked-app' | 'blocked-website';
  updatedAt: string;
  version: number;
};

export async function notifyPolicyChanged(policyType: PolicyInvalidation['policyType'] = 'policy') {
  const now = Date.now();
  const payload: PolicyInvalidation = {
    policyType,
    updatedAt: new Date(now).toISOString(),
    version: now,
  };
  await emitSocketEvent('policy-updated', payload, { toEmployees: true });
}
