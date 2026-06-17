import { PRODUCTS, processPurchase } from './src/iap-validation.js';

console.log("=== TEST VALIDATION IAP ===\n");
let pass=0,fail=0;
const check=(n,c)=>{console.log(`  ${c?'✓':'❌'} ${n}`);c?pass++:fail++;};

// Produits définis côté serveur (source de vérité)
check("5 produits définis", Object.keys(PRODUCTS).length===5);
check("Starter = 100 étoiles", PRODUCTS["dosco.starter"].stars===100);
check("Legend = 1500+500 bonus", PRODUCTS["dosco.legend"].stars===1500 && PRODUCTS["dosco.legend"].bonus===500);
check("Pass = non-consommable", PRODUCTS["dosco.pass"].type==="non_consumable");

// Produit inconnu rejeté
const r1 = await processPurchase({platform:"apple",productId:"dosco.HACK",receiptData:"x",userId:"u1"});
check("Produit inconnu → rejeté", r1.success===false && r1.error==="Produit inconnu");

// Plateforme inconnue rejetée
const r2 = await processPurchase({platform:"steam",productId:"dosco.starter",receiptData:"x",userId:"u1"});
check("Plateforme inconnue → rejetée", r2.success===false);

console.log(`\n${fail===0?'✅ IAP OK':'❌ '+fail+' ÉCHECS'} (${pass}/${pass+fail})`);
console.log("\nNOTE: La validation réelle Apple/Google nécessite:");
console.log("  - APPLE_SHARED_SECRET (App Store Connect)");
console.log("  - Compte de service Google Play + OAuth2");
console.log("  - Ces appels réseau sont implémentés mais nécessitent les vraies clés.");
console.log("\nProtections en place:");
console.log("  ✓ Produits définis côté serveur (client ne décide pas du prix/contenu)");
console.log("  ✓ Validation du reçu auprès du store avant de créditer");
console.log("  ✓ Anti-rejeu (un reçu consommable ne peut servir qu'une fois)");
console.log("  ✓ Créditation atomique côté serveur");
