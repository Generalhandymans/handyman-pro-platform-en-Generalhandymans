// Contractors: profiles, verification workflow (admin), performance.
const express = require('express');
const db = require('../db');
const { ah, authRequired, requireRole, isNonEmpty, failIfErrors } = require('../middleware');
const { contractorLifecycle, contractorScore, retentionAtRisk } = require('../services/crm');
const { auditLog } = require('../services/audit');

const router = express.Router();

async function enriched(c) {
  const u = await db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(c.user_id);
  return {
    ...c, user_name: u.name, email: u.email, phone: u.phone,
    lifecycle: contractorLifecycle(c), score: contractorScore(c), retention_at_risk: await retentionAtRisk(c),
  };
}

// Admin: everyone with lifecycle + score.
router.get('/', authRequired, requireRole('admin'), ah(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM contractors ORDER BY id DESC').all();
  res.json(await Promise.all(rows.map(enriched)));
}));

// Contractor: own profile.
router.get('/me', authRequired, requireRole('contractor'), ah(async (req, res) => {
  const c = await db.prepare('SELECT * FROM contractors WHERE user_id = ?').get(req.user.id);
  if (!c) return res.status(404).json({ error: 'Contractor profile not found.' });
  res.json(await enriched(c));
}));

// Contractor: update own editable profile fields.
router.patch('/me', authRequired, requireRole('contractor'), ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (b.city !== undefined && !isNonEmpty(b.city, 120)) errors.city = 'City is invalid.';
  if (b.service_radius_miles !== undefined && !(Number(b.service_radius_miles) >= 1 && Number(b.service_radius_miles) <= 500)) {
    errors.service_radius_miles = 'Radius must be 1-500 miles.';
  }
  if (failIfErrors(res, errors)) return;
  const fields = ['city', 'service_base', 'service_radius_miles', 'years_experience', 'specialties', 'license_number', 'insurance_info'];
  const sets = [], vals = [];
  for (const f of fields) {
    if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(typeof b[f] === 'string' ? b[f].trim() : b[f]); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
  vals.push(req.user.id);
  await db.prepare(`UPDATE contractors SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals);
  res.json(await enriched(await db.prepare('SELECT * FROM contractors WHERE user_id = ?').get(req.user.id)));
}));

// Admin: verification workflow — license, insurance, background check, activation.
router.patch('/:id/verify', authRequired, requireRole('admin'), ah(async (req, res) => {
  const c = await db.prepare('SELECT * FROM contractors WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contractor not found.' });
  const b = req.body || {};
  const errors = {};
  const patch = {};
  if (b.license_verified !== undefined) patch.license_verified = b.license_verified ? 1 : 0;
  if (b.insurance_verified !== undefined) patch.insurance_verified = b.insurance_verified ? 1 : 0;
  if (b.license_exempt !== undefined) patch.license_exempt = b.license_exempt ? 1 : 0;
  if (b.background_check !== undefined) {
    if (!['pending', 'passed', 'failed'].includes(b.background_check)) errors.background_check = 'Invalid value.';
    else patch.background_check = b.background_check;
  }
  if (b.status !== undefined) {
    if (!['pending', 'active', 'suspended'].includes(b.status)) errors.status = 'Invalid status.';
    else {
      // Guardrail: cannot activate until license (+ insurance verified and background passed),
      // unless the admin marked the contractor license-exempt (minor work not requiring a license).
      if (b.status === 'active') {
        const lv = patch.license_verified !== undefined ? patch.license_verified : c.license_verified;
        const le = patch.license_exempt !== undefined ? patch.license_exempt : c.license_exempt;
        const iv = patch.insurance_verified !== undefined ? patch.insurance_verified : c.insurance_verified;
        const bc = patch.background_check || c.background_check;
        if ((!lv && !le) || !iv || bc !== 'passed') {
          errors.status = 'Cannot activate: license and insurance must be verified and background check passed (or mark license-exempt for minor work).';
        }
      }
      if (!errors.status) patch.status = b.status;
    }
  }
  if (failIfErrors(res, errors)) return;
  const sets = Object.keys(patch).map(k => `${k} = ?`);
  if (sets.length) await db.prepare(`UPDATE contractors SET ${sets.join(', ')} WHERE id = ?`).run(...Object.values(patch), c.id);
  auditLog(req.user.id, 'contractor.verified', 'contractors', c.id, JSON.stringify(patch));
  const updated = await db.prepare('SELECT * FROM contractors WHERE id = ?').get(c.id);
  // Notify the contractor when their application becomes active (the "we'll notify you" promise).
  if (patch.status === 'active' && c.status !== 'active') {
    const u = await db.prepare('SELECT name, email FROM users WHERE id = ?').get(c.user_id);
    if (u && u.email) {
      const { notify, shell } = require('../services/notify');
      await notify({
        to: u.email,
        subject: 'Your Helpman application is active ✓',
        html: shell('You are active', `Hi ${u.name.split(' ')[0]}, your application was approved.`, [
          ['Status', 'Active'],
          ['License', updated.license_exempt ? 'Exempt (minor work)' : (updated.license_verified ? 'Verified' : '—')],
          ['Next step', 'Watch for job offers in your portal — you can accept or propose a counter-offer.'],
        ]),
      }).catch(() => {});
    }
  }
  res.json(await enriched(updated));
}));

router.get('/:id', authRequired, requireRole('admin'), ah(async (req, res) => {
  const c = await db.prepare('SELECT * FROM contractors WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contractor not found.' });
  res.json(await enriched(c));
}));

module.exports = router;
