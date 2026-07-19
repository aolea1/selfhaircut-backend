// Haircut State Lab — Firebase Storage helpers.
//
// Images never go into Firestore documents (size limits, and Firestore isn't
// built for blobs). Firestore stores only the Storage object path; a fresh
// signed URL is minted on demand whenever the Lab needs to display an image,
// so records never hold a URL that silently expires.
//
// Requires the same Firebase Admin instance server.js already initializes
// from FIREBASE_SERVICE_ACCOUNT — this module never initializes its own.

const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1 hour

function getBucket(admin) {
  if (!admin || !admin.apps || !admin.apps.length) return null;
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'selfhaircutai.firebasestorage.app';
  return admin.storage().bucket(bucketName);
}

function labPath(ownerUid, testId, filename) {
  return `haircut-state-lab/${ownerUid}/${testId}/${filename}`;
}

async function getSignedReadUrl(admin, path) {
  const bucket = getBucket(admin);
  if (!bucket) throw new Error('STORAGE_NOT_CONFIGURED');
  const [url] = await bucket.file(path).getSignedUrl({
    action: 'read',
    expires: Date.now() + SIGNED_URL_TTL_MS,
  });
  return url;
}

// Uploads a buffer to haircut-state-lab/{ownerUid}/{testId}/{filename} and
// returns both the object path (stored permanently in Firestore) and a
// freshly-signed read URL (used immediately by the caller, not persisted).
async function uploadLabFile(admin, { ownerUid, testId, filename, buffer, contentType }) {
  const bucket = getBucket(admin);
  if (!bucket) throw new Error('STORAGE_NOT_CONFIGURED');
  const path = labPath(ownerUid, testId, filename);
  const file = bucket.file(path);
  await file.save(buffer, {
    contentType,
    metadata: { cacheControl: 'private, max-age=0, no-store' },
  });
  const url = await getSignedReadUrl(admin, path);
  return { path, url };
}

module.exports = { uploadLabFile, getSignedReadUrl, labPath, getBucket };
