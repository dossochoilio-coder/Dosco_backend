// ════════════════════════════════════════════════════════════════
// SERVEUR DOSCO — Multijoueur temps réel + IAP
// WebSocket pour le jeu, HTTP/REST pour l'auth et les achats
// ════════════════════════════════════════════════════════════════
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import jwt from 'jsonwebtoken';
import { INIT_BOARD, isLegalMove, applyMove, checkEnd, getAllCaptures } from './game-engine.js';
import { processPurchase } from './iap-validation.js';
import {
  initStorage, getUser, getUserByName, saveUser, deleteUser,
  getProgress, saveProgress, receiptExists, saveReceipt, storageBackend,
  getAllRegisteredUsers, addTournamentSignup, getTournamentSignups, isSignedUp,
} from './storage.js';
import { hashPassword, verifyPassword, validateName, validatePassword } from './auth.js';
import { rateLimit } from './rate-limit.js';

// (Web Push retiré — notifications in-app via WebSocket)

// ════════════════════════════════════════════
// VERSIONS DE L'APPLICATION (mise à jour automatique)
// ════════════════════════════════════════════
// Quand tu publies une nouvelle version sur Google Play, mets à jour ces valeurs
// et redéploie le backend. Les apps plus anciennes détecteront la MAJ.
const APP_VERSION_INFO = {
  latest: "1.0.0",      // dernière version publiée sur le Store
  minimum: "1.0.0",     // version minimale acceptée (en dessous = MAJ obligatoire)
  androidPackage: "com.dosco.bataille.etoiles",
  storeUrl: "https://play.google.com/store/apps/details?id=com.dosco.bataille.etoiles",
  // Message optionnel affiché à l'utilisateur (null = message par défaut côté client)
  message: null
};

// Compare deux versions "x.y.z". Retourne -1, 0 ou 1.
function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// Évalue l'état de mise à jour pour une version cliente donnée.
function evaluateUpdate(clientVersion) {
  const cv = clientVersion || "0.0.0";
  const outdated = compareVersions(cv, APP_VERSION_INFO.latest) < 0;
  const mandatory = compareVersions(cv, APP_VERSION_INFO.minimum) < 0;
  return {
    current: cv,
    latest: APP_VERSION_INFO.latest,
    updateAvailable: outdated,
    mandatory: mandatory,
    storeUrl: APP_VERSION_INFO.storeUrl,
    message: APP_VERSION_INFO.message
  };
}


// Galaxies = arènes de mise (source de vérité serveur, anti-triche)
const GALAXIES = {
  voie_lactee: { stake: 10 },
  andromede:   { stake: 50 },
  sombrero:    { stake: 150 },
  tourbillon:  { stake: 500 },
  cigare:      { stake: 1500 },
};

const JWT_SECRET = process.env.JWT_SECRET || "dosco_dev_secret_CHANGE_IN_PROD";
const PORT = process.env.PORT || 8080;

