// One place that persists an uploaded photo: optimize, then keep it on local
// disk or (when S3_BUCKET is set) in object storage. Used by BOTH the
// request-photo and the project-photo routes so neither can drift again.
'use strict';
const fs = require('fs');
const photoSvc = require('./photos');
const storage = require('./storage');

async function persist(file, kind) {
  const opt = await photoSvc.optimize(file.path, file.mimetype);
  if (!storage.isConfigured()) {
    return { opt, filename: file.filename, storageKey: null, storageProvider: 'local' };
  }
  const ext = (String(file.originalname || '').split('.').pop() || 'jpg');
  const key = storage.objectKey({ kind, extension: ext });
  await storage.putObject({ key, filePath: opt.path || file.path, contentType: file.mimetype });
  try { fs.unlinkSync(file.path); } catch (e) { /* best effort */ }
  // photos.filename doubles as the lookup key for S3 rows (see server.js photo route).
  return { opt, filename: key, storageKey: key, storageProvider: 's3' };
}

module.exports = { persist };
