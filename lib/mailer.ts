import nodemailer from 'nodemailer';

function getMailSetting(key: string, fallback?: string) {
  return process.env[key] || fallback || '';
}

function getBooleanSetting(key: string, fallback = false) {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const SMTP_HOST = getMailSetting('SMTP_HOST', getMailSetting('GMAIL_HOST', 'smtp.gmail.com'));
const SMTP_PORT = Number(getMailSetting('SMTP_PORT', getMailSetting('GMAIL_PORT', '587')));
const SMTP_USER = getMailSetting('SMTP_USER', getMailSetting('GMAIL_USER', ''));
const SMTP_PASS = getMailSetting('SMTP_PASS', getMailSetting('GMAIL_APP_PASSWORD', getMailSetting('GMAIL_PASS', '')));
const SMTP_FROM_EMAIL = getMailSetting('SMTP_FROM_EMAIL', getMailSetting('GMAIL_FROM', SMTP_USER));
const SMTP_FROM_NAME = getMailSetting('SMTP_FROM_NAME', getMailSetting('GMAIL_FROM_NAME', 'Vorion'));
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const SMTP_SECURE = getBooleanSetting('SMTP_SECURE', SMTP_PORT === 465);
const SMTP_REQUIRE_TLS = getBooleanSetting('SMTP_REQUIRE_TLS', true);

let transporter: nodemailer.Transporter | null = null;

export function hasSmtpConfig() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

function getTransporter() {
  if (transporter) return transporter;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      'SMTP is not configured. Set SMTP_HOST/SMTP_USER/SMTP_PASS or Gmail GMAIL_USER/GMAIL_APP_PASSWORD in your environment.'
    );
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    requireTLS: SMTP_REQUIRE_TLS,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    ...(SMTP_HOST.includes('gmail') ? { service: 'gmail' } : {}),
  });

  return transporter;
}

function escapeHtml(str: string) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sends a "here are your account credentials" email.
 * Used for roles that are created with an admin-set password up front
 * (employee, team_lead, qa_manager) rather than the self-service invite-link flow.
 */
export async function sendCredentialsEmail(opts: {
  to: string;
  name: string;
  password: string;
  role: string;
}) {
  const { to, name, password, role } = opts;
  const t = getTransporter();

  const roleLabel = role.replace(/_/g, ' ');
  const loginUrl = `${APP_URL}/login`;
  const currentYear = new Date().getFullYear();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Welcome to Vorion</title>
</head>
<body style="margin:0;padding:0;background-color:#eef1f6;">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#eef1f6;">
    Your Vorion account is ready. Sign in with the credentials inside.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef1f6;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 10px rgba(23,32,51,0.06);">
          <tr>
            <td align="center" style="padding:24px 36px;background-color:#0A0E1A;">
              <img
                src="${APP_URL}/logo.png?v=1"
                width="200"
                alt="Vorion Systems"
                style="display:block;width:200px;max-width:100%;height:auto;margin:0 auto;border:0;outline:none;text-decoration:none;"
              >
            </td>
          </tr>

          <tr>
            <td style="padding:40px 36px 32px;font-family:Arial,Helvetica,sans-serif;">
              <h1 style="margin:0 0 12px;font-size:24px;line-height:1.3;color:#172033;">
                Welcome, ${escapeHtml(name)}
              </h1>

              <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3f4a5e;">
                Your Vorion account has been created. You've been added as
                <strong style="color:#172033;">${escapeHtml(roleLabel)}</strong>.
              </p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
                <tr>
                  <td style="padding:20px 22px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="padding-bottom:16px;">
                          <span style="display:block;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#64748b;">
                            Email
                          </span>
                          <span style="display:block;margin-top:4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#172033;">
                            ${escapeHtml(to)}
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td style="border-top:1px solid #e2e8f0;padding-top:16px;">
                          <span style="display:block;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#64748b;">
                            Password
                          </span>
                          <span style="display:block;margin-top:4px;font-family:'Courier New',monospace;font-size:17px;font-weight:700;letter-spacing:.5px;color:#172033;background-color:#eef2f8;padding:8px 12px;border-radius:6px;">
                            ${escapeHtml(password)}
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0;">
                <a href="${loginUrl}" style="background:#1E5AE0;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;">
                  Sign in
                </a>
              </p>

              <p style="margin:24px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#94a3b8;">
                If you weren't expecting this email, you can safely ignore it or contact our support team.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 36px;background-color:#f8fafc;border-top:1px solid #e2e8f0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#64748b;">
                    &copy; ${currentYear} Vorion Systems &middot; Support:
                    <a href="mailto:support@vorionsystems.com" style="color:#2563eb;text-decoration:none;">support@vorionsystems.com</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  const text =
    `Welcome, ${name}\n\n` +
    `An account has been created for you as ${roleLabel}.\n\n` +
    `Username / Email: ${to}\n` +
    `Temporary Password: ${password}\n\n` +
    `Log in: ${loginUrl}\n\n` +
    `For security, please log in and change your password as soon as possible.`;

  const info = await t.sendMail({
    from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
    to,
    subject: 'Your account credentials',
    html,
    text,
  });
  console.log('[mailer] credentials email accepted', { to, messageId: info?.messageId });
}

