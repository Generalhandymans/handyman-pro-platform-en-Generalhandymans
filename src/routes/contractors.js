// Contractors: profiles, verification workflow (admin), performance.
const express = require('express');
const multer = require('multer');
const path = require('path');
const { requireStaff, can } = require('../services/permissions');
const db = require('../db');
const { ah, authRequired, requireRole, isNonEmpty, isEmail, isPhone, failIfErrors } = require('../middleware');
const { contractorLifecycle, contractorScore, retentionAtRisk } = require('../services/crm');
const { auditLog } = require('../services/audit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { notify, shell } = require('../services/notify');

const router = express.Router();

const photoUpload = multer({
  dest: path.join(__dirname, '..', '..', 'uploads'),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed (max 5 MB).'));
  },
});

async function enriched(c) {
  const u = await db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(c.user_id);
  const { contractorPhotoUrl } = require('../services/notify');
  return {
    ...c, user_name: u.name, email: u.email, phone: u.phone,
    photo_url: contractorPhotoUrl(c),
    lifecycle: contractorLifecycle(c), score: contractorScore(c), retention_at_risk: await retentionAtRisk(c),
  };
}

// Admin: everyone with lifecycle + score.
router.get('/', authRequired, requireStaff('read'), ah(async (req, res) => {
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
  const cur0 = await db.prepare('SELECT provider_type FROM contractors WHERE user_id = ?').get(req.user.id);
  if (cur0 && cur0.provider_type === 'employee' && (b.license_number !== undefined || b.insurance_info !== undefined)) {
    return res.status(403).json({ error: 'Your license and insurance are covered by the company and managed by an administrator.' });
  }
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

  // A verification belongs to the DOCUMENT that was checked. Changing the license number or the
  // insurance details voids it (otherwise a verified contractor could swap in any text and keep the
  // badge), and an active contractor who loses a verification goes back to "pending" until re-checked.
  const cur = await db.prepare('SELECT * FROM contractors WHERE user_id = ?').get(req.user.id);
  const changed = (f) => b[f] !== undefined && String(b[f]).trim() !== String(cur[f] == null ? '' : cur[f]).trim();
  let reverify = false;
  if (changed('license_number') && cur.license_verified) { sets.push('license_verified = 0'); reverify = true; }
  if (changed('insurance_info') && cur.insurance_verified) { sets.push('insurance_verified = 0'); reverify = true; }
  if (reverify && cur.status === 'active') sets.push(`status = 'pending'`);

  vals.push(req.user.id);
  await db.prepare(`UPDATE contractors SET ${sets.join(', ')} WHERE user_id = ?`).run(...vals);
  if (reverify) await auditLog(req.user.id, 'contractor.reverification_required', 'contractors', cur.id, 'License/insurance details changed by the contractor');
  res.json(await enriched(await db.prepare('SELECT * FROM contractors WHERE user_id = ?').get(req.user.id)));
}));

// ---- Owner: add a COMPANY TECHNICIAN (provider_type 'employee') ----
// The company's own license/insurance cover them, so they start verified + background-checked; that is a
// deliberate bypass of the per-person verification, which is why only an OWNER can do it and it is audited.
// They are ASSIGNED jobs (no offer to accept) and are paid through payroll, so no per-job payable exists.
// They sign in like any contractor (set a password from an emailed link).
router.post('/employees', authRequired, requireStaff('staff'), ah(async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!isNonEmpty(b.name, 120)) errors.name = 'Name is required.';
  if (!isEmail(b.email)) errors.email = 'A valid email is required.';
  if (b.phone && !isPhone(b.phone)) errors.phone = 'Phone looks invalid.';
  if (b.city && !isNonEmpty(b.city, 80)) errors.city = 'City is too long.';
  if (b.specialties !== undefined && (!Array.isArray(b.specialties) || b.specialties.some(s => typeof s !== 'string'))) errors.specialties = 'A list of trades.';
  if (failIfErrors(res, errors)) return;
  const email = b.email.trim().toLowerCase();
  if (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'That email already has an account.' });
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10); // unknown until they set their own
  let userId, contractorId;
  await db.transaction(async (tx) => {
    const u = await tx.prepare(
      `INSERT INTO users (name, email, phone, password_hash, role, email_verified, reset_token, reset_expires) VALUES (?,?,?,?,'contractor',1,?,?)`
    ).run(b.name.trim(), email, (b.phone || '').trim(), hash, token, expires);
    userId = u.lastInsertRowid;
    const k = await tx.prepare(
      `INSERT INTO contractors (user_id, legal_name, city, specialties, license_verified, insurance_verified, background_check, status, provider_type)
       VALUES (?,?,?,?,1,1,'passed','active','employee')`
    ).run(userId, b.name.trim(), (b.city || '').trim() || null, JSON.stringify(b.specialties || []));
    contractorId = k.lastInsertRowid;
  });
  await auditLog(req.user.id, 'contractor.employee_created', 'contractors', contractorId, `${email} — company technician, verification covered by the company`);
  const link = `${process.env.PUBLIC_URL || 'http://localhost:3000'}/auth.html?reset=${token}`;
  await notify({
    to: email, subject: 'Your technician account at General Handyman Solutions',
    html: shell('Welcome to the team', `Hi ${b.name.trim().split(' ')[0]}, your technician account is ready. Set your password within 24 hours:`, [['Set password', link]]),
  }).catch(() => {});
  res.status(201).json({ id: contractorId, user_id: userId, provider_type: 'employee', status: 'active' });
}));

