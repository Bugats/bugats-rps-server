/* =========================
   THEZONE — ZOLE SERVER (MVP+ UI-ready)
   - 3-spēlētāju istabas
   - READY lobby
   - commit-reveal fairness (server commit + 3 client seeds -> deterministisks shuffle)
   - BIDDING: PASS/TAKE (MVP)
   - SKAT: soloists paņem talonu un atmet 2
   - PLAY: 8 stiķi, servera validācija + punktu skaitīšana
   - Public state + privātā roka katram spēlētājam
   ========================= */

const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const { Server } = require("socket.io");

// ====== ENV ======
const PORT = process.env.PORT || 10080;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "https://thezone.lv,https://www.thezone.lv,http://localhost:5173,http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function safeStr(s, max = 32) {
  return String(s || "").trim().slice(0, max);
}

function safeRoomId(s) {
  return safeStr(s, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function nowMs() {
  return Date.now();
}

// ====== CARD MODEL ======
/**
 * Card ID format: e.g. "QH", "10D", "8D"
 * suits: C,S,H,D
 * ranks: A,K,Q,J,10,9 (+ 8D,7D only)
 */

const SUIT_SYMBOL = { C: "♣", S: "♠", H: "♥", D: "♦" };
const SUIT_NAME = { C: "CLUBS", S: "SPADES", H: "HEARTS", D: "DIAMONDS" };

const BASE_RANKS = ["A", "K", "Q", "J", "10", "9"];

function makeDeck() {
  const deck = [];
  for (const s of ["C", "S", "H", "D"]) {
    for (const r of BASE_RANKS) deck.push(cardId(r, s));
  }
  // papildus 8♦ un 7♦
  deck.push(cardId("8", "D"));
  deck.push(cardId("7", "D"));
  // kopā 26
  return deck;
}

function cardId(rank, suit) {
  return `${rank}${suit}`;
}

function parseCardId(id) {
  const s = String(id || "").trim().toUpperCase();
  if (!s) return null;

  // "10D" vai "QH" vai "8D"
  let suit = s.slice(-1);
  let rank = s.slice(0, -1);

  if (!SUIT_SYMBOL[suit]) return null;
  if (rank === "8" || rank === "7") {
    if (suit !== "D") return null; // tikai 8D/7D
  } else if (!BASE_RANKS.includes(rank)) {
    return null;
  }

  return { id: s, rank, suit };
}

// ====== ZOLE TRUMPS & RANKING ======
// Trumps: all Queens + all Jacks + all Diamonds
function isTrump(card) {
  if (!card) return false;
  const { rank, suit } = typeof card === "string" ? parseCardId(card) || {} : card;
  if (!rank || !suit) return false;
  if (rank === "Q" || rank === "J") return true;
  if (suit === "D") return true;
  return false;
}

// Trump order (highest -> lowest):
// Q♣ Q♠ Q♥ Q♦ J♣ J♠ J♥ J♦ A♦ 10♦ K♦ 9♦ 8♦ 7♦
const TRUMP_ORDER = [
  "QC", "QS", "QH", "QD",
  "JC", "JS", "JH", "JD",
  "AD", "10D", "KD", "9D", "8D", "7D"
];
const TRUMP_RANK = new Map(TRUMP_ORDER.map((id, idx) => [id, TRUMP_ORDER.length - idx])); // higher number = stronger

// Non-trump suit order: A 10 K Q J 9
const SUIT_ORDER = ["A", "10", "K", "Q", "J", "9"];
const SUIT_RANK = new Map(SUIT_ORDER.map((r, idx) => [r, SUIT_ORDER.length - idx]));

// For following suit: if lead is non-trump suit C/S/H, only non-trump cards of that suit count as "suit"
function isPureSuitCard(card, suit) {
  const c = typeof card === "string" ? parseCardId(card) : card;
  if (!c) return false;
  if (c.suit !== suit) return false;
  if (isTrump(c)) return false; // Q/J are trumps, not suit-follow
  return true;
}

function getLegalCards(handIds, trick) {
  // trick: { leadSeat, leadCardId, leadSuit, cards:[{seat, cardId}] }
  const hand = (handIds || []).filter(Boolean);

  if (!trick || !trick.cards || trick.cards.length === 0) {
    return new Set(hand);
  }

  const leadCardId = trick.cards[0]?.cardId || trick.leadCardId;
  const leadCard = parseCardId(leadCardId);
  if (!leadCard) return new Set(hand);

  const leadIsTrump = isTrump(leadCard);
  const leadSuit = leadIsTrump ? null : leadCard.suit;

  if (leadIsTrump) {
    // jāmet trumpis, ja ir
    const trumps = hand.filter((id) => isTrump(parseCardId(id)));
    if (trumps.length > 0) return new Set(trumps);
    return new Set(hand);
  } else {
    // jāseko mastam, ja ir tīras (ne-trump) kārtis šajā mastā
    const suitCards = hand.filter((id) => isPureSuitCard(parseCardId(id), leadSuit));
    if (suitCards.length > 0) return new Set(suitCards);
    return new Set(hand);
  }
}

function compareCardsForTrick(aId, bId, leadCardId) {
  // returns >0 if a wins over b in same trick context
  const a = parseCardId(aId);
  const b = parseCardId(bId);
  const lead = parseCardId(leadCardId);
  if (!a || !b || !lead) return 0;

  const aTrump = isTrump(a);
  const bTrump = isTrump(b);
  const leadTrump = isTrump(lead);
  const leadSuit = leadTrump ? null : lead.suit;

  if (aTrump && bTrump) {
    return (TRUMP_RANK.get(a.id) || 0) - (TRUMP_RANK.get(b.id) || 0);
  }
  if (aTrump && !bTrump) return 1;
  if (!aTrump && bTrump) return -1;

  // neither trump
  // only lead suit matters
  if (a.suit === leadSuit && b.suit !== leadSuit) return 1;
  if (a.suit !== leadSuit && b.suit === leadSuit) return -1;
  if (a.suit !== leadSuit && b.suit !== leadSuit) return 0;

  // same lead suit
  return (SUIT_RANK.get(a.rank) || 0) - (SUIT_RANK.get(b.rank) || 0);
}

function cardPoints(cardIdStr) {
  const c = parseCardId(cardIdStr);
  if (!c) return 0;
  switch (c.rank) {
    case "A": return 11;
    case "10": return 10;
    case "K": return 4;
    case "Q": return 3;
    case "J": return 2;
    default: return 0; // 9,8,7
  }
}

// ====== SEEDED RNG (deterministic shuffle) ======
function xfnv1a(str) {
  // 32-bit hash
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleDeterministic(arr, seedStr) {
  const a = arr.slice();
  const seed = xfnv1a(seedStr);
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ====== ROOMS ======
/**
 * rooms Map: roomId -> room
 * room = {
 *   roomId,
 *   createdAt,
 *   handNo,
 *   dealerSeat,
 *   phase, // LOBBY | SEED | BIDDING | SKAT | DISCARD | PLAY | SCORE
 *   players: [ { seat, socketId, username, connected, ready, seed, bid } ],
 *   fairness: { serverCommit, serverReveal, finalSeed },
 *   deck: [],
 *   hands: {0:[],1:[],2:[]},
 *   skat: [],
 *   soloistSeat,
 *   discards: [], // 2 cards discarded by soloist
 *   currentTurnSeat,
 *   trickNo, // 0..7
 *   trick: { leadSeat, cards:[{seat, cardId}] },
 *   won: {0:[],1:[],2:[]}, // cards won
 *   points: {0:0,1:0,2:0},
 *   lastTrickWinnerSeat,
 *   lastTrickCards,
 *   log: []
 * }
 */

const rooms = new Map();

function makeEmptyPlayers() {
  return [0, 1, 2].map((seat) => ({
    seat,
    socketId: null,
    username: null,
    connected: false,
    ready: false,
    seed: null,
    bid: null
  }));
}

function roomLog(room, msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  room.log.push(line);
  if (room.log.length > 200) room.log.shift();
}

function getPublicState(room) {
  return {
    roomId: room.roomId,
    phase: room.phase,
    handNo: room.handNo,
    dealerSeat: room.dealerSeat,
    players: room.players.map((p) => ({
      seat: p.seat,
      username: p.username,
      connected: p.connected,
      ready: p.ready,
      bid: p.bid
    })),
    fairness: {
      serverCommit: room.fairness?.serverCommit || null,
      serverReveal: room.fairness?.serverReveal || null,
      finalSeed: room.fairness?.finalSeed || null
    },
    soloistSeat: room.soloistSeat,
    currentTurnSeat: room.currentTurnSeat,
    trickNo: room.trickNo,
    trick: room.trick ? {
      leadSeat: room.trick.leadSeat,
      cards: room.trick.cards.map((c) => ({ seat: c.seat, cardId: c.cardId }))
    } : null,
    points: room.points,
    lastTrickWinnerSeat: room.lastTrickWinnerSeat ?? null,
    lastTrickCards: room.lastTrickCards ?? null
  };
}

function emitRoom(room, io) {
  io.to(room.roomId).emit("room:state", getPublicState(room));
  io.to(room.roomId).emit("room:log", room.log.slice(-80));
  // send private hands
  for (const p of room.players) {
    if (p.socketId && p.connected) {
      const hand = room.hands[p.seat] || [];
      io.to(p.socketId).emit("your:hand", hand);
    }
  }
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    const room = {
      roomId,
      createdAt: nowMs(),
      handNo: 0,
      dealerSeat: 0,
      phase: "LOBBY",
      players: makeEmptyPlayers(),
      fairness: null,
      deck: [],
      hands: { 0: [], 1: [], 2: [] },
      skat: [],
      soloistSeat: null,
      discards: [],
      currentTurnSeat: null,
      trickNo: 0,
      trick: null,
      won: { 0: [], 1: [], 2: [] },
      points: { 0: 0, 1: 0, 2: 0 },
      lastTrickWinnerSeat: null,
      lastTrickCards: null,
      log: []
    };
    rooms.set(roomId, room);
  }
  return rooms.get(roomId);
}

function findEmptySeat(room) {
  return room.players.find((p) => !p.username)?.seat ?? null;
}

function seatOfSocket(room, socketId) {
  const p = room.players.find((x) => x.socketId === socketId);
  return p ? p.seat : null;
}

function resetForNewHand(room) {
  room.handNo += 1;
  room.phase = "SEED";
  room.players.forEach((p) => {
    p.ready = false;      // pēc partijas atpakaļ lobby -> atkal ready
    p.seed = null;
    p.bid = null;
  });
  room.fairness = null;
  room.deck = [];
  room.hands = { 0: [], 1: [], 2: [] };
  room.skat = [];
  room.soloistSeat = null;
  room.discards = [];
  room.currentTurnSeat = null;
  room.trickNo = 0;
  room.trick = null;
  room.won = { 0: [], 1: [], 2: [] };
  room.points = { 0: 0, 1: 0, 2: 0 };
  room.lastTrickWinnerSeat = null;
  room.lastTrickCards = null;
}

function startSeedPhase(room) {
  room.phase = "SEED";

  const serverSecret = crypto.randomBytes(32).toString("hex");
  const serverCommit = sha256Hex(serverSecret);

  room.fairness = {
    serverCommit,
    serverReveal: null,
    finalSeed: null,
    _serverSecret: serverSecret
  };

  roomLog(room, `Sākam partiju. Server commit: ${serverCommit.slice(0, 12)}…`);
}

function tryDealIfSeedsReady(room) {
  if (room.phase !== "SEED") return false;
  if (room.players.some((p) => !p.username || !p.connected)) return false;
  if (room.players.some((p) => !p.seed)) return false;

  const serverSecret = room.fairness?._serverSecret;
  const seeds = room.players.map((p) => p.seed);
  const finalSeed = sha256Hex(`${serverSecret}|${seeds[0]}|${seeds[1]}|${seeds[2]}|${room.roomId}|${room.handNo}`);

  const deck = makeDeck();
  const shuffled = shuffleDeterministic(deck, finalSeed);

  // reveal now (so clients can verify after)
  room.fairness.serverReveal = serverSecret;
  room.fairness.finalSeed = finalSeed;

  room.deck = shuffled.slice();
  room.skat = shuffled.slice(0, 2);
  // 24 cards to players: 8 each
  let idx = 2;
  for (let seat = 0; seat < 3; seat++) {
    room.hands[seat] = shuffled.slice(idx, idx + 8);
    idx += 8;
  }

  room.phase = "BIDDING";
  room.soloistSeat = null;
  room.currentTurnSeat = (room.dealerSeat + 1) % 3; // sāk solīt pa kreisi no dīlera

  roomLog(room, `Seed OK. Final seed: ${finalSeed.slice(0, 12)}… Deck dealt. Talons: 2 kārtis.`);
  return true;
}

function allReady(room) {
  return room.players.every((p) => p.username && p.connected && p.ready);
}

function chooseNextBidTurn(room) {
  // simplistic: rotate to next seat who hasn't bid
  for (let i = 0; i < 3; i++) {
    const s = (room.currentTurnSeat + i) % 3;
    if (room.players[s].bid == null) {
      room.currentTurnSeat = s;
      return;
    }
  }
  room.currentTurnSeat = null;
}

function finalizeBidding(room) {
  // if someone TAKE -> soloist that seat
  const taker = room.players.find((p) => p.bid === "TAKE");
  if (taker) {
    room.soloistSeat = taker.seat;
    room.phase = "SKAT";
    room.currentTurnSeat = taker.seat;
    roomLog(room, `Soloists: ${taker.username} (seat ${taker.seat}). Paņem talonu.`);
    return;
  }

  // all passed -> MVP fallback: dealer becomes soloist
  room.soloistSeat = room.dealerSeat;
  room.phase = "SKAT";
  room.currentTurnSeat = room.dealerSeat;
  roomLog(room, `Visi PASS. MVP režīms: soloists ir dīleris (seat ${room.dealerSeat}).`);
}

function takeSkat(room) {
  if (room.phase !== "SKAT") return { ok: false, error: "NAV_SKAT_FĀZES" };
  const s = room.soloistSeat;
  if (s == null) return { ok: false, error: "NAV_SOLOISTA" };

  room.hands[s] = room.hands[s].concat(room.skat);
  room.skat = [];
  room.phase = "DISCARD";
  room.currentTurnSeat = s;
  roomLog(room, `Soloists paņēma talonu un tagad atmet 2 kārtis.`);
  return { ok: true };
}

function discardTwo(room, cards) {
  if (room.phase !== "DISCARD") return { ok: false, error: "NAV_DISCARD_FĀZES" };
  const s = room.soloistSeat;
  if (s == null) return { ok: false, error: "NAV_SOLOISTA" };
  const hand = room.hands[s];

  const unique = Array.from(new Set((cards || []).map((c) => String(c).toUpperCase())));
  if (unique.length !== 2) return { ok: false, error: "JĀ_IZVĒLAS_2" };

  for (const id of unique) {
    if (!hand.includes(id)) return { ok: false, error: "KĀRTE_NAV_ROKĀ" };
  }

  room.hands[s] = hand.filter((id) => !unique.includes(id));
  room.discards = unique.slice();

  // start play
  room.phase = "PLAY";
  room.trickNo = 0;
  room.trick = { leadSeat: (room.dealerSeat + 1) % 3, cards: [] };
  room.currentTurnSeat = room.trick.leadSeat;

  roomLog(room, `Soloists atmeta 2 kārtis. Sākas izspēle (8 stiķi). Pirmais gājiens: seat ${room.currentTurnSeat}.`);
  return { ok: true };
}

function playCard(room, seat, cardIdStr) {
  if (room.phase !== "PLAY") return { ok: false, error: "NAV_PLAY_FĀZES" };
  if (room.currentTurnSeat !== seat) return { ok: false, error: "NAV_TAVS_GĀJIENS" };

  const cardIdU = String(cardIdStr || "").trim().toUpperCase();
  const card = parseCardId(cardIdU);
  if (!card) return { ok: false, error: "SLIKTA_KĀRTE" };

  const hand = room.hands[seat] || [];
  if (!hand.includes(card.id)) return { ok: false, error: "KĀRTE_NAV_ROKĀ" };

  // legal check
  const legal = getLegalCards(hand, room.trick);
  if (!legal.has(card.id)) return { ok: false, error: "NELEGĀLS_GĀJIENS" };

  // remove from hand
  room.hands[seat] = hand.filter((x) => x !== card.id);

  // add to trick
  room.trick.cards.push({ seat, cardId: card.id });

  // advance or resolve trick
  if (room.trick.cards.length < 3) {
    room.currentTurnSeat = (seat + 1) % 3;
    return { ok: true };
  }

  // resolve trick winner
  const leadCardId = room.trick.cards[0].cardId;
  let winnerSeat = room.trick.cards[0].seat;
  let winnerCard = room.trick.cards[0].cardId;

  for (let i = 1; i < 3; i++) {
    const c = room.trick.cards[i];
    const cmp = compareCardsForTrick(c.cardId, winnerCard, leadCardId);
    if (cmp > 0) {
      winnerSeat = c.seat;
      winnerCard = c.cardId;
    }
  }

  // collect cards and points
  const trickCards = room.trick.cards.map((x) => x.cardId);
  const trickPts = trickCards.reduce((sum, id) => sum + cardPoints(id), 0);

  room.won[winnerSeat] = room.won[winnerSeat].concat(trickCards);
  room.points[winnerSeat] += trickPts;

  room.lastTrickWinnerSeat = winnerSeat;
  room.lastTrickCards = room.trick.cards.map((x) => ({ seat: x.seat, cardId: x.cardId }));
  roomLog(room, `Stiķis #${room.trickNo + 1}: uzvar seat ${winnerSeat} (+${trickPts} punkti).`);

  // next trick or scoring
  room.trickNo += 1;

  if (room.trickNo >= 8) {
    // end game scoring
    const solo = room.soloistSeat;
    const soloName = room.players[solo]?.username || `seat ${solo}`;

    // discards count for soloist
    const discardPts = (room.discards || []).reduce((sum, id) => sum + cardPoints(id), 0);
    room.points[solo] += discardPts;

    const soloPts = room.points[solo];
    const result = soloPts >= 61 ? "UZVAR" : "ZAUDĒ";

    room.phase = "SCORE";
    room.currentTurnSeat = null;

    roomLog(room, `Partija beigusies. Soloists ${soloName}: ${soloPts} punkti (talons: +${discardPts}). Rezultāts: ${result}.`);
    return { ok: true, ended: true };
  }

  // start next trick with winner leading
  room.trick = { leadSeat: winnerSeat, cards: [] };
  room.currentTurnSeat = winnerSeat;
  return { ok: true, trickWinnerSeat: winnerSeat };
}

// ====== SERVER / SOCKET ======
const app = express();
app.use(express.json());

app.use(cors({
  origin: CORS_ORIGINS,
  methods: ["GET", "POST"],
  credentials: false
}));

app.get("/", (req, res) => {
  res.type("text/plain").send("THEZONE ZOLE SERVER OK");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "thezone-zole-server", uptimeSec: Math.floor(process.uptime()) });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGINS, methods: ["GET", "POST"] }
});

