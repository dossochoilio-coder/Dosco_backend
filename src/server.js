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
  saveBracket, loadBracket, loadAllBrackets,
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
  androidPackage: "com.dosco.batailledesetoiles",
  storeUrl: "https://play.google.com/store/apps/details?id=com.dosco.batailledesetoiles",
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
    const { name, password, country, secretQuestion, secretAnswer } = req.body || {};
    if (!validateName(name)) return res.status(400).json({ error: "Pseudo invalide : 2 à 14 caractères (lettres, chiffres, espace, point, tiret ou underscore)" });
    if (!validatePassword(password)) return res.status(400).json({ error: "Mot de passe invalide (min. 6 caractères)" });
    if (await getUserByName(name.trim())) return res.status(409).json({ error: "Ce pseudo est déjà pris" });

    const uid = "usr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const safeCountry = (typeof country === "string" && /^[A-Z]{2}$/.test(country)) ? country : "XX";
    // Question secrète (pour la récupération de mot de passe) : réponse hachée, jamais en clair
    const sQuestion = (typeof secretQuestion === "string" && secretQuestion.trim().length >= 1 && secretQuestion.trim().length <= 100) ? secretQuestion.trim() : null;
    const sAnswer = (typeof secretAnswer === "string" && secretAnswer.trim().length >= 2) ? secretAnswer.trim().toLowerCase() : null;
    const user = {
      uid,
      name: name.trim(),
      passHash: hashPassword(password),
      country: safeCountry,
      secretQuestion: sQuestion,
      secretAnswerHash: sAnswer ? hashPassword(sAnswer) : null,
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
    // Diagnostic précis (pour comprendre les échecs de connexion)
    if (!user) {
      console.log(`[login-debug] "${name.trim()}" → compte INTROUVABLE en base`);
      return res.status(401).json({ error: "Identifiants incorrects" });
    }
    if (!user.passHash) {
      console.log(`[login-debug] "${name.trim()}" (uid=${user.uid}) → TROUVÉ mais passHash VIDE en base`);
      return res.status(401).json({ error: "Identifiants incorrects" });
    }
    if (!verifyPassword(password, user.passHash)) {
      console.log(`[login-debug] "${name.trim()}" (uid=${user.uid}) → passHash présent mais MOT DE PASSE ne correspond pas`);
      return res.status(401).json({ error: "Identifiants incorrects" });
    }
    console.log(`[login-debug] "${name.trim()}" → connexion RÉUSSIE`);

    userCache.set(user.uid, user);
    const token = jwt.sign({ uid: user.uid }, JWT_SECRET, { expiresIn: '30d' });
    const { passHash, ...safe } = user;
    res.json({ token, user: safe });
  } catch (e) {
    console.error('login', e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── RÉCUPÉRATION DE MOT DE PASSE PAR QUESTION SECRÈTE ──

// 1) Récupérer la question secrète d'un compte (pour l'afficher au joueur)
app.post('/api/forgot/question', rateLimit(10, 60000, 'forgot-q'), async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "Pseudo requis" });
    const user = await getUserByName(name.trim());
    // Réponse volontairement neutre si le compte n'existe pas ou n'a pas de question
    // (évite de révéler quels pseudos existent)
    if (!user || !user.secretQuestion || !user.secretAnswerHash) {
      return res.status(404).json({ error: "Aucune question secrète pour ce compte. Récupération impossible." });
    }
    res.json({ question: user.secretQuestion });
  } catch (e) {
    console.error('forgot/question', e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// 2) Vérifier la réponse et définir un nouveau mot de passe
app.post('/api/forgot/reset', rateLimit(5, 60000, 'forgot-reset'), async (req, res) => {
  try {
    const { name, answer, newPassword } = req.body || {};
    if (!name || !answer || !newPassword) return res.status(400).json({ error: "Champs manquants" });
    if (!validatePassword(newPassword)) return res.status(400).json({ error: "Mot de passe invalide (min. 6 caractères)" });
    const user = await getUserByName(name.trim());
    if (!user || !user.secretAnswerHash) {
      return res.status(404).json({ error: "Récupération impossible pour ce compte." });
    }
    const ok = verifyPassword(String(answer).trim().toLowerCase(), user.secretAnswerHash);
    if (!ok) {
      console.log(`[forgot-reset] échec réponse secrète pour ${user.name}`);
      return res.status(401).json({ error: "Réponse incorrecte." });
    }
    // Réponse correcte → définir le nouveau mot de passe
    user.passHash = hashPassword(newPassword);
    await persistUser(user);
    console.log(`[forgot-reset] mot de passe réinitialisé pour ${user.name}`);
    // Connecter directement l'utilisateur
    const token = jwt.sign({ uid: user.uid }, JWT_SECRET, { expiresIn: '30d' });
    const { passHash, secretAnswerHash, ...safe } = user;
    res.json({ success: true, token, user: safe });
  } catch (e) {
    console.error('forgot/reset', e);
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
    gameId, color: "B", opponent: p2.name, opponentUid: p2.uid, opponentTitle: p2.title || null, opponentSkin: p2.skin || null,
    board: game.board, turn: "B", stake: game.stake, galaxy: game.galaxy,
    timeB: game.timeB, timeW: game.timeW, serverNow: Date.now()
  });
  send(p2.ws, "game_start", {
    gameId, color: "W", opponent: p1.name, opponentUid: p1.uid, opponentTitle: p1.title || null, opponentSkin: p1.skin || null,
    board: game.board, turn: "B", stake: game.stake, galaxy: game.galaxy,
    timeB: game.timeB, timeW: game.timeW, serverNow: Date.now()
  });
  return game;
}

async function handleMove(ws, uid, { gameId, from, to }) {
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
    // Si c'est une partie de TOURNOI : faire avancer le gagnant dans le bracket
    await handleTournamentGameEnd(game, end.winner, endData);
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

// ════════════════════════════════════════════
// TOURNOI À ÉLIMINATION DIRECTE (8 joueurs)
// ════════════════════════════════════════════
// Bracket en mémoire par semaine. 3 tours : quarts (4 matchs) → demis (2) → finale (1).
// Un match démarre quand ses DEUX joueurs sont connectés et prêts. Le gagnant avance,
// le perdant est éliminé jusqu'au prochain tournoi.
const tournaments = new Map(); // weekId → bracket

const TOURNAMENT_SIZE = 8;
const TOURNAMENT_ENTRY_FEE = 50;   // mise d'inscription (étoiles)
const TOURNAMENT_PRIZE = 500;       // récompense du champion (étoiles)

function newBracket(weekId, players) {
  // players : liste de {uid, name} (8 joueurs). On mélange pour l'appariement.
  const shuffled = players.slice().sort(() => Math.random() - 0.5).slice(0, TOURNAMENT_SIZE);
  // Quarts : 4 matchs de 2 joueurs
  const makeMatch = (id, a, b) => ({
    id, a: a || null, b: b || null, winner: null,
    gameId: null, status: (a && b) ? "pending" : "bye"
  });
  const quarters = [
    makeMatch("QF1", shuffled[0], shuffled[1]),
    makeMatch("QF2", shuffled[2], shuffled[3]),
    makeMatch("QF3", shuffled[4], shuffled[5]),
    makeMatch("QF4", shuffled[6], shuffled[7])
  ];
  const semis = [ makeMatch("SF1", null, null), makeMatch("SF2", null, null) ];
  const final = makeMatch("FINAL", null, null);
  return {
    weekId, createdAt: Date.now(), round: "quarters",
    quarters, semis, final, champion: null,
    players: shuffled.map(p => p.uid)
  };
}

// Trouver le match actif d'un joueur (celui où il doit jouer maintenant)
function findPlayerMatch(bracket, uid) {
  const rounds = [bracket.quarters, bracket.semis, [bracket.final]];
  for (const matches of rounds) {
    for (const m of matches) {
      if (m.status === "done") continue;
      if ((m.a && m.a.uid === uid) || (m.b && m.b.uid === uid)) return m;
    }
  }
  return null;
}

// Si la partie qui vient de se terminer était un match de tournoi : faire
// avancer le gagnant dans le bracket, créditer le champion le cas échéant,
// et diffuser le bracket à jour à tous les participants connectés.
// Facteur commun à TOUTES les fins de partie (coup gagnant, abandon, etc.) —
// avant ce correctif, seule la fin par coup gagnant appelait cette logique :
// un abandon en tournoi ne faisait jamais progresser le bracket.
async function handleTournamentGameEnd(game, winnerColor, endData) {
  if (!game.tournament || !winnerColor) return;
  try {
    const winnerUid = game.players[winnerColor];
    const bracket = tournaments.get(game.tournament.weekId);
    if (!bracket || !winnerUid) return;
    advanceTournament(bracket, game.tournament.matchId, winnerUid);
    persistBracket(bracket);
    endData.tournament = { weekId: game.tournament.weekId, matchId: game.tournament.matchId };
    console.log(`[tournament] Match ${game.tournament.matchId} terminé, gagnant: ${winnerUid}`);
    // Le champion vient d'être désigné (finale) → créditer la récompense
    if (bracket.champion && bracket.champion.uid === winnerUid && !bracket._prizePaid) {
      bracket._prizePaid = true;
      const champUser = await loadUser(winnerUid);
      if (champUser) {
        champUser.stars = (champUser.stars || 0) + TOURNAMENT_PRIZE;
        await persistUser(champUser);
        console.log(`[tournament] 🏆 ${champUser.name} CHAMPION → +${TOURNAMENT_PRIZE}★ (solde ${champUser.stars})`);
        endData.tournament.champion = true;
        endData.tournament.prize = TOURNAMENT_PRIZE;
        endData.tournament.newStars = champUser.stars;
      }
    }
    // Diffuser le bracket mis à jour à tous les participants connectés
    const bs = serializeBracket(bracket);
    for (const puid of bracket.players) {
      const pws = playerSockets.get(puid);
      if (pws) send(pws, "tournament_state", { weekId: bracket.weekId, bracket: bs, joined: true });
    }
  } catch (e) { console.error('tournament advance', e); }
}

// Enregistrer le résultat d'un match de tournoi et faire avancer le gagnant
function advanceTournament(bracket, matchId, winnerUid) {
  const all = [...bracket.quarters, ...bracket.semis, bracket.final];
  const match = all.find(m => m.id === matchId);
  if (!match || match.status === "done") return;
  const winner = (match.a && match.a.uid === winnerUid) ? match.a
               : (match.b && match.b.uid === winnerUid) ? match.b : null;
  if (!winner) return;
  match.winner = winner;
  match.status = "done";
  // Faire avancer le gagnant au tour suivant
  if (matchId === "QF1") bracket.semis[0].a = winner;
  else if (matchId === "QF2") bracket.semis[0].b = winner;
  else if (matchId === "QF3") bracket.semis[1].a = winner;
  else if (matchId === "QF4") bracket.semis[1].b = winner;
  else if (matchId === "SF1") bracket.final.a = winner;
  else if (matchId === "SF2") bracket.final.b = winner;
  else if (matchId === "FINAL") bracket.champion = winner;
  // Activer les matchs dont les deux joueurs sont désormais connus
  for (const m of [...bracket.semis, bracket.final]) {
    if (m.status !== "done" && m.a && m.b && m.status !== "pending") m.status = "pending";
  }
  // Mettre à jour le tour courant
  if (bracket.champion) bracket.round = "done";
  else if (bracket.semis.every(m => m.status === "done")) bracket.round = "final";
  else if (bracket.quarters.every(m => m.status === "done")) bracket.round = "semis";
}

const TOURNAMENT_FORFEIT_MS = 24 * 60 * 60 * 1000; // 24 heures

// Vérifier les forfaits : un joueur qui ne s'est jamais connecté dans les 24h
// suivant le début du tournoi perd son match par forfait. Suit la dernière activité.
function checkTournamentForfeits(bracket) {
  if (!bracket || bracket.champion) return false;
  const now = Date.now();
  const deadline = (bracket.createdAt || now) + TOURNAMENT_FORFEIT_MS;
  if (now < deadline) return false; // le délai de 24h n'est pas encore écoulé
  let changed = false;
  bracket.seen = bracket.seen || {}; // uid → dernier timestamp de connexion vu
  const activeMatches = [...bracket.quarters, ...bracket.semis, bracket.final];
  for (const m of activeMatches) {
    if (m.status === "done" || !m.a || !m.b) continue;
    const aOnline = playerSockets.has(m.a.uid) || (bracket.seen[m.a.uid] || 0) > 0;
    const bOnline = playerSockets.has(m.b.uid) || (bracket.seen[m.b.uid] || 0) > 0;
    // Si un seul des deux s'est connecté depuis le début → l'autre est forfait
    if (aOnline && !bOnline) { advanceTournament(bracket, m.id, m.a.uid); changed = true;
      console.log(`[tournament-forfait] ${m.b.name} absent 24h → ${m.a.name} avance`); }
    else if (bOnline && !aOnline) { advanceTournament(bracket, m.id, m.b.uid); changed = true;
      console.log(`[tournament-forfait] ${m.a.name} absent 24h → ${m.b.name} avance`); }
    // Si AUCUN des deux ne s'est connecté, on laisse le match en attente (personne ne mérite d'avancer)
  }
  return changed;
}

// Sauvegarder un bracket en base (persiste aux redéploiements)
function persistBracket(bracket) {
  if (!bracket) return;
  saveBracket(bracket.weekId, bracket).catch(e => console.error('saveBracket', e));
}

// Sérialiser le bracket pour l'envoi au client (sans données sensibles)
function serializeBracket(bracket) {
  if (!bracket) return null;
  const m = (x) => x ? ({ id: x.id, a: x.a, b: x.b,
    winner: x.winner ? x.winner.uid : null, status: x.status }) : null;
  return {
    weekId: bracket.weekId, round: bracket.round,
    quarters: bracket.quarters.map(m), semis: bracket.semis.map(m),
    final: m(bracket.final), champion: bracket.champion,
    createdAt: bracket.createdAt,
    forfeitDeadline: (bracket.createdAt || Date.now()) + TOURNAMENT_FORFEIT_MS
  };
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
          // Marquer la présence dans le tournoi en cours (évite le forfait 24h)
          try {
            const _bk = tournaments.get(isoWeekId());
            if (_bk && _bk.players && _bk.players.includes(uid)) {
              _bk.seen = _bk.seen || {};
              _bk.seen[uid] = Date.now();
              persistBracket(_bk);
            }
          } catch (e) {}
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
                opponentUid: g.players[oppColor],
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
        await handleMove(ws, uid, msg);
        break;
      }

      // Profil d'un adversaire : victoires/défaites/nulles (stats permanentes).
      // Recherche prioritaire par uid (fiable), repli par nom si absent.
      case "get_profile": {
        let target = null;
        if (typeof msg.uid === "string" && msg.uid) {
          target = await loadUser(msg.uid);
        }
        if (!target && typeof msg.name === "string" && msg.name.trim()) {
          // Le nom peut porter un préfixe cosmétique (ex: "🤖 ") côté client ;
          // on ne matche que sur le nom brut tel qu'enregistré en base.
          target = await getUserByName(msg.name.trim());
        }
        if (!target) {
          send(ws, "profile_data", { found: false });
          break;
        }
        send(ws, "profile_data", {
          found: true,
          name: target.name,
          wins: target.wins || 0,
          losses: target.losses || 0,
          draws: target.draws || 0,
          stars: target.stars || 0,
          rank: target.rank || null,
        });
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
          // Cas tournoi : un nul n'a pas de vainqueur (handleTournamentGameEnd
          // ne fait rien de plus dans ce cas), mais on l'appelle par cohérence
          // au cas où une règle de départage serait ajoutée plus tard.
          await handleTournamentGameEnd(game, null, endData);
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
        // Si c'est une partie de TOURNOI : faire avancer le gagnant dans le bracket
        // (bug corrigé : un abandon en tournoi ne faisait jamais progresser le bracket)
        await handleTournamentGameEnd(game, winner, endData);
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
          try {
            console.log(`[leaderboard-debug] ${users.length} compte(s) enregistré(s):`,
              users.map(u => { const t=(u.wins||0)+(u.losses||0)+(u.draws||0); return `${u.name}(${u.wins||0}V/${u.losses||0}D/${u.draws||0}N=${t}pj)${t>=5?"[OK]":"[<5→exclu]"}`; }).join(", "));
          } catch(e) {}
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
          // Déjà inscrit ? Ne pas re-débiter.
          const already = await isSignedUp(weekId, uid);
          if (already) {
            const signups = await getTournamentSignups(weekId);
            return send(ws, "tournament_state", { weekId, signups, joined: true });
          }
          // Vérifier le solde et débiter la mise d'inscription
          if ((u.stars || 0) < TOURNAMENT_ENTRY_FEE) {
            return send(ws, "tournament_error", { msg: `Il faut ${TOURNAMENT_ENTRY_FEE} étoiles pour participer (vous en avez ${u.stars || 0}).` });
          }
          u.stars = Math.max(0, (u.stars || 0) - TOURNAMENT_ENTRY_FEE);
          await persistUser(u);
          await addTournamentSignup(weekId, u);
          console.log(`[tournament] ${u.name} inscrit (−${TOURNAMENT_ENTRY_FEE}★, solde ${u.stars})`);
          const signups = await getTournamentSignups(weekId);
          send(ws, "tournament_state", { weekId, signups, joined: true, entryFee: TOURNAMENT_ENTRY_FEE, newStars: u.stars });
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
          const bracket = serializeBracket(tournaments.get(weekId));
          // Match actif du joueur (celui qu'il doit jouer maintenant)
          let myMatch = null;
          const bk = tournaments.get(weekId);
          if (bk && uid) {
            const pm = findPlayerMatch(bk, uid);
            if (pm && pm.a && pm.b) myMatch = { id: pm.id, status: pm.status,
              opponent: (pm.a.uid === uid ? pm.b : pm.a) };
          }
          send(ws, "tournament_state", { weekId, signups, joined, bracket, myMatch });
        } catch (e) {
          console.error('get_tournament', e);
          send(ws, "tournament_state", { weekId: isoWeekId(), signups: [], joined: false });
        }
        break;
      }

      // Générer le bracket quand 8 joueurs sont inscrits (n'importe qui peut le déclencher)
      case "tournament_start": {
        try {
          const weekId = isoWeekId();
          if (tournaments.has(weekId)) {
            // Déjà démarré → renvoyer l'état
            const bracket = serializeBracket(tournaments.get(weekId));
            return send(ws, "tournament_state", { weekId, bracket, joined: uid ? await isSignedUp(weekId, uid) : false });
          }
          const signups = await getTournamentSignups(weekId);
          if (signups.length < TOURNAMENT_SIZE) {
            return send(ws, "tournament_error", { msg: `Il faut ${TOURNAMENT_SIZE} joueurs inscrits (actuellement ${signups.length}).` });
          }
          const players = signups.slice(0, TOURNAMENT_SIZE).map(s => ({ uid: s.uid, name: s.name || "Joueur" }));
          const bracket = newBracket(weekId, players);
          tournaments.set(weekId, bracket);
          persistBracket(bracket);
          console.log(`[tournament] Bracket généré pour ${weekId} avec ${players.length} joueurs`);
          // Notifier tous les participants connectés + délai de forfait 24h
          const forfeitDeadline = bracket.createdAt + TOURNAMENT_FORFEIT_MS;
          for (const p of players) {
            const pws = playerSockets.get(p.uid);
            if (pws) send(pws, "tournament_state", {
              weekId, bracket: serializeBracket(bracket), joined: true,
              forfeitDeadline, forfeitHours: 24,
              tournamentStarted: true
            });
          }
        } catch (e) {
          console.error('tournament_start', e);
        }
        break;
      }

      // Lancer son match de tournoi : attend que l'adversaire soit connecté et prêt
      case "tournament_play": {
        try {
          if (!uid) return;
          const weekId = isoWeekId();
          const bracket = tournaments.get(weekId);
          if (!bracket) return send(ws, "tournament_error", { msg: "Aucun tournoi en cours." });
          const match = findPlayerMatch(bracket, uid);
          if (!match || !match.a || !match.b) return send(ws, "tournament_error", { msg: "Aucun match disponible pour vous." });
          if (match.status === "done") return send(ws, "tournament_error", { msg: "Ce match est déjà terminé." });
          const oppEntry = match.a.uid === uid ? match.b : match.a;
          const oppWs = playerSockets.get(oppEntry.uid);
          // Marquer ce joueur comme prêt
          match._ready = match._ready || {};
          match._ready[uid] = true;
          if (!oppWs) {
            return send(ws, "tournament_waiting", { matchId: match.id, opponent: oppEntry.name, reason: "offline" });
          }
          // L'adversaire est connecté : est-il prêt aussi ?
          if (!match._ready[oppEntry.uid]) {
            // Prévenir l'adversaire qu'un match l'attend
            send(oppWs, "tournament_match_ready", { matchId: match.id, opponent: (await loadUser(uid))?.name || "Joueur" });
            return send(ws, "tournament_waiting", { matchId: match.id, opponent: oppEntry.name, reason: "not_ready" });
          }
          // Les DEUX sont prêts → créer la partie de tournoi
          if (match.gameId && games.has(match.gameId)) {
            return; // partie déjà en cours
          }
          // Verrou synchrone anti-course : si les deux joueurs déclenchent
          // tournament_play au même instant, leurs deux gestionnaires de
          // message (un par socket) s'exécutent de façon entrelacée dès le
          // premier "await" ci-dessous. Sans ce verrou posé AVANT le premier
          // await, chaque invocation pouvait créer sa PROPRE partie séparée,
          // dissociant les deux joueurs (bug rapporté : chacun se retrouvait
          // seul, sans réel adversaire en face, et aucune progression n'était
          // jamais enregistrée dans le bracket).
          if (match._starting) return;
          match._starting = true;
          try {
            const uA = await loadUser(match.a.uid);
            const uB = await loadUser(match.b.uid);
            if (!uA || !uB) return;
            const wsA = playerSockets.get(uA.uid);
            const wsB = playerSockets.get(uB.uid);
            if (!wsA || !wsB) return send(ws, "tournament_waiting", { matchId: match.id, reason: "offline" });
            // Double vérification après l'attente : une autre invocation a-t-elle
            // déjà créé la partie pendant qu'on chargeait les utilisateurs ?
            if (match.gameId && games.has(match.gameId)) return;
            const p1 = { uid: uA.uid, name: uA.name, title: null, skin: null, ws: wsA, stake: 0, galaxy: "voie_lactee" };
            const p2 = { uid: uB.uid, name: uB.name, title: null, skin: null, ws: wsB, stake: 0, galaxy: "voie_lactee" };
            const game = createGame(p1, p2);
            game.tournament = { weekId, matchId: match.id }; // marquer comme partie de tournoi
            match.gameId = game.id;
            match.status = "playing";
            persistBracket(bracket);
            console.log(`[tournament] Match ${match.id} lancé: ${uA.name} vs ${uB.name}`);
          } finally {
            match._starting = false;
          }
        } catch (e) {
          console.error('tournament_play', e);
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
            // Si c'est une partie de TOURNOI : faire avancer le gagnant dans le bracket
            handleTournamentGameEnd(game, winner, endData).catch(e => console.error('tournament advance (disconnect)', e));
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
  server.listen(PORT, async () => {
    console.log(`🌌 DOSCO backend sur le port ${PORT}`);
    // Restaurer les brackets de tournoi persistés (survivent aux redéploiements)
    try {
      const saved = await loadAllBrackets();
      for (const { weekId, bracket } of saved) {
        if (bracket && weekId === isoWeekId()) { // seulement le tournoi de la semaine en cours
          tournaments.set(weekId, bracket);
          console.log(`[tournament] Bracket restauré pour ${weekId}`);
        }
      }
    } catch (e) { console.error('restore brackets', e); }
    // Vérification périodique des forfaits de tournoi (toutes les heures)
    setInterval(() => {
      try {
        for (const [wid, bk] of tournaments) {
          if (checkTournamentForfeits(bk)) {
            persistBracket(bk);
            const bs = serializeBracket(bk);
            for (const puid of bk.players) {
              const pws = playerSockets.get(puid);
              if (pws) send(pws, "tournament_state", { weekId: wid, bracket: bs, joined: true });
            }
          }
        }
      } catch (e) { console.error('forfeit check', e); }
    }, 60 * 60 * 1000);
    console.log(`✅ VERSION 2026-07-06-A : login priorise vrais comptes sur invités homonymes + point + récup passHash`);
    console.log(` Stockage: ${storageBackend()}`);
    console.log(` WebSocket: ws://localhost:${PORT}`);
    console.log(` REST API: http://localhost:${PORT}/api`);
  });
}).catch(e => {
  console.error('Échec du démarrage:', e);
  process.exit(1);
});
