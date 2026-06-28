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
  console.warn('⚠️  JWT_SECRET non défini — utilisez un secret fort en production !');
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.set('trust proxy', 1); // derrière le proxy Railway/Render/Fly

// ── CORS : autoriser le client du jeu à appeler l'API ──
// Le jeu peut être servi depuis un fichier local (origine "null"), un domaine,
// ou une app mobile. On autorise toutes les origines pour l'API publique du jeu.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end(); // réponse au preflight
  next();
});

// Cache mémoire des utilisateurs actifs (write-through vers le stockage persistant)
const userCache = new Map(); // uid → user
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

// Inscription : pseudo + mot de passe hashé (scrypt)
app.post('/api/register', rateLimit(10, 60000, 'register'), async (req, res) => {
  try {
    const { name, password } = req.body || {};
    if (!validateName(name)) return res.status(400).json({ error: "Pseudo invalide (2-14 caractères)" });
    if (!validatePassword(password)) return res.status(400).json({ error: "Mot de passe invalide (min. 6 caractères)" });
    if (await getUserByName(name.trim())) return res.status(409).json({ error: "Ce pseudo est déjà pris" });
    const uid = "usr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const user = { uid, name: name.trim(), passHash: hashPassword(password),
      stars: 100, rank: "Naine Blanche", wins: 0, losses: 0, hasPass: false, createdAt: Date.now() };
    await persistUser(user);
    const token = jwt.sign({ uid }, JWT_SECRET, { expiresIn: '30d' });
    const { passHash, ...safe } = user;
    res.json({ token, user: safe });
  } catch (e) { console.error('register', e); res.status(500).json({ error: "Erreur serveur" }); }
});

// Connexion : vérifie le mot de passe (réponse uniforme anti-énumération)
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
  } catch (e) { console.error('login', e); res.status(500).json({ error: "Erreur serveur" }); }
});

// Connexion invité (sans mot de passe)
app.post('/api/guest', rateLimit(20, 60000, 'guest'), async (req, res) => {
  try {
    const { name } = req.body || {};
    const uid = "gst_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const user = { uid, name: (validateName(name) ? name.trim() : "Invité"),
      stars: 100, rank: "Naine Blanche", wins: 0, losses: 0, hasPass: false, guest: true, createdAt: Date.now() };
    await persistUser(user);
    const token = jwt.sign({ uid }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (e) { res.status(500).json({ error: "Erreur serveur" }); }
});

// Middleware d'authentification (async — charge depuis le stockage)
async function auth(req, res, next){
  const token = req.headers.authorization?.replace('Bearer ','');
  if(!token) return res.status(401).json({error:"Non authentifié"});
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    const user = await loadUser(uid);
    if(!user) return res.status(401).json({error:"Utilisateur introuvable"});
    req.user = user;
    next();
  } catch(e){ return res.status(401).json({error:"Token invalide"}); }
}

// Validation d'achat IAP (sécurisée serveur + anti-rejeu + persistance)
app.post('/api/iap/validate', auth, rateLimit(30, 60000, 'iap'), async (req, res) => {
  try {
    const receiptId = req.body?.receiptId || req.body?.transactionId;
    if (receiptId && await receiptExists(receiptId)) {
      return res.status(409).json({ success:false, error:"Reçu déjà utilisé" });
    }
    const result = await processPurchase({ ...req.body, userId:req.user.uid });
    if(result.success){
      req.user.stars += result.starsGranted;
      if(result.isNonConsumable) req.user.hasPass = true;
      await persistUser(req.user);
      if (receiptId) await saveReceipt(receiptId, req.user.uid, req.body?.productId);
    }
    res.json(result);
  } catch(e){ console.error('iap', e); res.status(500).json({ success:false, error:"Erreur de validation" }); }
});

// Restauration des achats
app.post('/api/iap/restore', auth, (req, res) => {
  res.json({ success:true, hasPass: !!req.user.hasPass, stars: req.user.stars });
});

