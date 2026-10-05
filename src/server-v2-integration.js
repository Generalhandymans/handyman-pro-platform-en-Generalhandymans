'use strict';

/*
  This file shows the integration order to apply to existing server.js.
  It is intentionally separate so the current app is not overwritten blindly.
*/

const { validateEnv } = require('./config/env');
const { requestId, securityHeaders, noStoreSensitive } = require('./middleware/security-v2');
const { httpLogger } = require('./observability/logger');

function applyV2(app) {
  const cfg = validateEnv();

  if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy);

  app.use(requestId);
  app.use(securityHeaders());
  app.use(noStoreSensitive);
  app.use(httpLogger);

  app.use('/api/v2/health', require('./routes/health-v2'));
  app.use('/api/v2/media', require('./routes/media-v2'));
  app.use('/api/v2/dispatch', require('./routes/dispatch-v2'));

  return app;
}

module.exports = { applyV2 };
