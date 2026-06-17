// Test des modules de durcissement (sans dépendances externes)
import { hashPassword, verifyPassword, validateName, validatePassword } from './src/auth.js';
import { rateLimit } from './src/rate-limit.js';
import { initStorage, saveUser, getUser, getUserByName, saveProgress, getProgress, receiptExists, saveReceipt, deleteUser, storageBackend } from './src/storage.js';

let pass=0, fail=0;
const ok=(n,c)=>{console.log(`  ${c?'✓':'❌'} ${n}`);c?pass++:fail++;};

console.log("=== AUTH (scrypt) ===");
const h = hashPassword("monMotDePasse123");
ok("Hash généré (salt:hash)", h.includes(':') && h.length>80);
ok("Bon mot de passe accepté", verifyPassword("monMotDePasse123", h)===true);
ok("Mauvais mot de passe rejeté", verifyPassword("mauvais", h)===false);
ok("Deux hash du même mdp diffèrent (salt)", hashPassword("x")!==hashPassword("x"));
ok("validateName('Jo') ok", validateName("Jo")===true);
ok("validateName('A') trop court", validateName("A")===false);
ok("validateName 15 chars rejeté", validateName("ABCDEFGHIJKLMNO")===false);
ok("validatePassword('12345') trop court", validatePassword("12345")===false);
ok("validatePassword('123456') ok", validatePassword("123456")===true);

console.log("\n=== STORAGE (fichier JSON) ===");
process.env.DATA_DIR = '/tmp/dosco_test_data';
await initStorage();
ok("Backend = file", storageBackend()==='file');
await saveUser({uid:"u1", name:"Alice", passHash:h, stars:100, wins:0, losses:0});
const u = await getUser("u1");
ok("Utilisateur sauvé et relu", u && u.name==="Alice" && u.stars===100);
const byName = await getUserByName("Alice");
ok("Recherche par nom", byName && byName.uid==="u1");
await saveUser({uid:"u1", name:"Alice", passHash:h, stars:250, wins:3, losses:1});
const u2 = await getUser("u1");
ok("Mise à jour solde (250)", u2.stars===250 && u2.wins===3);
await saveProgress("u1", {stars:250, wins:3, bestStreak:5}, {skins:["nebula"]});
const prog = await getProgress("u1");
ok("Progression sauvée", prog && prog.season.bestStreak===5 && prog.inventory.skins[0]==="nebula");

console.log("\n=== IAP anti-rejeu ===");
ok("Reçu inconnu = false", (await receiptExists("rcpt_1"))===false);
await saveReceipt("rcpt_1", "u1", "stars_500");
ok("Reçu enregistré = true", (await receiptExists("rcpt_1"))===true);

console.log("\n=== RGPD suppression ===");
await deleteUser("u1");
ok("Utilisateur supprimé", (await getUser("u1"))===null);
ok("Progression supprimée", (await getProgress("u1"))===null);

console.log("\n=== RATE LIMIT ===");
const mw = rateLimit(3, 10000, 'test');
let blocked=false, allowed=0;
const fakeRes=()=>({setHeader(){},status(c){this._c=c;return this;},json(){this._sent=true;return this;}});
const fakeReq={headers:{'x-forwarded-for':'1.2.3.4'},socket:{remoteAddress:'1.2.3.4'}};
for(let i=0;i<5;i++){const r=fakeRes();let nx=false;mw(fakeReq,r,()=>{nx=true;});if(nx)allowed++;if(r._c===429)blocked=true;}
ok("3 requêtes autorisées", allowed===3);
ok("4e+ requête bloquée (429)", blocked===true);

console.log(`\n${fail===0?'✅ DURCISSEMENT OK':'❌ '+fail+' ÉCHECS'} (${pass}/${pass+fail})`);
process.exit(fail===0?0:1);