// Profil
app.get('/api/me', auth, (req, res) => { const {passHash,...safe}=req.user; res.json({ user:safe }); });

// Suppression de compte (droit RGPD)
app.delete('/api/me', auth, async (req, res) => {
  await deleteUser(req.user.uid);
  userCache.delete(req.user.uid);
  res.json({ success:true });
});

// ── Synchronisation cloud de la progression (persistante) ──
app.post('/api/sync/push', auth, rateLimit(60, 60000, 'sync'), async (req, res) => {
  try {
    const { season, inventory } = req.body || {};
    const existing = await getProgress(req.user.uid);
    let mergedSeason = season;
    // Anti-régression : ne jamais écraser une progression plus avancée
    if (existing && existing.season) {
      mergedSeason = { ...season,
        stars: Math.max(existing.season.stars||0, season?.stars||0),
        lifetimeStars: Math.max(existing.season.lifetimeStars||0, season?.lifetimeStars||0),
        wins: Math.max(existing.season.wins||0, season?.wins||0),
        bestStreak: Math.max(existing.season.bestStreak||0, season?.bestStreak||0) };
    }
    await saveProgress(req.user.uid, mergedSeason, inventory);
    res.json({ success:true, ts: Date.now() });
  } catch(e){ res.status(500).json({ error:"Erreur de synchronisation" }); }
});
app.post("/auth/google", async (req, res) => {
  const { accessToken } = req.body;

  try {
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const user = await response.json();

    res.json({
      id: user.sub,
      name: user.name,
      email: user.email,
      provider: "google",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Google auth failed" });
  }
});
app.post("/auth/facebook", async (req, res) => {
  const { accessToken } = req.body;

  try {
    const response = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email&access_token=${accessToken}`
    );

    const user = await response.json();

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      provider: "facebook",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Facebook auth failed" });
  }
});

app.get('/api/sync/pull', auth, async (req, res) => {
  const data = await getProgress(req.user.uid);
  if (!data) return res.json({ season:null, inventory:null });
  res.json(data);
});

// Health check (sondes Railway/Render/Fly)
app.get('/health', (req, res) => res.json({ status:"ok", backend:storageBackend(),
  players:wss?.clients.size||0, games:games.size, queue:waitingQueue.length }));

const server = createServer(app);

// ════════════════════════════════════════════
// WEBSOCKET — Multijoueur temps réel
// ════════════════════════════════════════════
const wss = new WebSocketServer({ server });

const waitingQueue = [];        // joueurs en attente de match
const games = new Map();        // gameId → état de la partie
const playerSockets = new Map(); // uid → ws

function send(ws, type, data){
  if(ws.readyState === 1) ws.send(JSON.stringify({ type, ...data }));
}

function createGame(p1, p2){
  const gameId = "game_" + Date.now() + "_" + Math.random().toString(36).slice(2,6);
  // p1 = bleu (commence), p2 = blanc
  const game = {
    id: gameId,
    board: JSON.parse(JSON.stringify(INIT_BOARD)),
    turn: "B",
    players: { B:p1.uid, W:p2.uid },
    names:   { B:p1.name, W:p2.name },
    stake: p1.stake || 0,
    galaxy: p1.galaxy || "voie_lactee",
    msc: 0,
    moveCount: 0,
    lastMove: null,
    startedAt: Date.now(),
  };
  games.set(gameId, game);
  p1.gameId = gameId; p2.gameId = gameId;
  send(p1.ws, "game_start", { gameId, color:"B", opponent:p2.name, board:game.board, turn:"B", stake:game.stake, galaxy:game.galaxy });
  send(p2.ws, "game_start", { gameId, color:"W", opponent:p1.name, board:game.board, turn:"B", stake:game.stake, galaxy:game.galaxy });
  return game;
}

function handleMove(ws, uid, { gameId, from, to }){
  const game = games.get(gameId);
  if(!game) return send(ws, "error", { msg:"Partie introuvable" });
  const color = game.players.B === uid ? "B" : (game.players.W === uid ? "W" : null);
  if(!color) return send(ws, "error", { msg:"Vous n'êtes pas dans cette partie" });
  if(game.turn !== color) return send(ws, "error", { msg:"Pas votre tour" });

  // ── VALIDATION SERVEUR : le coup est-il légal ? (anti-triche) ──
  if(!isLegalMove(game.board, from, to, color)){
    return send(ws, "error", { msg:"Coup illégal", board:game.board, turn:game.turn });
  }

  // Appliquer
  const { board, isCapture } = applyMove(game.board, from, to);
  game.board = board;
  game.msc = isCapture ? 0 : game.msc + 1;
  game.lastMove = to;
  game.moveCount++;

  // Vérifier fin de partie
  const end = checkEnd(game.board, to, color, game.msc);
  const nextTurn = color === "B" ? "W" : "B";
  game.turn = nextTurn;

  // Diffuser le coup aux deux joueurs
  const p1ws = playerSockets.get(game.players.B);
  const p2ws = playerSockets.get(game.players.W);
  const moveData = { gameId, from, to, isCapture, board:game.board, turn:nextTurn, by:color };
  if(p1ws) send(p1ws, "move", moveData);
  if(p2ws) send(p2ws, "move", moveData);

  if(end){
    settleStakes(game, end.winner).catch(e=>console.error('settle', e));
    const endData = { gameId, winner:end.winner, type:end.type, stake:game.stake };
    if(p1ws) send(p1ws, "game_end", endData);
    if(p2ws) send(p2ws, "game_end", endData);
    games.delete(gameId);
  }
}

// Règlement atomique des mises (persiste les soldes + stats)
async function settleStakes(game, winnerColor){
  if(!winnerColor || game.stake <= 0) return;
  const loserColor = winnerColor === "B" ? "W" : "B";
  const winner = await loadUser(game.players[winnerColor]);
  const loser  = await loadUser(game.players[loserColor]);
  if(winner && loser){
    winner.stars += game.stake; winner.wins = (winner.wins||0)+1;
    loser.stars = Math.max(0, loser.stars - game.stake); loser.losses = (loser.losses||0)+1;
    await persistUser(winner);
    await persistUser(loser);
  }
}

wss.on('connection', (ws) => {
  let uid = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e){ return; }

    switch(msg.type){
      case "auth": {
        try {
          const decoded = jwt.verify(msg.token, JWT_SECRET);
          uid = decoded.uid;
          playerSockets.set(uid, ws);
          ws.uid = uid;
          send(ws, "authed", { uid });
        } catch(e){ send(ws, "error", { msg:"Auth WS échouée" }); }
        break;
      }
      case "find_match": {
        if(!uid) return send(ws, "error", { msg:"Authentifiez-vous d'abord" });
        const user = await loadUser(uid);
        if(!user) return;
        // La mise est déterminée par la galaxie choisie (source serveur)
        const galaxyId = msg.galaxy || "voie_lactee";
        const galaxy = GALAXIES[galaxyId];
        if(!galaxy) return send(ws, "error", { msg:"Galaxie inconnue" });
        const stake = galaxy.stake;
        // Le joueur doit avoir assez d'étoiles pour miser
        if(user.stars < stake){
          return send(ws, "error", { msg:"Étoiles insuffisantes pour cette galaxie", need:stake, have:user.stars });
        }
        const me = { uid, name:user.name, ws, stake, galaxy:galaxyId };
        // Apparier dans la même galaxie (même mise)
        const idx = waitingQueue.findIndex(p => p.uid !== uid && p.galaxy === galaxyId);
        if(idx >= 0){
          const opponent = waitingQueue.splice(idx,1)[0];
          createGame(opponent, me);
        } else {
          waitingQueue.push(me);
          send(ws, "searching", { stake, galaxy:galaxyId });
        }
        break;
      }
      case "move": {
        if(!uid) return;
        handleMove(ws, uid, msg);
        break;
      }
      case "cancel_search": {
        const i = waitingQueue.findIndex(p => p.uid === uid);
        if(i>=0) waitingQueue.splice(i,1);
        send(ws, "search_cancelled", {});
        break;
      }
      case "offer_draw": {
        if(!uid || !msg.gameId) return;
        const game = games.get(msg.gameId);
        if(!game) return;
        const color = game.players.B===uid?"B":(game.players.W===uid?"W":null);
        if(!color) return;
        // Transmettre la demande à l'adversaire
        const oppColor = color==="B"?"W":"B";
        const oppWs = playerSockets.get(game.players[oppColor]);
        if(oppWs) send(oppWs, "draw_offered", { gameId:msg.gameId, by:color });
        break;
      }
      case "chat": {
        if(!uid || !msg.gameId || !msg.text) return;
        const game = games.get(msg.gameId);
        if(!game) return;
        const color = game.players.B===uid?"B":(game.players.W===uid?"W":null);
        if(!color) return;
        const oppColor = color==="B"?"W":"B";
        const oppWs = playerSockets.get(game.players[oppColor]);
        // Anti-abus : limiter la longueur
        const text = String(msg.text).slice(0,200);
        if(oppWs) send(oppWs, "chat", { gameId:msg.gameId, text, by:color });
        break;
      }
      case "draw_response": {
        if(!uid || !msg.gameId) return;
        const game = games.get(msg.gameId);
        if(!game) return;
        const p1ws=playerSockets.get(game.players.B), p2ws=playerSockets.get(game.players.W);
        if(msg.accepted){
          // Match nul : aucune mise échangée
          const endData={gameId:msg.gameId,winner:null,type:"draw",stake:game.stake};
          if(p1ws)send(p1ws,"game_end",endData);
          if(p2ws)send(p2ws,"game_end",endData);
          games.delete(msg.gameId);
        }else{
          // Refusé : notifier le proposeur
          const color = game.players.B===uid?"B":"W";
          const offererColor = color==="B"?"W":"B";
          const offererWs = playerSockets.get(game.players[offererColor]);
          if(offererWs) send(offererWs, "draw_declined", { gameId:msg.gameId });
        }
        break;
      }
      case "resign": {
        if(!uid || !msg.gameId) return;
        const game = games.get(msg.gameId);
        if(!game) return;
        const color = game.players.B===uid?"B":"W";
        const winner = color==="B"?"W":"B";
        settleStakes(game, winner).catch(e=>console.error('settle', e));
        const p1ws=playerSockets.get(game.players.B), p2ws=playerSockets.get(game.players.W);
        const endData={gameId:msg.gameId,winner,type:"forfeit",stake:game.stake};
        if(p1ws)send(p1ws,"game_end",endData);
        if(p2ws)send(p2ws,"game_end",endData);
        games.delete(msg.gameId);
        break;
      }
    }
  });

  ws.on('close', () => {
    if(uid){
      playerSockets.delete(uid);
      const i = waitingQueue.findIndex(p => p.uid === uid);
      if(i>=0) waitingQueue.splice(i,1);
      // Si en partie : l'adversaire gagne par abandon
      for(const [gid, game] of games){
        if(game.players.B===uid || game.players.W===uid){
          const winner = game.players.B===uid ? "W" : "B";
          settleStakes(game, winner).catch(e=>console.error('settle', e));
          const oppWs = playerSockets.get(game.players[winner]);
          if(oppWs) send(oppWs, "game_end", { gameId:gid, winner, type:"disconnect", stake:game.stake });
          games.delete(gid);
        }
      }
    }
  });
});

// Démarrage : initialiser le stockage AVANT d'écouter
initStorage().then(() => {
  server.listen(PORT, () => {
    console.log(`🌌 DOSCO backend sur le port ${PORT}`);
    console.log(`   Stockage:  ${storageBackend()}`);
    console.log(`   WebSocket: ws://localhost:${PORT}`);
    console.log(`   REST API:  http://localhost:${PORT}/api`);
  });
}).catch(e => { console.error('Échec du démarrage:', e); process.exit(1); });
