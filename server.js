const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const crypto = require("crypto");

const PORT = process.env.PORT || 10080;

// CORS: ņem no Render env "CORS_ORIGINS" kā CSV
const origins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true; // server-to-server / curl
  if (!origins.length) return true; // ja nav iestatīts, atļauj (dev)
  return origins.includes(origin);
}

const app = express();
app.set("trust proxy", process.env.TRUST_PROXY ? 1 : 0);

app.use(
  cors({
    origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
    credentials: true,
  })
);

app.get("/health", (req, res) => res.json({ ok: true }));

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: (origin, cb) => cb(null, isOriginAllowed(origin)),
    credentials: true,
  },
});

// ====== ZOLES MVP: istabas + super-random izdale ======

// Zoles kava (26 kārtis) — id formāts: "<suit><rank>"
// suits: C,S,H,D ; ranks: A,10,K,Q,J,9 + D8,D7
const BASE_DECK = [
  "CA","C10","CK","CQ","CJ","C9",
  "SA","S10","SK","SQ","SJ","S9",
  "HA","H10","HK","HQ","HJ","H9",
  "DA","D10","DK","DQ","DJ","D9","D8","D7"
];

const rooms = new Map(); // roomId -> roomState

function makeRoomId() {
  return crypto.randomBytes(2).toString("hex").toUpperCase(); // 4 hex
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Fisher–Yates ar crypto.randomInt = CSPRNG, bez bias
function shuffleCSPRNG(deck) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function publicRoomState(room) {
  return {
    roomId: room.roomId,
    phase: room.phase,
    players: room.players.map((p) => ({
      seat: p.seat,
      username: p.username,
      ready: p.ready,
      connected: !!p.socketId,
    })),
    dealerSeat: room.dealerSeat,
    handNo: room.handNo,
    fairness: room.fairness
      ? { commit: room.fairness.commit, handNo: room.handNo }
      : null,
  };
}

function emitRoom(room) {
  io.to(room.roomId).emit("zole:state", publicRoomState(room));
}

function startHand(room) {
  room.phase = "DEAL";
  room.handNo += 1;

  // “Godīgums”: commit pirms izdalīšanas (provably-fair pamats)
  const serverSeed = crypto.randomBytes(32);
  const commit = sha256Hex(serverSeed);
  room.fairness = { commit, serverSeed: serverSeed.toString("hex") };

  // Super random kava
  const deck = shuffleCSPRNG(BASE_DECK);

  // Dalīšana: 4 katram, 2 galdā, 4 katram
  // Sēdvietas secība no dealer+1
  const order = [0, 1, 2].map((i) => (room.dealerSeat + 1 + i) % 3);

  const hands = { 0: [], 1: [], 2: [] };
  let idx = 0;

  for (let r = 0; r < 4; r++) {
    for (const seat of order) hands[seat].push(deck[idx++]);
  }
  const talon = [deck[idx++], deck[idx++]];
  for (let r = 0; r < 4; r++) {
    for (const seat of order) hands[seat].push(deck[idx++]);
  }

  room.talon = talon;
  room.hands = hands;

  // Nosūti katram tikai viņa roku + commit (lai redz, ka izdale fiksēta)
  for (const p of room.players) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit("zole:hand", {
      roomId: room.roomId,
      handNo: room.handNo,
      commit: room.fairness.commit,
      hand: room.hands[p.seat],
      talonKnown: false, // lielajam vēlāk
    });
  }

  room.phase = "CHOOSE"; // nākamais būs kontrakta izvēle (V2)
  emitRoom(room);
}

// ====== Socket.IO ======
io.on("connection", (socket) => {
  socket.on("room:create", ({ username } = {}, cb) => {
    try {
      const roomId = makeRoomId();
      const room = {
        roomId,
        phase: "LOBBY",
        players: [
          { seat: 0, username: null, socketId: null, ready: false },
          { seat: 1, username: null, socketId: null, ready: false },
          { seat: 2, username: null, socketId: null, ready: false },
        ],
        dealerSeat: 2,
        handNo: 0,
        fairness: null,
        talon: null,
        hands: null,
      };
      rooms.set(roomId, room);

      // auto-join seat 0
      room.players[0].username = (username || "Player").slice(0, 24);
      room.players[0].socketId = socket.id;

      socket.join(roomId);
      emitRoom(room);

      cb && cb({ ok: true, roomId, seat: 0 });
    } catch (e) {
      cb && cb({ ok: false, error: "ROOM_CREATE_FAILED" });
    }
  });

  socket.on("room:join", ({ roomId, username } = {}, cb) => {
    try {
      roomId = (roomId || "").toUpperCase().trim();
      const room = rooms.get(roomId);
      if (!room) return cb && cb({ ok: false, error: "ROOM_NOT_FOUND" });

      const free = room.players.find((p) => !p.socketId);
      if (!free) return cb && cb({ ok: false, error: "ROOM_FULL" });

      free.username = (username || "Player").slice(0, 24);
      free.socketId = socket.id;
      free.ready = false;

      socket.join(roomId);
      emitRoom(room);

      cb && cb({ ok: true, roomId, seat: free.seat });
    } catch (e) {
      cb && cb({ ok: false, error: "ROOM_JOIN_FAILED" });
    }
  });

  socket.on("zole:ready", ({ roomId, ready } = {}, cb) => {
    try {
      roomId = (roomId || "").toUpperCase().trim();
      const room = rooms.get(roomId);
      if (!room) return cb && cb({ ok: false, error: "ROOM_NOT_FOUND" });

      const me = room.players.find((p) => p.socketId === socket.id);
      if (!me) return cb && cb({ ok: false, error: "NOT_IN_ROOM" });

      me.ready = !!ready;
      emitRoom(room);

      const allConnected = room.players.every((p) => !!p.socketId);
      const allReady = room.players.every((p) => p.ready);

      if (room.phase === "LOBBY" && allConnected && allReady) {
        startHand(room);
      }

      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ ok: false, error: "READY_FAILED" });
    }
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const p = room.players.find((x) => x.socketId === socket.id);
      if (!p) continue;

      p.socketId = null;
      p.ready = false;

      // ja spēle vēl nav sākusies, atbrīvo vietu
      // (V2: varam pielikt reconnect 30s + forfeit/BOT takeover)
      emitRoom(room);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log("ZOLE server listening on", PORT);
});
