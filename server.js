// thezone-zole-server (MVP) — Bugats edition
// Online 3-player Zole with fairness: commit-reveal + deterministic Fisher-Yates shuffle
// Deck: A,K,Q,J,10,9 of all suits + 8♦,7♦ (26 cards)
// Trumps: all ♦ + all Q/J (any suit)
// Scoring: A=11,10=10,K=4,Q=3,J=2 else 0 ; solo wins if >=61

const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 10090;

const CORS_ORIGINS =
  process.env.CORS_ORIGINS ||
  "https://thezone.lv,https://www.thezone.lv,http://localhost:3000,http://127.0.0.1:5500,http://localhost:5500";

const ORIGINS = CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

// -------------------- Express --------------------
const app = express();

app.use(
  cors({
    origin(origin, cb) {
      // allow server-to-server / curl / no-origin
      if (!origin) return cb(null, true);
      if (ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked: " + origin));
    },
    credentials: true
  })
);

app.get("/", (req, res) => {
  res.type("text/plain").send("thezone-zole-server OK");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

const server = http.createServer(app);

// -------------------- Socket.IO --------------------
const io = new Server(server, {
  cors: {
    origin: ORIGINS,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// -------------------- Helpers --------------------
function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}
function randHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function normalizeRoomId(id) {
  return String(id || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 12);
}

function sanitizeUsername(u) {
  let s = String(u || "").trim();
  if (!s) s = "Guest";
  s = s.slice(0, 16);
  // allow letters/numbers/_/-
  try {
    s = s.replace(/[^\p{L}\p{N}_-]/gu, "");
  } catch {
    s = s.replace(/[^a-zA-Z0-9_-]/g, "");
  }
  if (!s) s = "Guest";
  return s;
}

// Deterministic PRNG from a string seed (sha256 -> uint32 -> mulberry32)
function seedToUint32(seedStr) {
  const h = crypto.createHash("sha256").update(seedStr).digest();
  return h.readUInt32LE(0);
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fisherYatesShuffle(arr, seedStr) {
  const rnd = mulberry32(seedToUint32(seedStr));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// -------------------- Cards / Rules --------------------
const SUITS = ["S", "H", "C", "D"]; // spades, hearts, clubs, diamonds
const RANKS_ALL = ["A", "K", "Q", "J", "10", "9"];
const RANKS_DIAMONDS_EXTRA = ["8", "7"];

function makeDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS_ALL) deck.push(`${r}${s}`);
  }
  deck.push("8D");
  deck.push("7D");
  // total 26
  return deck;
}

function parseCardId(cardId) {
  const s = cardId.slice(-1);
  const r = cardId.slice(0, -1);
  return { r, s, id: cardId };
}

function isTrump(card) {
  // all diamonds are trump; all queens/jacks (any suit) are trump
  return card.s === "D" || card.r === "Q" || card.r === "J";
}

const TRUMP_ORDER = [
  "QD",
  "QC",
  "QH",
  "QS",
  "JD",
  "JC",
  "JH",
  "JS",
  "AD",
  "10D",
  "KD",
  "9D",
  "8D",
  "7D"
];

function trumpWeight(cardId) {
  const idx = TRUMP_ORDER.indexOf(cardId);
  // higher is better
  return idx === -1 ? -1 : (TRUMP_ORDER.length - idx);
}

function nonTrumpWeight(card) {
  // for suit tricks: A > 10 > K > 9
  // Q/J should never be here because they are trump
  const map = { A: 4, "10": 3, K: 2, "9": 1 };
  return map[card.r] || 0;
}

function mustFollowSuit(handIds, leadCardId) {
  const lead = parseCardId(leadCardId);
  const leadIsTrump = isTrump(lead);

  const hand = handIds.map(parseCardId);

  if (leadIsTrump) {
    const haveTrump = hand.some(isTrump);
    return haveTrump ? { mode: "TRUMP" } : { mode: "ANY" };
  }

  // lead is non-trump suit
  const suit = lead.s;
  const haveSuit = hand.some((c) => !isTrump(c) && c.s === suit);
  return haveSuit ? { mode: "SUIT", suit } : { mode: "ANY" };
}

function isLegalPlay(handIds, leadCardId, playCardId) {
  if (!handIds.includes(playCardId)) return false;
  if (!leadCardId) return true; // leading any card is fine

  const rule = mustFollowSuit(handIds, leadCardId);
  const p = parseCardId(playCardId);

  if (rule.mode === "ANY") return true;
  if (rule.mode === "TRUMP") return isTrump(p);
  if (rule.mode === "SUIT") return !isTrump(p) && p.s === rule.suit;
  return true;
}

function trickWinner(trick) {
  // trick: [{seat, cardId}] length 3
  const leadId = trick[0].cardId;
  const lead = parseCardId(leadId);

  const anyTrump = trick.some((t) => isTrump(parseCardId(t.cardId)));
  if (anyTrump) {
    let best = trick[0];
    let bestW = trumpWeight(best.cardId);
    for (const t of trick.slice(1)) {
      const w = trumpWeight(t.cardId);
      if (w > bestW) {
        best = t;
        bestW = w;
      }
    }
    return best.seat;
  }

  // no trumps -> follow lead suit, best non-trump rank
  const suit = lead.s;
  let best = trick[0];
  let bestW = nonTrumpWeight(parseCardId(best.cardId));
  for (const t of trick.slice(1)) {
    const c = parseCardId(t.cardId);
    if (c.s !== suit) continue; // should not happen if legal, but safe
    const w = nonTrumpWeight(c);
    if (w > bestW) {
      best = t;
      bestW = w;
    }
  }
  return best.seat;
}

function cardPoints(cardId) {
  const c = parseCardId(cardId);
  if (c.r === "A") return 11;
  if (c.r === "10") return 10;
  if (c.r === "K") return 4;
  if (c.r === "Q") return 3;
  if (c.r === "J") return 2;
  return 0;
}

// -------------------- Rooms --------------------
const rooms = new Map();

function emptyRoom(roomId) {
  return {
    id: roomId,
    phase: "LOBBY", // LOBBY | SEED | BIDDING | TAKE_SKAT | DISCARD | PLAY | RESULT
    createdAt: Date.now(),
    handNo: 0,

    dealerSeat: 0,
    players: [
      { seat: 0, username: null, socketId: null, connected: false, ready: false, seed: null, hand: [], tricks: [] },
      { seat: 1, username: null, socketId: null, connected: false, ready: false, seed: null, hand: [], tricks: [] },
      { seat: 2, username: null, socketId: null, connected: false, ready: false, seed: null, hand: [], tricks: [] }
    ],

    // fairness
    commit: null,
    serverSeed: null, // revealed only after hand ends
    shuffleSeedHash: null,
    deckAtDeal: null, // revealed at end
    seedsAtReveal: null,

    // deal
    skatHidden: [],     // the 2 cards (hidden until solo takes)
    skatFinal: [],      // the 2 discarded cards (count for solo)
    soloSeat: null,

    // bidding
    bidTurnSeat: null,
    bids: { 0: null, 1: null, 2: null },

    // play
    leaderSeat: null,
    turnSeat: null,
    trickNo: 0,
    trick: [], // [{seat, cardId}]
    result: null,

    log: []
  };
}

function roomLog(room, msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  room.log.push(line);
  if (room.log.length > 200) room.log.shift();
  io.to(room.id).emit("zole:log", { line });
}

function publicRoomState(room) {
  const fairness =
    room.phase === "RESULT" && room.serverSeed
      ? {
          revealed: true,
          commit: room.commit,
          serverSeed: room.serverSeed,
          clientSeeds: room.seedsAtReveal,
          shuffleSeedHash: room.shuffleSeedHash,
          deckAtDeal: room.deckAtDeal
        }
      : {
          revealed: false,
          commit: room.commit
        };

  return {
    roomId: room.id,
    phase: room.phase,
    handNo: room.handNo,
    dealerSeat: room.dealerSeat,
    players: room.players.map((p) => ({
      seat: p.seat,
      username: p.username,
      ready: p.ready,
      connected: p.connected
    })),
    soloSeat: room.soloSeat,
    bids: room.bids,
    bidTurnSeat: room.bidTurnSeat,
    leaderSeat: room.leaderSeat,
    turnSeat: room.turnSeat,
    trickNo: room.trickNo,
    trick: room.trick,
    result: room.result,
    fairness
  };
}

function emitState(room) {
  io.to(room.id).emit("room:state", publicRoomState(room));
}

function emitHands(room) {
  for (const p of room.players) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit("zole:hand", {
      handNo: room.handNo,
      roomId: room.id,
      commit: room.commit,
      phase: room.phase,
      hand: p.hand
    });
  }
}

// -------------------- Game Flow --------------------
function allSeatedAndConnected(room) {
  return room.players.every((p) => p.username && p.connected);
}
function allReady(room) {
  return room.players.every((p) => p.username && p.connected && p.ready);
}

function resetForNewHand(room, keepReady = true) {
  room.phase = "LOBBY";
  room.commit = null;
  room.serverSeed = null;
  room.shuffleSeedHash = null;
  room.deckAtDeal = null;
  room.seedsAtReveal = null;

  room.skatHidden = [];
  room.skatFinal = [];
  room.soloSeat = null;

  room.bidTurnSeat = null;
  room.bids = { 0: null, 1: null, 2: null };

  room.leaderSeat = null;
  room.turnSeat = null;
  room.trickNo = 0;
  room.trick = [];
  room.result = null;

  for (const p of room.players) {
    p.seed = null;
    p.hand = [];
    p.tricks = [];
    if (!keepReady) p.ready = false;
  }
}

function startSeedPhase(room) {
  room.phase = "SEED";
  room.commit = null;
  room.serverSeed = null;
  room.shuffleSeedHash = null;
  room.deckAtDeal = null;
  room.seedsAtReveal = null;

  for (const p of room.players) p.seed = null;

  const serverSeed = randHex(32);
  const commit = sha256Hex(serverSeed);

  // keep serverSeed hidden until end
  room._serverSeedHidden = serverSeed;
  room.commit = commit;

  roomLog(room, `FAIRNESS commit: ${commit.slice(0, 16)}… (serverSeed atklāsies pēc partijas)`);
  emitState(room);

  // request seeds
  for (const p of room.players) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit("zole:seed_request", { roomId: room.id, handNo: room.handNo, commit });
  }
}

function tryDealIfSeedsReady(room) {
  if (room.phase !== "SEED") return;
  if (!room.players.every((p) => typeof p.seed === "string" && p.seed.length > 0)) return;

  // build deterministic shuffle seed from hidden serverSeed + all player seeds
  const serverSeed = room._serverSeedHidden;
  const s0 = room.players[0].seed;
  const s1 = room.players[1].seed;
  const s2 = room.players[2].seed;

  const combo = `${serverSeed}|${s0}|${s1}|${s2}|${room.handNo}|${room.id}`;
  const shuffleSeedHash = sha256Hex(combo);

  room.shuffleSeedHash = shuffleSeedHash;

  // shuffle
  const deck = makeDeck();
  const shuffled = fisherYatesShuffle(deck.slice(), shuffleSeedHash);

  // deal round-robin starting from forehand (left of dealer)
  const forehand = (room.dealerSeat + 1) % 3;

  // first 24 cards distributed round-robin, last 2 are skatHidden
  const hands = [[], [], []];
  for (let i = 0; i < 24; i++) {
    const seat = (forehand + (i % 3)) % 3;
    hands[seat].push(shuffled[i]);
  }
  room.skatHidden = [shuffled[24], shuffled[25]];

  for (const p of room.players) {
    p.hand = hands[p.seat];
    p.tricks = [];
  }

  room.phase = "BIDDING";
  room.soloSeat = null;
  room.bids = { 0: null, 1: null, 2: null };
  room.bidTurnSeat = forehand;

  room.leaderSeat = forehand;
  room.turnSeat = null;
  room.trickNo = 0;
  room.trick = [];
  room.result = null;

  roomLog(room, `Kārtis izdalītas. BIDDING sāk seat ${room.bidTurnSeat} (forehand).`);
  emitState(room);
  emitHands(room);
  promptBidTurn(room);
}

function promptBidTurn(room) {
  if (room.phase !== "BIDDING") return;
  const seat = room.bidTurnSeat;
  const p = room.players[seat];
  if (!p || !p.socketId) return;

  io.to(p.socketId).emit("zole:your_turn", {
    type: "BID",
    seat,
    canPass: true,
    canTake: true
  });

  io.to(room.id).emit("zole:info", { msg: `BID: gaida seat ${seat} (${p.username})` });
}

function advanceBidTurn(room) {
  // find next seat with bid=null
  for (let step = 1; step <= 3; step++) {
    const s = (room.bidTurnSeat + step) % 3;
    if (room.bids[s] === null) {
      room.bidTurnSeat = s;
      promptBidTurn(room);
      emitState(room);
      return;
    }
  }
}

function startTakeSkat(room, soloSeat) {
  room.phase = "TAKE_SKAT";
  room.soloSeat = soloSeat;
  room.bidTurnSeat = null;

  roomLog(room, `Soloists seat ${soloSeat} ŅEM. Talons nosūtīts soloistam.`);

  const solo = room.players[soloSeat];
  if (solo && solo.socketId) {
    io.to(solo.socketId).emit("zole:skat", {
      skat: room.skatHidden,
      msg: "Tu ņēmi. Tev ir talons (2 kārtis). Spied “Paņemt talonu”."
    });
    io.to(solo.socketId).emit("zole:your_turn", { type: "TAKE_SKAT", seat: soloSeat });
  }

  emitState(room);
}

function startDiscard(room) {
  room.phase = "DISCARD";
  const soloSeat = room.soloSeat;
  const solo = room.players[soloSeat];

  if (solo && solo.socketId) {
    io.to(solo.socketId).emit("zole:your_turn", { type: "DISCARD", seat: soloSeat });
  }

  roomLog(room, `Soloists izvēlas 2 kārtis atmešanai (skat).`);
  emitState(room);
  emitHands(room);
}

function startPlay(room) {
  room.phase = "PLAY";
  room.trickNo = 0;
  room.trick = [];
  room.turnSeat = room.leaderSeat;

  roomLog(room, `PLAY sākas. 1. gājienu dara seat ${room.turnSeat}.`);
  emitState(room);
  promptPlayTurn(room);
}

function promptPlayTurn(room) {
  if (room.phase !== "PLAY") return;
  const seat = room.turnSeat;
  const p = room.players[seat];
  if (!p || !p.socketId) return;

  // send lead card if exists
  const leadCardId = room.trick.length > 0 ? room.trick[0].cardId : null;

  io.to(p.socketId).emit("zole:your_turn", {
    type: "PLAY",
    seat,
    leadCardId
  });

  io.to(room.id).emit("zole:info", { msg: `GAIDI gājienu: seat ${seat} (${p.username})` });
}

function nextTurnSeat(room) {
  return (room.turnSeat + 1) % 3;
}

function finishTrick(room) {
  const winSeat = trickWinner(room.trick);
  const cards = room.trick.map((t) => t.cardId);

  room.players[winSeat].tricks.push(...cards);
  roomLog(room, `Stiķis #${room.trickNo + 1}: uzvar seat ${winSeat}.`);

  room.trick = [];
  room.trickNo += 1;

  if (room.trickNo >= 8) {
    finishHand(room);
    return;
  }

  room.leaderSeat = winSeat;
  room.turnSeat = winSeat;
  emitState(room);
  promptPlayTurn(room);
}

function finishHand(room) {
  room.phase = "RESULT";

  // Reveal fairness now (safe after hand ends)
  room.serverSeed = room._serverSeedHidden;
  room.seedsAtReveal = room.players.map((p) => p.seed);
  room.deckAtDeal = (() => {
    // allow public verification: show the exact shuffled deck order used at deal
    const combo = `${room.serverSeed}|${room.seedsAtReveal[0]}|${room.seedsAtReveal[1]}|${room.seedsAtReveal[2]}|${room.handNo}|${room.id}`;
    const hash = sha256Hex(combo);
    const deck = makeDeck();
    return fisherYatesShuffle(deck.slice(), hash);
  })();

  const solo = room.soloSeat;
  const soloPointsTricks = room.players[solo].tricks.reduce((a, id) => a + cardPoints(id), 0);
  const soloPointsSkat = room.skatFinal.reduce((a, id) => a + cardPoints(id), 0);
  const soloPoints = soloPointsTricks + soloPointsSkat;

  const total = 120; // fixed for this deck
  const defPoints = total - soloPoints;

  const soloWin = soloPoints >= 61;

  room.result = {
    soloSeat: solo,
    soloPoints,
    defPoints,
    soloWin,
    skat: room.skatFinal
  };

  roomLog(room, `REZULTĀTS: solo seat ${solo} punkti ${soloPoints} (skat ${soloPointsSkat}). ${soloWin ? "UZVAR" : "ZAUDĒ"}.`);
  roomLog(room, `FAIRNESS reveal: serverSeed atklāts (verifikācijai).`);

  emitState(room);

  // prepare next hand after short delay
  setTimeout(() => {
    room.handNo += 1;
    room.dealerSeat = (room.dealerSeat + 1) % 3;
    resetForNewHand(room, false); // require READY again
    roomLog(room, `Atpakaļ LOBBY. Nākamais dīleris: seat ${room.dealerSeat}.`);
    emitState(room);
    emitHands(room);
  }, 4500);
}

// -------------------- Seat Management --------------------
function findSeatByUsername(room, username) {
  return room.players.find((p) => p.username === username) || null;
}

function assignSeat(room, username, socketId) {
  // reconnect to same username seat if disconnected
  const existing = findSeatByUsername(room, username);
  if (existing) {
    if (existing.connected) return { ok: false, error: "Šis niks jau ir istabā. Izmanto citu niku." };
    existing.socketId = socketId;
    existing.connected = true;
    existing.ready = false;
    return { ok: true, seat: existing.seat, reconnected: true };
  }

  const free = room.players.find((p) => !p.username);
  if (!free) return { ok: false, error: "Istaba ir pilna (3/3)." };

  free.username = username;
  free.socketId = socketId;
  free.connected = true;
  free.ready = false;
  free.seed = null;
  free.hand = [];
  free.tricks = [];

  return { ok: true, seat: free.seat, reconnected: false };
}

function removeSeat(room, socketId) {
  const p = room.players.find((x) => x.socketId === socketId);
  if (!p) return null;

  // keep seat reserved but mark disconnected
  p.connected = false;
  p.socketId = null;
  p.ready = false;
  return p.seat;
}

// -------------------- Socket Handlers --------------------
io.on("connection", (socket) => {
  socket.data.username = null;
  socket.data.roomId = null;
  socket.data.seat = null;

  socket.emit("server:hello", { ok: true });

  socket.on("hello", (payload, ack) => {
    const username = sanitizeUsername(payload && payload.username);
    socket.data.username = username;
    if (ack) ack({ ok: true, username });
  });

  socket.on("room:create", (payload, ack) => {
    const username = sanitizeUsername(payload && payload.username) || socket.data.username;
    const roomId = normalizeRoomId(payload && payload.roomId);

    if (!roomId) return ack && ack({ ok: false, error: "Ievadi ROOM (piem., A1B2)." });

    if (!rooms.has(roomId)) {
      rooms.set(roomId, emptyRoom(roomId));
    }
    const room = rooms.get(roomId);

    const asn = assignSeat(room, username, socket.id);
    if (!asn.ok) return ack && ack(asn);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.seat = asn.seat;
    socket.data.username = username;

    roomLog(room, `${username} ienāca istabā (seat ${asn.seat})${asn.reconnected ? " (reconnect)" : ""}.`);
    emitState(room);
    emitHands(room);

    return ack && ack({ ok: true, roomId, seat: asn.seat });
  });

  socket.on("room:join", (payload, ack) => {
    const username = sanitizeUsername(payload && payload.username) || socket.data.username;
    const roomId = normalizeRoomId(payload && payload.roomId);

    if (!roomId) return ack && ack({ ok: false, error: "Ievadi ROOM (piem., A1B2)." });

    if (!rooms.has(roomId)) {
      // MVP: auto-create if missing
      rooms.set(roomId, emptyRoom(roomId));
    }
    const room = rooms.get(roomId);

    const asn = assignSeat(room, username, socket.id);
    if (!asn.ok) return ack && ack(asn);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.seat = asn.seat;
    socket.data.username = username;

    roomLog(room, `${username} pievienojās istabai (seat ${asn.seat})${asn.reconnected ? " (reconnect)" : ""}.`);
    emitState(room);
    emitHands(room);

    return ack && ack({ ok: true, roomId, seat: asn.seat });
  });

  socket.on("room:leave", (payload, ack) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms.has(roomId)) return ack && ack({ ok: true });

    const room = rooms.get(roomId);
    const seat = removeSeat(room, socket.id);
    socket.leave(roomId);

    if (seat !== null) roomLog(room, `${socket.data.username} aizgāja (seat ${seat}).`);

    socket.data.roomId = null;
    socket.data.seat = null;

    emitState(room);
    emitHands(room);

    return ack && ack({ ok: true });
  });

  socket.on("zole:ready", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    if (!roomId || seat === null) return ack && ack({ ok: false, error: "Nav istabas." });

    const room = rooms.get(roomId);
    const p = room.players[seat];
    if (!p) return ack && ack({ ok: false, error: "Seat error." });

    const ready = !!(payload && payload.ready);
    p.ready = ready;

    roomLog(room, `${p.username} READY=${ready}.`);
    emitState(room);

    // If all ready -> start seed phase (new hand)
    if (room.phase === "LOBBY" && allSeatedAndConnected(room) && allReady(room)) {
      startSeedPhase(room);
    }

    return ack && ack({ ok: true, ready });
  });

  socket.on("zole:seed", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    if (!roomId || seat === null) return ack && ack({ ok: false, error: "Nav istabas." });

    const room = rooms.get(roomId);
    if (room.phase !== "SEED") return ack && ack({ ok: false, error: "Šobrīd seed netiek prasīts." });

    const p = room.players[seat];
    if (!p) return ack && ack({ ok: false, error: "Seat error." });

    const seed = String(payload && payload.seed || "").trim().slice(0, 64);
    if (!seed) return ack && ack({ ok: false, error: "Seed tukšs." });

    p.seed = seed;
    roomLog(room, `${p.username} iedeva seed.`);
    emitState(room);

    tryDealIfSeedsReady(room);
    return ack && ack({ ok: true });
  });

  socket.on("zole:bid", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    if (!roomId || seat === null) return ack && ack({ ok: false, error: "Nav istabas." });

    const room = rooms.get(roomId);
    if (room.phase !== "BIDDING") return ack && ack({ ok: false, error: "Tagad nav BIDDING." });
    if (room.bidTurnSeat !== seat) return ack && ack({ ok: false, error: "Nav tavs gājiens (BID)." });

    const action = String(payload && payload.action || "").toUpperCase();
    if (!["PASS", "TAKE"].includes(action)) return ack && ack({ ok: false, error: "Bid action invalid." });

    room.bids[seat] = action;
    roomLog(room, `BID seat ${seat} (${room.players[seat].username}): ${action}`);

    if (action === "TAKE") {
      emitState(room);
      startTakeSkat(room, seat);
      return ack && ack({ ok: true });
    }

    // PASS
    const allDone = Object.values(room.bids).every((v) => v !== null);
    if (allDone) {
      roomLog(room, "Visi PASS. Pārizdale (next dealer).");
      room.handNo += 1;
      room.dealerSeat = (room.dealerSeat + 1) % 3;
      // keep ready true: but require new seeds
      resetForNewHand(room, true);
      emitState(room);
      startSeedPhase(room);
      return ack && ack({ ok: true });
    }

    advanceBidTurn(room);
    emitState(room);
    return ack && ack({ ok: true });
  });

  socket.on("zole:takeSkat", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    if (!roomId || seat === null) return ack && ack({ ok: false, error: "Nav istabas." });

    const room = rooms.get(roomId);
    if (room.phase !== "TAKE_SKAT") return ack && ack({ ok: false, error: "Tagad nav TAKE_SKAT." });
    if (room.soloSeat !== seat) return ack && ack({ ok: false, error: "Tikai soloists var ņemt talonu." });

    const solo = room.players[seat];
    solo.hand = solo.hand.concat(room.skatHidden);
    room.skatHidden = [];

    roomLog(room, `Soloists paņēma talonu. Rokā tagad ${solo.hand.length} kārtis.`);
    emitHands(room);
    emitState(room);
    startDiscard(room);

    return ack && ack({ ok: true });
  });

  socket.on("zole:discard", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    if (!roomId || seat === null) return ack && ack({ ok: false, error: "Nav istabas." });

    const room = rooms.get(roomId);
    if (room.phase !== "DISCARD") return ack && ack({ ok: false, error: "Tagad nav DISCARD." });
    if (room.soloSeat !== seat) return ack && ack({ ok: false, error: "Tikai soloists atmet." });

    const ids = (payload && payload.cardIds) || [];
    if (!Array.isArray(ids) || ids.length !== 2) return ack && ack({ ok: false, error: "Jāatmet tieši 2 kārtis." });

    const solo = room.players[seat];
    const unique = Array.from(new Set(ids.map(String)));
    if (unique.length !== 2) return ack && ack({ ok: false, error: "Kārtīm jābūt 2 dažādām." });

    if (!unique.every((id) => solo.hand.includes(id))) return ack && ack({ ok: false, error: "Atmest var tikai no savas rokas." });

    // remove from hand
    solo.hand = solo.hand.filter((x) => !unique.includes(x));
    room.skatFinal = unique.slice();

    roomLog(room, `Soloists atmeta 2 kārtis skat. Rokā palika ${solo.hand.length}.`);
    emitHands(room);
    emitState(room);

    startPlay(room);
    return ack && ack({ ok: true });
  });

  socket.on("zole:play", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    if (!roomId || seat === null) return ack && ack({ ok: false, error: "Nav istabas." });

    const room = rooms.get(roomId);
    if (room.phase !== "PLAY") return ack && ack({ ok: false, error: "Tagad nav PLAY." });
    if (room.turnSeat !== seat) return ack && ack({ ok: false, error: "Nav tavs gājiens." });

    const p = room.players[seat];
    const cardId = String(payload && payload.cardId || "");

    const leadCardId = room.trick.length > 0 ? room.trick[0].cardId : null;
    if (!isLegalPlay(p.hand, leadCardId, cardId)) return ack && ack({ ok: false, error: "Neleģāls gājiens (jāseko mastam / trumpim)." });

    // remove from hand, add to trick
    p.hand = p.hand.filter((x) => x !== cardId);
    room.trick.push({ seat, cardId });

    roomLog(room, `PLAY seat ${seat} (${p.username}) uzlika ${cardId}.`);
    emitHands(room);
    emitState(room);

    if (room.trick.length >= 3) {
      finishTrick(room);
      return ack && ack({ ok: true });
    }

    room.turnSeat = nextTurnSeat(room);
    emitState(room);
    promptPlayTurn(room);
    return ack && ack({ ok: true });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const seat = removeSeat(room, socket.id);
    if (seat !== null) roomLog(room, `${socket.data.username} atvienojās (seat ${seat}).`);

    emitState(room);
    emitHands(room);
  });
});

server.listen(PORT, () => {
  console.log("thezone-zole-server listening on", PORT);
});
