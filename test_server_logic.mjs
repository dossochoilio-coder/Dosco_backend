import { INIT_BOARD, isLegalMove, applyMove, checkEnd, getAllCaptures, getMoves } from './src/game-engine.js';

console.log("=== TEST MOTEUR SERVEUR (anti-triche) ===\n");
let board = JSON.parse(JSON.stringify(INIT_BOARD));
let pass=0, fail=0;
function check(name,cond){ console.log(`  ${cond?'✓':'❌'} ${name}`); cond?pass++:fail++; }

// 1. Coup légal accepté
check("B7→B6 légal (mouvement valide)", isLegalMove(board,"B7","B6","B"));
// 2. Coup illégal rejeté (case non atteignable)
check("B7→B4 illégal (trop loin)", !isLegalMove(board,"B7","B4","B"));
// 3. Bouger une pièce adverse rejeté
check("Blanc bouge pièce bleue → rejeté", !isLegalMove(board,"B7","B6","W"));
// 4. Bouger depuis case vide rejeté
check("Case vide → rejeté", !isLegalMove(board,"D5","D6","B"));

// 5. Capture obligatoire
let cb = JSON.parse(JSON.stringify(INIT_BOARD));
cb["B6"]={color:"B",type:"Acrux"}; cb["B5"]={color:"W",type:"Merak"};
const caps = getAllCaptures("B",cb);
check("Capture détectée", Object.keys(caps).length>0);
// Quand capture dispo, un mouvement non-capture est illégal
const hasMandatory = Object.keys(caps).length>0;
check("Capture obligatoire forcée", hasMandatory && !isLegalMove(cb,"A7","A6","B"));

// 6. Application de coup
const {board:nb, isCapture} = applyMove(board,"B7","B6");
check("applyMove déplace la pièce", nb["B6"] && !nb["B7"]);
check("applyMove détecte non-capture", isCapture===false);

// 7. Fin de partie - élimination
const elimBoard = {D1:{color:"W",type:"Sirus"}};
const end1 = checkEnd(elimBoard,"D1","W",1);
check("Élimination détectée", end1?.type==="elimination" && end1.winner==="W");

// 8. Infiltration
let infB = JSON.parse(JSON.stringify(INIT_BOARD));
infB["D9"]={color:"W",type:"Sirus"};
const end2 = checkEnd(infB,"D9","W",1);
check("Infiltration blanc D9", end2?.type==="infiltration" && end2.winner==="W");

// 9. Nulle 50 coups
check("Nulle à 50 coups", checkEnd(board,"D5","B",50)?.type==="draw");

console.log(`\n${fail===0?'✅ TOUS PASSENT':'❌ '+fail+' ÉCHECS'} (${pass}/${pass+fail})`);
