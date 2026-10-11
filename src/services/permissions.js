// Team roles for the admin panel. Every staff account has users.role = 'admin';
// users.staff_role says WHAT it may do. NULL means 'owner' (full access), so
// accounts created before this feature keep working unchanged.
//
//   owner     everything, including managing the team
//   finance   money: payments, refunds, contractor payouts, KPIs
//   dispatch  operations: assign, schedule, move stages, contractors, costs
//   support   customers: messages, quotes, CRM, campaigns (no money, no costs)
//
// 'disabled' = deactivated: cannot sign in and has no permissions.
'use strict';

const ROLES = {
  owner:    ['read', 'support', 'costs', 'dispatch', 'finance', 'marketing', 'staff'],
  finance:  ['read', 'costs', 'finance'],
  dispatch: ['read', 'support', 'costs', 'dispatch'],
  support:  ['read', 'support', 'marketing'],
};
const ASSIGNABLE = ['owner', 'finance', 'dispatch', 'support'];

const effectiveRole = (u) => (u && u.role === 'admin' ? (u.staff_role || 'owner') : null);
const permissionsOf = (u) => ROLES[effectiveRole(u)] || [];
const can = (u, area) => permissionsOf(u).includes(area);

// Use AFTER authRequired:  router.post('/x', authRequired, requireStaff('finance'), ...)
function requireStaff(area) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'You do not have permission to do that.' });
    if (!can(req.user, area)) {
      return res.status(403).json({ error: `Your team role (${effectiveRole(req.user)}) cannot do this. Ask an owner.`, code: 'STAFF_ROLE' });
    }
    next();
  };
}

module.exports = { ROLES, ASSIGNABLE, effectiveRole, permissionsOf, can, requireStaff };
