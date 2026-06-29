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
} from './storage.js';
import { hashPassword, verifyPassword, validateName, validatePassword } from './auth.js';
import { rateLimit } from './rate-limit.js';

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
    const { name, password } = req.body || {};
    if (!validateName(name)) return res.status(400).json({ error: "Pseudo invalide (2-14 caractères)" });
    if (!validatePassword(password)) return res.status(400).json({ error: "Mot de passe invalide (min. 6 caractères)" });
    if (await getUserByName(name.trim())) return res.status(409).json({ error: "Ce pseudo est déjà pris" });

    const uid = "usr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const user = {
      uid,
      name: name.trim(),
      passHash: hashPassword(password),
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
    next();
  } catch (e) {
    return res.status(401).json({ error: "Token invalide" });
  }
}

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
    ws.send(JSON.stringify({ type, ...data }));
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
    stake: p1.stake || 0,
    galaxy: p1.galaxy || "voie_lactee",
    msc: 0,
    moveCount: 0,
    lastMove: null,
    startedAt: Date.now(),
  };
  games.set(gameId, game);
  p1.gameId = gameId;
  p2.gameId = gameId;

  send(p1.ws, "game_start", {
    gameId, color: "B", opponent: p2.name,
    board: game.board, turn: "B", stake: game.stake, galaxy: game.galaxy
  });
  send(p2.ws, "game_start", {
    gameId, color: "W", opponent: p1.name,
    board: game.board, turn: "B", stake: game.stake, galaxy: game.galaxy
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

  const end = checkEnd(game.board, to, color, game.msc);
  const nextTurn = color === "B" ? "W" : "B";
  game.turn = nextTurn;

  const p1ws = playerSockets.get(game.players.B);
  const p2ws = playerSockets.get(game.players.W);

  const moveData = { gameId, from, to, isCapture, board: game.board, turn: nextTurn, by: color };
  if (p1ws) send(p1ws, "move", moveData);
  if (p2ws) send(p2ws, "move", moveData);

  if (end) {
    settleStakes(game, end.winner).catch(e => console.error('settle', e));
    const endData = { gameId, winner: end.winner, type: end.type, reason: end.reason || null, stake: game.stake };
    if (p1ws) send(p1ws, "game_end", endData);
    if (p2ws) send(p2ws, "game_end", endData);
    cacheEndedGame(game);
    games.delete(gameId);
  }
}

async function settleStakes(game, winnerColor) {
  if (!winnerColor || game.stake <= 0) return;

  const loserColor = winnerColor === "B" ? "W" : "B";
  const winner = await loadUser(game.players[winnerColor]);
  const loser = await loadUser(game.players[loserColor]);

  if (winner && loser) {
    winner.stars += game.stake;
    winner.wins = (winner.wins || 0) + 1;
    loser.stars = Math.max(0, loser.stars - game.stake);
    loser.losses = (loser.losses || 0) + 1;
    await persistUser(winner);
    await persistUser(loser);
  }
}

// Nouvelle fonction pour match nul (restitution des mises)
async function settleDrawStakes(game) {
  if (game.stake <= 0) return;

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
          playerSockets.set(uid, ws);
          ws.uid = uid;
          send(ws, "authed", { uid });
          // Envoyer les revanches en attente
          const pending = pendingRematches.get(uid);
          if (pending && (Date.now() - pending.ts) < 2 * 60 * 1000) {
            send(ws, "rematch_offered", { gameId: pending.gameId, from: pending.fromUid, fromName: pending.fromName });
            pendingRematches.delete(uid);
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

        const me = { uid, name: user.name, ws, stake, galaxy: galaxyId };
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
            type: "draw",
            reason: "Match nul accepté — mises conservées",
            stake: game.stake
          };
          if (p1ws) send(p1ws, "game_end", endData);
          if (p2ws) send(p2ws, "game_end", endData);
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
        if (!game) return; // partie déjà terminée, resign ignoré silencieusement

        const color = game.players.B === uid ? "B" : "W";
        const winner = color === "B" ? "W" : "B";
        settleStakes(game, winner).catch(e => console.error('settle', e));

        const p1ws = playerSockets.get(game.players.B);
        const p2ws = playerSockets.get(game.players.W);
        const endData = { gameId: msg.gameId, winner, type: "forfeit", stake: game.stake };
        if (p1ws) send(p1ws, "game_end", endData);
        if (p2ws) send(p2ws, "game_end", endData);
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
              ws: playerSockets.get(game.players.B),
              stake: game.stake,
              galaxy: game.galaxy
            },
            {
              uid: game.players.W,
              name: game.names.W,
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
      playerSockets.delete(uid);
      const i = waitingQueue.findIndex(p => p.uid === uid);
      if (i >= 0) waitingQueue.splice(i, 1);

      for (const [gid, game] of games) {
        if (game.players.B === uid || game.players.W === uid) {
          const winner = game.players.B === uid ? "W" : "B";
          settleStakes(game, winner).catch(e => console.error('settle', e));
          const oppWs = playerSockets.get(game.players[winner]);
          if (oppWs) send(oppWs, "game_end", { gameId: gid, winner, type: "disconnect", stake: game.stake });
          cacheEndedGame(game);
          games.delete(gid);
        }
      }
    }
  });
});

// Démarrage
initStorage().then(() => {
  server.listen(PORT, () => {
    console.log(`🌌 DOSCO backend sur le port ${PORT}`);
    console.log(` Stockage: ${storageBackend()}`);
    console.log(` WebSocket: ws://localhost:${PORT}`);
    console.log(` REST API: http://localhost:${PORT}/api`);
  });
}).catch(e => {
  console.error('Échec du démarrage:', e);
  process.exit(1);
});
