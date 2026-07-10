/**
 * Owner-access unit tests
 * Run with: node owner.test.js
 */

// ── Inline the helpers under test ────────────────────────────────────────────
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isOwner(user) {
  const emailVerified      = user?.email_verified === true || user?.emailVerified === true;
  const authenticatedEmail = normalizeEmail(user?.email);
  const ownerEmail         = normalizeEmail(process.env.OWNER_EMAIL);
  return Boolean(
    emailVerified &&
    authenticatedEmail &&
    ownerEmail &&
    authenticatedEmail === ownerEmail
  );
}

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    console.error(`       expected: ${expected}`);
    console.error(`       received: ${actual}`);
    failed++;
  }
}

// Set a known OWNER_EMAIL for the tests
process.env.OWNER_EMAIL = 'owner@example.com';

console.log('\nOwner-access tests\n');

// 1. Verified owner email → true
assert(
  'verified owner email grants access',
  isOwner({ email: 'owner@example.com', emailVerified: true }),
  true
);

// 2. Case-insensitive match
assert(
  'uppercase owner email still matches',
  isOwner({ email: 'OWNER@EXAMPLE.COM', emailVerified: true }),
  true
);

// 3. Whitespace tolerance
assert(
  'leading/trailing whitespace ignored',
  isOwner({ email: '  owner@example.com  ', emailVerified: true }),
  true
);

// 4. Unverified email → denied even if address matches
assert(
  'unverified email is denied even if address matches',
  isOwner({ email: 'owner@example.com', emailVerified: false }),
  false
);

// 5. Admin SDK shape (email_verified snake_case)
assert(
  'Admin SDK email_verified field accepted',
  isOwner({ email: 'owner@example.com', email_verified: true }),
  true
);

// 6. Different user → denied
assert(
  'non-owner email is denied',
  isOwner({ email: 'other@example.com', emailVerified: true }),
  false
);

// 7. No email at all → denied
assert(
  'missing email is denied',
  isOwner({ emailVerified: true }),
  false
);

// 8. Null user → denied (unauthenticated)
assert(
  'null user is denied',
  isOwner(null),
  false
);

// 9. Empty OWNER_EMAIL env var → no one is owner
process.env.OWNER_EMAIL = '';
assert(
  'empty OWNER_EMAIL means no one is owner',
  isOwner({ email: 'owner@example.com', emailVerified: true }),
  false
);

// 10. Owner credits are conceptually null (owner skips deduction — tested via API)
//     Here we just confirm the helper returns true when configured correctly.
process.env.OWNER_EMAIL = 'owner@example.com';
assert(
  'owner confirmed for credit-deduction bypass check',
  isOwner({ email: 'owner@example.com', emailVerified: true }),
  true
);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
