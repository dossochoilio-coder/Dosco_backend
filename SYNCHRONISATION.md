# ☁️ Synchronisation cloud — progression multi-appareils

Le jeu sauvegarde la progression du joueur (étoiles, statistiques, inventaire
cosmétique) sur le serveur, permettant de retrouver sa progression sur
n'importe quel appareil.

## Fonctionnement

| Moment | Action |
|--------|--------|
| Connexion | `pull` : récupère la progression cloud et la fusionne avec le local |
| Après chaque partie | `push` (throttlé 1×/min) : envoie la progression au cloud |

## Fusion anti-perte

La synchronisation ne fait **jamais régresser** la progression. À chaque
fusion (locale ↔ cloud, ou côté serveur), le système conserve :
- le **maximum** d'étoiles
- le **maximum** de victoires
- la **meilleure** série

Cela protège contre les pertes en cas de jeu hors-ligne sur deux appareils.

## Endpoints serveur

```
POST /api/sync/push   (auth)  → { season, inventory, ts }
GET  /api/sync/pull   (auth)  → { season, inventory, ts }
```

## Activation

La synchronisation s'active automatiquement dès que :
1. `DOSCO_SERVER_URL` est configuré dans le jeu
2. Le joueur est authentifié (token présent)

Sans serveur configuré, tout reste en localStorage (repli transparent,
aucune erreur).

## Production

En production, remplacer le `Map` en mémoire (`progressDB`) par une table
PostgreSQL indexée par `uid`, avec horodatage pour la résolution de conflits.
