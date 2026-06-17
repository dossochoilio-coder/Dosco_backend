// ════════════════════════════════════════════════════════════════
// CLIENT MULTIJOUEUR DOSCO — à intégrer dans le jeu (DOSCO_Game_Mockup.jsx)
// Remplace la simulation en ligne par une vraie connexion serveur.
// ════════════════════════════════════════════════════════════════

const DOSCONet = {
  ws: null,
  token: null,
  uid: null,
  gameId: null,
  myColor: null,
  handlers: {},
  serverUrl: "" // Configurez votre serveur, ex: "wss://votre-domaine.com", // ⚠️ à remplacer par votre domaine

  // S'authentifier (REST) puis ouvrir le WebSocket
  async connect(playerName) {
    // 1. Auth REST
    const apiUrl = this.serverUrl.replace("wss://","https://").replace("ws://","http://");
    const res = await fetch(`${apiUrl}/api/auth`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ name: playerName })
    });
    const { token, user } = await res.json();
    this.token = token; this.uid = user.uid;

    // 2. WebSocket
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.serverUrl);
      this.ws.onopen = () => this._send("auth", { token });
      this.ws.onmessage = (e) => this._onMessage(JSON.parse(e.data), resolve);
      this.ws.onerror = () => reject(new Error("Connexion serveur échouée"));
      this.ws.onclose = () => this._emit("disconnected", {});
    });
  },

  _send(type, data) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type, ...data }));
  },

  _onMessage(msg, resolveConnect) {
    switch(msg.type) {
      case "authed": this.uid = msg.uid; resolveConnect?.(this.uid); break;
      case "searching": this._emit("searching", msg); break;
      case "game_start":
        this.gameId = msg.gameId; this.myColor = msg.color;
        this._emit("gameStart", msg); break;
      case "move": this._emit("move", msg); break;
      case "game_end": this._emit("gameEnd", msg); this.gameId = null; break;
      case "draw_offered": this._emit("drawOffered", msg); break;
      case "draw_declined": this._emit("drawDeclined", msg); break;
      case "error": this._emit("error", msg); break;
    }
  },

  // Chercher une partie avec une mise
  findMatch(stake = 0) { this._send("find_match", { stake }); },
  cancelSearch() { this._send("cancel_search", {}); },

  // Envoyer un coup (le serveur le validera)
  sendMove(from, to) { this._send("move", { gameId: this.gameId, from, to }); },
  resign() { this._send("resign", { gameId: this.gameId }); },
  offerDraw() { this._send("offer_draw", { gameId: this.gameId }); },
  respondDraw(accepted) { this._send("draw_response", { gameId: this.gameId, accepted }); },

  // Validation d'achat IAP via le serveur
  async validatePurchase(platform, receiptData, productId, extra = {}) {
    const apiUrl = this.serverUrl.replace("wss://","https://").replace("ws://","http://");
    const res = await fetch(`${apiUrl}/api/iap/validate`, {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${this.token}`},
      body: JSON.stringify({ platform, receiptData, productId, ...extra })
    });
    return res.json();
  },

  // Système d'événements
  on(event, cb) { this.handlers[event] = cb; },
  _emit(event, data) { this.handlers[event]?.(data); },

  disconnect() { this.ws?.close(); this.ws = null; }
};

// Exemple d'utilisation dans le jeu :
// await DOSCONet.connect("Commandant");
// DOSCONet.on("gameStart", ({color, opponent, board}) => { /* afficher le plateau */ });
// DOSCONet.on("move", ({board, turn}) => { /* mettre à jour le plateau */ });
// DOSCONet.on("gameEnd", ({winner, type, stake}) => { /* afficher le résultat */ });
// DOSCONet.findMatch(10); // chercher une partie avec mise de 10 étoiles
// DOSCONet.sendMove("B7", "B6");

if (typeof window !== "undefined") window.DOSCONet = DOSCONet;
export default DOSCONet;

