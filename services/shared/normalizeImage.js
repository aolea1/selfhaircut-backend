// Extracted from server.js (Haircut State Lab phase 1) — no behavior change.
// Pure image-prep utility: HEIC->JPEG, EXIF auto-orient, resize-if-oversized,
// recompress. Used by both the existing /analyze etc. routes and the new
// Haircut State Lab anatomy route.
const MAX_IMG_DIMENSION = 1600;
const JPEG_QUALITY      = 82;

async function normalizeImage(buffer, originalMimetype, logCtx) {
  let workBuf  = buffer;
  let workMime = originalMimetype || 'image/jpeg';

  // Convert HEIC/HEIF → JPEG (pure-JS, no native lib needed)
  if (workMime === 'image/heic' || workMime === 'image/heif') {
    try {
      const heicConvert = require('heic-convert');
      workBuf  = Buffer.from(await heicConvert({ buffer: workBuf, format: 'JPEG', quality: 0.9 }));
      workMime = 'image/jpeg';
      logCtx.heicConverted = true;
    } catch(e) {
      logCtx.heicConvertError = e.message;
      // Fall through and let sharp try anyway
    }
  }

  const sharp = require('sharp');
  const img   = sharp(workBuf).rotate(); // auto-orient via EXIF
  const meta  = await img.metadata();
  logCtx.originalWidth  = meta.width;
  logCtx.originalHeight = meta.height;
  logCtx.originalFormat = meta.format;

  // Reject if sharp can't read the image at all
  if (!meta.width || !meta.height) throw new Error('IMAGE_UNREADABLE: sharp could not decode image');

  // Resize if oversized (keeps aspect ratio, never enlarges)
  const needsResize = meta.width > MAX_IMG_DIMENSION || meta.height > MAX_IMG_DIMENSION;
  const pipeline    = needsResize
    ? img.resize(MAX_IMG_DIMENSION, MAX_IMG_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    : img;
  if (needsResize) logCtx.resized = true;

  const outBuf = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: false }).toBuffer();
  if (!outBuf || outBuf.length < 1000) throw new Error('IMAGE_EMPTY: processed image is too small to be valid');

  logCtx.processedSize   = outBuf.length;
  logCtx.processedFormat = 'image/jpeg';
  logCtx.processedWidth  = needsResize ? Math.round(meta.width  * Math.min(MAX_IMG_DIMENSION/meta.width, MAX_IMG_DIMENSION/meta.height)) : meta.width;
  logCtx.processedHeight = needsResize ? Math.round(meta.height * Math.min(MAX_IMG_DIMENSION/meta.width, MAX_IMG_DIMENSION/meta.height)) : meta.height;

  return { buffer: outBuf, mediaType: 'image/jpeg' };
}

module.exports = { normalizeImage, MAX_IMG_DIMENSION, JPEG_QUALITY };
