/**
 * Serveur Node.js pour Wuthering Waves PvP Draft
 * - Discord OAuth2 authentication
 * - Socket.IO pour le temps réel
 * - Stockage JSON persistant des box joueurs
 */
require('dotenv').config();


const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// ============================================
// CONFIGURATION
// ============================================

const PORT = process.env.PORT || 3001;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/auth/discord/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || "wuwa-pvp-secret-key-change-in-production";

// Fichier de stockage des données
const DATA_DIR = path.join(__dirname, "data");
const BOXES_FILE = path.join(DATA_DIR, "boxes.json");

// ============================================
// INITIALISATION
// ============================================

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Middleware
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 jours
    },
  })
);

// ============================================
// STOCKAGE JSON PERSISTANT
// ============================================

// Créer le dossier data s'il n'existe pas
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Charger les box depuis le fichier
function loadBoxes() {
  try {
    if (fs.existsSync(BOXES_FILE)) {
      const data = fs.readFileSync(BOXES_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Erreur chargement boxes:", error);
  }
  return {};
}

// Sauvegarder les box dans le fichier
function saveBoxes(boxes) {
  try {
    fs.writeFileSync(BOXES_FILE, JSON.stringify(boxes, null, 2));
  } catch (error) {
    console.error("Erreur sauvegarde boxes:", error);
  }
}

// Stockage en mémoire (chargé depuis le fichier au démarrage)
let playerBoxes = loadBoxes();

// ============================================
// ÉTAT DU JEU EN MÉMOIRE
// ============================================

// Map des utilisateurs connectés: socketId -> { discordId, username, avatar }
const connectedUsers = new Map();

// Map inverse: discordId -> socketId
const discordToSocket = new Map();

// État de la draft actuelle (une seule room pour simplifier)
let currentDraftState = null;
let draftRoom = {
  player1: null, // { discordId, username, socketId }
  player2: null,
  spectators: [],
};

// Configuration de la draft
let draftConfig = {
  gameMode: "whiwa",
  bansPhase1: 1,
  bansPhase2: 1,
  draftTimerMinutes: 5,
  draftTimerSeconds: 0,
  prepTimerMinutes: 7,
  balanceBans: 0,
  balanceBansPlayer: 1,
};

// ============================================
// DISCORD OAUTH2
// ============================================

// Redirection vers '/' (test)
app.get("/", (req, res) => {
  res.redirect('https://pvp-frontend-nu.vercel.app/');
});

// Redirection vers Discord OAuth
app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify",
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// Callback Discord OAuth
app.get("/auth/discord/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect(`${CLIENT_URL}?error=no_code`);
  }

  try {
    // Échanger le code contre un access token
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error("Token exchange failed");
    }

    const tokenData = await tokenResponse.json();

    // Récupérer les infos utilisateur Discord
    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!userResponse.ok) {
      throw new Error("User fetch failed");
    }

    const userData = await userResponse.json();

    // Stocker en session
    req.session.user = {
      discordId: userData.id,
      username: userData.username,
      avatar: userData.avatar
        ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
        : null,
    };

    res.redirect(`${CLIENT_URL}?auth=success`);
  } catch (error) {
    console.error("Discord OAuth error:", error);
    res.redirect(`${CLIENT_URL}?error=auth_failed`);
  }
});

// Vérifier la session
app.get("/auth/me", (req, res) => {
  if (req.session.user) {
    res.json({ user: req.session.user });
  } else {
    res.status(401).json({ error: "Non authentifié" });
  }
});

