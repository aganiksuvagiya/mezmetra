import nodemailer from 'nodemailer';
import { config } from '../config.js';

/**
 * Sends email through SMTP (SMTP_URL). Any provider works: Gmail with an app password, Brevo, Resend, Amazon SES ...
 * Without SMTP_URL nothing is sent: in development the message is printed to the console so the flow can be tried
 * locally; in production only a warning is logged (never the message, it contains a secret link).
 * `send({ to, subject, text, html })` resolves when the mail was handed to the server.
 */
export function createMailer() {
  const unconfigured = {
    configured: false,
    async send({ to, subject, text }) {
      if (config.isProd) {
        console.warn(`[mail] SMTP is not set up, so "${subject}" to ${to} was not sent.`);
        return;
      }
      console.log(`[mail] SMTP is not set up, so this email was NOT sent. It would have been:\n  To: ${to}\n  Subject: ${subject}\n\n${text}\n`);
    },
  };

  // An empty value, or a placeholder such as "none" (some dashboards insist on a value), means "no email".
  const url = config.smtpUrl.trim();
  if (!url || ['none', 'no', 'off', '-'].includes(url.toLowerCase())) return unconfigured;
  try {
    const transport = nodemailer.createTransport(url);
    return { configured: true, send: (message) => transport.sendMail({ from: config.mailFrom, ...message }) };
  } catch (err) {
    // A mistyped SMTP_URL must not stop the whole API from starting.
    console.warn(`[mail] SMTP_URL is not valid (${err.message}); password reset emails will not be sent.`);
    return unconfigured;
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function passwordResetEmail({ to, name, link, minutes }) {
  const text = [
    `Hi ${name},`,
    '',
    'Someone asked to reset the password of your MezMitra account. To choose a new password, open this link:',
    link,
    '',
    `The link works once and expires in ${minutes} minutes. If you did not ask for this, ignore this email: your password stays as it is.`,
    '',
    'MezMitra',
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;line-height:1.5;color:#1e293b">
<p>Hi ${escapeHtml(name)},</p>
<p>Someone asked to reset the password of your MezMitra account.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#b45309;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Choose a new password</a></p>
<p style="font-size:13px;color:#64748b">The link works once and expires in ${minutes} minutes. If the button doesn't work, copy this address into your browser:<br>${escapeHtml(link)}</p>
<p style="font-size:13px;color:#64748b">If you did not ask for this, ignore this email: your password stays as it is.</p></div>`;
  return { to, subject: 'Reset your MezMitra password', text, html };
}
