'use strict';

const crypto = require('crypto');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const bucket = process.env.S3_BUCKET;
const client = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT,
  credentials: process.env.S3_ACCESS_KEY_ID ? {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  } : undefined,
});

function assertConfigured() {
  if (!bucket) throw new Error('S3_BUCKET is not configured');
}

function objectKey({ projectId, jobId, kind = 'request', extension = 'bin' }) {
  const scope = projectId ? `projects/${projectId}` : `jobs/${jobId}`;
  return `${scope}/${kind}/${crypto.randomUUID()}.${String(extension).replace(/[^a-z0-9]/gi, '')}`;
}

async function putPrivate({ key, body, contentType, metadata = {} }) {
  assertConfigured();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [String(k), String(v)])
    ),
  }));
  return key;
}

async function signedReadUrl(key, expiresIn = 300) {
  assertConfigured();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn }
  );
}

async function remove(key) {
  assertConfigured();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

module.exports = { objectKey, putPrivate, signedReadUrl, remove };
