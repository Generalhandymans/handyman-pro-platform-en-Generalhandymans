'use strict';

const helmet = require('helmet');
const crypto = require('crypto');

function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "img-src": ["'self'", "data:", "blob:"],
        "script-src": ["'self'", "https://js.stripe.com"],
        "frame-src": ["https://js.stripe.com", "https://hooks.stripe.com"],
        "connect-src": ["'self'", "https://api.stripe.com"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'none'"],
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

function noStoreSensitive(req, res, next) {
  if (req.path.startsWith('/api/auth') || req.path.startsWith('/api/payments')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

module.exports = { requestId, securityHeaders, noStoreSensitive };