// ---- Owner: convert between company technician and independent contractor ----
router.patch('/:id/provider-type', authRequired, requireStaff('staff'), ah(async (req, res) => {
  const type = (req.body || {}).provider_type;
  if (!['contractor', 'employee'].includes(type)) return res.status(422).json({ errors: { provider_type: 'employee or contractor.' } });
  const c = await db.prepare('SELECT * FROM contractors WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contractor not found.' });
  if (c.provider_type === type) return res.json({ id: c.id, provider_type: type });
  if (type === 'employee') {
    // Becoming payroll: an unpaid per-job payable would be orphaned.
    const open = await db.prepare(`SELECT COUNT(*) c FROM contractor_payables WHERE contractor_id = ? AND status IN ('pending','approved')`).get(c.id);
    if (Number(open.c) > 0) return res.status(409).json({ error: 'This contractor has unpaid payouts. Pay or cancel them before converting to a company technician.' });
    await db.prepare(`UPDATE contractors SET provider_type = 'employee' WHERE id = ?`).run(c.id);
  } else {
    // The company's coverage ended with the employment: they must be verified on their own again.
    await db.prepare(`UPDATE contractors SET provider_type = 'contractor', license_verified = 0, insurance_verified = 0, background_check = 'pending', status = 'pending' WHERE id = ?`).run(c.id);
  }
  await auditLog(req.user.id, 'contractor.provider_type_changed', 'contractors', c.id, `${c.provider_type} -> ${type}`);
  res.json(await db.prepare('SELECT * FROM contractors WHERE id = ?').get(c.id));
}));

// ---- Contractor: upload / replace the profile photo ----
// Shown to customers on assignment emails, so it is required before any job
// can be offered. The contractor is told this in the portal and by email.
router.post('/me/photo', authRequired, requireRole('contractor'), photoUpload.single('photo'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Send the photo as the "photo" file field.' });
  const { filename } = await require('../services/photostore').persist(req.file, 'profile');
  await db.prepare('UPDATE contractors SET photo_filename = ? WHERE user_id = ?').run(filename, req.user.id);
  await auditLog(req.user.id, 'contractor.photo_uploaded', 'contractors', req.user.id, 'Profile photo updated');
  const { contractorPhotoUrl } = require('../services/notify');
  res.status(201).json({ photo_url: `${require('../services/magiclink').baseUrl()}/api/contractor-photos/${filename}` });
}));

// ---- Dispatch: re-send the "upload your photo" reminder ----
router.post('/:id/remind-photo', authRequired, requireStaff('dispatch'), ah(async (req, res) => {
  const c = await db.prepare(
    'SELECT c.*, u.name, u.email FROM contractors c JOIN users u ON u.id = c.user_id WHERE c.id = ?'
  ).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contractor not found.' });
  if (c.photo_filename) return res.status(400).json({ error: 'This contractor already has a profile photo.' });
  const { notify, photoReminder } = require('../services/notify');
  await notify({ to: c.email, subject: 'Action needed: upload your profile photo', html: photoReminder(c.name.split(' ')[0]) });
  await auditLog(req.user.id, 'contractor.photo_reminded', 'contractors', c.id, 'Photo reminder re-sent');
  res.json({ reminded: true });
}));

// Admin: verification workflow — license, insurance, background check, activation.
router.patch('/:id/verify', authRequired, requireStaff('dispatch'), ah(async (req, res) => {
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
  await auditLog(req.user.id, 'contractor.verified', 'contractors', c.id, JSON.stringify(patch));
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

// ---- Admin: set a contractor's base location (for distance in matching) ----
// Send { lat, lng } or { address } (geocoded when GEOCODE_API_KEY is set).
router.patch('/:id/location', authRequired, requireStaff('dispatch'), ah(async (req, res) => {
  const c = await db.prepare('SELECT id FROM contractors WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contractor not found.' });
  const geo = require('../services/geocode');
  let { lat, lng, address } = req.body || {};
  if (address) {
    const pt = await geo.geocode(String(address));
    if (!pt) return res.status(422).json({ error: 'Could not geocode that address. Send lat/lng instead or configure GEOCODE_API_KEY.' });
    lat = pt.lat; lng = pt.lng;
  }
  lat = Number(lat); lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(422).json({ error: 'Validation failed', fields: { lat: 'Latitude -90..90 required.', lng: 'Longitude -180..180 required.' } });
  }
  await db.prepare('UPDATE contractors SET lat = ?, lng = ? WHERE id = ?').run(lat, lng, c.id);
  await auditLog(req.user.id, 'contractor.located', 'contractors', c.id, `lat ${lat}, lng ${lng}`);
  res.json({ id: c.id, lat, lng });
}));

router.get('/:id', authRequired, requireStaff('read'), ah(async (req, res) => {
  const c = await db.prepare('SELECT * FROM contractors WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contractor not found.' });
  res.json(await enriched(c));
}));

module.exports = router;
