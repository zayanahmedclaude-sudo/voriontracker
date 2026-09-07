import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { copyR2Object, getR2KeyFromUrl, putR2Object } from '@/lib/r2';
import { getExistingColumns, queryRows, sql } from '@/lib/db';
import { requireAuth, err, ok } from '@/lib/api';
import { hasSmtpConfig, sendScreenshotFlagReportEmail } from '@/lib/mailer';
import { ensureRoleFeatureSchema } from '@/lib/schema';
import { DEFAULT_STORAGE_SCOPE, getFlaggedEvidencePrefix, getStorageDatePath } from '@/lib/screenshot-storage';
import {
  canCreateScreenshotFlags,
  canSendFlagReports,
  canViewFlags,
  normalizeRole,
} from '@/lib/roles';

function parseEmailList(value: FormDataEntryValue | null) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeR2ObjectName(name: string) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'file';
}

function getScreenshotUrlExpression(columns: Set<string>, tableAlias = 's') {
  if (columns.has('file_url')) return `${tableAlias}.file_url`;
  throw new Error('screenshots table is missing its R2 URL column');
}

function getImageExtension(contentType: string, rawUrl: string) {
  const normalized = contentType.toLowerCase().split(';')[0].trim();
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/png') return 'png';
  const pathname = (() => {
    try {
      return new URL(rawUrl).pathname;
    } catch {
      return '';
    }
  })();
  const match = pathname.match(/\.([a-z0-9]+)$/i);
  const ext = match?.[1]?.toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'png' ? (ext === 'jpeg' ? 'jpg' : ext) : 'png';
}

async function saveFlaggedScreenshotToR2(screenshot: { id: string; file_url: string; employee_id: string; captured_at: string }) {
  if (!screenshot.file_url) throw new Error('Screenshot has no file URL to flag');
  const sourceKey = getR2KeyFromUrl(screenshot.file_url);
  if (!sourceKey) throw new Error('Screenshot URL is not a recognized R2 object');
  const extension = getImageExtension('image/png', screenshot.file_url);
  const flaggedName = `flagged-screenshot-${screenshot.id}.${extension}`;
  const r2Key = `${getFlaggedEvidencePrefix(DEFAULT_STORAGE_SCOPE, screenshot.employee_id, screenshot.captured_at)}${screenshot.id}-${flaggedName}`;

  const r2Object = await copyR2Object(sourceKey, r2Key);

  return { url: r2Object.url, name: flaggedName };
}

export async function GET(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  const role = normalizeRole(user.role);
  if (!canViewFlags(role)) return err('Forbidden', 403);

  try {
    await ensureRoleFeatureSchema();
    const { searchParams } = new URL(req.url);
    const employeeId = searchParams.get('employeeId');
    const date = searchParams.get('date');
    const availableColumns = await getExistingColumns('screenshots', ['file_url', 'storage_expired_at']);
    const screenshotUrlExpression = getScreenshotUrlExpression(availableColumns);
    const values: any[] = [];
    const filters: string[] = [];

    if (employeeId) {
      values.push(employeeId);
      filters.push(`sf.employee_id = $${values.length}`);
    }
    if (date) {
      values.push(date);
      filters.push(`DATE(s.captured_at) = $${values.length}`);
    }

    const rows = await queryRows(
      `SELECT
        sf.id,
        sf.comment,
        sf.pdf_url,
        sf.pdf_name,
        sf.flagged_screenshot_url,
        sf.flagged_screenshot_name,
        sf.email_to,
        sf.email_cc,
        sf.email_sent_at,
        sf.created_at,
        sf.updated_at,
        s.id AS screenshot_id,
        COALESCE(sf.flagged_screenshot_url, ${screenshotUrlExpression}) AS screenshot_url,
        ${screenshotUrlExpression} AS original_screenshot_url,
        s.captured_at,
        sf.employee_id,
        employee.full_name AS employee_name,
        flagged_by.full_name AS flagged_by_name
      FROM screenshot_flags sf
      JOIN screenshots s ON s.id = sf.screenshot_id
      JOIN public.profiles employee ON employee.id = sf.employee_id
      JOIN public.profiles flagged_by ON flagged_by.id = sf.flagged_by
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY sf.created_at DESC`,
      values,
    );

    return ok(rows);
  } catch (e: any) {
    console.error('GET /api/screenshot-flags error:', e?.message || e);
    return err(e?.message || 'Failed to load screenshot flags', 500);
  }
}

