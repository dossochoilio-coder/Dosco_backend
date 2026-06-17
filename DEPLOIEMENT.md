# 🚀 Déploiement DOSCO Backend — Guide pas-à-pas

De zéro à un serveur multijoueur en ligne en ~12 minutes.
Aucune expérience serveur requise. Suivez exactement dans l'ordre.

═══════════════════════════════════════════════════════════
## CE QU'IL VOUS FAUT (5 min de préparation)
═══════════════════════════════════════════════════════════

1. **Un compte GitHub** (gratuit) — https://github.com/signup
2. **Le dossier `dosco_backend`** poussé dans un dépôt GitHub
   - Créez un dépôt vide sur github.com (bouton "New")
   - Dans un terminal, depuis le dossier `dosco_backend` :
     ```bash
     git init
     git add .
     git commit -m "DOSCO backend"
     git branch -M main
     git remote add origin https://github.com/VOTRE_NOM/dosco-backend.git
     git push -u origin main
     ```
3. **Un secret JWT fort** — exécutez ceci et gardez le résultat :
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

═══════════════════════════════════════════════════════════
## OPTION A — RAILWAY (le plus simple, recommandé)
═══════════════════════════════════════════════════════════

### Étape 1 — Créer le projet
1. Allez sur https://railway.app → "Login with GitHub"
2. "New Project" → "Deploy from GitHub repo"
3. Sélectionnez votre dépôt `dosco-backend`
4. Railway détecte Node.js et lance un premier build

### Étape 2 — Ajouter PostgreSQL (persistance)
1. Dans le projet : "New" → "Database" → "Add PostgreSQL"
2. Railway crée la base ET injecte automatiquement `DATABASE_URL`
   dans votre service. Rien d'autre à faire pour la DB.

### Étape 3 — Configurer le secret
1. Cliquez sur votre service → onglet "Variables"
2. "New Variable" → nom : `JWT_SECRET`, valeur : (le secret généré)
3. Le service redémarre automatiquement

### Étape 4 — Exposer le serveur
1. Onglet "Settings" → section "Networking"
2. "Generate Domain" → Railway crée une URL HTTPS
   (ex : `dosco-backend-production.up.railway.app`)

### Étape 5 — Vérifier
```bash
curl https://VOTRE-URL.up.railway.app/health
```
Réponse attendue :
```json
{"status":"ok","backend":"postgresql","players":0,"games":0,"queue":0}
```
`"backend":"postgresql"` confirme que la DB est branchée. ✅

═══════════════════════════════════════════════════════════
## OPTION B — RENDER
═══════════════════════════════════════════════════════════

1. https://render.com → "New" → "Web Service" → connectez le dépôt
2. Build Command : `npm install` · Start Command : `npm start`
3. "Advanced" → "Add Environment Variable" :
   - `JWT_SECRET` = (votre secret)
4. Pour la persistance : "New" → "PostgreSQL", puis copiez son
   "Internal Database URL" dans une variable `DATABASE_URL` du service.
   (Sans Postgres, le serveur bascule sur stockage fichier — voir note.)
5. Render fournit l'URL HTTPS → testez `/health`.

═══════════════════════════════════════════════════════════
## OPTION C — FLY.IO
═══════════════════════════════════════════════════════════

```bash
curl -L https://fly.io/install.sh | sh
fly auth signup
cd dosco_backend
fly launch                       # détecte fly.toml, choisissez une région
fly secrets set JWT_SECRET=VOTRE_SECRET
fly postgres create              # crée une DB
fly postgres attach <db-name>    # injecte DATABASE_URL
fly deploy
```

═══════════════════════════════════════════════════════════
## ACTIVER LE MULTIJOUEUR DANS LE JEU
═══════════════════════════════════════════════════════════

Une fois l'URL obtenue (ex : `dosco-backend-production.up.railway.app`),
dans `DOSCO_Game_Mockup.jsx`, trouvez la ligne :

```javascript
const DOSCO_SERVER_URL = "";
```

Remplacez par votre URL en **wss://** (WebSocket sécurisé) :

```javascript
const DOSCO_SERVER_URL = "wss://dosco-backend-production.up.railway.app";
```

Recompilez. Le mode en ligne passe de « ENTRAÎNEMENT » à « CONNECTÉ »
et recherche alors de **vrais adversaires**.

═══════════════════════════════════════════════════════════
## NOTES DE PRODUCTION
═══════════════════════════════════════════════════════════

**Persistance** : avec `DATABASE_URL` défini → PostgreSQL (survit à tout).
Sans → fichiers JSON dans `DATA_DIR`. ⚠️ Sur Railway/Render/Fly, le système
de fichiers est éphémère (réinitialisé à chaque déploiement) : pour de
vrais comptes joueurs, utilisez **toujours PostgreSQL** en production.

**Sécurité incluse** :
- Mots de passe hashés (scrypt, sel unique, comparaison à temps constant)
- Rate limiting par IP (anti-bruteforce sur login/register)
- Validation serveur de chaque coup (anti-triche)
- Mises gérées exclusivement côté serveur (winner-takes-all atomique)
- Anti-rejeu sur les reçus d'achat
- Suppression de compte (RGPD) via DELETE /api/me

**Routes REST** :
- `POST /api/register` {name, password} → {token, user}
- `POST /api/login`    {name, password} → {token, user}
- `POST /api/guest`    {name}           → {token, user}
- `GET  /api/me`        (auth)          → {user}
- `DELETE /api/me`      (auth)          → suppression RGPD
- `POST /api/iap/validate` (auth)       → validation achat
- `POST /api/sync/push` / `GET /api/sync/pull` (auth) → cloud save
- `GET  /health`                        → état du serveur

**WebSocket** : auth → find_match {galaxy} → move {from,to} → game_end.
Galaxies et mises : Voie Lactée 10 · Andromède 50 · Sombrero 150 ·
Tourbillon 500 · Cigare 1500 (étoiles).

**Tester localement avant de déployer** :
```bash
npm install
JWT_SECRET=test npm start
# dans un autre terminal :
curl localhost:8080/health
npm test   # lance les tests de durcissement + mises
```
