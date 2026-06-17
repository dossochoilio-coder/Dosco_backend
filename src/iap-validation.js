// ════════════════════════════════════════════════════════════════
// VALIDATION SÉCURISÉE DES ACHATS IAP (côté serveur)
// JAMAIS faire confiance au client. Toujours valider le reçu
// auprès d'Apple / Google avant de créditer les étoiles.
// ════════════════════════════════════════════════════════════════


// Produits autorisés (la source de vérité est ici, pas chez le client)
export const PRODUCTS = {
  "dosco.starter":  { stars:100,  bonus:0,   type:"consumable" },
  "dosco.explorer": { stars:300,  bonus:50,  type:"consumable" },
  "dosco.champion": { stars:700,  bonus:150, type:"consumable" },
  "dosco.legend":   { stars:1500, bonus:500, type:"consumable" },
  "dosco.pass":     { stars:200,  bonus:0,   type:"non_consumable" },
};

// Anti-rejeu : un reçu déjà utilisé ne peut pas être recrédité
const usedReceipts = new Set(); // En prod : table en base de données

// ── Validation Apple App Store ──
// https://developer.apple.com/documentation/appstorereceipts/verifyreceipt
export async function validateApple(receiptData, isSandbox=false){
  const url = isSandbox
    ? "https://sandbox.itunes.apple.com/verifyReceipt"
    : "https://buy.itunes.apple.com/verifyReceipt";
  try {
    const res = await fetch(url, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        "receipt-data": receiptData,
        "password": process.env.APPLE_SHARED_SECRET || "", // App-specific shared secret
        "exclude-old-transactions": true,
      })
    });
    const data = await res.json();
    // Code 21007 = reçu sandbox envoyé en prod → réessayer en sandbox
    if(data.status === 21007 && !isSandbox){
      return validateApple(receiptData, true);
    }
    if(data.status !== 0){
      return { valid:false, error:`Apple status ${data.status}` };
    }
    // Extraire les achats
    const purchases = (data.receipt?.in_app || []).map(p => ({
      productId: p.product_id,
      transactionId: p.transaction_id,
      purchaseDate: p.purchase_date_ms,
    }));
    return { valid:true, purchases, platform:"apple" };
  } catch(e){
    return { valid:false, error:"Apple validation failed: "+e.message };
  }
}

// ── Validation Google Play ──
// Nécessite l'API Google Play Developer + compte de service OAuth2
export async function validateGoogle(packageName, productId, purchaseToken, accessToken){
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/products/${productId}/tokens/${purchaseToken}`;
  try {
    const res = await fetch(url, {
      headers:{ "Authorization":`Bearer ${accessToken}` }
    });
    if(!res.ok) return { valid:false, error:`Google HTTP ${res.status}` };
    const data = await res.json();
    // purchaseState: 0 = acheté, 1 = annulé, 2 = en attente
    if(data.purchaseState !== 0){
      return { valid:false, error:"Achat non confirmé" };
    }
    return {
      valid:true,
      platform:"google",
      purchases:[{ productId, transactionId:data.orderId, purchaseDate:data.purchaseTimeMillis }]
    };
  } catch(e){
    return { valid:false, error:"Google validation failed: "+e.message };
  }
}

// ── Point d'entrée : valider et créditer ──
export async function processPurchase({ platform, receiptData, productId, purchaseToken, packageName, googleAccessToken, userId }){
  // 1. Le produit doit exister
  const product = PRODUCTS[productId];
  if(!product) return { success:false, error:"Produit inconnu" };

  // 2. Valider auprès du store
  let result;
  if(platform === "apple"){
    result = await validateApple(receiptData);
  } else if(platform === "google"){
    result = await validateGoogle(packageName, productId, purchaseToken, googleAccessToken);
  } else {
    return { success:false, error:"Plateforme inconnue" };
  }

  if(!result.valid) return { success:false, error:result.error };

  // 3. Vérifier que le produit acheté correspond
  const match = result.purchases.find(p => p.productId === productId);
  if(!match) return { success:false, error:"Produit non trouvé dans le reçu" };

  // 4. Anti-rejeu (consommables uniquement — un non-consommable peut être restauré)
  const receiptKey = `${platform}:${match.transactionId}`;
  if(product.type === "consumable" && usedReceipts.has(receiptKey)){
    return { success:false, error:"Reçu déjà utilisé" };
  }
  usedReceipts.add(receiptKey);

  // 5. Créditer (en prod : transaction atomique en base)
  const starsToGrant = product.stars + product.bonus;
  return {
    success:true,
    productId,
    starsGranted: starsToGrant,
    transactionId: match.transactionId,
    isNonConsumable: product.type === "non_consumable",
  };
}

