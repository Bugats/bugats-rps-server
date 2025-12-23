/* ============================
   THEZONE.LV — ZOLE MVP v1.2
   - 3 spēlētāju istabas + READY
   - Commit–reveal fairness: serverCommit + 3 clientSeeds -> deterministisks shuffle
   - Bidding: PASS / TAKE / ZOLE / MAZĀ / LIELĀ
   - TAKE: talons + atmešana (2)
   - PLAY: 8 stiķi + legal-move validācija
   - Punkti (lielie punkti / matchPts) pēc LV Wikipedia izmaksām:
     TAKE / ZOLE / MAZĀ (LIELĀ interpretēta kā "zole uz visiem" — jāpaņem visi 8 stiķi)
   - Avatāri: avatarUrl katram spēlētājam
   ============================ */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const PORT = process.env.PORT || 10080;

// CORS_ORIGINS piemērs Render env:
// https://thezone.lv,https://www.thezone.lv,http://localhost:5500
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = CORS_ORIGINS.length
  ? { origin: CORS_ORIGINS, credentials: true }
  : { origin: true, credentials: true };

const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: "256kb" }));

app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOptions.origin, credentials: true },
});

/* ============================
   KĀRTIS + NOTEIKUMI
   ============================ */

const SUIT_ICON = { C: "♣", S: "♠", H: "♥", D: "♦" };

// Kava: A,K,Q,J,10,9 visos mastos + 8♦,7♦
function buildDeck() {
  const deck = [];
  const base = ["A", "K", "Q", "J", "10", "9"];
  for (const s of ["C", "S", "H"]) {
    for (const r of base) deck.push({ r, s });
  }
  for (const r of ["A", "K", "Q", "J", "10", "9", "8", "7"]) deck.push({ r, s: "D" });
  return deck; // 26
}

// Punkti (acis)
const EYES = { A: 11, "10": 10, K: 4, Q: 3, J: 2, "9": 0, "8": 0, "7": 0 };
function cardEyes(c) {
  return EYES[c.r] ?? 0;
}

function isTrump(c) {
  return c.s === "D" || c.r === "Q" || c.r === "J";
}

// Īstā trumpju secība (validācijai; UI joslu nerādām)
const TRUMP_ORDER = [
  { r: "Q", s: "C" },
  { r: "Q", s: "S" },
  { r: "Q", s: "H" },
  { r: "Q", s: "D" },
  { r: "J", s: "C" },
  { r: "J", s: "S" },
  { r: "J", s: "H" },
  { r: "J", s: "D" },
  { r: "A", s: "D" },
  { r: "10", s: "D" },
  { r: "K", s: "D" },
  { r: "9", s: "D" },
  { r: "8", s: "D" },
  { r: "7", s: "D" }
];

function sameCard(a, b) {
  return a && b && a.r === b.r && a.s === b.s;
}

function cardKey(c) {
  return `${c.r}${c.s}`;
}

const TRUMP_INDEX = new Map(TRUMP_ORDER.map((c, i) => [cardKey(c), i]));
function trumpStrength(c) {
  return TRUMP_INDEX.get(cardKey(c));
}

// Ne-trump (parastie) - tikai A,10,K,9 (Q/J ir trumpji)
const NON_TRUMP_RANK = { A: 4, "10": 3, K: 2, "9": 1 };
function nonTrumpStrength(c) {
  return NON_TRUMP_RANK[c.r] ?? 0;
}

function leadFollowType(leadCard) {
  if (!leadCard) return null;
  return isTrump(leadCard) ? "TRUMP" : leadCard.s; // suit to follow
}

function hasFollow(hand, follow) {
  if (!follow) return false;
  if (follow === "TRUMP") return hand.some(isTrump);
  return hand.some((c) => !isTrump(c) && c.s === follow);
}

function isLegalPlay(hand, follow, c) {
  if (!follow) return true; // pirmais gājiens stiķī
  if (follow === "TRUMP") {
    const must = hasFollow(hand, "TRUMP");
    return must ? isTrump(c) : true;
  }
  const must = hasFollow(hand, follow);
  if (!must) return true;
  // jāspēlē konkrētais masts ar ne-trump kārti
  return !isTrump(c) && c.s === follow;
}

