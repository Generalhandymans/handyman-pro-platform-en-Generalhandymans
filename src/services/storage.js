// Object storage for photos: S3-compatible (AWS S3, Cloudflare R2, etc.)
// when S3_BUCKET is configured, local disk otherwise.
//
// When S3 is active:
//   - uploads go to the bucket under photos/<kind>/<uuid>.<ext>
//   - reads use short-lived signed URLs (never expose the raw key)
//   - the photos table stores storage_provider='s3' + storage_key
// When S3 is NOT configured: everything stays on local disk (current behavior).
'use strict';

const crypto = require('crypto');

function isConfigured() {
  return !!process.env.S3_BUCKET;
}

function lazyClient() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: !!process.env.S3_ENDPOINT,
    credentials: process.env.S3_ACCESS_KEY_ID ? {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    } : undefined,
  });
}

function objectKey({ kind = 'request', extension = 'jpg' }) {
  const ext = String(extension || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'jpg';
  return `photos/${kind}/${crypto.randomUUID()}.${ext}`;
}

async function putObject({ key, filePath, contentType }) {
  const fs = require('fs');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const body = fs.readFileSync(filePath);
  await lazyClient().send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || 'image/jpeg',
  }));
  return key;
}

async function signedReadUrl(key, expiresIn = 300) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(
    lazyClient(),
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    { expiresIn }
  );
}

async function deleteObject(key) {
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await lazyClient().send(new DeleteObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
  }));
}

module.exports = { isConfigured, objectKey, putObject, signedReadUrl, deleteObject };
