// Contractors: profiles, verification workflow (admin), performance.
const express = require('express');
const multer = require('multer');
const path = require('path');
const { requireStaff, can } = require('../services/permissions');
const db = require('../db');
const { ah, authRequired, requireRole, isNonEmpty, failIfErrors } = require('../middleware');
const { contractorLifecycle, contractorScore, retentionAtRisk } = require('../services/crm');
const { auditLog } = require('../services/audit');

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
  res.json(rows.map(enriched));
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
  if (b.background_check !== undefined) {
    if (!['pending', 'passed', 'failed'].includes(b.background_check)) errors.background_check = 'Invalid value.';
    else patch.background_check = b.background_check;
  }
  if (b.status !== undefined) {
    if (!['pending', 'active', 'suspended'].includes(b.status)) errors.status = 'Invalid status.';
    else {
      // Guardrail: cannot activate until license + insurance verified and background passed.
      if (b.status === 'active') {
        const lv = patch.license_verified !== undefined ? patch.license_verified : c.license_verified;
        const iv = patch.insurance_verified !== undefined ? patch.insurance_verified : c.insurance_verified;
        const bc = patch.background_check || c.background_check;
        if (!lv || !iv || bc !== 'passed') {
          errors.status = 'Cannot activate: license and insurance must be verified and background check passed.';
        }
      }
      if (!errors.status) patch.status = b.status;
    }
  }
  if (failIfErrors(res, errors)) return;
  const sets = Object.keys(patch).map(k => `${k} = ?`);
  if (sets.length) await db.prepare(`UPDATE contractors SET ${sets.join(', ')} WHERE id = ?`).run(...Object.values(patch), c.id);
  await auditLog(req.user.id, 'contractor.verified', 'contractors', c.id, JSON.stringify(patch));
  res.json(await enriched(await db.prepare('SELECT * FROM contractors WHERE id = ?').get(c.id)));
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
