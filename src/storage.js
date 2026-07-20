'use strict';

// Photo storage: R2 (S3-compatible) when configured, local disk otherwise
// (dev/CI). Keys are unguessable uuids; objects are only served through the
// app so the bucket never needs to be public.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

let s3 = null;
if (config.r2) {
  const { S3Client } = require('@aws-sdk/client-s3');
  s3 = new S3Client({
    region: 'auto',
    endpoint: config.r2.endpoint,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });
}

const localDir = path.join(path.dirname(config.databasePath), 'photos');

function newKey(ext) {
  return `${crypto.randomUUID()}${ext}`;
}

async function putPhoto(buffer, contentType) {
  const ext = contentType === 'image/png' ? '.png' : contentType === 'image/webp' ? '.webp' : '.jpg';
  const key = newKey(ext);
  if (s3) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(
      new PutObjectCommand({
        Bucket: config.r2.bucket,
        Key: `${config.r2.keyPrefix}/${key}`,
        Body: buffer,
        ContentType: contentType,
      })
    );
  } else {
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, key), buffer);
  }
  return key;
}

async function getPhotoStream(key) {
  if (!/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(key)) return null;
  if (s3) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try {
      const r = await s3.send(
        new GetObjectCommand({ Bucket: config.r2.bucket, Key: `${config.r2.keyPrefix}/${key}` })
      );
      return { stream: r.Body, contentType: r.ContentType || 'image/jpeg' };
    } catch {
      return null;
    }
  }
  const file = path.join(localDir, key);
  if (!fs.existsSync(file)) return null;
  const ct = key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  return { stream: fs.createReadStream(file), contentType: ct };
}

module.exports = { putPhoto, getPhotoStream, usingR2: !!s3 };
