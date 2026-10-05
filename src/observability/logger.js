'use strict';

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'password',
      '*.password',
      '*.password_hash',
      '*.token',
      '*.reset_token',
      '*.verify_token',
      '*.client_secret',
      '*.stripe_signature',
    ],
    censor: '[REDACTED]',
  },
});

function httpLogger(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger.info({
      request_id: req.id,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Math.round(ms * 10) / 10,
      user_id: req.user?.id,
      role: req.user?.role,
    }, 'http_request');
  });
  next();
}

module.exports = { logger, httpLogger };