io.on("connection", (socket) => {
  socket.emit("server:hello", { ok: true });

  function joinRoom(roomId, username) {
    const rid = safeRoomId(roomId);
    if (!rid) return { ok: false, error: "SLIKTS_ROOM" };
    const name = safeStr(username, 20);
    if (!name) return { ok: false, error: "SLIKTS_NIKS" };

    const room = ensureRoom(rid);

    // prevent same socket in multiple seats
    const existingSeat = seatOfSocket(room, socket.id);
    if (existingSeat != null) {
      return { ok: true, roomId: rid, seat: existingSeat };
    }

    const seat = findEmptySeat(room);
    if (seat == null) return { ok: false, error: "ISTABA_PILNA" };

    const p = room.players[seat];
    p.socketId = socket.id;
    p.username = name;
    p.connected = true;
    p.ready = false;
    p.seed = null;
    p.bid = null;

    socket.join(rid);
    roomLog(room, `Pievienojās: ${name} (seat ${seat}).`);
    emitRoom(room, io);

    return { ok: true, roomId: rid, seat };
  }

  socket.on("room:create", (payload, cb) => {
    const username = payload?.username;
    let rid = safeRoomId(payload?.roomId);

    if (!rid) {
      rid = crypto.randomBytes(2).toString("hex").toUpperCase(); // 4 chars
    }

    const room = ensureRoom(rid);
    const seat = findEmptySeat(room);
    if (seat == null) {
      if (typeof cb === "function") cb({ ok: false, error: "ISTABA_PILNA" });
      return;
    }

    const res = joinRoom(rid, username);
    if (typeof cb === "function") cb(res);
  });

  socket.on("room:join", (payload, cb) => {
    const roomId = payload?.roomId;
    const username = payload?.username;

    const res = joinRoom(roomId, username);
    if (typeof cb === "function") cb(res);
  });

  socket.on("zole:ready", (payload, cb) => {
    const rid = safeRoomId(payload?.roomId);
    const room = rooms.get(rid);
    if (!room) return cb?.({ ok: false, error: "NAV_ROOM" });

    const seat = seatOfSocket(room, socket.id);
    if (seat == null) return cb?.({ ok: false, error: "NAV_SEAT" });

    const val = !!payload?.ready;
    room.players[seat].ready = val;

    roomLog(room, `${room.players[seat].username} READY = ${val ? "JĀ" : "NĒ"}.`);

    // start game if all ready
    if (room.phase === "LOBBY" && allReady(room)) {
      startSeedPhase(room);
    }

    emitRoom(room, io);
    cb?.({ ok: true });
  });

  socket.on("zole:seed", (payload, cb) => {
    const rid = safeRoomId(payload?.roomId);
    const room = rooms.get(rid);
    if (!room) return cb?.({ ok: false, error: "NAV_ROOM" });

    const seat = seatOfSocket(room, socket.id);
    if (seat == null) return cb?.({ ok: false, error: "NAV_SEAT" });

    if (room.phase !== "SEED") return cb?.({ ok: false, error: "NAV_SEED_FĀZES" });

    const seed = safeStr(payload?.seed, 64);
    if (!seed) return cb?.({ ok: false, error: "SLIKTS_SEED" });

    room.players[seat].seed = seed;
    roomLog(room, `Seed saņemts no seat ${seat}.`);

    tryDealIfSeedsReady(room);
    emitRoom(room, io);
    cb?.({ ok: true });
  });

  socket.on("zole:bid", (payload, cb) => {
    const rid = safeRoomId(payload?.roomId);
    const room = rooms.get(rid);
    if (!room) return cb?.({ ok: false, error: "NAV_ROOM" });

    const seat = seatOfSocket(room, socket.id);
    if (seat == null) return cb?.({ ok: false, error: "NAV_SEAT" });

    if (room.phase !== "BIDDING") return cb?.({ ok: false, error: "NAV_BIDDING" });
    if (room.players[seat].bid != null) return cb?.({ ok: false, error: "JAU_SOLĪTS" });

    const action = String(payload?.action || "").toUpperCase();
    if (action !== "PASS" && action !== "TAKE") return cb?.({ ok: false, error: "SLIKTA_DARBĪBA" });

    room.players[seat].bid = action;
    roomLog(room, `BID: seat ${seat} -> ${action}`);

    if (action === "TAKE") {
      finalizeBidding(room);
    } else {
      // if all have bid now, finalize
      if (room.players.every((p) => p.bid != null)) {
        finalizeBidding(room);
      } else {
        room.currentTurnSeat = (seat + 1) % 3;
        chooseNextBidTurn(room);
      }
    }

    emitRoom(room, io);
    cb?.({ ok: true });
  });

  socket.on("zole:takeSkat", (payload, cb) => {
    const rid = safeRoomId(payload?.roomId);
    const room = rooms.get(rid);
    if (!room) return cb?.({ ok: false, error: "NAV_ROOM" });

    const seat = seatOfSocket(room, socket.id);
    if (seat == null) return cb?.({ ok: false, error: "NAV_SEAT" });

    if (room.soloistSeat !== seat) return cb?.({ ok: false, error: "NAV_SOLOISTS" });

    const res = takeSkat(room);
    emitRoom(room, io);
    cb?.(res);
  });

  socket.on("zole:discard", (payload, cb) => {
    const rid = safeRoomId(payload?.roomId);
    const room = rooms.get(rid);
    if (!room) return cb?.({ ok: false, error: "NAV_ROOM" });

    const seat = seatOfSocket(room, socket.id);
    if (seat == null) return cb?.({ ok: false, error: "NAV_SEAT" });

    if (room.soloistSeat !== seat) return cb?.({ ok: false, error: "NAV_SOLOISTS" });

    const res = discardTwo(room, payload?.cards);
    emitRoom(room, io);
    cb?.(res);
  });

  socket.on("zole:play", (payload, cb) => {
    const rid = safeRoomId(payload?.roomId);
    const room = rooms.get(rid);
    if (!room) return cb?.({ ok: false, error: "NAV_ROOM" });

    const seat = seatOfSocket(room, socket.id);
    if (seat == null) return cb?.({ ok: false, error: "NAV_SEAT" });

    const res = playCard(room, seat, payload?.cardId);
    emitRoom(room, io);
    cb?.(res);
  });

  socket.on("zole:next", (payload, cb) => {
    // pēc SCORE: atpakaļ uz LOBBY un nākamais dīleris
    const rid = safeRoomId(payload?.roomId);
    const room = rooms.get(rid);
    if (!room) return cb?.({ ok: false, error: "NAV_ROOM" });

    if (room.phase !== "SCORE") return cb?.({ ok: false, error: "NAV_SCORE" });

    room.dealerSeat = (room.dealerSeat + 1) % 3;
    resetForNewHand(room);
    room.phase = "LOBBY";
    roomLog(room, `Atpakaļ lobby. Nākamais dīleris: seat ${room.dealerSeat}.`);
    emitRoom(room, io);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    // mark disconnected in any room
    for (const room of rooms.values()) {
      const p = room.players.find((x) => x.socketId === socket.id);
      if (p) {
        p.connected = false;
        roomLog(room, `Atvienojās: ${p.username} (seat ${p.seat}).`);
        emitRoom(room, io);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`thezone-zole-server listening on :${PORT}`);
  console.log(`CORS_ORIGINS: ${CORS_ORIGINS.join(", ")}`);
});
