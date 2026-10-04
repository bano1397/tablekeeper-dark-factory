'use strict';
// scrypt password hashing (node:crypto). Format: scrypt$N$r$p$<salt hex>$<hash hex>.
const crypto = require('node:crypto');

const N = 16384, R = 8, P = 1, KEYLEN = 32;
// Fixture users are hashed in bulk on reset, which must finish within 10 s even for
// large fixtures; they get a lower (still memory-hard) scrypt cost.
const SEED_HASH_COST = 4096;

function scrypt(password, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password, cost = N) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, cost, R, P);
  return `scrypt$${cost}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

function isHash(value) {
  return typeof value === 'string' && /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]{64}$/.test(value);
}

async function verifyPassword(password, stored) {
  if (!isHash(stored)) return false;
  const [, n, r, p, saltHex, keyHex] = stored.split('$');
  const expected = Buffer.from(keyHex, 'hex');
  try {
    const key = await scrypt(password, Buffer.from(saltHex, 'hex'), Number(n), Number(r), Number(p));
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, isHash, SEED_HASH_COST };
