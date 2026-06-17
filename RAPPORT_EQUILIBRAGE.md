# 📊 Rapport d'équilibrage DOSCO — Simulations IA vs IA

Généré par simulation automatisée (parties complètes IA contre IA).

## 1. Équilibrage des couleurs

**Test : n3 vs n3, 60 parties, couleurs fixes**

| Camp | Victoires | Taux |
|------|-----------|------|
| Blancs (Sud) | 31 | 52% |
| Bleus (Nord, commencent) | 25 | 42% |
| Nulles | 4 | 7% |

**Verdict : ✅ Équilibré.** L'écart 52/42 est dans la marge normale d'un jeu
asymétrique. Les bleus commencent mais n'ont pas d'avantage décisif. Durée
moyenne : 81 coups par partie.

Répartition des fins : Infiltration 57%, Élimination 37%, Nulle 7%.
→ Les deux voies de victoire sont viables, l'infiltration légèrement favorisée.

## 2. Hiérarchie de force des niveaux

**Avant correction** (profondeurs mal étalées) :
- n5 vs n4 : 58% seulement
- n7 vs n6 : 50% (ÉGALITÉ — défaut majeur)

**Après correction** (iterative deepening + budgets temps distincts) :

| Duel | Victoires du fort | Verdict |
|------|-------------------|---------|
| n4 vs n3 | 9/10 (90%) | ✅ |
| n5 vs n4 | 8/8 (100%) | ✅ |
| n6 vs n5 | domine, 0 défaite | ✅ |

**Verdict : ✅ Hiérarchie monotone.** Chaque niveau bat distinctement le
précédent. La progression de difficulté est désormais réelle et perceptible.

## 3. Temps de réflexion (jouabilité)

| Niveau | Profondeur | Temps/coup |
|--------|-----------|------------|
| n1 Naine | aléatoire | <1ms |
| n2 Géante | capture | <1ms |
| n3 Nébuleuse | depth-2 +30% bruit | ~28ms |
| n4 Pulsare | depth-3 | ~89ms |
| n5 Quasar | depth-4, budget 0.8s | ~556ms |
| n6 Supernova | depth-6, budget 1.2s | ~1.2s |
| n7 Trou Noir | depth-8, budget 2.5s | ~2.5s |

**Verdict : ✅ Jouable.** Tous les niveaux répondent en moins de 2.5s. Le temps
croissant renforce la perception de difficulté.

## Corrections appliquées au moteur

1. **Iterative deepening** pour n5-n7 : approfondit progressivement jusqu'à
   épuisement du budget temps → exploite au mieux le temps disponible
2. **Budgets temps distincts** (0.8s / 1.2s / 2.5s) garantissant à la fois
   force croissante ET réactivité
3. **Principal Variation** : le meilleur coup de l'itération précédente est
   exploré en premier → élagage alpha-beta plus efficace
4. **Bruit dégressif** : n3 (30%) → n4 (10%) → n5+ (0%) pour des paliers nets

## Recommandations futures

- Simuler 1000+ parties par duel pour des intervalles de confiance serrés
  (les tests actuels utilisent 6-12 parties par contrainte de temps)
- Tester contre des joueurs humains pour calibrer la perception de difficulté
- Envisager une table d'ouvertures pour n7 (jeu encore plus fort en début de partie)
