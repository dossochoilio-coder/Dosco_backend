// ════════════════════════════════════════════════════════════════
// COUCHE DE PERSISTANCE
// Utilise PostgreSQL si DATABASE_URL est défini (production),
// sinon un stockage fichier JSON (développement / petits déploiements).
// Le serveur survit ainsi aux redémarrages dans tous les cas.
// ════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';

let DATA_DIR = process.env.DATA_DIR || './data';
const USE_PG = !!process.env.DATABASE_URL;

let pgPool = null;

// ── Initialisation ──
export async function initStorage() {
  DATA_DIR = process.env.DATA_DIR || './data'; // (re)lecture au démarrage
  if (USE_PG) {
    try {
      const pg = await import('pg');
      pgPool = new pg.default.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
      });
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS users (
          uid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          pass_hash TEXT,
          stars INTEGER DEFAULT 100,
          rank TEXT DEFAULT 'Naine Blanche',
          wins INTEGER DEFAULT 0,
          losses INTEGER DEFAULT 0,
          has_pass BOOLEAN DEFAULT FALSE,
          data JSONB DEFAULT '{}',
          created_at BIGINT
        );
        CREATE TABLE IF NOT EXISTS progress (
          uid TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
          season JSONB,
          inventory JSONB,
          updated_at BIGINT
        );
        CREATE TABLE IF NOT EXISTS receipts (
          id TEXT PRIMARY KEY,
          uid TEXT,
          product_id TEXT,
          ts BIGINT
        );
      `);
      console.log('[storage] PostgreSQL connecté et schéma prêt');
      return;
    } catch (e) {
      console.error('[storage] Échec PostgreSQL, repli sur fichier:', e.message);
      pgPool = null;
    }
  }
  // Repli fichier
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('[storage] Stockage fichier JSON dans', DATA_DIR);
}

// ── Helpers fichier ──
function fileLoad(name) {
  try {
    const p = path.join(DATA_DIR, name + '.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return {}; }
}
function fileSave(name, obj) {
  try {
    const p = path.join(DATA_DIR, name + '.json');
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, p); // écriture atomique
  } catch (e) { console.error('[storage] save error', name, e.message); }
}

// ════════════════════════════════════════════
// API utilisateurs
// ════════════════════════════════════════════
export async function getUser(uid) {
  if (pgPool) {
    const r = await pgPool.query('SELECT * FROM users WHERE uid=$1', [uid]);
    if (!r.rows[0]) return null;
    const u = r.rows[0];
    return { uid:u.uid, name:u.name, passHash:u.pass_hash, stars:u.stars, rank:u.rank,
             wins:u.wins, losses:u.losses, hasPass:u.has_pass, ...u.data, createdAt:Number(u.created_at) };
  }
  const users = fileLoad('users');
  return users[uid] || null;
}

export async function getUserByName(name) {
  if (pgPool) {
    const r = await pgPool.query('SELECT * FROM users WHERE name=$1', [name]);
    if (!r.rows[0]) return null;
    return getUser(r.rows[0].uid);
  }
  const users = fileLoad('users');
  return Object.values(users).find(u => u.name === name) || null;
}

export async function saveUser(user) {
  if (pgPool) {
    await pgPool.query(`
      INSERT INTO users (uid,name,pass_hash,stars,rank,wins,losses,has_pass,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (uid) DO UPDATE SET
        name=$2, pass_hash=$3, stars=$4, rank=$5, wins=$6, losses=$7, has_pass=$8
    `, [user.uid, user.name, user.passHash||null, user.stars||100, user.rank||'Naine Blanche',
        user.wins||0, user.losses||0, !!user.hasPass, user.createdAt||Date.now()]);
    return user;
  }
  const users = fileLoad('users');
  users[user.uid] = user;
  fileSave('users', users);
  return user;
}

export async function deleteUser(uid) {
  if (pgPool) { await pgPool.query('DELETE FROM users WHERE uid=$1', [uid]); return; }
  const users = fileLoad('users');
  delete users[uid];
  fileSave('users', users);
  const prog = fileLoad('progress');
  delete prog[uid];
  fileSave('progress', prog);
}

// ════════════════════════════════════════════
// API progression (sync cloud)
// ════════════════════════════════════════════
export async function getProgress(uid) {
  if (pgPool) {
    const r = await pgPool.query('SELECT * FROM progress WHERE uid=$1', [uid]);
    if (!r.rows[0]) return null;
    return { season:r.rows[0].season, inventory:r.rows[0].inventory, ts:Number(r.rows[0].updated_at) };
  }
  const prog = fileLoad('progress');
  return prog[uid] || null;
}

export async function saveProgress(uid, season, inventory) {
  const ts = Date.now();
  if (pgPool) {
    await pgPool.query(`
      INSERT INTO progress (uid,season,inventory,updated_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT (uid) DO UPDATE SET season=$2, inventory=$3, updated_at=$4
    `, [uid, season, inventory, ts]);
    return;
  }
  const prog = fileLoad('progress');
  prog[uid] = { season, inventory, ts };
  fileSave('progress', prog);
}

// ════════════════════════════════════════════
// API reçus IAP (anti-rejeu)
// ════════════════════════════════════════════
export async function receiptExists(id) {
  if (pgPool) {
    const r = await pgPool.query('SELECT 1 FROM receipts WHERE id=$1', [id]);
    return r.rows.length > 0;
  }
  const receipts = fileLoad('receipts');
  return !!receipts[id];
}

export async function saveReceipt(id, uid, productId) {
  if (pgPool) {
    await pgPool.query('INSERT INTO receipts (id,uid,product_id,ts) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [id, uid, productId, Date.now()]);
    return;
  }
  const receipts = fileLoad('receipts');
  receipts[id] = { uid, productId, ts: Date.now() };
  fileSave('receipts', receipts);
}

export function storageBackend() {
  return pgPool ? 'postgresql' : 'file';
}

