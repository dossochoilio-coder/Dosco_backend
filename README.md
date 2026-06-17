# 🌌 DOSCO Backend — Multijoueur + Validation IAP

Backend Node.js complet pour DOSCO : multijoueur temps réel par WebSocket
et validation sécurisée des achats intégrés.

## Architecture

```
src/
├── server.js            → Serveur principal (Express + WebSocket)
├── game-engine.js       → Moteur de jeu AUTORITAIRE (anti-triche)
├── iap-validation.js    → Validation sécurisée Apple/Google
└── client-integration.js → Client à intégrer dans le jeu
```

## Sécurité — Principes clés

### Anti-triche multijoueur
Le serveur est **l'autorité** : il maintient l'état réel de chaque partie et
**valide chaque coup** (légalité, tour du joueur, capture obligatoire).
Un client malveillant ne peut PAS :
- jouer hors de son tour
- faire un coup illégal
- bouger les pièces de l'adversaire
- ignorer une capture obligatoire

### Validation IAP sécurisée
- Les produits (prix, contenu) sont définis **côté serveur** — le client ne décide rien
- Chaque reçu est validé auprès d'Apple/Google **avant** de créditer
- Anti-rejeu : un reçu consommable ne peut être utilisé qu'une fois
- Créditation atomique

## Démarrage

```bash
npm install
# Variables d'environnement (production)
export JWT_SECRET="<secret-aléatoire-fort>"
export APPLE_SHARED_SECRET="<depuis App Store Connect>"
export PORT=8080
npm start
```

## Déploiement recommandé

| Composant | Service suggéré |
|-----------|----------------|
| Serveur | Railway, Render, Fly.io, AWS |
| Base de données | PostgreSQL (Supabase, Neon) |
| Cache/sessions | Redis (Upstash) |
| WebSocket | Le serveur gère nativement (ou Ably/Pusher) |
| Validation reçus | Ce backend ou RevenueCat |

## ⚠️ Avant la production

1. **Remplacer la DB en mémoire** (`Map`) par PostgreSQL
2. **Mots de passe / OAuth** réels (actuellement auth simplifiée)
3. **APPLE_SHARED_SECRET** depuis App Store Connect
4. **Compte de service Google Play** + OAuth2 pour la validation Android
5. **HTTPS/WSS obligatoire** (certificat TLS)
6. **Rate limiting** sur les endpoints
7. **Logs et monitoring** (Sentry, etc.)
8. Mettre à jour `serverUrl` dans `client-integration.js`

## Intégration au jeu

Copier `client-integration.js` et remplacer la simulation en ligne de
`OnlineScreen` par les appels `DOSCONet.*`. Voir les exemples en bas du fichier.

## Tests inclus

```bash
node test_server_logic.mjs   # Moteur + anti-triche (11 tests)
node test_multiplayer.mjs    # Flux multijoueur (8 tests)
node test_iap.mjs            # Validation IAP (6 tests)
```
