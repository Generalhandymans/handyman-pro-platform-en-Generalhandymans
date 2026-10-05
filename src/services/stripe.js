// Stripe integration — REAL payments.
//
// Setup (2 minutes, no code changes):
//   1. Create a free account at https://dashboard.stripe.com/register
//   2. Copy your keys from Developers -> API keys:
//        STRIPE_SECRET_KEY      (sk_live_...  — starts with sk_test_ in test mode)
//        STRIPE_PUBLISHABLE_KEY (pk_live_... / pk_test_... — used by the frontend)
//   3. Create a webhook at Developers -> Webhooks -> Add endpoint:
//        URL: https://YOUR-DOMAIN/api/payments/webhook
//        Events: payment_intent.succeeded, payment_intent.payment_failed
//        Copy the signing secret -> STRIPE_WEBHOOK_SECRET (whsec_...)
//   4. Set the three env vars and restart. Done — deposits go through Stripe.
//
// When the keys are NOT set, everything keeps working exactly as before:
// payments are recorded manually (provider='manual'). Nothing breaks.
let stripeClient = null;

function isEnabled() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function getClient() {
  if (!isEnabled()) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
  if (!stripeClient) {
    stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// Creates a PaymentIntent for a project deposit and records it as pending.
// Returns { client_secret, payment_id } — the frontend confirms with the
// publishable key via Stripe.js, the webhook marks it paid.
function createDepositIntent({ projectId, amountCents, customerEmail, description }) {
  const db = require('../db');
  const stripe = getClient();
  return stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    receipt_email: customerEmail || undefined,
    description: description || `General Handyman Solutions — deposit for project #${projectId}`,
    metadata: { project_id: String(projectId), kind: 'deposit' },
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  }).then((pi) => {
    const info = db.prepare(
      `INSERT INTO payments (project_id, kind, amount_cents, status, provider, provider_ref, notes)
       VALUES (?,?,?,'pending','stripe',?,?)`
    ).run(projectId, 'deposit', amountCents, pi.id, 'Stripe PaymentIntent created');
    return { client_secret: pi.client_secret, payment_id: info.lastInsertRowid, payment_intent_id: pi.id };
  });
}

// Verifies the webhook signature and applies the event to our ledger.
// Returns the event type handled, or null when signature verification fails.
function handleWebhook(rawBody, signature) {
  const db = require('../db');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set.');
  const stripe = getClient();
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (e) {
    return null; // bad signature — caller returns 400
  }
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    db.prepare(
      `UPDATE payments SET status = 'paid', notes = COALESCE(notes,'') || ' | Stripe confirmed ' || datetime('now')
       WHERE provider_ref = ? AND provider = 'stripe'`
    ).run(pi.id);
    // A confirmed deposit moves the job forward in the pipeline.
    const pid = pi.metadata && pi.metadata.project_id;
    if (pid) {
      const proj = db.prepare('SELECT job_request_id FROM projects WHERE id = ?').get(pid);
      if (proj) {
        db.prepare(`UPDATE job_requests SET status = 'deposit_paid', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(proj.job_request_id);
      }
    }
    return 'payment_intent.succeeded';
  }
  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    db.prepare(
      `UPDATE payments SET status = 'failed', notes = COALESCE(notes,'') || ' | Stripe failed ' || datetime('now')
       WHERE provider_ref = ? AND provider = 'stripe'`
    ).run(pi.id);
    return 'payment_intent.payment_failed';
  }
  return event.type; // acknowledged, nothing to do
}

module.exports = { isEnabled, getClient, createDepositIntent, handleWebhook };
