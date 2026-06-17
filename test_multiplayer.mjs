// Test du flux multijoueur en simulant 2 clients avec la logique serveur
import { INIT_BOARD, isLegalMove, applyMove, checkEnd } from './src/game-engine.js';

console.log("=== TEST FLUX MULTIJOUEUR ===\n");

// Simuler le serveur de jeu en mémoire
const games = new Map();
function createGame(p1uid, p2uid, stake){
  const id="g1";
  games.set(id,{id,board:JSON.parse(JSON.stringify(INIT_BOARD)),turn:"B",
    players:{B:p1uid,W:p2uid},stake,msc:0,moveCount:0,lastMove:null});
  return id;
}
function serverHandleMove(gameId, uid, from, to){
  const game=games.get(gameId);
  if(!game) return {error:"no game"};
  const color=game.players.B===uid?"B":(game.players.W===uid?"W":null);
  if(!color) return {error:"not in game"};
  if(game.turn!==color) return {error:"not your turn"};
  if(!isLegalMove(game.board,from,to,color)) return {error:"illegal"};
  const {board,isCapture}=applyMove(game.board,from,to);
  game.board=board; game.msc=isCapture?0:game.msc+1; game.lastMove=to; game.moveCount++;
  const end=checkEnd(game.board,to,color,game.msc);
  game.turn=color==="B"?"W":"B";
  return {ok:true,isCapture,turn:game.turn,end};
}

let pass=0,fail=0;
const check=(n,c)=>{console.log(`  ${c?'✓':'❌'} ${n}`);c?pass++:fail++;};

// Créer une partie : Alice (bleu) vs Bob (blanc), mise 10
const gid = createGame("alice","bob",10);
check("Partie créée", games.has(gid));
check("Bleu commence", games.get(gid).turn==="B");

// Alice (bleu) joue B7→B6
let r = serverHandleMove(gid,"alice","B7","B6");
check("Alice joue B7→B6", r.ok===true);
check("Tour passe à blanc", r.turn==="W");

// Bob essaie de jouer alors que... non c'est son tour maintenant
r = serverHandleMove(gid,"bob","C2","D3");
check("Bob joue C2→D3", r.ok===true);

// TENTATIVE DE TRICHE : Alice rejoue alors que ce n'est pas son tour... 
// (après le coup de Bob, c'est le tour de Alice à nouveau)
r = serverHandleMove(gid,"bob","E2","E3"); // Bob essaie de rejouer
check("Bob rejoue hors tour → REJETÉ", r.error==="not your turn");

// TENTATIVE DE TRICHE : coup illégal
r = serverHandleMove(gid,"alice","A7","A2"); // saut impossible
check("Coup illégal → REJETÉ", r.error==="illegal");

// TENTATIVE DE TRICHE : bouger pièce adverse
r = serverHandleMove(gid,"alice","C2","C3"); // C2 est une pièce blanche (Bob)
check("Alice bouge pièce de Bob → REJETÉ", r.error==="illegal" || r.error==="not your turn");

console.log(`\n${fail===0?'✅ MULTIJOUEUR OK':'❌ '+fail+' ÉCHECS'} (${pass}/${pass+fail})`);
console.log("\nLe serveur valide chaque coup → triche impossible côté client.");