// Déconnexion
app.post("/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ============================================
// API REST POUR LES BOX
// ============================================

// Récupérer la box d'un joueur
app.get("/api/box/:discordId", (req, res) => {
  const { discordId } = req.params;
  const box = playerBoxes[discordId] || [];
  res.json({ box });
});

// ============================================
// SOCKET.IO - TEMPS RÉEL
// ============================================

io.on("connection", (socket) => {
  console.log(`Socket connecté: ${socket.id}`);

  // ----------------------------------------
  // AUTHENTIFICATION SOCKET
  // ----------------------------------------
  socket.on("auth:login", (userData) => {
    const { discordId, username, avatar } = userData;

    // Enregistrer l'utilisateur
    connectedUsers.set(socket.id, { discordId, username, avatar });
    discordToSocket.set(discordId, socket.id);

    console.log(`Utilisateur authentifié: ${username} (${discordId})`);

    // Charger et envoyer sa box
    const box = playerBoxes[discordId] || [];
    socket.emit("box:loaded", { box });

    // Envoyer l'état actuel de la room
    socket.emit("room:state", {
      player1: draftRoom.player1,
      player2: draftRoom.player2,
      draftState: currentDraftState,
      config: draftConfig,
    });
  });

  // ----------------------------------------
  // GESTION DES BOX
  // ----------------------------------------

  // Sauvegarder la box d'un joueur
  socket.on("box:save", (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) {
      socket.emit("error", { message: "Non authentifié" });
      return;
    }

    const { box } = data;
    playerBoxes[user.discordId] = box;
    saveBoxes(playerBoxes);

    socket.emit("box:saved", { success: true });
    console.log(`Box sauvegardée pour ${user.username}`);
  });

  // ----------------------------------------
  // GESTION DE LA ROOM
  // ----------------------------------------

  // Rejoindre en tant que joueur 1 ou 2
  socket.on("room:join", (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) {
      socket.emit("error", { message: "Non authentifié" });
      return;
    }

    const { slot } = data; // "player1" ou "player2"

    if (slot === "player1") {
      if (draftRoom.player1 && draftRoom.player1.discordId !== user.discordId) {
        socket.emit("error", { message: "Slot joueur 1 déjà occupé" });
        return;
      }
      draftRoom.player1 = { ...user, socketId: socket.id };
    } else if (slot === "player2") {
      if (draftRoom.player2 && draftRoom.player2.discordId !== user.discordId) {
        socket.emit("error", { message: "Slot joueur 2 déjà occupé" });
        return;
      }
      draftRoom.player2 = { ...user, socketId: socket.id };
    }

    // Notifier tous les clients
    io.emit("room:updated", {
      player1: draftRoom.player1,
      player2: draftRoom.player2,
    });

    console.log(`${user.username} a rejoint en tant que ${slot}`);
  });

  // Quitter un slot
  socket.on("room:leave", () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;

    if (draftRoom.player1?.discordId === user.discordId) {
      draftRoom.player1 = null;
    } else if (draftRoom.player2?.discordId === user.discordId) {
      draftRoom.player2 = null;
    }

    io.emit("room:updated", {
      player1: draftRoom.player1,
      player2: draftRoom.player2,
    });
  });

  // ----------------------------------------
  // CONFIGURATION DE LA DRAFT
  // ----------------------------------------

  socket.on("config:update", (config) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;

    // Seuls les joueurs peuvent modifier la config
    if (
      draftRoom.player1?.discordId !== user.discordId &&
      draftRoom.player2?.discordId !== user.discordId
    ) {
      socket.emit("error", { message: "Seuls les joueurs peuvent modifier la configuration" });
      return;
    }

    draftConfig = { ...draftConfig, ...config };
    io.emit("config:updated", draftConfig);
  });

  // ----------------------------------------
  // DRAFT - LOGIQUE CENTRALISÉE
  // ----------------------------------------

  // Démarrer la draft
  socket.on("draft:start", () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;

    // Vérifier que les deux joueurs sont présents
    if (!draftRoom.player1 || !draftRoom.player2) {
      socket.emit("error", { message: "Les deux joueurs doivent être présents" });
      return;
    }

    // Initialiser l'état de la draft
    currentDraftState = {
      phase: "ban1",
      currentPlayer: 1,
      bans: [],
      picks: [],
      player1Picks: [],
      player2Picks: [],
      currentPhase1BanCount: { player1: 0, player2: 0 },
      currentPhase2BanCount: { player1: 0, player2: 0 },
      currentPick1Count: { player1: 0, player2: 0 },
      currentPick2Count: { player1: 0, player2: 0 },
      balanceBansUsed: 0,
      timerStartedAt: Date.now(),
    };

    io.emit("draft:started", {
      draftState: currentDraftState,
      config: draftConfig,
    });

    console.log("Draft démarrée");
  });

  // Ban d'un personnage
  socket.on("draft:ban", (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;

    const { characterId } = data;

    // Vérifier que c'est bien le tour de ce joueur
    const playerNumber = getPlayerNumber(user.discordId);
    if (!playerNumber) {
      socket.emit("error", { message: "Vous n'êtes pas un joueur" });
      return;
    }

    if (!currentDraftState) {
      socket.emit("error", { message: "La draft n'a pas commencé" });
      return;
    }

    if (currentDraftState.currentPlayer !== playerNumber) {
      socket.emit("error", { message: "Ce n'est pas votre tour" });
      return;
    }

    if (!currentDraftState.phase.startsWith("ban")) {
      socket.emit("error", { message: "Ce n'est pas une phase de ban" });
      return;
    }

    // Vérifier que le personnage n'est pas déjà banni
    if (currentDraftState.bans.some((b) => b.characterId === characterId)) {
      socket.emit("error", { message: "Ce personnage est déjà banni" });
      return;
    }

    // Ajouter le ban
    const phase = currentDraftState.phase === "ban1" ? "phase1" : "phase2";
    currentDraftState.bans.push({
      characterId,
      phase,
      bannedBy: playerNumber,
    });

    // Mettre à jour les compteurs
    if (currentDraftState.phase === "ban1") {
      currentDraftState.currentPhase1BanCount[`player${playerNumber}`]++;
    } else {
      currentDraftState.currentPhase2BanCount[`player${playerNumber}`]++;
    }

    // Calculer le prochain état
    advanceDraftState();

    // Notifier tous les clients
    io.emit("draft:updated", { draftState: currentDraftState });
  });

  // Pick d'un personnage
  socket.on("draft:pick", (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;

    const { characterId } = data;

    const playerNumber = getPlayerNumber(user.discordId);
    if (!playerNumber) {
      socket.emit("error", { message: "Vous n'êtes pas un joueur" });
      return;
    }

    if (!currentDraftState) {
      socket.emit("error", { message: "La draft n'a pas commencé" });
      return;
    }

    if (currentDraftState.currentPlayer !== playerNumber) {
      socket.emit("error", { message: "Ce n'est pas votre tour" });
      return;
    }

    if (!currentDraftState.phase.startsWith("pick")) {
      socket.emit("error", { message: "Ce n'est pas une phase de pick" });
      return;
    }

    // Vérifier que le personnage n'est pas banni ou déjà pick
    if (currentDraftState.bans.some((b) => b.characterId === characterId)) {
      socket.emit("error", { message: "Ce personnage est banni" });
      return;
    }

    if (currentDraftState.picks.some((p) => p.characterId === characterId)) {
      socket.emit("error", { message: "Ce personnage est déjà sélectionné" });
      return;
    }

    // Ajouter le pick
    currentDraftState.picks.push({
      characterId,
      pickedBy: playerNumber,
      order: currentDraftState.picks.length + 1,
    });

    if (playerNumber === 1) {
      currentDraftState.player1Picks.push(characterId);
    } else {
      currentDraftState.player2Picks.push(characterId);
    }

    // Mettre à jour les compteurs
    if (currentDraftState.phase === "pick1") {
      currentDraftState[`currentPick1Count`][`player${playerNumber}`]++;
    } else {
      currentDraftState[`currentPick2Count`][`player${playerNumber}`]++;
    }

    // Calculer le prochain état
    advanceDraftState();

    // Notifier tous les clients
    io.emit("draft:updated", { draftState: currentDraftState });
  });

  // Reset la draft
  socket.on("draft:reset", () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;

    currentDraftState = null;
    io.emit("draft:reset");
  });

  // ----------------------------------------
  // DÉCONNEXION
  // ----------------------------------------

  socket.on("disconnect", () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      discordToSocket.delete(user.discordId);

      // Si c'était un joueur, le retirer de la room
      if (draftRoom.player1?.socketId === socket.id) {
        draftRoom.player1 = null;
        io.emit("room:updated", {
          player1: draftRoom.player1,
          player2: draftRoom.player2,
        });
      } else if (draftRoom.player2?.socketId === socket.id) {
        draftRoom.player2 = null;
        io.emit("room:updated", {
          player1: draftRoom.player1,
          player2: draftRoom.player2,
        });
      }

      console.log(`Utilisateur déconnecté: ${user.username}`);
    }

    connectedUsers.delete(socket.id);
  });
});

