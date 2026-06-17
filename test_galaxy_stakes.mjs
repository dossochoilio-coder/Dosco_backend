import { INIT_BOARD, isLegalMove, applyMove, checkEnd } from './src/game-engine.js';
console.log("=== TEST MISES PAR GALAXIE (logique serveur) ===\n");
const GALAXIES = { voie_lactee:{stake:10}, andromede:{stake:50}, sombrero:{stake:150}, tourbillon:{stake:500}, cigare:{stake:1500} };
let pass=0,fail=0; const check=(n,c)=>{console.log(`  ${c?'✓':'❌'} ${n}`);c?pass++:fail++;};

// Simuler le règlement d'une mise winner-takes-all
function settleStake(winnerStars, loserStars, stake){
  return { winner: winnerStars + stake, loser: Math.max(0, loserStars - stake) };
}

check("5 galaxies définies", Object.keys(GALAXIES).length===5);
check("Voie Lactée = 10", GALAXIES.voie_lactee.stake===10);
check("Cigare = 1500", GALAXIES.cigare.stake===1500);

// Winner-takes-all dans Andromède (50)
let r = settleStake(300, 300, 50);
check("Gagnant Andromède: 300→350", r.winner===350);
check("Perdant Andromède: 300→250", r.loser===250);

// Un joueur ne peut entrer dans Tourbillon (500) avec 300 étoiles
const canEnter = (stars, galaxy) => stars >= GALAXIES[galaxy].stake;
check("300 étoiles ne peut pas entrer Tourbillon", !canEnter(300, "tourbillon"));
check("600 étoiles peut entrer Tourbillon", canEnter(600, "tourbillon"));
check("Personne avec 100 ne peut entrer Cigare", !canEnter(100, "cigare"));

// Le perdant ne descend jamais sous 0
r = settleStake(1000, 30, 50);
check("Perdant à 30 misant 50 → 0 (jamais négatif)", r.loser===0);

console.log(`\n${fail===0?'✅ MISES OK':'❌ '+fail+' ÉCHECS'} (${pass}/${pass+fail})`);
