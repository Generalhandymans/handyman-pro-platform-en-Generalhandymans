// Pluggable email provider for mass campaigns.
// Interface: send({ to, subject, html }) -> { ok, provider, error? }
//
// SENDER IDENTITY (owner-confirmed): every email the platform sends comes from
// the BUSINESS account, never a personal one.
//
//   HANDYMAN_FROM_EMAIL  (default: "generalhandymans@gmail.com" — the real business address)
//   HANDYMAN_FROM_NAME   (default: "Helpman")
//
// Real delivery additionally requires a provider: EMAIL_PROVIDER=sendgrid plus
// SENDGRID_API_KEY (or another SMTP setup). Default is "console" log mode,
// which records every message in the email_log table without sending anything.
// See README ("Business email setup") before sending real mail.
const FROM_EMAIL = process.env.HANDYMAN_FROM_EMAIL || process.env.EMAIL_FROM || 'generalhandymans@gmail.com';
const FROM_NAME = process.env.HANDYMAN_FROM_NAME || 'Helpman';

// Providers:
//  - "console" (default): prints to server console AND returns ok:true.
//    Every attempt is ALSO recorded in the email_log table by the caller,
//    so "send" in log mode is fully auditable without sending anything real.
//  - "sendgrid": uses native fetch against the SendGrid v3 API when
//    SENDGRID_API_KEY is set. No extra dependency.
//
// Honest fallback: without a key the platform never pretends to deliver mail.
const PROVIDER = (process.env.EMAIL_PROVIDER || 'console').toLowerCase();
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';

function activeProvider() {
  if (PROVIDER === 'sendgrid' && SENDGRID_KEY) return 'sendgrid';
  return 'console';
}

async function send({ to, subject, html }) {
  const provider = activeProvider();
  if (provider === 'sendgrid') return sendViaSendGrid({ to, subject, html });
  return sendViaConsole({ to, subject, html });
}

async function sendViaConsole({ to, subject, html }) {
  const text = (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  console.log(`[mail:console] to=${to} subject="${subject}" preview="${text}..."`);
  return { ok: true, provider: 'console' };
}

async function sendViaSendGrid({ to, subject, html }) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SENDGRID_KEY}` },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      content: [{ type: 'text/html', value: html }],
    }),
  });
  if (res.status === 202) return { ok: true, provider: 'sendgrid' };
  const err = await res.text().catch(() => '');
  return { ok: false, provider: 'sendgrid', error: `SendGrid ${res.status}: ${err.slice(0, 200)}` };
}

module.exports = { send, activeProvider, FROM_EMAIL, FROM_NAME };