// ============================================
// FONCTIONS UTILITAIRES
// ============================================

function getPlayerNumber(discordId) {
  if (draftRoom.player1?.discordId === discordId) return 1;
  if (draftRoom.player2?.discordId === discordId) return 2;
  return null;
}

function advanceDraftState() {
  if (!currentDraftState) return;

  const { phase, currentPlayer } = currentDraftState;
  const { bansPhase1, bansPhase2, balanceBans, balanceBansPlayer } = draftConfig;

  // Logique de transition des phases
  switch (phase) {
    case "ban1": {
      const p1Bans = currentDraftState.currentPhase1BanCount.player1;
      const p2Bans = currentDraftState.currentPhase1BanCount.player2;
      const totalBansNeeded = bansPhase1 + (balanceBansPlayer === 1 ? balanceBans : 0);
      const p1Done = p1Bans >= (balanceBansPlayer === 1 ? totalBansNeeded : bansPhase1);
      const p2Done = p2Bans >= (balanceBansPlayer === 2 ? bansPhase1 + balanceBans : bansPhase1);

      if (p1Done && p2Done) {
        currentDraftState.phase = "pick1";
        currentDraftState.currentPlayer = 1;
      } else {
        // Alterner entre les joueurs
        currentDraftState.currentPlayer = currentPlayer === 1 ? 2 : 1;
        // Si le joueur suivant a fini ses bans, revenir à l'autre
        const nextP1Bans = currentDraftState.currentPhase1BanCount.player1;
        const nextP2Bans = currentDraftState.currentPhase1BanCount.player2;
        if (currentDraftState.currentPlayer === 1 && nextP1Bans >= (balanceBansPlayer === 1 ? totalBansNeeded : bansPhase1)) {
          currentDraftState.currentPlayer = 2;
        } else if (currentDraftState.currentPlayer === 2 && nextP2Bans >= (balanceBansPlayer === 2 ? bansPhase1 + balanceBans : bansPhase1)) {
          currentDraftState.currentPlayer = 1;
        }
      }
      break;
    }

    case "pick1": {
      const p1Picks = currentDraftState.currentPick1Count.player1;
      const p2Picks = currentDraftState.currentPick1Count.player2;

      if (p1Picks >= 3 && p2Picks >= 3) {
        currentDraftState.phase = "ban2";
        currentDraftState.currentPlayer = 1;
      } else {
        // Logique d'alternance: 1-2-2-1-1-2
        const totalPicks = p1Picks + p2Picks;
        if (totalPicks === 0) currentDraftState.currentPlayer = 1;
        else if (totalPicks === 1) currentDraftState.currentPlayer = 2;
        else if (totalPicks === 2) currentDraftState.currentPlayer = 2;
        else if (totalPicks === 3) currentDraftState.currentPlayer = 1;
        else if (totalPicks === 4) currentDraftState.currentPlayer = 1;
        else if (totalPicks === 5) currentDraftState.currentPlayer = 2;
      }
      break;
    }

    case "ban2": {
      const p1Bans = currentDraftState.currentPhase2BanCount.player1;
      const p2Bans = currentDraftState.currentPhase2BanCount.player2;

      if (p1Bans >= bansPhase2 && p2Bans >= bansPhase2) {
        currentDraftState.phase = "pick2";
        currentDraftState.currentPlayer = 2;
      } else {
        currentDraftState.currentPlayer = currentPlayer === 1 ? 2 : 1;
        // Vérifier si le joueur suivant a fini
        if (currentDraftState.currentPlayer === 1 && currentDraftState.currentPhase2BanCount.player1 >= bansPhase2) {
          currentDraftState.currentPlayer = 2;
        } else if (currentDraftState.currentPlayer === 2 && currentDraftState.currentPhase2BanCount.player2 >= bansPhase2) {
          currentDraftState.currentPlayer = 1;
        }
      }
      break;
    }

    case "pick2": {
      const p1Picks = currentDraftState.currentPick2Count.player1;
      const p2Picks = currentDraftState.currentPick2Count.player2;

      if (p1Picks >= 3 && p2Picks >= 3) {
        currentDraftState.phase = "complete";
      } else {
        // Logique d'alternance inverse: 2-1-1-2-2-1
        const totalPicks = p1Picks + p2Picks;
        if (totalPicks === 0) currentDraftState.currentPlayer = 2;
        else if (totalPicks === 1) currentDraftState.currentPlayer = 1;
        else if (totalPicks === 2) currentDraftState.currentPlayer = 1;
        else if (totalPicks === 3) currentDraftState.currentPlayer = 2;
        else if (totalPicks === 4) currentDraftState.currentPlayer = 2;
        else if (totalPicks === 5) currentDraftState.currentPlayer = 1;
      }
      break;
    }
  }
}

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║        Wuthering Waves PvP Draft Server                   ║
╠═══════════════════════════════════════════════════════════╣
║  Serveur démarré sur le port ${PORT}                          ║
║  Client URL: ${CLIENT_URL}                         ║
╚═══════════════════════════════════════════════════════════╝

Routes disponibles:
  - GET  /auth/discord          : Connexion Discord
  - GET  /auth/discord/callback : Callback OAuth
  - GET  /auth/me               : Session utilisateur
  - POST /auth/logout           : Déconnexion
  - GET  /api/box/:discordId    : Récupérer une box

Events Socket.IO:
  - auth:login    : Authentification socket
  - box:save      : Sauvegarder sa box
  - room:join     : Rejoindre un slot joueur
  - room:leave    : Quitter son slot
  - config:update : Modifier la config
  - draft:start   : Démarrer la draft
  - draft:ban     : Bannir un personnage
  - draft:pick    : Choisir un personnage
  - draft:reset   : Reset la draft
  `);
});