function pickTrickWinner(plays) {
  // plays: [{seat, card}] (3 gab.)
  const lead = plays[0].card;
  const anyTrump = plays.some((p) => isTrump(p.card));

  if (anyTrump) {
    // augstākais trumpis
    let best = plays[0];
    for (const p of plays) {
      if (!isTrump(p.card)) continue;
      if (!isTrump(best.card)) {
        best = p;
        continue;
      }
      const a = trumpStrength(p.card);
      const b = trumpStrength(best.card);
      if ((a ?? 999) < (b ?? 999)) best = p; // mazāks index = augstāks trumpis
    }
    return best.seat;
  }

  // nav trumpju => augstākais pēc lead masta
  let best = plays[0];
  for (const p of plays) {
    if (p.card.s !== lead.s) continue;
    if (nonTrumpStrength(p.card) > nonTrumpStrength(best.card)) best = p;
  }
  return best.seat;
}

/* ============================
   FAIR RNG (deterministisks)
   ============================ */

function sha256hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function seedToU32(hex) {
  // paņem 8 hex simbolus => 32-bit
  const h = hex.slice(0, 8);
  return parseInt(h, 16) >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleDeterministic(arr, seedHex) {
  const a = arr.slice();
  const rng = mulberry32(seedToU32(seedHex));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ============================
   ISTABAS / STĀVOKLIS
   ============================ */

const rooms = new Map(); // roomId -> room

function normRoomId(roomId) {
  return String(roomId || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function randomRoomId() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function safeUsername(u) {
  return String(u || "").trim().slice(0, 18);
}

function safeAvatarUrl(u) {
  const s = String(u || "").trim().slice(0, 300);
  if (!s) return "";
  try {
    const url = new URL(s);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function newRoom(roomId) {
  return {
    roomId,
    phase: "LOBBY",
    players: [
      { seat: 0, username: null, avatarUrl: "", ready: false, connected: false, socketId: null, seed: null, matchPts: 0 },
      { seat: 1, username: null, avatarUrl: "", ready: false, connected: false, socketId: null, seed: null, matchPts: 0 },
      { seat: 2, username: null, avatarUrl: "", ready: false, connected: false, socketId: null, seed: null, matchPts: 0 }
    ],
    dealerSeat: 0,
    handNo: 0,

    // fairness
    fairness: null, // { serverCommit, serverReveal, combinedHash }

    // bidding
    bids: [], // [{seat,bid}]
    bidTurnSeat: 0,
    contract: null, // TAKE/ZOLE/MAZĀ/LIELĀ
    bigSeat: null,

    // cards
    deck: null,
    hands: [[], [], []],
    talon: [],
    discard: [],
    taken: [[], [], []],

    // trick
    leaderSeat: null,
    turnSeat: null,
    trickPlays: [] // [{seat,card}]
  };
}

function getOrCreateRoom(roomId) {
  const id = normRoomId(roomId) || randomRoomId();
  if (!rooms.has(id)) rooms.set(id, newRoom(id));
  return rooms.get(id);
}

function roomHasAllPlayers(room) {
  return room.players.every((p) => !!p.username);
}

function roomAllReady(room) {
  return room.players.every((p) => !!p.username && p.ready);
}

function resetHandState(room) {
  room.fairness = null;
  room.bids = [];
  room.bidTurnSeat = (room.dealerSeat + 1) % 3;
  room.contract = null;
  room.bigSeat = null;

  room.deck = null;
  room.hands = [[], [], []];
  room.talon = [];
  room.discard = [];
  room.taken = [[], [], []];

  room.leaderSeat = null;
  room.turnSeat = null;
  room.trickPlays = [];
}

function startNewHand(room) {
  room.handNo += 1;
  room.phase = "BIDDING";
  resetHandState(room);

  // fairness: server commit tagad, reveal pēc sēklu savākšanas
  const serverReveal = crypto.randomBytes(16).toString("hex");
  const serverCommit = sha256hex(serverReveal);
  room.fairness = { serverCommit, serverReveal: null, combinedHash: null };

  // notīrām sēklas, lai katram jaunā partijā jāiesūta
  for (const p of room.players) p.seed = null;

  emitRoom(room, { note: "NEW_HAND" });
}

function dealIfReady(room) {
  // gaidām 3 sēklas
  if (!roomHasAllPlayers(room)) return false;
  if (!room.players.every((p) => typeof p.seed === "string" && p.seed.length > 0)) return false;

  const serverReveal = crypto.randomBytes(16).toString("hex");
  const serverCommit = room.fairness?.serverCommit || sha256hex(serverReveal);
  const combined = sha256hex(
    `${serverReveal}:${room.players[0].seed}:${room.players[1].seed}:${room.players[2].seed}`
  );

  room.fairness = { serverCommit, serverReveal, combinedHash: combined };

  const deck = shuffleDeterministic(buildDeck(), combined);
  room.deck = deck.slice();

  // izdalām: 8 + 8 + 8 + talons 2
  room.hands[0] = deck.slice(0, 8);
  room.hands[1] = deck.slice(8, 16);
  room.hands[2] = deck.slice(16, 24);
  room.talon = deck.slice(24, 26);

  room.leaderSeat = (room.dealerSeat + 1) % 3;
  room.turnSeat = room.bidTurnSeat; // bidding sākas no seat pa kreisi no dīlera
  return true;
}

function bidRank(bid) {
  // augstākais uzvar: LIELĀ > MAZĀ > ZOLE > TAKE > PASS
  const r = { PASS: 0, TAKE: 1, ZOLE: 2, "MAZĀ": 3, "LIELĀ": 4 };
  return r[bid] ?? 0;
}

function updateHighestBid(room) {
  let best = null;
  for (const b of room.bids) {
    if (!best || bidRank(b.bid) > bidRank(best.bid)) best = b;
  }
  return best;
}

function biddingDone(room) {
  // MVP: beidzam, kad ir 3 ieraksti bids (katrs nosolījis vienreiz)
  return room.bids.length >= 3;
}

function preparePlayPhase(room) {
  room.phase = "PLAY";
  room.trickPlays = [];
  room.leaderSeat = (room.dealerSeat + 1) % 3;
  room.turnSeat = room.leaderSeat;
}

function sumEyes(cards) {
  return cards.reduce((acc, c) => acc + cardEyes(c), 0);
}

function trickCount(cards) {
  return Math.floor(cards.length / 3);
}

/*
  IZMAKSAS (lielie punkti) pēc LV Wikipedia:
  - Parastā spēle (TAKE): 1/2/3 un 2/3/4 atkarībā no acīm/stiķiem
  - ZOLE: 5/6/7 un 6/7/8
  - Mazā zole: +6 / -7
  Avots: LV Wikipedia par “Zole/Zolīte” izmaksām. :contentReference[oaicite:1]{index=1}
*/
function applyPayout(room, bigSeat, pay, bigWins) {
  // big saņem no katra / maksā katram => neto 0-summa
  if (bigWins) {
    room.players[bigSeat].matchPts += pay * 2;
    for (const p of room.players) if (p.seat !== bigSeat) p.matchPts -= pay;
  } else {
    room.players[bigSeat].matchPts -= pay * 2;
    for (const p of room.players) if (p.seat !== bigSeat) p.matchPts += pay;
  }
}

function scoreHand(room) {
  const contract = room.contract;
  const bigSeat = room.bigSeat;

  const bigTaken = room.taken[bigSeat];
  const bigTricks = trickCount(bigTaken);

  const totalEyes = 120; // 26 kāršu summa
  const talonEyes = sumEyes(room.talon);
  const discardEyes = sumEyes(room.discard);

  let bigEyes = sumEyes(bigTaken);

  // TAKE: atmešana pieskaitās lielajam
  if (contract === "TAKE") bigEyes += discardEyes;

  // ZOLE/LIELĀ: talons paliek “mazajiem” (skaitās viņiem) => bigEyes neliekam klāt
  // MAZĀ: izmaksas nav atkarīgas no acīm

  const oppEyes = totalEyes - bigEyes;
  const oppTricks = 8 - bigTricks;

  let pay = 0;
  let bigWins = false;
  let note = "";

  if (contract === "TAKE") {
    bigWins = bigEyes >= 61;

    if (bigWins) {
      if (oppTricks === 0) pay = 3;
      else if (oppEyes < 30) pay = 2;
      else pay = 1;
    } else {
      if (bigTricks === 0) pay = 4;
      else if (bigEyes < 31) pay = 3;
      else pay = 2;
    }

    note = `TAKE: bigEyes=${bigEyes}, oppEyes=${oppEyes}, pay=${pay}, ${bigWins ? "WIN" : "LOSE"}`;
  }

  if (contract === "ZOLE") {
    bigWins = bigEyes >= 61;

    if (bigWins) {
      if (bigTricks === 8) pay = 7;
      else if (bigEyes >= 91) pay = 6;
      else pay = 5;
    } else {
      if (bigTricks === 0) pay = 8;
      else if (bigEyes < 31) pay = 7;
      else pay = 6;
    }

    note = `ZOLE: bigEyes=${bigEyes}, talonEyes=${talonEyes}, pay=${pay}, ${bigWins ? "WIN" : "LOSE"}`;
  }

  if (contract === "MAZĀ") {
    // Mazā zole: jāpaņem 0 stiķi
    bigWins = bigTricks === 0;
    pay = bigWins ? 6 : 7;
    note = `MAZĀ: bigTricks=${bigTricks}, pay=${pay}, ${bigWins ? "WIN" : "LOSE"}`;
  }

  if (contract === "LIELĀ") {
    // Interpretācija: “zole uz visiem” (jāpaņem visi 8 stiķi).
    // Win: kā zole (all tricks) pay=7; Lose: kā zole (no tricks worst-case) pay=8.
    bigWins = bigTricks === 8;
    pay = bigWins ? 7 : 8;
    note = `LIELĀ: bigTricks=${bigTricks}, pay=${pay}, ${bigWins ? "WIN" : "LOSE"}`;
  }

  applyPayout(room, bigSeat, pay, bigWins);

  room.phase = "SCORE";
  emitRoom(room, { note, scoring: { contract, bigSeat, bigEyes, oppEyes, talonEyes, discardEyes, bigTricks, pay, bigWins } });

  // nākamajai partijai atpakaļ uz LOBBY (READY atkal)
  room.phase = "LOBBY";
  for (const p of room.players) p.ready = false;

  // dīleris rotē
  room.dealerSeat = (room.dealerSeat + 1) % 3;

  resetHandState(room);
  emitRoom(room, { note: "BACK_TO_LOBBY" });
}

function computeLegalForSeat(room, seat) {
  if (room.phase !== "PLAY") return [];
  if (room.turnSeat !== seat) return [];
  const hand = room.hands[seat] || [];
  if (room.trickPlays.length === 0) return hand.slice();
  const lead = room.trickPlays[0]?.card;
  const follow = leadFollowType(lead);
  const must = hasFollow(hand, follow);
  if (!must) return hand.slice();
  if (follow === "TRUMP") return hand.filter(isTrump);
  return hand.filter((c) => !isTrump(c) && c.s === follow);
}

function publicPlayers(room) {
  return room.players.map((p) => ({
    seat: p.seat,
    username: p.username,
    avatarUrl: p.avatarUrl,
    ready: p.ready,
    connected: p.connected,
    matchPts: p.matchPts
  }));
}

function sanitizeStateForSeat(room, seat) {
  const me = room.players[seat] || null;

  return {
    roomId: room.roomId,
    phase: room.phase,
    handNo: room.handNo,

    dealerSeat: room.dealerSeat,

    // fairness (commit-reveal)
    fairness: room.fairness
      ? {
          serverCommit: room.fairness.serverCommit,
          serverReveal: room.fairness.serverReveal, // atklājam pēc deal
          combinedHash: room.fairness.combinedHash
        }
      : null,

    players: publicPlayers(room),

    // bidding
    bids: room.bids,
    bidTurnSeat: room.bidTurnSeat,
    contract: room.contract,
    bigSeat: room.bigSeat,

    // play
    leaderSeat: room.leaderSeat,
    turnSeat: room.turnSeat,
    trickPlays: room.trickPlays,

    // cards visibility
    mySeat: seat,
    myUsername: me?.username || null,
    myHand: room.hands[seat] || [],
    myTaken: room.taken[seat] || [],
    talon: room.contract === "TAKE" && room.bigSeat === seat ? room.talon : [],

    // discard redzams tikai lielajam (un tikai discard fāzē)
    myDiscard: room.bigSeat === seat ? room.discard : [],

    legal: computeLegalForSeat(room, seat),

    // debug īss kopsavilkums
    meta: {
      handSizes: room.hands.map((h) => h.length),
      takenTricks: room.taken.map((t) => trickCount(t))
    }
  };
}

function emitRoom(room, extra) {
  // emit katram seat personalizētu stāvokli
  for (const p of room.players) {
    if (!p.socketId) continue;
    const s = io.sockets.sockets.get(p.socketId);
    if (!s) continue;
    s.emit("room:state", sanitizeStateForSeat(room, p.seat), extra || null);
  }
}

/* ============================
   SOCKET.IO
   ============================ */

io.on("connection", (socket) => {
  socket.emit("server:hello", { ok: true, ts: Date.now() });

  socket.on("room:create", (payload, ack) => {
    try {
      const username = safeUsername(payload?.username);
      const avatarUrl = safeAvatarUrl(payload?.avatarUrl);
      const clientSeed = String(payload?.seed || "").trim();

      if (!username) return ack?.({ ok: false, error: "NICK_REQUIRED" });

      const roomId = normRoomId(payload?.roomId) || randomRoomId();
      const room = getOrCreateRoom(roomId);

      // atrodam brīvu seat vai atgūstam savu (ja bija disconnected ar to pašu nick)
      let seat = room.players.findIndex((p) => !p.username);
      if (seat === -1) {
        seat = room.players.findIndex((p) => p.username === username && !p.connected);
      }
      if (seat === -1) return ack?.({ ok: false, error: "ROOM_FULL" });

      room.players[seat].username = username;
      room.players[seat].avatarUrl = avatarUrl || room.players[seat].avatarUrl || "";
      room.players[seat].ready = false;
      room.players[seat].connected = true;
      room.players[seat].socketId = socket.id;
      room.players[seat].seed = clientSeed || room.players[seat].seed;

      socket.join(room.roomId);
      socket.data.roomId = room.roomId;
      socket.data.seat = seat;

      ack?.({ ok: true, roomId: room.roomId, seat });

      emitRoom(room, { note: "JOIN" });
    } catch (e) {
      ack?.({ ok: false, error: "CREATE_FAILED" });
    }
  });

  socket.on("room:join", (payload, ack) => {
    try {
      const username = safeUsername(payload?.username);
      const avatarUrl = safeAvatarUrl(payload?.avatarUrl);
      const clientSeed = String(payload?.seed || "").trim();

      const roomId = normRoomId(payload?.roomId);
      if (!roomId) return ack?.({ ok: false, error: "ROOM_REQUIRED" });
      if (!username) return ack?.({ ok: false, error: "NICK_REQUIRED" });

      const room = rooms.get(roomId);
      if (!room) return ack?.({ ok: false, error: "ROOM_NOT_FOUND" });

      let seat = room.players.findIndex((p) => !p.username);
      if (seat === -1) {
        seat = room.players.findIndex((p) => p.username === username && !p.connected);
      }
      if (seat === -1) return ack?.({ ok: false, error: "ROOM_FULL" });

      room.players[seat].username = username;
      room.players[seat].avatarUrl = avatarUrl || room.players[seat].avatarUrl || "";
      room.players[seat].ready = false;
      room.players[seat].connected = true;
      room.players[seat].socketId = socket.id;
      room.players[seat].seed = clientSeed || room.players[seat].seed;

      socket.join(room.roomId);
      socket.data.roomId = room.roomId;
      socket.data.seat = seat;

      ack?.({ ok: true, roomId: room.roomId, seat });

      emitRoom(room, { note: "JOIN" });
    } catch {
      ack?.({ ok: false, error: "JOIN_FAILED" });
    }
  });

  socket.on("room:leave", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;

    if (room && typeof seat === "number") {
      // atbrīvojam seat (MVP)
      room.players[seat] = {
        seat,
        username: null,
        avatarUrl: "",
        ready: false,
        connected: false,
        socketId: null,
        seed: null,
        matchPts: room.players[seat].matchPts // var saglabāt; te saglabājam punktus “seatā”
      };
      emitRoom(room, { note: "LEAVE" });
    }

    socket.leave(roomId || "");
    socket.data.roomId = null;
    socket.data.seat = null;
    ack?.({ ok: true });
  });

  // fairness seed (pieņemam vairākus event nosaukumus, lai frontam būtu tolerantāk)
  function setSeed(seedRaw) {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || typeof seat !== "number") return;

    const seed = String(seedRaw || "").trim().slice(0, 64);
    if (!seed) return;

    room.players[seat].seed = seed;
    emitRoom(room, { note: "SEED" });

    // ja jau bidding fāze un kāršu vēl nav, varam dealot
    if (room.phase === "BIDDING") {
      if (!room.deck) {
        const did = dealIfReady(room);
        if (did) emitRoom(room, { note: "DEAL_OK" });
      }
    }
  }
  socket.on("fair:seed", setSeed);
  socket.on("fair:clientSeed", setSeed);
  socket.on("seed", setSeed);

  socket.on("zole:ready", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || typeof seat !== "number") return ack?.({ ok: false, error: "NOT_IN_ROOM" });

    const ready = !!payload?.ready;
    room.players[seat].ready = ready;

    ack?.({ ok: true, ready });

    // ja visi ready => start hand
    if (room.phase === "LOBBY" && roomHasAllPlayers(room) && roomAllReady(room)) {
      startNewHand(room);
    } else {
      emitRoom(room, { note: "READY" });
    }
  });

  socket.on("zole:bid", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || typeof seat !== "number") return ack?.({ ok: false, error: "NOT_IN_ROOM" });

    if (room.phase !== "BIDDING") return ack?.({ ok: false, error: "NOT_BIDDING" });
    if (room.turnSeat !== seat) return ack?.({ ok: false, error: "NOT_YOUR_TURN" });

    // ja vēl nav kāršu, mēģinām dealot (sēklas)
    if (!room.deck) {
      const did = dealIfReady(room);
      if (!did) return ack?.({ ok: false, error: "WAIT_SEEDS" });
    }

    const bid = String(payload?.bid || "").toUpperCase();
    const allowed = new Set(["PASS", "TAKE", "ZOLE", "MAZĀ", "LIELĀ"]);
    if (!allowed.has(bid)) return ack?.({ ok: false, error: "BAD_BID" });

    // nepieļaujam 2x bid no tā paša seat MVP plūsmā
    if (room.bids.some((b) => b.seat === seat)) return ack?.({ ok: false, error: "ALREADY_BID" });

    room.bids.push({ seat, bid });

    // nākamais
    room.turnSeat = (room.turnSeat + 1) % 3;

    ack?.({ ok: true });

    // ja beidzās
    if (biddingDone(room)) {
      const best = updateHighestBid(room);

      if (!best || best.bid === "PASS") {
        // visi pass => atpakaļ LOBBY, ready atkal
        room.phase = "LOBBY";
        for (const p of room.players) p.ready = false;
        room.dealerSeat = (room.dealerSeat + 1) % 3;
        resetHandState(room);
        emitRoom(room, { note: "ALL_PASS" });
        return;
      }

      room.contract = best.bid;
      room.bigSeat = best.seat;

      // TAKE: lielais paņem talonu, atmet 2 (DISCARD)
      if (room.contract === "TAKE") {
        room.phase = "DISCARD";
        // uzreiz ieliekam talonu lielajam rokā (10)
        room.hands[room.bigSeat] = room.hands[room.bigSeat].concat(room.talon);
        room.turnSeat = room.bigSeat;
        emitRoom(room, { note: "TAKE_SELECTED" });
        return;
      }

      // ZOLE / MAZĀ / LIELĀ: uzreiz PLAY
      preparePlayPhase(room);
      emitRoom(room, { note: "CONTRACT_SELECTED" });
      return;
    }

    emitRoom(room, { note: "BID" });
  });

  socket.on("zole:discard", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || typeof seat !== "number") return ack?.({ ok: false, error: "NOT_IN_ROOM" });

    if (room.phase !== "DISCARD") return ack?.({ ok: false, error: "NOT_DISCARD" });
    if (room.bigSeat !== seat) return ack?.({ ok: false, error: "NOT_BIG" });

    const discard = Array.isArray(payload?.discard) ? payload.discard : [];
    if (discard.length !== 2) return ack?.({ ok: false, error: "NEED_2" });

    const hand = room.hands[seat] || [];
    const picked = [];

    for (const x of discard) {
      const c = normalizeCard(x);
      if (!c) return ack?.({ ok: false, error: "BAD_CARD" });

      const idx = hand.findIndex((h) => sameCard(h, c));
      if (idx === -1) return ack?.({ ok: false, error: "NOT_IN_HAND" });

      // noņemam no hand
      picked.push(hand.splice(idx, 1)[0]);
    }

    room.discard = picked;

    ack?.({ ok: true });

    // pēc atmešanas -> PLAY
    preparePlayPhase(room);
    emitRoom(room, { note: "DISCARD_OK" });
  });

  socket.on("zole:play", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || typeof seat !== "number") return ack?.({ ok: false, error: "NOT_IN_ROOM" });

    if (room.phase !== "PLAY") return ack?.({ ok: false, error: "NOT_PLAY" });
    if (room.turnSeat !== seat) return ack?.({ ok: false, error: "NOT_YOUR_TURN" });

    const c = normalizeCard(payload?.card);
    if (!c) return ack?.({ ok: false, error: "BAD_CARD" });

    const hand = room.hands[seat] || [];
    const idx = hand.findIndex((h) => sameCard(h, c));
    if (idx === -1) return ack?.({ ok: false, error: "NOT_IN_HAND" });

    // legal-move
    const follow = room.trickPlays.length ? leadFollowType(room.trickPlays[0].card) : null;
    if (!isLegalPlay(hand, follow, c)) return ack?.({ ok: false, error: "ILLEGAL" });

    // izspēlējam
    const played = hand.splice(idx, 1)[0];
    room.trickPlays.push({ seat, card: played });

    ack?.({ ok: true });

    // ja vēl nav 3 kārtis, nākamais seat
    if (room.trickPlays.length < 3) {
      room.turnSeat = (room.turnSeat + 1) % 3;
      emitRoom(room, { note: "PLAY" });
      return;
    }

    // stiķis pilns => nosakam uzvarētāju
    const winnerSeat = pickTrickWinner(room.trickPlays);
    for (const p of room.trickPlays) room.taken[winnerSeat].push(p.card);

    // jaunais stiķis: uzvarētājs sāk
    room.trickPlays = [];
    room.leaderSeat = winnerSeat;
    room.turnSeat = winnerSeat;

    emitRoom(room, { note: "TRICK_WIN", trickWinner: winnerSeat });

    // ja visi izspēlējuši 8 stiķus (kopā 24 kārtis), beidzam
    const totalTakenCards = room.taken.reduce((acc, t) => acc + t.length, 0);
    if (totalTakenCards >= 24) {
      // punktu skaitīšana
      scoreHand(room);
    }
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;

    if (room && typeof seat === "number" && room.players[seat]) {
      room.players[seat].connected = false;
      room.players[seat].socketId = null;
      room.players[seat].ready = false;
      emitRoom(room, { note: "DISCONNECT" });
    }
  });
});

function normalizeCard(x) {
  // pieņemam gan {r,s}, gan "10D" / "QD" utt.
  if (!x) return null;

  if (typeof x === "object" && x.r && x.s) {
    const r = String(x.r).toUpperCase();
    const s = String(x.s).toUpperCase();
    if (!["C", "S", "H", "D"].includes(s)) return null;
    return { r, s };
  }

  if (typeof x === "string") {
    const s = x.trim().toUpperCase();
    // 10D vai AD utt.
    const m = s.match(/^(10|[AKQJ9879])([CSHD])$/);
    if (!m) return null;
    return { r: m[1], s: m[2] };
  }

  return null;
}

server.listen(PORT, () => {
  console.log(`[zole] listening on :${PORT}`);
  console.log(`[zole] CORS_ORIGINS: ${CORS_ORIGINS.length ? CORS_ORIGINS.join(", ") : "ANY"}`);
});
