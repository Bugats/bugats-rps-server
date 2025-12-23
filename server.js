// ===== ZOLE (MVP) server — Bugats/thezone.lv =====
// Node + Express + Socket.IO
// - 3 spēlētāju istabas (0..2)
// - READY lobby (start, kad visi 3 ir "ready")
// - Aizsardzība pret dubult-seat / dubult-nick
// - Commit-Reveal (serverCommit + 3 clientSeed) -> deterministisks shuffle
// - GET / un GET /health lai nebūtu "Cannot GET /"

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const PORT = process.env.PORT || 10080;

// CORS_ORIGINS piemērs: "https://thezone.lv,https://www.thezone.lv,http://localhost:3000"
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Ja nav norādīts, atļaujam visu (MVP/dev). Ja ir norādīts, atļaujam tikai to sarakstu.
function isAllowedOrigin(origin) {
  if (!origin) return true; // curl / server-to-server / file://
  if (!CORS_ORIGINS.length) return true;
  return CORS_ORIGINS.includes(origin);
}

function sha256Hex(strOrBuf) {
  return crypto.createHash("sha256").update(strOrBuf).digest("hex");
}

function now() {
  return Date.now();
}

function safeUpperRoomId(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function genRoomId() {
  // 4..6 simboli, viegli runāt/ierakstīt
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const len = 4;
  let out = "";
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ===== Zoles kava (26) =====
// A,K,Q,J,10,9 visos mastos (24) + 8♦,7♦ (2)
const SUITS = [
  { k: "C", sym: "♣" },
  { k: "S", sym: "♠" },
  { k: "H", sym: "♥" },
  { k: "D", sym: "♦" }
];
const RANKS_6 = ["A", "K", "Q", "J", "10", "9"];

function buildDeck26() {
  const deck = [];
  for (const suit of SUITS) {
    for (const r of RANKS_6) {
      deck.push({ suit: suit.k, rank: r, label: `${r}${suit.sym}` });
    }
  }
  // + 8♦, 7♦
  deck.push({ suit: "D", rank: "8", label: `8♦` });
  deck.push({ suit: "D", rank: "7", label: `7♦` });
  return deck;
}

// ===== Deterministisks RNG (bez modulo bias) no seedHex =====
function makeDetRand(seedHex) {
  let counter = 0;

  function nextU32() {
    // sha256(seedHex + ":" + counter) -> pirmie 4 baiti
    const h = crypto.createHash("sha256");
    h.update(seedHex);
    h.update(":");
    h.update(String(counter++));
    const buf = h.digest();
    return buf.readUInt32BE(0);
  }

  function randInt(maxExclusive) {
    if (maxExclusive <= 0) return 0;
    const range = maxExclusive >>> 0;
    const maxU32 = 0x100000000; // 2^32
    const limit = Math.floor(maxU32 / range) * range;

    // rejection sampling
    while (true) {
      const r = nextU32();
      if (r < limit) return r % range;
    }
  }

  return { randInt };
}

function shuffleWithSeed(arr, seedHex) {
  const a = arr.slice();
  const rng = makeDetRand(seedHex);
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.randInt(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// ===== Istabu stāvoklis =====
const rooms = new Map(); // roomId -> room

function makeRoom(roomId) {
  return {
    roomId,
    createdAt: now(),
    updatedAt: now(),
    phase: "LOBBY", // LOBBY | DEALING | HAND
    handNo: 0,
    dealerSeat: 2, // sākam ar 2, lai pirmais "pa kreisi" būtu 0
    players: [
      { seat: 0, username: null, socketId: null, connected: false, ready: false },
      { seat: 1, username: null, socketId: null, connected: false, ready: false },
      { seat: 2, username: null, socketId: null, connected: false, ready: false }
    ],
    fairness: null, // { serverCommit, serverSeed, clientSeeds, combinedSeed, deckHash }
    hands: null, // { 0:[cards],1:[cards],2:[cards], talon:[cards], deck:[cards] }
    pendingSeeds: {} // seat -> clientSeed
  };
}

function getRoomStatePublic(room) {
  return {
    roomId: room.roomId,
    phase: room.phase,
    handNo: room.handNo,
    dealerSeat: room.dealerSeat,
    players: room.players.map((p) => ({
      seat: p.seat,
      username: p.username,
      ready: p.ready,
      connected: p.connected
    })),
    fairness: room.fairness
      ? {
          serverCommit: room.fairness.serverCommit,
          deckHash: room.fairness.deckHash || null
        }
      : null
  };
}

function broadcastRoomState(io, room) {
  io.to(room.roomId).emit("room:state", getRoomStatePublic(room));
}

function allSeatsFilled(room) {
  return room.players.every((p) => !!p.username);
}

function allReady(room) {
  return room.players.every((p) => !!p.username && p.ready === true && p.connected === true);
}

// ===== Deal loģika (4-4-4-2-4-4-4, sāk pa kreisi no dalītāja) =====
function dealZole(deck, dealerSeat) {
  const hands = { 0: [], 1: [], 2: [], talon: [] };

  const left = (dealerSeat + 1) % 3;
  const next = (dealerSeat + 2) % 3;
  const dealer = dealerSeat;

  let idx = 0;

  function take4(seat) {
    hands[seat].push(...deck.slice(idx, idx + 4));
    idx += 4;
  }

  take4(left);
  take4(next);
  take4(dealer);

  hands.talon.push(...deck.slice(idx, idx + 2));
  idx += 2;

  take4(left);
  take4(next);
  take4(dealer);

  return hands;
}

function startHand(io, room) {
  room.updatedAt = now();
  room.phase = "DEALING";
  room.handNo += 1;
  room.dealerSeat = (room.dealerSeat + 1) % 3;
  room.pendingSeeds = {};

  const serverSeed = crypto.randomBytes(32).toString("hex");
  const serverCommit = sha256Hex(serverSeed);

  room.fairness = {
    serverCommit,
    serverSeed: null, // atklāsim pēc tam, kad savāksim clientSeed
    clientSeeds: null,
    combinedSeed: null,
    deckHash: null
  };

  room.hands = null;

  // paziņojam, ka vajag seed (klients nosūtīs automātiski)
  io.to(room.roomId).emit("zole:needSeed", {
    roomId: room.roomId,
    handNo: room.handNo,
    dealerSeat: room.dealerSeat,
    serverCommit
  });

  broadcastRoomState(io, room);

  // saglabājam serverSeed lokāli (nevis fairness objektā publiski)
  room.__serverSeed = serverSeed;
  room.__serverCommit = serverCommit;
}

function tryDealWhenReady(io, room) {
  if (room.phase !== "LOBBY") return;
  if (!allSeatsFilled(room)) return;
  if (!allReady(room)) return;
  startHand(io, room);
}

function doDeal(io, room) {
  const serverSeed = room.__serverSeed;
  const serverCommit = room.__serverCommit;

  const clientSeeds = [room.pendingSeeds[0], room.pendingSeeds[1], room.pendingSeeds[2]];
  if (clientSeeds.some((s) => !s)) return;

  // kombinētais seed
  const combined = sha256Hex(`${serverSeed}|${clientSeeds[0]}|${clientSeeds[1]}|${clientSeeds[2]}|${room.handNo}`);

  const deck0 = buildDeck26();
  const deck = shuffleWithSeed(deck0, combined);

  const dealt = dealZole(deck, room.dealerSeat);

  // deck hash (lai var pārbaudīt)
  const deckStr = deck.map((c) => `${c.rank}${c.suit}`).join(",");
  const deckHash = sha256Hex(deckStr);

  room.hands = {
    0: dealt[0],
    1: dealt[1],
    2: dealt[2],
    talon: dealt.talon,
    deck
  };

  room.fairness = {
    serverCommit,
    serverSeed, // MVP: atklājam uzreiz (jo vēl nav spēles fāzes)
    clientSeeds,
    combinedSeed: combined,
    deckHash
  };

  room.phase = "HAND";
  room.updatedAt = now();

  // katram sūtam viņa roku
  for (const p of room.players) {
    if (!p.socketId) continue;
    const hand = room.hands[p.seat] || [];
    io.to(p.socketId).emit("zole:hand", {
      roomId: room.roomId,
      handNo: room.handNo,
      dealerSeat: room.dealerSeat,
      serverCommit,
      deckHash,
      cards: hand.map((c) => c.label)
    });
  }

  // fairness info visiem (MVP)
  io.to(room.roomId).emit("zole:fairness", {
    roomId: room.roomId,
    handNo: room.handNo,
    serverCommit,
    serverSeed,
    clientSeeds,
    combinedSeed: combined,
    deckHash,
    // MVP debug: arī talons
    talon: room.hands.talon.map((c) => c.label)
  });

  broadcastRoomState(io, room);
}

// ===== Express =====
const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    credentials: true
  })
);

app.get("/", (req, res) => {
  res.type("text").send("ZOLE server OK");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "zole", ts: now() });
});

