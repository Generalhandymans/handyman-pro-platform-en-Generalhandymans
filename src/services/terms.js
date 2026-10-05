// Legal terms versions + acceptance recording.
// Bump a version string whenever the corresponding terms page changes;
// the version is stored with every acceptance as legal proof.
const db = require('../db');

const CLIENT_TERMS_VERSION = '2026-10-05';
const CONTRACTOR_TERMS_VERSION = '2026-10-05';

function recordAcceptance({ userId, kind, referenceId, version, ip }) {
  db.prepare(
    `INSERT OR IGNORE INTO terms_acceptances (user_id, kind, reference_id, terms_version, ip)
     VALUES (?,?,?,?,?)`
  ).run(userId, kind, referenceId, version, ip || null);
}

function getAcceptance(kind, referenceId, userId) {
  return db.prepare(
    `SELECT * FROM terms_acceptances WHERE kind = ? AND reference_id = ? AND user_id = ?`
  ).get(kind, referenceId, userId);
}

module.exports = { CLIENT_TERMS_VERSION, CONTRACTOR_TERMS_VERSION, recordAcceptance, getAcceptance };
