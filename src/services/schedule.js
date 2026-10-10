// Scheduling helpers for the admin agenda. PURE functions (no database), so the
// overlap logic is easy to test. Dates are 'YYYY-MM-DD' (a time part is ignored).
'use strict';

const ACTIVE = new Set(['assigned', 'scheduled', 'in_progress', 'review']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const day = (s) => (s ? String(s).slice(0, 10) : null);

function intervalOf(r) {
  const start = day(r.scheduled_start);
  if (!start) return null;
  const end = day(r.scheduled_end) || start;
  return { start, end: end < start ? start : end };
}
const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;

// Ids of OTHER active projects of the same contractor whose dates overlap `row`.
function conflictsFor(row, rows) {
  const iv = intervalOf(row);
  if (!iv || row.contractor_id == null) return [];
  return rows
    .filter(o => o.id !== row.id && o.contractor_id === row.contractor_id && ACTIVE.has(o.stage))
    .filter(o => { const oi = intervalOf(o); return oi && overlaps(iv, oi); })
    .map(o => o.id);
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// rows: project rows joined with job + contractor info. Returns the agenda for [from, to].
function buildSchedule(rows, from, to) {
  const active = rows.filter(r => ACTIVE.has(r.stage));
  const window = { start: from, end: to };
  const items = [];
  const unscheduled = [];
  for (const r of active) {
    const iv = intervalOf(r);
    const conflicts = conflictsFor(r, active);
    const item = { ...r, conflicts };
    if (!iv) unscheduled.push(item);
    else if (overlaps(iv, window)) items.push(item);
  }
  items.sort((a, b) => day(a.scheduled_start).localeCompare(day(b.scheduled_start)) || a.id - b.id);
  unscheduled.sort((a, b) => a.id - b.id);
  return {
    from, to, items, unscheduled,
    conflict_count: items.filter(i => i.conflicts.length).length,
  };
}

module.exports = { ACTIVE, DATE_RE, intervalOf, overlaps, conflictsFor, addDays, buildSchedule };
