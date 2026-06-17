// ════════════════════════════════════════════════════════════════
// MOTEUR DE JEU DOSCO — CÔTÉ SERVEUR (autorité anti-triche)
// Le serveur valide CHAQUE coup. Le client ne peut jamais tricher.
// ════════════════════════════════════════════════════════════════

export const VALID_CELLS = new Set(["D1","C2","D2","E2","A3","B3","C3","D3","E3","F3","G3","A4","B4","C4","D4","E4","F4","G4","A5","B5","C5","D5","E5","F5","G5","A6","B6","C6","D6","E6","F6","G6","A7","B7","C7","D7","E7","F7","G7","C8","D8","E8","D9"]);
const COL = {A:0,B:1,C:2,D:3,E:4,F:5,G:6};
const COLR = ["A","B","C","D","E","F","G"];
const toRC = c => ({c:COL[c[0]], r:parseInt(c.slice(1))-1});
const toCoord = (c,r) => { if(c<0||c>6||r<0||r>8)return null; const k=COLR[c]+(r+1); return VALID_CELLS.has(k)?k:null; };

// Morphologies canoniques (format [dc, dr])
export const DIRS = {
  W: {
    Sirus:[[-1,1],[0,1],[1,1],[-1,0],[1,0],[-1,-1],[0,-1],[1,-1]],
    Alhena:[[-1,1],[0,1],[1,1],[-1,0],[1,0],[0,-1]],
    Altair:[[-1,1],[1,1],[-1,0],[1,0],[-1,-1],[1,-1]],
    Vega:[[0,1],[-1,0],[1,0],[-1,-1],[0,-1],[1,-1]],
    Deneb:[[-1,1],[0,1],[1,1],[-1,-1],[0,-1],[1,-1]],
    Merak:[[0,1],[-1,0],[1,0],[0,-1]],
    Alioth:[[-1,1],[1,1],[-1,-1],[1,-1]],
  },
  B: {
    Rigel:[[-1,1],[0,1],[1,1],[-1,0],[1,0],[-1,-1],[0,-1],[1,-1]],
    Acrux:[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[0,1]],
    Hadar:[[-1,-1],[1,-1],[-1,0],[1,0],[-1,1],[1,1]],
    Epi:[[0,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]],
    Spica:[[-1,-1],[0,-1],[1,-1],[-1,1],[0,1],[1,1]],
    Mimosa:[[0,-1],[-1,0],[1,0],[0,1]],
    Regulus:[[-1,-1],[1,-1],[-1,1],[1,1]],
  }
};

export const INIT_BOARD = {
  D1:{color:"W",type:"Sirus"},C2:{color:"W",type:"Altair"},E2:{color:"W",type:"Vega"},
  A3:{color:"W",type:"Alioth"},B3:{color:"W",type:"Deneb"},F3:{color:"W",type:"Alhena"},G3:{color:"W",type:"Merak"},
  D9:{color:"B",type:"Rigel"},C8:{color:"B",type:"Epi"},E8:{color:"B",type:"Hadar"},
  A7:{color:"B",type:"Mimosa"},B7:{color:"B",type:"Acrux"},F7:{color:"B",type:"Spica"},G7:{color:"B",type:"Regulus"}
};

export function getMoves(coord, board){
  const star = board[coord];
  if(!star) return {moves:[], captures:[]};
  const dirs = DIRS[star.color][star.type] || [];
  const {c,r} = toRC(coord);
  const moves=[], captures=[];
  for(const [dc,dr] of dirs){
    const nc=c+dc, nr=r+dr;
    const target = toCoord(nc,nr);
    if(!target) continue;
    const occupant = board[target];
    if(!occupant) moves.push(target);
    else if(occupant.color !== star.color) captures.push(target);
  }
  return {moves, captures};
}

export function getAllCaptures(color, board){
  const res={};
  for(const [coord,star] of Object.entries(board)){
    if(star.color!==color) continue;
    const {captures}=getMoves(coord,board);
    if(captures.length>0) res[coord]=captures;
  }
  return res;
}

// Valider qu'un coup est légal (capture obligatoire incluse)
export function isLegalMove(board, from, to, color){
  const star = board[from];
  if(!star || star.color!==color) return false;
  const {moves, captures} = getMoves(from, board);
  const mandatory = getAllCaptures(color, board);
  const hasMandatory = Object.keys(mandatory).length>0;
  if(hasMandatory){
    // Seules les captures sont légales
    return captures.includes(to);
  }
  return moves.includes(to) || captures.includes(to);
}

export function checkEnd(board, lastMove, color, msc){
  const opp = color==="W"?"B":"W";
  let wCount=0, bCount=0;
  for(const s of Object.values(board)){ if(s.color==="W")wCount++; else bCount++; }
  // Élimination
  if(wCount===0) return {winner:"B", type:"elimination"};
  if(bCount===0) return {winner:"W", type:"elimination"};
  // Infiltration : blanc atteint D9, bleu atteint D1
  if(lastMove==="D9" && board["D9"]?.color==="W") return {winner:"W", type:"infiltration"};
  if(lastMove==="D1" && board["D1"]?.color==="B") return {winner:"B", type:"infiltration"};
  // Nulle 50 coups sans capture
  if(msc>=50) return {winner:null, type:"draw"};
  return null;
}

// Appliquer un coup validé
export function applyMove(board, from, to){
  const nb = {...board};
  const isCapture = !!nb[to];
  nb[to] = {...nb[from]};
  delete nb[from];
  return {board:nb, isCapture};
}

