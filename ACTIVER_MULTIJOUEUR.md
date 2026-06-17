# 🌐 Activer le vrai multijoueur en ligne

Par défaut, le jeu fonctionne en **mode entraînement** (adversaires IA locaux).
Pour activer le multijoueur réel entre joueurs, suivez ces étapes.

## 1. Déployer le serveur

```bash
cd dosco_backend
npm install
# Variables d'environnement
export JWT_SECRET="<secret-fort-aléatoire>"
export PORT=8080
npm start
```

Déployez sur un hébergeur supportant WebSocket :
- **Railway / Render / Fly.io** (simple, WebSocket natif)
- **VPS** (DigitalOcean, AWS EC2) avec Nginx en proxy WSS

Vous obtiendrez une URL type `wss://dosco-xyz.up.railway.app`.

## 2. Configurer le client dans le jeu

Dans `DOSCO_Game_Mockup.jsx`, trouvez cette ligne (au début, après INIT_BOARD) :

```javascript
const DOSCO_SERVER_URL = ""; // ⚠️ Renseignez votre serveur
```

Remplacez par votre URL :

```javascript
const DOSCO_SERVER_URL = "wss://dosco-xyz.up.railway.app";
```

Recompilez le jeu. Le mode en ligne basculera automatiquement :
- Statut **"CONNECTÉ"** (vert) au lieu de "ENTRAÎNEMENT"
- Matchmaking réel entre joueurs
- Coups validés par le serveur (anti-triche)
- Mises échangées réellement

## 3. Comportement automatique

Le jeu détecte l'état du serveur :

| Situation | Comportement |
|-----------|-------------|
| `DOSCO_SERVER_URL` vide | Mode entraînement (IA locale) |
| Serveur configuré et joignable | Multijoueur réel |
| Serveur configuré mais injoignable | Repli automatique sur entraînement + message |

Aucun plantage si le serveur tombe : le joueur peut toujours jouer.

## 4. Production

Voir `README.md` pour la checklist complète (PostgreSQL, Redis, HTTPS, etc.).
