// ════════════════════════════════════════════════════════════════
// RATE LIMITING — protection anti-abus / anti-bruteforce
// Fenêtre glissante en mémoire par IP. Léger, sans dépendance.
// (En cas de multi-instances, utiliser Redis ; ici suffisant pour 1 instance.)
// ════════════════════════════════════════════════════════════════

const buckets = new Map(); // clé → { count, resetAt }

// Nettoyage périodique des entrées expirées
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
}, 60000).unref?.();

function clientKey(req) {
  // Derrière un proxy (Railway/Render/Fly), l'IP réelle est dans x-forwarded-for
  const fwd = req.headers['x-forwarded-for'];
  const ip = (fwd ? fwd.split(',')[0].trim() : req.socket?.remoteAddress) || 'unknown';
  return ip;
}

/**
 * Crée un middleware de limitation.
 * @param {number} max  — nombre de requêtes autorisées par fenêtre
 * @param {number} windowMs — durée de la fenêtre en ms
 * @param {string} name — préfixe (pour cibler une route précise)
 */
export function rateLimit(max, windowMs, name = 'g') {
  return (req, res, next) => {
    const key = name + ':' + clientKey(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - b.count));
    if (b.count > max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', retry);
      return res.status(429).json({ error: 'Trop de requêtes, réessayez plus tard', retryAfter: retry });
    }
    next();
  };
}