const server = http.createServer(app);

// ===== Socket.IO =====
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    credentials: true
  }
});

// socket -> { roomId, seat }
const socketSeat = new Map();

function leaveCurrentRoom(socket) {
  const info = socketSeat.get(socket.id);
  if (!info) return;
  const { roomId, seat } = info;
  const room = rooms.get(roomId);
  socket.leave(roomId);
  socketSeat.delete(socket.id);

  if (room) {
    const p = room.players[seat];
    if (p && p.socketId === socket.id) {
      p.socketId = null;
      p.connected = false;
      p.ready = false;
    }
    room.updatedAt = now();
    broadcastRoomState(io, room);

    // ja istaba tukša, var tīrīt pēc brīža
    const anyConnected = room.players.some((x) => x.connected);
    const anyUsers = room.players.some((x) => x.username);
    if (!anyConnected && !anyUsers) {
      rooms.delete(roomId);
    }
  }
}

io.on("connection", (socket) => {
  socket.emit("srv:hello", { ok: true });

  socket.on("room:create", (payload = {}, cb) => {
    try {
      const username = String(payload.username || "").trim().slice(0, 20);
      if (!username) return cb?.({ ok: false, error: "Ievadi niku." });

      let roomId = safeUpperRoomId(payload.roomId);
      if (!roomId) roomId = genRoomId();

      // ja socket jau ir istabā, vispirms izmetam ārā
      leaveCurrentRoom(socket);

      let room = rooms.get(roomId);
      if (!room) {
        room = makeRoom(roomId);
        rooms.set(roomId, room);
      }

      // paņem pirmo brīvo seat
      const free = room.players.find((p) => !p.username);
      if (!free) return cb?.({ ok: false, error: "Istaba pilna." });

      // iestata spēlētāju
      free.username = username;
      free.socketId = socket.id;
      free.connected = true;
      free.ready = false;

      socket.join(roomId);
      socketSeat.set(socket.id, { roomId, seat: free.seat });

      room.updatedAt = now();
      broadcastRoomState(io, room);

      cb?.({ ok: true, roomId, seat: free.seat });
    } catch (e) {
      cb?.({ ok: false, error: "Servera kļūda (create)." });
    }
  });

  socket.on("room:join", (payload = {}, cb) => {
    try {
      const username = String(payload.username || "").trim().slice(0, 20);
      if (!username) return cb?.({ ok: false, error: "Ievadi niku." });

      const roomId = safeUpperRoomId(payload.roomId);
      if (!roomId) return cb?.({ ok: false, error: "Ievadi istabas kodu." });

      // ja socket jau ir istabā, vispirms izmetam ārā
      leaveCurrentRoom(socket);

      let room = rooms.get(roomId);
      if (!room) {
        // MVP: ja nav, izveidojam automātiski (vari atslēgt, ja gribi)
        room = makeRoom(roomId);
        rooms.set(roomId, room);
      }

      // ja šis niks jau ir istabā un ir CONNECTED -> bloķē
      const sameNick = room.players.find((p) => p.username === username);

      if (sameNick && sameNick.connected) {
        return cb?.({
          ok: false,
          error: "Šis niks jau ir istabā (atver citu logu ar citu niku vai gaidi reconnect)."
        });
      }

      // ja šis niks ir istabā, bet disconnected -> reclaim seat
      if (sameNick && !sameNick.connected) {
        sameNick.socketId = socket.id;
        sameNick.connected = true;
        sameNick.ready = false;

        socket.join(roomId);
        socketSeat.set(socket.id, { roomId, seat: sameNick.seat });

        room.updatedAt = now();
        broadcastRoomState(io, room);

        return cb?.({ ok: true, roomId, seat: sameNick.seat, reclaimed: true });
      }

      // citādi ņemam brīvu vietu
      const free = room.players.find((p) => !p.username);
      if (!free) return cb?.({ ok: false, error: "Istaba pilna." });

      free.username = username;
      free.socketId = socket.id;
      free.connected = true;
      free.ready = false;

      socket.join(roomId);
      socketSeat.set(socket.id, { roomId, seat: free.seat });

      room.updatedAt = now();
      broadcastRoomState(io, room);

      cb?.({ ok: true, roomId, seat: free.seat });
    } catch (e) {
      cb?.({ ok: false, error: "Servera kļūda (join)." });
    }
  });

  socket.on("zole:ready", (payload = {}, cb) => {
    const info = socketSeat.get(socket.id);
    if (!info) return cb?.({ ok: false, error: "Tu neesi istabā." });

    const room = rooms.get(info.roomId);
    if (!room) return cb?.({ ok: false, error: "Istaba nav atrasta." });

    const p = room.players[info.seat];
    if (!p || p.socketId !== socket.id) return cb?.({ ok: false, error: "Seat nav derīgs." });

    p.ready = !!payload.ready;
    room.updatedAt = now();
    broadcastRoomState(io, room);

    cb?.({ ok: true, ready: p.ready });

    // mēģinām startēt hand
    tryDealWhenReady(io, room);
  });

  socket.on("zole:seed", (payload = {}, cb) => {
    const info = socketSeat.get(socket.id);
    if (!info) return cb?.({ ok: false, error: "Tu neesi istabā." });

    const room = rooms.get(info.roomId);
    if (!room) return cb?.({ ok: false, error: "Istaba nav atrasta." });

    if (room.phase !== "DEALING") {
      return cb?.({ ok: false, error: "Šobrīd seed nav vajadzīgs." });
    }

    const seed = String(payload.clientSeed || "").trim();
    if (!/^[a-f0-9]{16,128}$/i.test(seed)) {
      return cb?.({ ok: false, error: "Nederīgs seed (hex)." });
    }

    // tikai vienreiz
    if (room.pendingSeeds[info.seat]) {
      return cb?.({ ok: true, already: true });
    }

    room.pendingSeeds[info.seat] = seed.toLowerCase();
    room.updatedAt = now();
    cb?.({ ok: true });

    // ja visi 3 seed ir, deal
    if (room.pendingSeeds[0] && room.pendingSeeds[1] && room.pendingSeeds[2]) {
      doDeal(io, room);
    }
  });

  socket.on("room:leave", (payload = {}, cb) => {
    leaveCurrentRoom(socket);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    // atzīmējam disconnected, bet username paliek (reconnect reclaim)
    const info = socketSeat.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomId);
    if (room) {
      const p = room.players[info.seat];
      if (p && p.socketId === socket.id) {
        p.socketId = null;
        p.connected = false;
        p.ready = false;
      }
      room.updatedAt = now();
      broadcastRoomState(io, room);
    }
    socketSeat.delete(socket.id);
  });
});

// Periodiska istabu tīrīšana
setInterval(() => {
  const cutoff = now() - 60 * 60 * 1000; // 1h
  for (const [rid, room] of rooms.entries()) {
    if (room.updatedAt < cutoff) rooms.delete(rid);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`[zole] listening on :${PORT}`);
});
