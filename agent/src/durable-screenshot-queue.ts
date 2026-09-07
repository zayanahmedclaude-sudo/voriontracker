export type DurableR2Upload = {
  path: string;
  url: string;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  downloadUrl?: string;
  contentType?: string;
  checksum?: string;
};

export type PendingScreenshot = {
  localId: string;
  imageBuf?: Buffer;
  imageExt?: 'webp' | 'png';
  imageMime?: string;
  thumbnailBuf?: Buffer;
  thumbnailMime?: string;
  upload?: DurableR2Upload;
  activeApp: string;
  activityPct: number;
  capturedAt: string;
  sessionId: string | null;
  captureContext: 'employee_session' | 'device_background';
  employeeId: string | null;
  deviceRegistrationId: string | null;
  attempts: number;
  nextRetryAt?: number;
  permanentFailure?: string;
};

export function serializePendingScreenshot(shot: PendingScreenshot) {
  return {
    version: 1,
    localId: shot.localId,
    imageBase64: shot.imageBuf?.toString('base64') || null,
    imageExt: shot.imageExt || null,
    imageMime: shot.imageMime || null,
    thumbnailBase64: shot.thumbnailBuf?.toString('base64') || null,
    thumbnailMime: shot.thumbnailMime || null,
    upload: shot.upload || null,
    activeApp: shot.activeApp,
    activityPct: shot.activityPct,
    capturedAt: shot.capturedAt,
    sessionId: shot.sessionId,
    captureContext: shot.captureContext,
    employeeId: shot.employeeId,
    deviceRegistrationId: shot.deviceRegistrationId,
    attempts: shot.attempts,
    nextRetryAt: shot.nextRetryAt || null,
    permanentFailure: shot.permanentFailure || null,
  };
}

export function deserializePendingScreenshot(record: any): PendingScreenshot | null {
  if (!record || record.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(String(record.localId || ''))) return null;
  const captureContext = record.captureContext === 'employee_session' ? 'employee_session' : record.captureContext === 'device_background' ? 'device_background' : null;
  const sessionId = record.sessionId ? String(record.sessionId) : null;
  const employeeId = record.employeeId ? String(record.employeeId) : null;
  const deviceRegistrationId = record.deviceRegistrationId ? String(record.deviceRegistrationId) : null;
  if (!captureContext || (captureContext === 'employee_session' && (!sessionId || !employeeId || deviceRegistrationId)) || (captureContext === 'device_background' && (sessionId || employeeId || !deviceRegistrationId))) return null;
  const capturedAt = String(record.capturedAt || '');
  if (Number.isNaN(new Date(capturedAt).getTime())) return null;
  return {
    localId: String(record.localId),
    imageBuf: record.imageBase64 ? Buffer.from(String(record.imageBase64), 'base64') : undefined,
    imageExt: record.imageExt === 'png' ? 'png' : record.imageExt === 'webp' ? 'webp' : undefined,
    imageMime: record.imageMime ? String(record.imageMime) : undefined,
    thumbnailBuf: record.thumbnailBase64 ? Buffer.from(String(record.thumbnailBase64), 'base64') : undefined,
    thumbnailMime: record.thumbnailMime ? String(record.thumbnailMime) : undefined,
    upload: record.upload || undefined,
    activeApp: String(record.activeApp || 'Unknown').slice(0, 500),
    activityPct: Math.max(0, Math.min(100, Number(record.activityPct) || 0)),
    capturedAt,
    sessionId,
    captureContext,
    employeeId,
    deviceRegistrationId,
    attempts: Math.max(0, Number(record.attempts) || 0),
    nextRetryAt: record.nextRetryAt ? Number(record.nextRetryAt) : undefined,
    permanentFailure: record.permanentFailure ? String(record.permanentFailure).slice(0, 200) : undefined,
  };
}

export function canAuthenticateScreenshot(shot: PendingScreenshot, employeeSubject: string, hasEmployeeToken: boolean, deviceId: string, hasDeviceToken: boolean) {
  if (shot.permanentFailure) return false;
  if (shot.captureContext === 'employee_session') return Boolean(hasEmployeeToken && shot.employeeId && employeeSubject === shot.employeeId);
  return Boolean(hasDeviceToken && shot.deviceRegistrationId && deviceId === shot.deviceRegistrationId);
}
