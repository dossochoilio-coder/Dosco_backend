// ════════════════════════════════════════════════════════════════
// AUTHENTIFICATION SÉCURISÉE
// Hash de mot de passe avec scrypt (module natif crypto, sans dépendance).
// scrypt est résistant aux attaques GPU/ASIC — recommandé pour les mots de passe.
// ════════════════════════════════════════════════════════════════

import crypto from 'crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

// Hache un mot de passe : renvoie "salt:hash" (hex)
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
  });
  return salt.toString('hex') + ':' + hash.toString('hex');
}

// Vérifie un mot de passe en temps constant (anti timing-attack)
export function verifyPassword(password, stored) {
  try {
    const [saltHex, hashHex] = stored.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
    });
    // timingSafeEqual exige des buffers de même longueur
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}

// Validation basique d'un pseudo
export function validateName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed.length >= 2 && trimmed.length <= 14 && /^[\w\-À-ÿ ]+$/.test(trimmed);
}

// Validation basique d'un mot de passe
export function validatePassword(pw) {
  return typeof pw === 'string' && pw.length >= 6 && pw.length <= 128;
}

