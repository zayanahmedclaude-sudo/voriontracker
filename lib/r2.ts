import { CopyObjectCommand, DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let client: S3Client | null = null;

function required(name: string) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Server misconfigured: ${name} is not set`);
  return value;
}

function endpoint() {
  return String(process.env.R2_ENDPOINT || `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`).replace(/\/$/, '');
}

export function getR2Client() {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: endpoint(),
      credentials: {
        accessKeyId: required('R2_ACCESS_KEY_ID'),
        secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
      },
    });
  }
  return client;
}

export function getR2Bucket() {
  return required('R2_BUCKET_NAME');
}

export function getR2PublicUrl(key: string) {
  const base = String(process.env.R2_PUBLIC_URL || `${endpoint()}/${getR2Bucket()}`).replace(/\/$/, '');
  return `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export function getR2KeyFromUrl(rawUrl: unknown) {
  if (typeof rawUrl !== 'string' || !rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    const publicBase = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    if (publicBase) {
      const base = new URL(publicBase);
      const prefix = base.pathname.replace(/\/$/, '') + '/';
      if (url.origin === base.origin && url.pathname.startsWith(prefix)) {
        return decodeURIComponent(url.pathname.slice(prefix.length));
      }
    }
    const api = new URL(endpoint());
    const bucketPrefix = `/${getR2Bucket()}/`;
    if (url.origin === api.origin && url.pathname.startsWith(bucketPrefix)) {
      return decodeURIComponent(url.pathname.slice(bucketPrefix.length));
    }
  } catch {}
  return '';
}

export function isR2Url(rawUrl: unknown) {
  return Boolean(getR2KeyFromUrl(rawUrl));
}

export async function createR2Upload(key: string, contentType: string, expiresIn = 600) {
  const uploadUrl = await getSignedUrl(
    getR2Client(),
    new PutObjectCommand({ Bucket: getR2Bucket(), Key: key, ContentType: contentType }),
    { expiresIn },
  );
  return { key, uploadUrl, url: getR2PublicUrl(key) };
}

export async function putR2Object(key: string, body: Buffer | Uint8Array, contentType: string) {
  await getR2Client().send(new PutObjectCommand({
    Bucket: getR2Bucket(),
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return { key, url: getR2PublicUrl(key) };
}

export async function copyR2Object(sourceKey: string, destinationKey: string, contentType?: string) {
  await getR2Client().send(new CopyObjectCommand({
    Bucket: getR2Bucket(),
    Key: destinationKey,
    CopySource: `${getR2Bucket()}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`,
    ...(contentType ? { ContentType: contentType, MetadataDirective: 'REPLACE' as const } : {}),
  }));
  return { key: destinationKey, url: getR2PublicUrl(destinationKey) };
}

export async function deleteR2Objects(keys: string[]) {
  if (!keys.length) return 0;
  let deleted = 0;
  for (let index = 0; index < keys.length; index += 1000) {
    const batch = keys.slice(index, index + 1000);
    await getR2Client().send(new DeleteObjectsCommand({
      Bucket: getR2Bucket(),
      Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
    }));
    deleted += batch.length;
  }
  return deleted;
}
