// Business-event log. record() NEVER throws: losing a timeline entry must not break a payment or a stage change.
'use strict';
const db = require('../db');

async function record(entity, entityId, type, { actorId = null, data = null } = {}) {
  try {
    await db.prepare('INSERT INTO events (entity, entity_id, type, actor_id, data) VALUES (?,?,?,?,?)')
      .run(entity, Number(entityId), type, actorId, data == null ? null : JSON.stringify(data));
  } catch (e) { console.error('[events] could not record', type, e.message); }
}
const stage = (projectId, from, to, actorId) => record('project', projectId, 'project.stage', { actorId, data: { from, to } });

module.exports = { record, stage };
