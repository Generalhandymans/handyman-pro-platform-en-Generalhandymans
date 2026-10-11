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

// Two-step verification is REQUIRED for the areas that move money or manage the
// team ('finance', 'staff'). On by default in production; REQUIRE_2FA=true/false overrides.
const mfaPolicyOn = () => process.env.REQUIRE_2FA === 'true' || (process.env.NODE_ENV === 'production' && process.env.REQUIRE_2FA !== 'false');
const MFA_AREAS = ['finance', 'staff'];
const mfaRequired = (u) => mfaPolicyOn() && MFA_AREAS.some(a => can(u, a));

// null when allowed, else { error, code } to send with a 403. Used by requireStaff and by
// routes that decide per ACTION (e.g. a dispute resolution that refunds needs 'finance').
function denial(user, area) {
  if (!user || user.role !== 'admin') return { error: 'You do not have permission to do that.' };
  if (!can(user, area)) return { error: `Your team role (${effectiveRole(user)}) cannot do this. Ask an owner.`, code: 'STAFF_ROLE' };
  if (MFA_AREAS.includes(area) && mfaPolicyOn() && !user.totp_enabled) {
    return { error: 'Turn on two-step verification (Security tab) to use this area.', code: 'MFA_REQUIRED' };
  }
  return null;
}

// Use AFTER authRequired:  router.post('/x', authRequired, requireStaff('finance'), ...)
function requireStaff(area) {
  return (req, res, next) => {
    const d = denial(req.user, area);
    if (d) return res.status(403).json(d);
    next();
  };
}

module.exports = { ROLES, ASSIGNABLE, effectiveRole, permissionsOf, can, denial, requireStaff, mfaPolicyOn, mfaRequired };
