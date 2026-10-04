// Photo optimization: resize to max 1600px on the long edge and compress.
// Uses sharp when available; falls back to storing the original untouched
// (documented in README — never silently pretends to optimize).
const fs = require('fs');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const MAX_SIDE = 1600;

async function optimize(filePath, mime) {
  const stat = fs.statSync(filePath);
  if (!sharp) {
    return { optimized: false, reason: 'sharp not installed', width: null, height: null, size: stat.size };
  }
  try {
    const img = sharp(filePath).rotate();
    const meta = await img.metadata();
    const longest = Math.max(meta.width || 0, meta.height || 0);
    let pipeline = img;
    if (longest > MAX_SIDE) pipeline = pipeline.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    // Normalize to JPEG for photos (keeps PNG only when it has transparency needs — photos don't).
    const wantJpeg = (mime || '').startsWith('image/') && mime !== 'image/png';
    const out = wantJpeg ? await pipeline.jpeg({ quality: 80, mozjpeg: true }).toBuffer()
                         : await pipeline.png({ compressionLevel: 8 }).toBuffer();
    const outMeta = await sharp(out).metadata();
    fs.writeFileSync(filePath, out);
    return {
      optimized: true, width: outMeta.width || null, height: outMeta.height || null,
      size: out.length, original_size: stat.size,
    };
  } catch (e) {
    return { optimized: false, reason: 'optimize failed: ' + String(e.message).slice(0, 120), width: null, height: null, size: stat.size };
  }
}

function available() { return !!sharp; }

module.exports = { optimize, available, MAX_SIDE };
