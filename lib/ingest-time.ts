export const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MAX_INGEST_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export type IngestTime = {
  effectiveAt: string;
  deviceAt: string;
  receivedAt: string;
  clockSkewSeconds: number;
  corrected: boolean;
};

/**
 * Normalize a device timestamp without applying any timezone conversion.
 * ISO timestamps describe an instant; timezone affects display and shift policy only.
 */
export function resolveIngestTime(value: unknown, received = new Date()): IngestTime | null {
  const parsed = value ? new Date(String(value)) : received;
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() < received.getTime() - MAX_INGEST_AGE_MS) return null;

  const clockSkewSeconds = Math.round((parsed.getTime() - received.getTime()) / 1000);
  const corrected = parsed.getTime() > received.getTime() + MAX_FUTURE_CLOCK_SKEW_MS;
  return {
    effectiveAt: (corrected ? received : parsed).toISOString(),
    deviceAt: parsed.toISOString(),
    receivedAt: received.toISOString(),
    clockSkewSeconds,
    corrected,
  };
}
