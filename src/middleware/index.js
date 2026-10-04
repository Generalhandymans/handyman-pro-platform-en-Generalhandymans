// Shared middleware: JWT auth, role checks, input validation helpers.
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('[warn] JWT_SECRET not set — using insecure dev default. Set it in .env');
}

// Wrap async route handlers so rejected promises reach Express error handling.
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Reads "Authorization: Bearer <token>", attaches req.user = {id, role, name}.
function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// authRequired must run first. Usage: requireRole('admin'), requireRole('admin','contractor')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden for role ' + req.user.role });
    }
    next();
  };
}

// --- tiny validation helpers (keep them strict but simple) ---
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+()\-.\s\d]{7,20}$/;

function isEmail(v) { return typeof v === 'string' && EMAIL_RE.test(v.trim()); }
function isPhone(v) { return typeof v === 'string' && PHONE_RE.test(v.trim()); }
function isNonEmpty(v, max = 500) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}
function isInt(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max;
}
// Collects {field: message} pairs; route returns 400 if any.
function failIfErrors(res, errors) {
  const keys = Object.keys(errors);
  if (keys.length) {
    res.status(400).json({ error: 'Validation failed', fields: errors });
    return true;
  }
  return false;
}

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

module.exports = { ah, authRequired, requireRole, isEmail, isPhone, isNonEmpty, isInt, failIfErrors, signToken };