export async function POST(req: NextRequest) {
  const user = requireAuth(req);
  if ('status' in user) return user;
  const role = normalizeRole(user.role);
  if (!canCreateScreenshotFlags(role)) return err('Forbidden', 403);

  try {
    await ensureRoleFeatureSchema();
    const formData = await req.formData();
    const screenshotId = String(formData.get('screenshotId') || '').trim();
    const comment = String(formData.get('comment') || '').trim();
    const sendReport = String(formData.get('sendReport') || '').toLowerCase() === 'true';
    const to = parseEmailList(formData.get('to'));
    const cc = parseEmailList(formData.get('cc'));
    const pdf = formData.get('pdf');

    if (!screenshotId) return err('screenshotId is required', 400);
    if (!comment) return err('comment is required', 400);
    if (sendReport && !canSendFlagReports(role)) {
      return err('Only QA Managers can send report emails.', 403);
    }
    if (sendReport && to.length === 0) {
      return err('At least one "to" email is required to send a report.', 400);
    }

    const availableColumns = await getExistingColumns('screenshots', ['file_url']);
    const screenshotUrlExpression = getScreenshotUrlExpression(availableColumns);
    const screenshotRows = await queryRows(
      `SELECT s.id, ${screenshotUrlExpression} AS file_url, s.storage_expired_at, s.captured_at, s.employee_id, p.full_name AS employee_name
      FROM screenshots s
      JOIN public.profiles p ON p.id = s.employee_id
      WHERE s.id = $1
      LIMIT 1`,
      [screenshotId],
    );
    const screenshot = screenshotRows?.[0];
    if (!screenshot) return err('Screenshot not found', 404);
    if (!screenshot.file_url || screenshot.storage_expired_at) {
      return err('Screenshot expired after the 14-day retention period', 410);
    }

    let flaggedScreenshotUrl: string | null = null;
    let flaggedScreenshotName: string | null = null;
    try {
      const savedScreenshot = await saveFlaggedScreenshotToR2(screenshot);
      flaggedScreenshotUrl = savedScreenshot.url;
      flaggedScreenshotName = savedScreenshot.name;
    } catch (uploadError: any) {
      console.error('[screenshot-flags] flagged screenshot upload failed', uploadError?.message || uploadError);
      return err(uploadError?.message || 'Failed to save flagged screenshot to R2.', 500);
    }

    let pdfUrl: string | null = null;
    let pdfName: string | null = null;
    let attachmentBuffer: Buffer | null = null;

    if (pdf && typeof pdf !== 'string') {
      if (pdf.type !== 'application/pdf') {
        return err('Only PDF uploads are allowed.', 400);
      }
      attachmentBuffer = Buffer.from(await pdf.arrayBuffer());
      pdfName = sanitizeR2ObjectName(pdf.name || `flag-report-${Date.now()}.pdf`);

      const r2Key = `evidence/documents/${DEFAULT_STORAGE_SCOPE}/${user.sub}/${getStorageDatePath()}/${Date.now()}-${randomUUID()}-${pdfName}`;
      try {
        const r2Object = await putR2Object(r2Key, attachmentBuffer, 'application/pdf');
        pdfUrl = r2Object.url;
      } catch (uploadError: any) {
        console.error('[screenshot-flags] pdf upload failed', uploadError?.message || uploadError);
        return err('Failed to upload PDF report.', 500);
      }
    }

    let emailSent = false;
    let emailWarning: string | null = null;

    if (sendReport) {
      if (!hasSmtpConfig()) {
        emailWarning = 'SMTP is not configured (GMAIL_USER/GMAIL_APP_PASSWORD missing), so the flag was saved without sending the email report.';
      } else {
        try {
          const subject = `Vorion Screenshot Flag Report - ${screenshot.employee_name}`;
          const capturedStr = new Date(screenshot.captured_at).toLocaleString();
          const safeComment = escapeHtml(comment).replace(/\n/g, '<br />');

          const row = (label: string, valueHtml: string) => `
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #E4E7EC;width:140px;vertical-align:top">
                <span style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6B7280">${escapeHtml(label)}</span>
              </td>
              <td style="padding:10px 0;border-bottom:1px solid #E4E7EC;vertical-align:top">
                <span style="font-size:14px;color:#0A0E1A">${valueHtml}</span>
              </td>
            </tr>`;

          const pdfRowHtml = pdfUrl
            ? row('PDF Report', `<a href="${escapeHtml(pdfUrl)}" style="color:#1E5AE0;text-decoration:none;font-weight:600">${escapeHtml(pdfName)}</a> (also attached to this email)`)
            : pdfName
              ? row('PDF Report', `${escapeHtml(pdfName)} (attached to this email)`)
              : '';

          const html = `
            <div style="background:#F5F7FA;padding:32px 16px;font-family:Arial,Helvetica,sans-serif">
              <div style="max-width:640px;margin:0 auto;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E4E7EC">
                <div style="background:#0A0E1A;padding:20px 28px">
                  <span style="color:#F5F7FA;font-size:18px;font-weight:800;letter-spacing:.02em">Vorion &middot; Screenshot Flag Report</span>
                </div>
                <div style="padding:28px">
                  <table style="width:100%;border-collapse:collapse">
                    ${row('Employee', escapeHtml(screenshot.employee_name))}
                    ${row('Flagged By', escapeHtml(user.name))}
                    ${row('Captured', escapeHtml(capturedStr))}
                    ${row('Flagged Screenshot', `<a href="${escapeHtml(flaggedScreenshotUrl)}" style="color:#1E5AE0;text-decoration:none;font-weight:600">Open saved evidence</a>`)}
                    ${pdfRowHtml}
                  </table>
                  <div style="margin-top:18px">
                    <span style="font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#6B7280">Comment</span>
                    <p style="font-size:14px;color:#0A0E1A;line-height:1.6;margin:8px 0 0;white-space:pre-wrap">${safeComment}</p>
                  </div>
                </div>
                <div style="padding:16px 28px;background:#F5F7FA;border-top:1px solid #E4E7EC">
                  <span style="font-size:11px;color:#98A2B3">This is an automated report from Vorion. Please do not reply to this email.</span>
                </div>
              </div>
            </div>`;

          const text =
            `Screenshot Flag Report\n\n` +
            `Employee: ${screenshot.employee_name}\n` +
            `Flagged by: ${user.name}\n` +
            `Captured: ${capturedStr}\n` +
            `Flagged Screenshot: ${flaggedScreenshotUrl}\n` +
            (pdfUrl ? `PDF Report: ${pdfUrl}\n` : pdfName ? `PDF Report: ${pdfName} (attached)\n` : '') +
            `\nComment:\n${comment}\n\n` +
            `Original Screenshot: ${screenshot.file_url}`;

          await sendScreenshotFlagReportEmail({
            to,
            cc,
            subject,
            html,
            text,
            attachments: attachmentBuffer && pdfName
              ? [{ filename: pdfName, ...(pdfUrl ? { path: pdfUrl } : { content: attachmentBuffer }) }]
              : undefined,
          });
          emailSent = true;
        } catch (mailError: any) {
          console.error('[screenshot-flags] email send failed', mailError);
          emailWarning = mailError?.message || 'Flag saved, but the report email could not be sent.';
        }
      }
    }

    const [flag] = await sql`
      INSERT INTO screenshot_flags (
        screenshot_id,
        employee_id,
        flagged_by,
        comment,
        pdf_url,
        pdf_name,
        flagged_screenshot_url,
        flagged_screenshot_name,
        email_to,
        email_cc,
        email_sent_at
      )
      VALUES (
        ${screenshot.id},
        ${screenshot.employee_id},
        ${user.sub},
        ${comment},
        ${pdfUrl},
        ${pdfName},
        ${flaggedScreenshotUrl},
        ${flaggedScreenshotName},
        ${to},
        ${cc},
        ${emailSent ? new Date().toISOString() : null}
      )
      RETURNING id, created_at
    `;

    return ok({
      id: flag.id,
      created_at: flag.created_at,
      screenshot_id: screenshot.id,
      screenshot_url: flaggedScreenshotUrl,
      pdf_url: pdfUrl,
      email_sent: emailSent,
      warning: emailWarning,
    }, 201);
  } catch (e: any) {
    console.error('POST /api/screenshot-flags error:', e?.message || e);
    return err(e?.message || 'Failed to save screenshot flag', 500);
  }
}
