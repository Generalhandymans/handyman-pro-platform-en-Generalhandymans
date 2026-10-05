// Admin audit trail: who did what, when. Called from every admin write path.
const db = require('../db');

async function auditLog(adminId, action, entity, entityId, details) {
  try {
    await db.prepare(
      'INSERT INTO admin_audit (admin_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)'
    ).run(
      adminId || null, action, entity, entityId == null ? null : entityId,
      details == null ? null : String(details).slice(0, 2000)
    );
  } catch (e) { /* auditing must never break the request */ }
}

module.exports = { auditLog };
