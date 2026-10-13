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

// Simulated payment mode ("como si Stripe estuviera"): for end-to-end testing
// without real Stripe keys. Enabled ONLY with SIMULATED_PAYMENTS=true and only
// when Stripe is NOT configured. Every simulated record is clearly labeled so
// it can never be confused with a real charge.
function isSimulated() {
  return !isEnabled() && process.env.SIMULATED_PAYMENTS === 'true';
}

function getClient() {
  if (!isEnabled()) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
  if (!stripeClient) {
    stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// Creates a PaymentIntent (deposit or final balance) and records it as pending.
// Returns { client_secret, payment_id } — the frontend confirms with the
// publishable key via Stripe.js, the webhook marks it paid.
async function createIntent({ projectId, amountCents, kind = 'deposit', customerEmail, description }) {
  const db = require('../db');
  const stripe = getClient();
  const label = kind === 'final' ? 'final balance' : 'deposit';
  const pi = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    receipt_email: customerEmail || undefined,
    description: description || `Helpman — ${label} for project #${projectId}`,
    metadata: { project_id: String(projectId), kind },
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  });
  const info = await db.prepare(
    `INSERT INTO payments (project_id, kind, amount_cents, status, provider, provider_ref, notes)
     VALUES (?,?,?,'pending','stripe',?,?)`
  ).run(projectId, kind, amountCents, pi.id, 'Stripe PaymentIntent created');
  return { client_secret: pi.client_secret, payment_id: info.lastInsertRowid, payment_intent_id: pi.id };
}
// Backwards-compatible name.
const createDepositIntent = (args) => createIntent({ ...args, kind: 'deposit' });

// Refunds (part of) a PAID Stripe payment. Stripe itself rejects refunds above
// what is still refundable; we also check first to return a clean error.
async function refundPayment({ payment, amountCents, cap = false, note }) {
  const db = require('../db');
  const stripe = getClient();
  const pi = await stripe.paymentIntents.retrieve(payment.provider_ref, { expand: ['latest_charge'] });
  const charge = pi.latest_charge;
  const refundable = charge ? (charge.amount - charge.amount_refunded) : 0;
  // cap=true: refund min(requested, refundable); nothing refundable -> null (caller moves on to the next payment).
  const amount = cap ? Math.min(amountCents || refundable, refundable) : (amountCents || refundable);
  if (cap && refundable < 1) return null;
  if (amount < 1 || amount > refundable) {
    const err = new Error(`Refundable amount is ${refundable} cents.`);
    err.statusCode = 400;
    throw err;
  }
  const refund = await stripe.refunds.create({ payment_intent: payment.provider_ref, amount });
  const info = await db.prepare(
    `INSERT INTO payments (project_id, kind, amount_cents, status, provider, provider_ref, notes)
     VALUES (?,?,?,'paid','stripe',?,?)`
  ).run(payment.project_id, 'refund', amount, refund.id, note || `Refund of payment #${payment.id}`);
  return { refund_id: refund.id, payment_id: info.lastInsertRowid, amount_cents: amount };
}

// Verifies the webhook signature and applies the event to our ledger.
// Contract: returns null ONLY when the signature is invalid (caller -> 400);
// returns the event type when handled; THROWS when processing fails so the
// route answers 500 and Stripe retries. Idempotent: replays change nothing.
async function handleWebhook(rawBody, signature) {
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
    const pay = await db.prepare(
      `SELECT id, amount_cents, status FROM payments WHERE provider = 'stripe' AND provider_ref = ?`
    ).get(pi.id);
    if (!pay) return event.type;                    // not one of ours
    if (pay.status === 'paid') return event.type;   // replay: already applied
    if (pi.amount_received !== pay.amount_cents) {  // never mark paid on a different amount
      await db.prepare(
        `UPDATE payments SET notes = COALESCE(notes,'') || ' | AMOUNT MISMATCH: received ' || ? WHERE id = ?`
      ).run(String(pi.amount_received), pay.id);
      throw new Error(`Amount mismatch on ${pi.id}: expected ${pay.amount_cents}, received ${pi.amount_received}`);
    }
    const upd = await db.prepare(
      `UPDATE payments SET status = 'paid', notes = COALESCE(notes,'') || ' | Stripe confirmed'
       WHERE id = ? AND status <> 'paid'`
    ).run(pay.id);
    const kind = pi.metadata && pi.metadata.kind;
    const pid = pi.metadata && pi.metadata.project_id;
    if (upd.changes === 1) await require('./events').record('payment', pay.id, 'payment.paid', { data: { project_id: Number(pid) || null, kind, amount_cents: pay.amount_cents } });
    if (upd.changes === 1 && kind === 'deposit' && pid) {
      const proj = await db.prepare('SELECT job_request_id FROM projects WHERE id = ?').get(pid);
      if (proj) {
        // Only moves FORWARD: a late/replayed event can never pull a job back.
        await db.prepare(
          `UPDATE job_requests SET status = 'deposit_paid', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status IN ('new','ai_analyzed','quote_sent')`
        ).run(proj.job_request_id);
      }
      // Email the customer: deposit received + Terms of Service.
      const { depositConfirmationEmail } = require('./notify');
      await depositConfirmationEmail(pid).catch(() => {});
    }
    return event.type;
  }

  if (event.type === 'payment_intent.payment_failed') {
    await db.prepare(
      `UPDATE payments SET status = 'failed', notes = COALESCE(notes,'') || ' | Stripe failed'
       WHERE provider = 'stripe' AND provider_ref = ? AND status = 'pending'`
    ).run(event.data.object.id);
    return event.type;
  }
  return event.type; // acknowledged, nothing to do
}

// Test hook: lets the automated tests inject a fake Stripe client (no network). Never used in production.
function _setClientForTests(client) { stripeClient = client; }

// Status reporter: true when Stripe is NOT configured but SIMULATED_PAYMENTS=true.
// Every simulated record is clearly labeled so it can never be confused with a real charge.
function isSimulated() {
  return !isEnabled() && process.env.SIMULATED_PAYMENTS === 'true';
}

module.exports = { _setClientForTests, isEnabled, isSimulated, getClient, createIntent, createDepositIntent, refundPayment, handleWebhook };