export async function sendInviteEmail(opts: {
  to: string;
  name: string;
  role: string;
  actionUrl: string;
}) {
  const { to, name, role, actionUrl } = opts;
  const t = getTransporter();
  const roleLabel = role.replace(/_/g, ' ');

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0A0E1A;">You're invited, ${escapeHtml(name)}</h2>
      <p>An account was created for you as <strong>${escapeHtml(roleLabel)}</strong>.</p>
      <p>Use the button below to finish setting up your account and choose a password.</p>
      <p>
        <a href="${actionUrl}" style="background:#1E5AE0;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">
          Accept invitation
        </a>
      </p>
      <p style="color:#888; font-size:12px;">If the button does not work, copy and paste this link into your browser:</p>
      <p style="word-break:break-all; color:#1E5AE0;">${escapeHtml(actionUrl)}</p>
    </div>
  `;

  const text =
    `You have been invited to Vorion, ${name}\n\n` +
    `An account was created for you as ${roleLabel}.\n\n` +
    `Complete your setup here: ${actionUrl}`;

  const info = await t.sendMail({
    from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
    to,
    subject: 'You are invited to Vorion',
    html,
    text,
  });
  console.log('[mailer] invite email accepted', { to, messageId: info?.messageId });
}

export async function sendVerificationEmail(opts: {
  to: string;
  name: string;
  actionUrl: string;
}) {
  const { to, name, actionUrl } = opts;
  const t = getTransporter();

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0A0E1A;">Verify your account</h2>
      <p>Hello ${escapeHtml(name)},</p>
      <p>Use the button below to verify your account and continue.</p>
      <p>
        <a href="${actionUrl}" style="background:#1E5AE0;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">
          Verify account
        </a>
      </p>
      <p style="color:#888; font-size:12px;">If the button does not work, copy and paste this link into your browser:</p>
      <p style="word-break:break-all; color:#1E5AE0;">${escapeHtml(actionUrl)}</p>
    </div>
  `;

  const text = `Verify your account for ${name}: ${actionUrl}`;

  const info = await t.sendMail({
    from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
    to,
    subject: 'Verify your Vorion account',
    html,
    text,
  });
  console.log('[mailer] verification email accepted', { to, messageId: info?.messageId });
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  name: string;
  actionUrl: string;
}) {
  const { to, name, actionUrl } = opts;
  const t = getTransporter();

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0A0E1A;">Reset your password</h2>
      <p>Hello ${escapeHtml(name)},</p>
      <p>Use the button below to choose a new password for your Vorion account.</p>
      <p>
        <a href="${actionUrl}" style="background:#1E5AE0;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">
          Reset password
        </a>
      </p>
      <p style="color:#888; font-size:12px;">If the button does not work, copy and paste this link into your browser:</p>
      <p style="word-break:break-all; color:#1E5AE0;">${escapeHtml(actionUrl)}</p>
    </div>
  `;

  const text = `Reset your Vorion password, ${name}: ${actionUrl}`;

  const info = await t.sendMail({
    from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
    to,
    subject: 'Reset your Vorion password',
    html,
    text,
  });
  console.log('[mailer] password reset email accepted', { to, messageId: info?.messageId });
}

/**
 * Screenshot flag report email — sent via the same Gmail/SMTP transporter
 * as every other email in this file (invite, verification, credentials).
 * Uses GMAIL_USER / GMAIL_APP_PASSWORD (or SMTP_* equivalents) from the
 * environment.
 */
export async function sendScreenshotFlagReportEmail(opts: {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; path?: string; content?: Buffer }>;
}) {
  const t = getTransporter();
  const info = await t.sendMail({
    from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
    to: opts.to.join(', '),
    cc: opts.cc?.length ? opts.cc.join(', ') : undefined,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    attachments: opts.attachments,
  });
  console.log('[mailer] screenshot flag email accepted', {
    to: opts.to,
    cc: opts.cc || [],
    messageId: info?.messageId,
  });
}