if (JWT_SECRET === "dosco_dev_secret_CHANGE_IN_PROD") {
  console.warn('⚠️ JWT_SECRET non défini — utilisez un secret fort en production !');
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.set('trust proxy', 1);

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Cache mémoire
const userCache = new Map();

async function loadUser(uid) {
  if (userCache.has(uid)) return userCache.get(uid);
  const u = await getUser(uid);
  if (u) userCache.set(uid, u);
  return u;
}

async function persistUser(user) {
  userCache.set(user.uid, user);
  await saveUser(user);
}

// ════════════════════════════════════════════
// REST API
// ════════════════════════════════════════════

app.post('/api/register', rateLimit(10, 60000, 'register'), async (req, res) => {
  try {
    const { name, password, country } = req.body || {};
    if (!validateName(name)) return res.status(400).json({ error: "Pseudo invalide (2-14 caractères)" });
    if (!validatePassword(password)) return res.status(400).json({ error: "Mot de passe invalide (min. 6 caractères)" });
    if (await getUserByName(name.trim())) return res.status(409).json({ error: "Ce pseudo est déjà pris" });

    const uid = "usr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const safeCountry = (typeof country === "string" && /^[A-Z]{2}$/.test(country)) ? country : "XX";
    const user = {
      uid,
      name: name.trim(),
      passHash: hashPassword(password),
      country: safeCountry,
      stars: 100,
      rank: "Naine Blanche",
      wins: 0,
      losses: 0,
      draws: 0,
      hasPass: false,
      createdAt: Date.now()
    };
    await persistUser(user);

    const token = jwt.sign({ uid }, JWT_SECRET, { expiresIn: '30d' });
    const { passHash, ...safe } = user;
    res.json({ token, user: safe });
  } catch (e) {
    console.error('register', e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post('/api/login', rateLimit(10, 60000, 'login'), async (req, res) => {
  try {
    const { name, password } = req.body || {};
    if (!name || !password) return res.status(400).json({ error: "Pseudo et mot de passe requis" });

    const user = await getUserByName(name.trim());
    if (!user || !user.passHash || !verifyPassword(password, user.passHash)) {
      return res.status(401).json({ error: "Identifiants incorrects" });
    }

    userCache.set(user.uid, user);
    const token = jwt.sign({ uid: user.uid }, JWT_SECRET, { expiresIn: '30d' });
    const { passHash, ...safe } = user;
    res.json({ token, user: safe });
  } catch (e) {
    console.error('login', e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post('/api/guest', rateLimit(20, 60000, 'guest'), async (req, res) => {
  try {
    const { name, stars } = req.body || {};
    const uid = "gst_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    // Accepter les étoiles locales du client pour les invités (synchronisation)
    const initialStars = (typeof stars === "number" && stars >= 0) ? Math.min(stars, 999999) : 100;
    const user = {
      uid,
      name: (validateName(name) ? name.trim() : "Invité"),
      stars: initialStars,
      rank: "Naine Blanche",
      wins: 0,
      losses: 0,
      draws: 0,
      hasPass: false,
      guest: true,
      createdAt: Date.now()
    };
    await persistUser(user);

    const token = jwt.sign({ uid }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

async function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: "Non authentifié" });
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    const user = await loadUser(uid);
    if (!user) return res.status(401).json({ error: "Utilisateur introuvable" });
    req.user = user;
    req.uid = uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Token invalide" });
  }
}

// Validation d'un achat Google Play (anti-fraude : vérifie le reçu auprès de Google)
// Nécessite les identifiants d'un compte de service Google Play configurés en variables d'env.
app.post('/api/iap/google/validate', auth, rateLimit(30, 60000, 'iap_google'), async (req, res) => {
  try {
    const { productId, productType, purchaseToken } = req.body || {};
    if (!productId || !purchaseToken) {
      return res.status(400).json({ valid: false, error: "Paramètres manquants" });
    }
    // Si la vérification Google n'est pas configurée, on accepte sans bloquer
    // (l'achat a déjà été payé côté Google Play ; on évite juste de bloquer l'utilisateur)
    const pkg = process.env.ANDROID_PACKAGE_NAME || 'com.dosco.batailledesetoiles';
    const saJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (!saJson) {
      console.log('[iap] Validation Google Play non configurée (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON absent) — achat accepté sans vérif');
      return res.json({ valid: true, unverified: true });
    }
    // Vérification réelle auprès de l'API Google Play Developer
    try {
      const { google } = await import('googleapis');
      const creds = JSON.parse(saJson);
      const authClient = new google.auth.JWT(
        creds.client_email, null, creds.private_key,
        ['https://www.googleapis.com/auth/androidpublisher']
      );
      const publisher = google.androidpublisher({ version: 'v3', auth: authClient });
      let result;
      if (productType === 'subs') {
        result = await publisher.purchases.subscriptions.get({
          packageName: pkg, subscriptionId: productId, token: purchaseToken
        });
        const valid = result.data && (result.data.paymentState === 1 || result.data.paymentState === 2);
        return res.json({ valid: !!valid, data: { expiryTimeMillis: result.data.expiryTimeMillis } });
      } else {
        result = await publisher.purchases.products.get({
          packageName: pkg, productId: productId, token: purchaseToken
        });
        // purchaseState 0 = acheté
        const valid = result.data && result.data.purchaseState === 0;
        return res.json({ valid: !!valid });
      }
    } catch (e) {
      console.error('[iap] Erreur validation Google:', e.message);
      // Ne pas bloquer un achat déjà payé si l'API échoue temporairement
      return res.json({ valid: true, unverified: true, note: e.message });
    }
  } catch (e) {
    return res.status(500).json({ valid: false, error: "Erreur serveur" });
  }
});

app.post('/api/iap/validate', auth, rateLimit(30, 60000, 'iap'), async (req, res) => {
  try {
    const receiptId = req.body?.receiptId || req.body?.transactionId;
    if (receiptId && await receiptExists(receiptId)) {
      return res.status(409).json({ success: false, error: "Reçu déjà utilisé" });
    }
    const result = await processPurchase({ ...req.body, userId: req.user.uid });
    if (result.success) {
      req.user.stars += result.starsGranted;
      if (result.isNonConsumable) req.user.hasPass = true;
      await persistUser(req.user);
      if (receiptId) await saveReceipt(receiptId, req.user.uid, req.body?.productId);
    }
    res.json(result);
  } catch (e) {
    console.error('iap', e);
    res.status(500).json({ success: false, error: "Erreur de validation" });
  }
});

app.post('/api/iap/restore', auth, (req, res) => {
  res.json({ success: true, hasPass: !!req.user.hasPass, stars: req.user.stars });
});

app.get('/api/me', auth, (req, res) => {
  const { passHash, ...safe } = req.user;
  res.json({ user: safe });
});

app.delete('/api/me', auth, async (req, res) => {
  await deleteUser(req.user.uid);
  userCache.delete(req.user.uid);
  res.json({ success: true });
});

app.post('/api/sync/push', auth, rateLimit(60, 60000, 'sync'), async (req, res) => {
  try {
    const { season, inventory } = req.body || {};
    const existing = await getProgress(req.user.uid);
    let mergedSeason = season;

    if (existing && existing.season) {
      mergedSeason = {
        ...season,
        stars: Math.max(existing.season.stars || 0, season?.stars || 0),
        lifetimeStars: Math.max(existing.season.lifetimeStars || 0, season?.lifetimeStars || 0),
        wins: Math.max(existing.season.wins || 0, season?.wins || 0),
        bestStreak: Math.max(existing.season.bestStreak || 0, season?.bestStreak || 0)
      };
    }
    await saveProgress(req.user.uid, mergedSeason, inventory);
    // Synchroniser les étoiles ET le pays vers la table users (pour le classement)
    try {
      const u = await loadUser(req.user.uid);
      if (u) {
        let changed = false;
        const newStars = mergedSeason && typeof mergedSeason.stars === "number" ? mergedSeason.stars : null;
        if (newStars !== null && newStars !== u.stars) { u.stars = newStars; changed = true; }
        if (mergedSeason && typeof mergedSeason.wins === "number" && mergedSeason.wins > (u.wins||0)) { u.wins = mergedSeason.wins; changed = true; }
        if (mergedSeason && typeof mergedSeason.losses === "number" && mergedSeason.losses > (u.losses||0)) { u.losses = mergedSeason.losses; changed = true; }
        if (mergedSeason && typeof mergedSeason.country === "string" && /^[A-Z]{2}$/.test(mergedSeason.country) && (!u.country || u.country === "XX")) { u.country = mergedSeason.country; changed = true; }
        if (changed) await persistUser(u);
      }
    } catch (e) { /* le classement se mettra à jour au prochain sync */ }
    res.json({ success: true, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ error: "Erreur de synchronisation" });
  }
});

app.get('/api/sync/pull', auth, async (req, res) => {
  const data = await getProgress(req.user.uid);
  if (!data) return res.json({ season: null, inventory: null });
  res.json(data);
});

// ── OAuth Google ──
// Vérifie le credential JWT Google via l'API tokeninfo de Google
app.post('/api/oauth/google', rateLimit(20, 60000, 'oauth'), async (req, res) => {
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: "Token manquant" });

    // Vérifier le token via l'API Google
    const gRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!gRes.ok) return res.status(401).json({ error: "Token Google invalide" });
    const payload = await gRes.json();

    if (!payload.sub) return res.status(401).json({ error: "Token invalide" });
    // SÉCURITÉ : vérifier que le token a bien été émis POUR notre application
    if (GOOGLE_CLIENT_IDS.length && !GOOGLE_CLIENT_IDS.includes(payload.aud)) {
      return res.status(401).json({ error: "Token non destiné à cette application" });
    }

    const googleId = "google_" + payload.sub;
    const email = payload.email || (payload.sub + "@google.dosco");
    const displayName = (payload.name || payload.email || "JOUEUR").toUpperCase().slice(0, 14);

    // Chercher ou créer le compte
    let user = await getUserByName(googleId);
    if (!user) {
      // Nouveau compte Google
      const uid = "ggl_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      user = {
        uid,
        name: displayName,
        googleId,
        email,
        stars: 100,
        rank: "Naine Blanche",
        wins: 0, losses: 0, draws: 0,
        hasPass: false,
        provider: "google",
        oauth: "google",
        createdAt: Date.now()
      };
      await persistUser(user);
      // Stocker l'index googleId → uid
      await saveUser({ uid: googleId, _ref: uid });
    } else if (user._ref) {
      user = await loadUser(user._ref);
    }

    const token = jwt.sign({ uid: user.uid }, JWT_SECRET, { expiresIn: '30d' });
    const { passHash, ...safe } = user;
    res.json({ token, user: safe });
  } catch(e) {
    console.error('oauth/google', e);
    res.status(500).json({ error: "Erreur serveur OAuth" });
  }
});

// ── OAuth Facebook ──
app.post('/api/oauth/facebook', rateLimit(20, 60000, 'oauth'), async (req, res) => {
  try {
    const { accessToken, userId } = req.body || {};
    if (!accessToken || !userId) return res.status(400).json({ error: "Token manquant" });

    // Vérifier via l'API Graph de Facebook
    const fbRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${accessToken}`);
    if (!fbRes.ok) return res.status(401).json({ error: "Token Facebook invalide" });
    const profile = await fbRes.json();

    if (profile.id !== userId) return res.status(401).json({ error: "ID Facebook invalide" });

    const fbId = "fb_" + profile.id;
    const email = profile.email || (profile.id + "@fb.dosco");
    const displayName = (profile.name || "JOUEUR FACEBOOK").toUpperCase().slice(0, 14);

    let user = await getUserByName(fbId);
    if (!user) {
      const uid = "fb_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      user = {
        uid,
        name: displayName,
        fbId,
        email,
        stars: 100,
        rank: "Naine Blanche",
        wins: 0, losses: 0, draws: 0,
        hasPass: false,
        provider: "facebook",
        createdAt: Date.now()
      };
      await persistUser(user);
      await saveUser({ uid: fbId, _ref: uid });
    } else if (user._ref) {
      user = await loadUser(user._ref);
    }

    const token = jwt.sign({ uid: user.uid }, JWT_SECRET, { expiresIn: '30d' });
    const { passHash, ...safe } = user;
    res.json({ token, user: safe });
  } catch(e) {
    console.error('oauth/facebook', e);
    res.status(500).json({ error: "Erreur serveur OAuth" });
  }
});

// Endpoint public de version : l'app interroge pour savoir si une MAJ existe.
// Usage : GET /api/version?v=1.0.0  (v = version actuelle de l'app)
app.get('/api/version', (req, res) => {
  const clientVersion = (typeof req.query.v === "string") ? req.query.v : "0.0.0";
  res.json(evaluateUpdate(clientVersion));
});

app.get('/health', (req, res) => res.json({
  status: "ok",
  backend: storageBackend(),
  players: wss?.clients?.size || 0,
  games: games.size,
  queue: waitingQueue.length
}));

const server = createServer(app);

// ════════════════════════════════════════════
// WEBSOCKET — Multijoueur temps réel
// ════════════════════════════════════════════

const wss = new WebSocketServer({ server });

// Heartbeat : fermer les connexions mortes toutes les 30s
const HEARTBEAT_INTERVAL = 30000;
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch(e) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch(e) { ws.isAlive = false; }
  });
}, HEARTBEAT_INTERVAL);

wss.on('connection', function onConn(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

const waitingQueue = [];
const games = new Map();
const playerSockets = new Map();
// Parties terminées gardées en cache 5 min pour permettre la revanche
const endedGames = new Map();
// Buffer : game_end en attente de livraison (si le client se reconnecte)
const pendingGameEnds = new Map(); // uid -> {endData, ts}
// Revanches en attente : si l'adversaire est offline, la demande est mise en buffer
const pendingRematches = new Map(); // oppUid -> { gameId, fromUid, fromName, ts }
function cacheEndedGame(game) {
  endedGames.set(game.id, { ...game });
  setTimeout(() => endedGames.delete(game.id), 5 * 60 * 1000);
}
function getGameOrEnded(gameId) {
  return games.get(gameId) || endedGames.get(gameId);
}

function send(ws, type, data) {
  if (ws && ws.readyState === 1) {
    // IMPORTANT : type APRÈS le spread pour qu'il ne soit JAMAIS écrasé par data.type
    // (game_end contient data.type="draw"/"forfeit" qui écrasait le type du message)
    ws.send(JSON.stringify({ ...data, type }));
    return true;
  }
}

function createGame(p1, p2) {
  const gameId = "game_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  const game = {
    id: gameId,
    board: JSON.parse(JSON.stringify(INIT_BOARD)),
    turn: "B",
    players: { B: p1.uid, W: p2.uid },
    names: { B: p1.name, W: p2.name },
    titles: { B: p1.title || null, W: p2.title || null },
    skins: { B: p1.skin || null, W: p2.skin || null },
    stake: p1.stake || 0,
    galaxy: p1.galaxy || "voie_lactee",
    msc: 0,
    moveCount: 0,
    lastMove: null,
    startedAt: Date.now(),
    timeB: 300,          // temps restant Bleus (secondes) — autorité serveur
    timeW: 300,          // temps restant Blancs (secondes)
    turnStartedAt: Date.now(), // horodatage du début du tour courant
  };
  games.set(gameId, game);
  p1.gameId = gameId;
  p2.gameId = gameId;

  console.log(`[game_start] ${gameId} | B="${p1.name}" (titre:${p1.title||"—"}) vs W="${p2.name}" (titre:${p2.title||"—"})`);
  send(p1.ws, "game_start", {
    gameId, color: "B", opponent: p2.name, opponentTitle: p2.title || null, opponentSkin: p2.skin || null,
    board: game.board, turn: "B", stake: game.stake, galaxy: game.galaxy,
    timeB: game.timeB, timeW: game.timeW, serverNow: Date.now()
  });
  send(p2.ws, "game_start", {
    gameId, color: "W", opponent: p1.name, opponentTitle: p1.title || null, opponentSkin: p1.skin || null,
    board: game.board, turn: "B", stake: game.stake, galaxy: game.galaxy,
    timeB: game.timeB, timeW: game.timeW, serverNow: Date.now()
  });
  return game;
}

function handleMove(ws, uid, { gameId, from, to }) {
  const game = games.get(gameId);
  if (!game) return send(ws, "error", { msg: "Partie introuvable" });

  const color = game.players.B === uid ? "B" : (game.players.W === uid ? "W" : null);
  if (!color) return send(ws, "error", { msg: "Vous n'êtes pas dans cette partie" });
  if (game.turn !== color) return send(ws, "error", { msg: "Pas votre tour" });

  if (!isLegalMove(game.board, from, to, color)) {
    return send(ws, "error", { msg: "Coup illégal", board: game.board, turn: game.turn });
  }

  const { board, isCapture } = applyMove(game.board, from, to);
  game.board = board;
  game.msc = isCapture ? 0 : game.msc + 1;
  game.lastMove = to;
  game.moveCount++;

  // ── CHRONO AUTORITAIRE SERVEUR ──
  // Décompter le temps réellement consommé par le joueur qui vient de jouer.
  const nowTs = Date.now();
  const elapsedSec = Math.max(0, Math.round((nowTs - game.turnStartedAt) / 1000));
  if (color === "B") game.timeB = Math.max(0, game.timeB - elapsedSec);
  else game.timeW = Math.max(0, game.timeW - elapsedSec);
  game.turnStartedAt = nowTs; // le tour de l'adversaire commence maintenant

  const end = checkEnd(game.board, to, color, game.msc);
  const nextTurn = color === "B" ? "W" : "B";
  game.turn = nextTurn;

  const p1ws = playerSockets.get(game.players.B);
  const p2ws = playerSockets.get(game.players.W);

  const moveData = { gameId, from, to, isCapture, board: game.board, turn: nextTurn, by: color,
    timeB: game.timeB, timeW: game.timeW, serverNow: nowTs };
  if (p1ws) send(p1ws, "move", moveData);
  if (p2ws) send(p2ws, "move", moveData);

  if (end) {
    settleStakes(game, end.winner).catch(e => console.error('settle', e));
    const endData = { gameId, winner: end.winner, endType: end.type, reason: end.reason || null, stake: game.stake };
    if (p1ws) send(p1ws, "game_end", endData);
    if (p2ws) send(p2ws, "game_end", endData);
    cacheEndedGame(game);
    games.delete(gameId);
  }
}

// ID de semaine ISO (identique au client) pour le tournoi hebdomadaire
function isoWeekId() {
  const d = new Date();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const fdNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdNr + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  return target.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

async function settleStakes(game, winnerColor) {
  if (!winnerColor) return;

  const loserColor = winnerColor === "B" ? "W" : "B";
  const winner = await loadUser(game.players[winnerColor]);
  const loser = await loadUser(game.players[loserColor]);

  if (winner && loser) {
    // Mise (uniquement si > 0)
    if (game.stake > 0) {
      winner.stars += game.stake;
      loser.stars = Math.max(0, loser.stars - game.stake);
    }
    // Statistiques TOUJOURS comptées (pour le classement par % de victoires)
    winner.wins = (winner.wins || 0) + 1;
    loser.losses = (loser.losses || 0) + 1;
    await persistUser(winner);
    await persistUser(loser);
  }
}

// Match nul : restitution des mises + comptage des nulles (toujours)
async function settleDrawStakes(game) {
  const p1 = await loadUser(game.players.B);
  const p2 = await loadUser(game.players.W);

  if (p1 && p2) {
    p1.draws = (p1.draws || 0) + 1;
    p2.draws = (p2.draws || 0) + 1;
    await persistUser(p1);
    await persistUser(p2);
  }
}

wss.on('connection', (ws) => {
  let uid = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      case "auth": {
        try {
          const decoded = jwt.verify(msg.token, JWT_SECRET);
          uid = decoded.uid;
          // Fermer proprement un ancien socket pour le même uid (évite les sockets fantômes)
          const oldWs = playerSockets.get(uid);
          if (oldWs && oldWs !== ws && oldWs.readyState === 1) {
            try { oldWs.close(4001, "reconnect"); } catch(e) {}
          }
          playerSockets.set(uid, ws);
          ws.uid = uid;
          send(ws, "authed", { uid, version: evaluateUpdate(msg.appVersion || "0.0.0") });
          // Livrer un game_end en attente (si le client s'était déconnecté avant de le recevoir)
          const pendingEnd = pendingGameEnds.get(uid);
          if (pendingEnd && (Date.now() - pendingEnd.ts) < 5 * 60 * 1000) {
            send(ws, "game_end", pendingEnd.endData);
            pendingGameEnds.delete(uid);
          }
          // Envoyer les revanches en attente
          const pending = pendingRematches.get(uid);
          if (pending && (Date.now() - pending.ts) < 2 * 60 * 1000) {
            send(ws, "rematch_offered", { gameId: pending.gameId, from: pending.fromUid, fromName: pending.fromName });
            pendingRematches.delete(uid);
          }
          // ── RESTAURATION DE PARTIE ACTIVE ──
          // Si le joueur est encore dans une partie en cours (reconnexion après coupure),
          // lui renvoyer l'état complet pour qu'il reprenne là où il en était (évite l'écran figé).
          for (const [gid, g] of games) {
            if (g.players.B === uid || g.players.W === uid) {
              const myColor = g.players.B === uid ? "B" : "W";
              const oppColor = myColor === "B" ? "W" : "B";
              const nowTs = Date.now();
              // Lever la pause : le chrono du joueur actif redémarre maintenant.
              // (le temps consommé avant la coupure a déjà été retiré au moment de la pause)
              if (g.pausedFor) {
                g.pausedFor = null;
                g.pausedAt = null;
                g.turnStartedAt = nowTs; // redémarrer le décompte du tour courant à la reprise
              }
              const tB = g.timeB, tW = g.timeW;
              // Prévenir l'adversaire que le joueur est revenu
              const oppWsR = playerSockets.get(g.players[oppColor]);
              if (oppWsR) send(oppWsR, "opponent_reconnected", { gameId: gid });
              console.log(`[game_resume] ${gid} | ${uid} reprend la partie (couleur ${myColor})`);
              send(ws, "game_resume", {
                gameId: gid,
                color: myColor,
                opponent: g.names[oppColor],
                opponentTitle: g.titles ? g.titles[oppColor] : null,
                opponentSkin: g.skins ? g.skins[oppColor] : null,
                board: g.board,
                turn: g.turn,
                stake: g.stake,
                galaxy: g.galaxy,
                lastMove: g.lastMove,
                timeB: tB,
                timeW: tW,
                serverNow: nowTs
              });
              break;
            }
          }
        } catch (e) {
          send(ws, "error", { msg: "Auth WS échouée" });
        }
        break;
      }

      case "find_match": {
        if (!uid) return send(ws, "error", { msg: "Authentifiez-vous d'abord" });
        const user = await loadUser(uid);
        if (!user) return;

        const galaxyId = msg.galaxy || "voie_lactee";
        const galaxy = GALAXIES[galaxyId];
        if (!galaxy) return send(ws, "error", { msg: "Galaxie inconnue" });

        const stake = galaxy.stake;
        // Pour les invités : accepter aussi les étoiles déclarées par le client
        // (le client a pu gagner des étoiles en local que le serveur ne connaît pas encore)
        const clientStars = (typeof msg.stars === "number" && msg.stars >= 0) ? msg.stars : 0;
        const effectiveStars = user.guest ? Math.max(user.stars, clientStars) : user.stars;
        if (effectiveStars < stake) {
          return send(ws, "error", { msg: "Étoiles insuffisantes pour cette galaxie", need: stake, have: effectiveStars });
        }
        // Synchroniser le solde serveur si le client en déclare plus
        if (user.guest && clientStars > user.stars) {
          user.stars = clientStars;
          await persistUser(user);
        }

        const playerTitle = (typeof msg.title === "string" && msg.title.length <= 40) ? msg.title : null;
        const playerSkin = (typeof msg.skin === "string" && msg.skin.length <= 40) ? msg.skin : null;
        // Nom prioritaire : celui envoyé par le client (vrai pseudo), sinon celui en base.
        // Évite le nom générique "Joueur" et garde la base à jour.
        const clientName = (typeof msg.name === "string" && msg.name.trim().length >= 2 && msg.name.trim().length <= 20) ? msg.name.trim() : null;
        const effectiveName = clientName || user.name || "Joueur";
        const clientCountry = (typeof msg.country === "string" && /^[A-Z]{2}$/.test(msg.country)) ? msg.country : null;
        let userChanged = false;
        if (clientName && clientName !== user.name) { user.name = clientName; userChanged = true; }
        // Renseigner le pays s'il est absent/inconnu en base (permet le classement national)
        if (clientCountry && (!user.country || user.country === "XX")) { user.country = clientCountry; userChanged = true; }
        if (userChanged) persistUser(user).catch(() => {});
        const me = { uid, name: effectiveName, title: playerTitle, skin: playerSkin, ws, stake, galaxy: galaxyId };
        const idx = waitingQueue.findIndex(p => p.uid !== uid && p.galaxy === galaxyId);

        if (idx >= 0) {
          const opponent = waitingQueue.splice(idx, 1)[0];
          createGame(opponent, me);
        } else {
          waitingQueue.push(me);
          send(ws, "searching", { stake, galaxy: galaxyId });
        }
        break;
      }

      case "move": {
        if (!uid) return;
        handleMove(ws, uid, msg);
        break;
      }

      case "cancel_search": {
        const i = waitingQueue.findIndex(p => p.uid === uid);
        if (i >= 0) waitingQueue.splice(i, 1);
        send(ws, "search_cancelled", {});
        break;
      }

      case "offer_draw": {
        if (!uid || !msg.gameId) return;
        const game = games.get(msg.gameId);
        if (!game) return;
        const color = game.players.B === uid ? "B" : (game.players.W === uid ? "W" : null);
        if (!color) return;

        const oppColor = color === "B" ? "W" : "B";
        const oppWs = playerSockets.get(game.players[oppColor]);
        if (oppWs) send(oppWs, "draw_offered", { gameId: msg.gameId, by: color });
        break;
      }

      case "draw_response": {
        if (!uid || !msg.gameId) return;
        const game = games.get(msg.gameId);
        if (!game) return;

        const p1ws = playerSockets.get(game.players.B);
        const p2ws = playerSockets.get(game.players.W);

        if (msg.accepted) {
          await settleDrawStakes(game);
          const endData = {
            gameId: msg.gameId,
            winner: null,
            endType: "draw",
            reason: "Match nul accepté — mises conservées",
            stake: game.stake
          };
          // Diagnostic détaillé : état des sockets des DEUX joueurs
          const s1 = p1ws ? send(p1ws, "game_end", endData) : false;
          const s2 = p2ws ? send(p2ws, "game_end", endData) : false;
          // Bufferiser pour livraison à la reconnexion (5 min)
          pendingGameEnds.set(game.players.B, { endData, ts: Date.now() });
          pendingGameEnds.set(game.players.W, { endData, ts: Date.now() });
          cacheEndedGame(game);
          games.delete(msg.gameId);
        } else {
          const color = game.players.B === uid ? "B" : "W";
          const offererColor = color === "B" ? "W" : "B";
          const offererWs = playerSockets.get(game.players[offererColor]);
          if (offererWs) send(offererWs, "draw_declined", { gameId: msg.gameId });
        }
        break;
      }

      case "resign": {
        if (!uid || !msg.gameId) return;
        const game = games.get(msg.gameId);
        if (!game) return; // partie déjà terminée

        const color = game.players.B === uid ? "B" : "W";
        const winner = color === "B" ? "W" : "B";
        settleStakes(game, winner).catch(e => console.error('settle', e));

        const p1ws = playerSockets.get(game.players.B);
        const p2ws = playerSockets.get(game.players.W);
        const endData = { gameId: msg.gameId, winner, endType: "forfeit", stake: game.stake };
        const s1 = p1ws ? send(p1ws, "game_end", endData) : false;
        const s2 = p2ws ? send(p2ws, "game_end", endData) : false;
        pendingGameEnds.set(game.players.B, { endData, ts: Date.now() });
        pendingGameEnds.set(game.players.W, { endData, ts: Date.now() });
        cacheEndedGame(game);
        games.delete(msg.gameId);
        break;
      }

      // ========== NOUVEAU : SYSTÈME DE REVANCHE ==========
      case "rematch_request": {
        if (!uid || !msg.gameId) return;
        const game = getGameOrEnded(msg.gameId);
        if (!game) return;

        const myColor = game.players.B === uid ? "B" : "W";
        const oppColor = myColor === "B" ? "W" : "B";
        const oppUid = game.players[oppColor];
        const oppWs = playerSockets.get(oppUid);
        const fromName = game.names[myColor];

        if (oppWs && oppWs.readyState === 1) {
          send(oppWs, "rematch_offered", {
            gameId: msg.gameId,
            from: uid,
            fromName
          });
        } else {
          // Adversaire temporairement déconnecté : stocker la demande 2 min
          pendingRematches.set(oppUid, { gameId: msg.gameId, fromUid: uid, fromName, ts: Date.now() });
          setTimeout(() => {
            const p = pendingRematches.get(oppUid);
            if (p && p.fromUid === uid) pendingRematches.delete(oppUid);
          }, 2 * 60 * 1000);
        }
        break;
      }

      case "rematch_response": {
        if (!uid || !msg.gameId || typeof msg.accepted !== "boolean") return;
        const game = getGameOrEnded(msg.gameId);
        if (!game) return;

        const oppColor = game.players.B === uid ? "W" : "B";
        const oppWs = playerSockets.get(game.players[oppColor]);

        if (msg.accepted && oppWs) {
          // Créer une nouvelle partie
          const newGame = createGame(
            {
              uid: game.players.B,
              name: game.names.B,
              title: game.titles ? game.titles.B : null,
              skin: game.skins ? game.skins.B : null,
              ws: playerSockets.get(game.players.B),
              stake: game.stake,
              galaxy: game.galaxy
            },
            {
              uid: game.players.W,
              name: game.names.W,
              title: game.titles ? game.titles.W : null,
              skin: game.skins ? game.skins.W : null,
              ws: playerSockets.get(game.players.W),
              stake: game.stake,
              galaxy: game.galaxy
            }
          );

          send(ws, "rematch_accepted", { newGameId: newGame.id });
          send(oppWs, "rematch_accepted", { newGameId: newGame.id });

          games.delete(msg.gameId);
        } else if (oppWs) {
          send(oppWs, "rematch_declined", { gameId: msg.gameId });
        }
        break;
      }

      case "ping": {
        send(ws, "pong", { ts: Date.now() });
        break;
      }

      case "get_leaderboard": {
        // Classement RÉEL : comptes enregistrés, min. 5 matchs, trié par % de victoires.
        // Renvoie le top 10 mondial + top 10 national + la position du joueur courant.
        try {
          const users = await getAllRegisteredUsers();
          // Construire la liste éligible (≥ 10 parties jouées)
          const eligible = users
            .map(u => {
              const total = (u.wins||0) + (u.losses||0) + (u.draws||0);
              const decisive = (u.wins||0) + (u.losses||0);
              const winPct = decisive > 0 ? Math.round((u.wins / decisive) * 100) : 0;
              return { id: u.uid, name: u.name, stars: u.stars||0, wins: u.wins||0, losses: u.losses||0,
                       draws: u.draws||0, total, winPct, country: u.country||'XX',
                       pts: winPct, score: winPct };
            })
            .filter(u => u.total >= 5);
          // DIAGNOSTIC : afficher les stats réelles utilisées pour le classement
          try {
            console.log(`[leaderboard] ${eligible.length} joueur(s) éligible(s) (≥5 parties):`,
              eligible.map(u => `${u.name}=${u.winPct}%(${u.wins}V/${u.losses}D,${u.total}pj)`).join(", "));
          } catch(e) {}

          // Tri : % de victoires décroissant, départage par nombre de victoires puis moins de défaites
          const sortFn = (a, b) => (b.winPct - a.winPct) || (b.wins - a.wins) || (a.losses - b.losses);

          // Classement MONDIAL
          const world = eligible.slice().sort(sortFn);
          const worldTop = world.slice(0, 10).map((u, i) => ({ ...u, rank: i + 1 }));

          // Récupérer le joueur courant et son pays
          const meUser = uid ? await loadUser(uid) : null;
          const myCountry = (meUser && meUser.country) || 'XX';

          // Position du joueur courant dans le classement mondial
          let myWorld = null;
          const myWorldIdx = world.findIndex(u => u.id === uid);
          if (myWorldIdx >= 0) {
            myWorld = { ...world[myWorldIdx], rank: myWorldIdx + 1 };
          }

          // Classement NATIONAL (même pays que le joueur courant)
          const national = eligible.filter(u => (u.country||'XX') === myCountry).sort(sortFn);
          const nationalTop = national.slice(0, 10).map((u, i) => ({ ...u, rank: i + 1 }));
          let myNational = null;
          const myNatIdx = national.findIndex(u => u.id === uid);
          if (myNatIdx >= 0) {
            myNational = { ...national[myNatIdx], rank: myNatIdx + 1 };
          }

          send(ws, "leaderboard", {
            players: worldTop,                 // compat : ancien champ = top mondial
            world: worldTop,
            national: nationalTop,
            myCountry: myCountry,
            me: {
              world: myWorld,                  // {rank, winPct, wins...} ou null si < 10 matchs
              national: myNational
            },
            totals: { world: world.length, national: national.length }
          });
        } catch (e) {
          console.error('get_leaderboard', e);
          send(ws, "leaderboard", { players: [], world: [], national: [], me: { world: null, national: null } });
        }
        break;
      }

      case "tournament_signup": {
        if (!uid) return;
        try {
          const u = await loadUser(uid);
          if (!u || u.guest) {
            return send(ws, "tournament_error", { msg: "Inscription réservée aux comptes enregistrés" });
          }
          const weekId = isoWeekId();
          await addTournamentSignup(weekId, u);
          const signups = await getTournamentSignups(weekId);
          send(ws, "tournament_state", { weekId, signups, joined: true });
        } catch (e) {
          console.error('tournament_signup', e);
        }
        break;
      }

      case "get_tournament": {
        try {
          const weekId = isoWeekId();
          const signups = await getTournamentSignups(weekId);
          const joined = uid ? await isSignedUp(weekId, uid) : false;
          send(ws, "tournament_state", { weekId, signups, joined });
        } catch (e) {
          console.error('get_tournament', e);
          send(ws, "tournament_state", { weekId: isoWeekId(), signups: [], joined: false });
        }
        break;
      }



      case "chat": {
        if (!uid || !msg.gameId || !msg.text) return;
        const game = games.get(msg.gameId);
        if (!game) return;

        const color = game.players.B === uid ? "B" : (game.players.W === uid ? "W" : null);
        if (!color) return;

        const oppColor = color === "B" ? "W" : "B";
        const oppWs = playerSockets.get(game.players[oppColor]);
        const text = String(msg.text).slice(0, 200);
        if (oppWs) send(oppWs, "chat", { gameId: msg.gameId, text, by: color });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (uid) {
      // Ne supprimer du playerSockets que si c'est encore CE socket (pas un reconnect)
      if (playerSockets.get(uid) === ws) {
        playerSockets.delete(uid);
      }
      const i = waitingQueue.findIndex(p => p.uid === uid);
      if (i >= 0) waitingQueue.splice(i, 1);

      const disconnectedUid = uid;

      // Si le joueur est dans une partie active : mettre EN PAUSE (geler son chrono)
      // et prévenir l'adversaire, plutôt que de déclarer forfait tout de suite.
      for (const [gid, game] of games) {
        if (game.players.B === disconnectedUid || game.players.W === disconnectedUid) {
          const dcColor = game.players.B === disconnectedUid ? "B" : "W";
          // Marquer la pause et figer le décompte : on retient le temps déjà consommé du tour courant
          if (!game.pausedFor) {
            game.pausedFor = dcColor;
            game.pausedAt = Date.now();
            // Si c'était au tour du joueur déconnecté, figer son chrono en retirant le temps déjà écoulé
            if (game.turn === dcColor) {
              const elapsed = Math.max(0, Math.round((Date.now() - game.turnStartedAt) / 1000));
              if (dcColor === "B") game.timeB = Math.max(0, game.timeB - elapsed);
              else game.timeW = Math.max(0, game.timeW - elapsed);
            }
          }
          const oppColor = dcColor === "B" ? "W" : "B";
          const oppWs = playerSockets.get(game.players[oppColor]);
          if (oppWs) send(oppWs, "opponent_disconnected", { gameId: gid, graceMs: 90000 });
          console.log(`[pause] ${gid} | ${disconnectedUid} (${dcColor}) déconnecté → partie en pause (90s)`);
        }
      }

      // DÉLAI DE GRÂCE ÉTENDU : 90s pour absorber les coupures 4G/mobiles.
      setTimeout(() => {
        const reconnected = playerSockets.has(disconnectedUid);
        if (reconnected) {
          return; // le joueur est revenu → game_resume déjà envoyé à l'auth
        }
        // Toujours absent après 90s → forfait légitime
        for (const [gid, game] of games) {
          if (game.players.B === disconnectedUid || game.players.W === disconnectedUid) {
            const winner = game.players.B === disconnectedUid ? "W" : "B";
            console.log(`[disconnect-forfait] ${gid} | ${disconnectedUid} absent 90s → victoire ${winner}`);
            settleStakes(game, winner).catch(e => console.error('settle', e));
            const endData = { gameId: gid, winner, endType: "disconnect", stake: game.stake };
            const oppWs = playerSockets.get(game.players[winner]);
            if (oppWs) send(oppWs, "game_end", endData);
            pendingGameEnds.set(game.players.B, { endData, ts: Date.now() });
            pendingGameEnds.set(game.players.W, { endData, ts: Date.now() });
            cacheEndedGame(game);
            games.delete(gid);
          }
        }
      }, 90000); // 90 secondes de grâce
    }
  });
});

// Démarrage
initStorage().then(() => {
  server.listen(PORT, () => {
    console.log(`🌌 DOSCO backend sur le port ${PORT}`);
    console.log(`✅ VERSION 2026-07-04-C : login serveur-first (compte survit à la réinstallation) + classement`);
    console.log(` Stockage: ${storageBackend()}`);
    console.log(` WebSocket: ws://localhost:${PORT}`);
    console.log(` REST API: http://localhost:${PORT}/api`);
  });
}).catch(e => {
  console.error('Échec du démarrage:', e);
  process.exit(1);
});
