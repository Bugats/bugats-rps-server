/* ============================
   THEZONE.LV — ZOLE v1.7 (BEZ PULĒM)
   - Solīšana:
       "ŅEMT GALDU" (agrāk TAKE)
       "GARĀM"      (agrāk PASS)
       "ZOLE"
       "MAZĀ" (Mazā zole)
     Ja visi 3 pasaka "GARĀM" => "GALDS" (tavs padi/galds), bez redeal.

   - Punkti (cietā/sporta sistēma):
     ŅEMT GALDU:
       WIN 61–90: +2 no katra
       WIN 91+:   +4 no katra
       WIN SAUSĀ (Mazajiem 0 stiķi): +6 no katra
       LOSE 31–60: -2 katram
       LOSE 0–30:  -4 katram
       LOSE SAUSĀ (Lielajam 0 stiķi): -6 katram

     ZOLE:
       WIN (>=61): +10 no katra
       LOSE:       -12 katram

     MAZĀ:
       WIN (0 stiķi): +12 no katra
       LOSE (>=1 stiķis): -14 katram (tūlītēja zaude, ja paņem 1 stiķi)

   - GALDS (visi garām):
       Talons pieliekas 1. un 2. stiķa uzvarētājam (lai kopā 120 acis).
       Zaud tas, kam visvairāk acis.
       Punkti:
         1 zaudētājs: zaud -2, pārējie +1
         2 vienādi visvairāk: abi -2, trešais +4
         3 vienādi: 0

   ============================ */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const PORT = process.env.PORT || 10080;

// GALDS zaudētāja punkti (parasti -2)
let GALDS_LOSER_PTS = parseInt(process.env.GALDS_LOSER_PTS || "-2", 10);
if (!Number.isFinite(GALDS_LOSER_PTS) || GALDS_LOSER_PTS === 0) GALDS_LOSER_PTS = -2;
if (GALDS_LOSER_PTS > 0) GALDS_LOSER_PTS = -Math.abs(GALDS_LOSER_PTS);

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
app.get("/health", (req, res) =>
  res.json({ ok: true, galdsLoserPts: GALDS_LOSER_PTS })
);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOptions.origin, credentials: true }
});

/* ============================
   SEAT ROTĀCIJA (CW)
   next = (seat + 2) % 3
   ============================ */
function nextSeatCW(seat) {
  return (seat + 2) % 3;
}

/* ============================
   KĀRTIS + NOTEIKUMI
   ============================ */

const EYES = { A: 11, "10": 10, K: 4, Q: 3, J: 2, "9": 0, "8": 0, "7": 0 };

const NON_TRUMP_RANK_STD = { A: 4, "10": 3, K: 2, "9": 1 };
function nonTrumpStrengthStd(c) {
  return NON_TRUMP_RANK_STD[c.r] ?? 0;
}

const NO_TRUMP_RANK = { A: 7, "10": 6, K: 5, Q: 4, J: 3, "9": 2, "8": 1, "7": 0 };
function noTrumpStrength(c) {
  return NO_TRUMP_RANK[c.r] ?? 0;
}

function buildDeck() {
  // 26 kārtis: (A,K,Q,J,10,9) visos mastos + 8♦,7♦
  const deck = [];
  const base = ["A", "K", "Q", "J", "10", "9"];
  for (const s of ["C", "S", "H"]) {
    for (const r of base) deck.push({ r, s });
  }
  for (const r of ["A", "K", "Q", "J", "10", "9", "8", "7"]) deck.push({ r, s: "D" });
  return deck;
}

function cardEyes(c) {
  return EYES[c.r] ?? 0;
}

function sumEyes(cards) {
  return cards.reduce((acc, c) => acc + cardEyes(c), 0);
}

function sameCard(a, b) {
  return a && b && a.r === b.r && a.s === b.s;
}

function cardKey(c) {
  return `${c.r}${c.s}`;
}

/* ===== Standarta trumpji (klasiskā zole) =====
   Trumpji: visas Q; visas J; visi ♦
*/
function isTrumpStd(c) {
  return c.s === "D" || c.r === "Q" || c.r === "J";
}

// Trumpju secība (Q♣ Q♠ Q♥ Q♦ J♣ J♠ J♥ J♦ A♦ 10♦ K♦ 9♦ 8♦ 7♦)
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
const TRUMP_INDEX = new Map(TRUMP_ORDER.map((c, i) => [cardKey(c), i]));
function trumpStrengthStd(c) {
  return TRUMP_INDEX.get(cardKey(c));
}

function rulesForContract(contract) {
  // MAZĀ = bez trumpjiem, viss pārējais (ŅEMT/ZOLE/GALDS) = ar standarta trumpjiem
  if (contract === "MAZĀ") return { trumps: false };
  return { trumps: true };
}

function leadFollow(room, leadCard) {
  if (!leadCard) return null;
  const { trumps } = rulesForContract(room.contract);
  if (!trumps) return leadCard.s;
  return isTrumpStd(leadCard) ? "TRUMP" : leadCard.s;
}

function hasFollow(hand, follow, room) {
  if (!follow) return false;
  const { trumps } = rulesForContract(room.contract);

  if (!trumps) {
    return hand.some((c) => c.s === follow);
  }

  if (follow === "TRUMP") return hand.some(isTrumpStd);
  return hand.some((c) => !isTrumpStd(c) && c.s === follow);
}

function isLegalPlay(hand, follow, c, room) {
  if (!follow) return true;

  const { trumps } = rulesForContract(room.contract);

  if (!trumps) {
    const must = hasFollow(hand, follow, room);
    return must ? c.s === follow : true;
  }

  if (follow === "TRUMP") {
    const must = hasFollow(hand, "TRUMP", room);
    return must ? isTrumpStd(c) : true;
  }

  const must = hasFollow(hand, follow, room);
  if (!must) return true;
  return !isTrumpStd(c) && c.s === follow;
}

function pickTrickWinner(room, plays) {
  const lead = plays[0].card;
  const { trumps } = rulesForContract(room.contract);

  if (!trumps) {
    let best = plays[0];
    for (const p of plays) {
      if (p.card.s !== lead.s) continue;
      if (noTrumpStrength(p.card) > noTrumpStrength(best.card)) best = p;
    }
    return best.seat;
  }

  const anyTrump = plays.some((p) => isTrumpStd(p.card));
  if (anyTrump) {
    let best = null;
    for (const p of plays) {
      if (!isTrumpStd(p.card)) continue;
      if (!best) best = p;
      else {
        const a = trumpStrengthStd(p.card);
        const b = trumpStrengthStd(best.card);
        if ((a ?? 999) < (b ?? 999)) best = p;
      }
    }
    return best ? best.seat : plays[0].seat;
  }

  let best = plays[0];
  for (const p of plays) {
    if (p.card.s !== lead.s) continue;
    if (nonTrumpStrengthStd(p.card) > nonTrumpStrengthStd(best.card)) best = p;
  }
  return best.seat;
}

function trickCount(cards) {
  return Math.floor(cards.length / 3);
}

/* ============================
   FAIR RNG — commit/reveal
   ============================ */

function sha256hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function seedToU32(hex) {
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

const rooms = new Map();

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

    fairness: null,

    bids: [],
    bidTurnSeat: 0,

    contract: null, // "ŅEMT GALDU" / "ZOLE" / "MAZĀ" / "GALDS"
    bigSeat: null,

    deck: null,
    hands: [[], [], []],
    talon: [],
    discard: [],
    taken: [[], [], []],

    leaderSeat: null,
    turnSeat: null,
    trickPlays: [],

    // GALDS: talons 1./2. stiķim
    galdsTrickNo: 0,
    galdsTalonIndex: 0,

    lastResult: null
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
  room.bidTurnSeat = nextSeatCW(room.dealerSeat);

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

  room.galdsTrickNo = 0;
  room.galdsTalonIndex = 0;
}

function dealIfReady(room) {
  if (!roomHasAllPlayers(room)) return false;
  if (!room.players.every((p) => typeof p.seed === "string" && p.seed.length > 0)) return false;

  const serverSecret = room.fairness?.serverSecret;
  const serverCommit = room.fairness?.serverCommit;
  if (!serverSecret || !serverCommit) return false;

  const combined = sha256hex(
    `${serverSecret}:${room.players[0].seed}:${room.players[1].seed}:${room.players[2].seed}`
  );

  room.fairness.serverReveal = serverSecret;
  room.fairness.combinedHash = combined;

  const deck = shuffleDeterministic(buildDeck(), combined);
  room.deck = deck.slice();

  room.hands[0] = deck.slice(0, 8);
  room.hands[1] = deck.slice(8, 16);
  room.hands[2] = deck.slice(16, 24);
  room.talon = deck.slice(24, 26);

  room.leaderSeat = nextSeatCW(room.dealerSeat);
  return true;
}

function startNewHand(room) {
  room.handNo += 1;
  room.phase = "BIDDING";
  resetHandState(room);

  const serverSecret = crypto.randomBytes(16).toString("hex");
  const serverCommit = sha256hex(serverSecret);
  room.fairness = { serverCommit, serverSecret, serverReveal: null, combinedHash: null };

  room.turnSeat = room.bidTurnSeat;

  const didDeal = dealIfReady(room);
  emitRoom(room, { note: didDeal ? "NEW_HAND_DEALT" : "NEW_HAND_WAIT_SEEDS" });
}

function preparePlayPhase(room) {
  room.phase = "PLAY";
  room.trickPlays = [];
  room.turnSeat = room.leaderSeat;
}

/* ============================
   PUNKTU PALĪG: deltas
   ============================ */
function applyDeltas(room, deltas) {
  for (const p of room.players) {
    p.matchPts += (deltas[p.seat] || 0);
  }
}

/* ============================
   SCORE: ŅEMT GALDU / ZOLE
   ============================ */
function scoreTakeOrZole(room) {
  const contract = room.contract; // "ŅEMT GALDU" / "ZOLE"
  const bigSeat = room.bigSeat;

  const totalEyes = 120;

  const bigTaken = room.taken[bigSeat];
  const bigTricks = trickCount(bigTaken);

  const discardEyes = sumEyes(room.discard);
  const talonEyes = sumEyes(room.talon);

  let bigEyes = sumEyes(bigTaken);
  if (contract === "ŅEMT GALDU") bigEyes += discardEyes;

  const oppEyes = totalEyes - bigEyes;
  const oppTricks = 8 - bigTricks;

  let payEach = 0;
  let bigWins = false;
  let status = "";

  if (contract === "ŅEMT GALDU") {
    bigWins = bigEyes >= 61; // 60 = zaudējums

    if (bigWins) {
      if (oppTricks === 0) {
        payEach = 6;
        status = "UZVARA SAUSĀ (M 0 stiķi)";
      } else if (bigEyes >= 91) {
        payEach = 4;
        status = "UZVARA ŠMUĻOS (91+ acis)";
      } else {
        payEach = 2;
        status = "UZVARA (61–90 acis)";
      }
    } else {
      if (bigTricks === 0) {
        payEach = 6;
        status = "ZAUDĒJUMS SAUSĀ (L 0 stiķi)";
      } else if (bigEyes <= 30) {
        payEach = 4;
        status = "ZAUDĒJUMS ŠMUĻOS (0–30 acis)";
      } else {
        payEach = 2;
        status = "ZAUDĒJUMS (31–60 acis)";
      }
    }
  }

  if (contract === "ZOLE") {
    bigWins = bigEyes >= 61;
    if (bigWins) {
      payEach = 10;
      status = "UZVARA (>=61 acis)";
    } else {
      payEach = 12;
      status = "ZAUDĒJUMS (<61 acis)";
    }
  }

  const deltas = [0, 0, 0];
  if (bigWins) {
    deltas[bigSeat] += payEach * 2;
    for (let s = 0; s < 3; s++) if (s !== bigSeat) deltas[s] -= payEach;
  } else {
    deltas[bigSeat] -= payEach * 2;
    for (let s = 0; s < 3; s++) if (s !== bigSeat) deltas[s] += payEach;
  }
  applyDeltas(room, deltas);

  room.lastResult = {
    ts: Date.now(),
    handNo: room.handNo,
    contract,
    bigSeat,
    status,
    bigWins,
    payEach,
    deltas,
    names: room.players.map((p) => p.username || null),
    ptsAfter: room.players.map((p) => p.matchPts || 0),
    bigEyes,
    oppEyes,
    bigTricks,
    oppTricks,
    talonEyes,
    discardEyes
  };

  room.phase = "SCORE";
  emitRoom(room, { note: `SCORE_${contract}` });

  endToLobby(room, "BACK_TO_LOBBY");
}

/* ============================
   SCORE: MAZĀ
   ============================ */
function scoreMaza(room, reason) {
  const bigSeat = room.bigSeat;
  const bigTricks = trickCount(room.taken[bigSeat]);

  const bigWins = bigTricks === 0;
  const payEach = bigWins ? 12 : 14;
  const status = bigWins ? "UZVARA (0 stiķi)" : "ZAUDĒJUMS (paņemts stiķis)";

  const deltas = [0, 0, 0];
  if (bigWins) {
    deltas[bigSeat] += payEach * 2;
    for (let s = 0; s < 3; s++) if (s !== bigSeat) deltas[s] -= payEach;
  } else {
    deltas[bigSeat] -= payEach * 2;
    for (let s = 0; s < 3; s++) if (s !== bigSeat) deltas[s] += payEach;
  }
  applyDeltas(room, deltas);

  room.lastResult = {
    ts: Date.now(),
    handNo: room.handNo,
    contract: "MAZĀ",
    bigSeat,
    status,
    bigWins,
    payEach,
    deltas,
    names: room.players.map((p) => p.username || null),
    ptsAfter: room.players.map((p) => p.matchPts || 0),
    bigTricks,
    reason: reason || "END"
  };

  room.phase = "SCORE";
  emitRoom(room, { note: `SCORE_MAZA_${reason || "END"}` });

  endToLobby(room, "BACK_TO_LOBBY");
}

/* ============================
   SCORE: GALDS (visi garām)
   ============================ */
function scoreGalds(room) {
  const eyes = room.taken.map((t) => sumEyes(t));
  const maxEyes = Math.max(...eyes);

  const loserSeats = [];
  for (let s = 0; s < 3; s++) if (eyes[s] === maxEyes) loserSeats.push(s);

  const deltas = [0, 0, 0];

  if (loserSeats.length === 3) {
    // visi vienādi -> 0
  } else {
    const sumLosers = GALDS_LOSER_PTS * loserSeats.length; // negatīvs
    for (const s of loserSeats) deltas[s] += GALDS_LOSER_PTS;

    const winners = [];
    for (let s = 0; s < 3; s++) if (!loserSeats.includes(s)) winners.push(s);

    const winDelta = winners.length > 0 ? Math.round((-sumLosers) / winners.length) : 0;
    for (const s of winners) deltas[s] += winDelta;
  }

  applyDeltas(room, deltas);

  room.lastResult = {
    ts: Date.now(),
    handNo: room.handNo,
    contract: "GALDS",
    status: "GALDS (visi garām) — zaud visvairāk acis",
    eyes,
    loserSeats,
    galdsLoserPts: GALDS_LOSER_PTS,
    deltas,
    names: room.players.map((p) => p.username || null),
    ptsAfter: room.players.map((p) => p.matchPts || 0)
  };

  room.phase = "SCORE";
  emitRoom(room, { note: "SCORE_GALDS" });

  endToLobby(room, "BACK_TO_LOBBY");
}

/* ============================
   LOBBY atgriešanās + dīlera rotācija
   ============================ */
function endToLobby(room, extraNote) {
  room.phase = "LOBBY";
  for (const p of room.players) p.ready = false;

  room.dealerSeat = nextSeatCW(room.dealerSeat);
  resetHandState(room);

  emitRoom(room, { note: extraNote || "BACK_TO_LOBBY" });
}

/* ============================
   LEGAL
   ============================ */
function computeLegalForSeat(room, seat) {
  if (room.phase !== "PLAY") return [];
  if (room.turnSeat !== seat) return [];
  const hand = room.hands[seat] || [];
  if (room.trickPlays.length === 0) return hand.slice();

  const follow = leadFollow(room, room.trickPlays[0]?.card);
  const must = hasFollow(hand, follow, room);
  if (!must) return hand.slice();

  const { trumps } = rulesForContract(room.contract);
  if (!trumps) return hand.filter((c) => c.s === follow);

  if (follow === "TRUMP") return hand.filter(isTrumpStd);
  return hand.filter((c) => !isTrumpStd(c) && c.s === follow);
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
  const { trumps } = rulesForContract(room.contract);

  return {
    roomId: room.roomId,
    phase: room.phase,
    handNo: room.handNo,
    dealerSeat: room.dealerSeat,

    fairness: room.fairness
      ? {
          serverCommit: room.fairness.serverCommit,
          serverReveal: room.fairness.serverReveal,
          combinedHash: room.fairness.combinedHash
        }
      : null,

    players: publicPlayers(room),

    bids: room.bids,
    bidTurnSeat: room.bidTurnSeat,
    contract: room.contract,
    bigSeat: room.bigSeat,

    rules: {
      trumpsEnabled: !!trumps,
      galdsLoserPts: GALDS_LOSER_PTS
    },

    leaderSeat: room.leaderSeat,
    turnSeat: room.turnSeat,
    trickPlays: room.trickPlays,

    mySeat: seat,
    myUsername: me?.username || null,
    myHand: room.hands[seat] || [],
    myTaken: room.taken[seat] || [],

    myDiscard: room.bigSeat === seat ? room.discard : [],

    legal: computeLegalForSeat(room, seat),

    meta: {
      handSizes: room.hands.map((h) => h.length),
      takenTricks: room.taken.map((t) => trickCount(t))
    },

    lastResult: room.lastResult
  };
}

function emitRoom(room, extra) {
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

  function pickSeat(room, username) {
    let seat = room.players.findIndex((p) => p.username === username && !p.connected);
    if (seat !== -1) return seat;

    const dup = room.players.find((p) => p.username === username && p.connected);
    if (dup) return -2;

    seat = room.players.findIndex((p) => !p.username);
    return seat;
  }

  socket.on("room:create", (payload, ack) => {
    try {
      const username = safeUsername(payload?.username);
      const avatarUrl = safeAvatarUrl(payload?.avatarUrl);
      const clientSeed = String(payload?.seed || "").trim();

      if (!username) return ack?.({ ok: false, error: "NICK_REQUIRED" });

      const roomId = normRoomId(payload?.roomId) || randomRoomId();
      const room = getOrCreateRoom(roomId);

      const seat = pickSeat(room, username);
      if (seat === -2) return ack?.({ ok: false, error: "DUPLICATE_NICK" });
      if (seat === -1) return ack?.({ ok: false, error: "ROOM_FULL" });

      room.players[seat].username = username;
      room.players[seat].avatarUrl = avatarUrl || room.players[seat].avatarUrl || "";
      room.players[seat].ready = false;
      room.players[seat].connected = true;
      room.players[seat].socketId = socket.id;

      room.players[seat].seed =
        clientSeed || room.players[seat].seed || crypto.randomBytes(8).toString("hex");

      socket.join(room.roomId);
      socket.data.roomId = room.roomId;
      socket.data.seat = seat;

      ack?.({ ok: true, roomId: room.roomId, seat });
      emitRoom(room, { note: "JOIN" });
    } catch {
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

      const seat = pickSeat(room, username);
      if (seat === -2) return ack?.({ ok: false, error: "DUPLICATE_NICK" });
      if (seat === -1) return ack?.({ ok: false, error: "ROOM_FULL" });

      room.players[seat].username = username;
      room.players[seat].avatarUrl = avatarUrl || room.players[seat].avatarUrl || "";
      room.players[seat].ready = false;
      room.players[seat].connected = true;
      room.players[seat].socketId = socket.id;

      room.players[seat].seed =
        clientSeed || room.players[seat].seed || crypto.randomBytes(8).toString("hex");

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
      const keepPts = room.players[seat].matchPts;
      room.players[seat] = {
        seat,
        username: null,
        avatarUrl: "",
        ready: false,
        connected: false,
        socketId: null,
        seed: null,
        matchPts: keepPts
      };
      emitRoom(room, { note: "LEAVE" });
    }

    socket.leave(roomId || "");
    socket.data.roomId = null;
    socket.data.seat = null;
    ack?.({ ok: true });
  });

  function setSeed(seedRaw) {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || typeof seat !== "number") return;

    if (room.deck && room.deck.length) return;

    const seed = String(seedRaw || "").trim().slice(0, 64);
    if (!seed) return;

    room.players[seat].seed = seed;

    if (room.phase === "BIDDING" && room.fairness && !room.deck) {
      const did = dealIfReady(room);
      emitRoom(room, { note: did ? "AUTO_DEAL_OK" : "SEED" });
      return;
    }

    emitRoom(room, { note: "SEED" });
  }
  socket.on("fair:seed", setSeed);
  socket.on("seed", setSeed);

  socket.on("zole:ready", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || typeof seat !== "number") return ack?.({ ok: false, error: "NOT_IN_ROOM" });

    const ready = !!payload?.ready;
    room.players[seat].ready = ready;

    ack?.({ ok: true, ready });

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

    if (!room.deck) {
      const did = dealIfReady(room);
      if (!did) return ack?.({ ok: false, error: "WAIT_SEEDS" });
      emitRoom(room, { note: "DEAL_OK" });
    }

    const bidRaw = String(payload?.bid || "").toUpperCase().trim();

    // Pieņemam arī vecos (drošībai), bet saglabājam jaunajos nosaukumos
    const isGaram = bidRaw === "GARĀM" || bidRaw === "GARAM" || bidRaw === "PASS";
    const isNemt =
      bidRaw === "ŅEMT GALDU" ||
      bidRaw === "NEMT GALDU" ||
      bidRaw === "ŅEMT" ||
      bidRaw === "NEMT" ||
      bidRaw === "TAKE";

    const isZole = bidRaw === "ZOLE";
    const isMaza =
      bidRaw === "MAZĀ" ||
      bidRaw === "MAZA" ||
      bidRaw === "MAZĀ ZOLE" ||
      bidRaw === "MAZA ZOLE" ||
      bidRaw === "MAZA_ZOLE";

    if (!isGaram && !isNemt && !isZole && !isMaza) return ack?.({ ok: false, error: "BAD_BID" });

    const bidName = isGaram ? "GARĀM" : isNemt ? "ŅEMT GALDU" : isZole ? "ZOLE" : "MAZĀ";
    room.bids.push({ seat, bid: bidName });

    if (bidName === "GARĀM") {
      room.turnSeat = nextSeatCW(room.turnSeat);

      const garamCount = room.bids.filter((b) => b.bid === "GARĀM").length;
      if (garamCount >= 3) {
        // visi garām => GALDS
        room.contract = "GALDS";
        room.bigSeat = null;
        room.phase = "PLAY";
        room.trickPlays = [];
        room.turnSeat = room.leaderSeat;
        room.galdsTrickNo = 0;
        room.galdsTalonIndex = 0;

        emitRoom(room, { note: "ALL_GARAM_GALDS" });
        return ack?.({ ok: true, allGaram: true });
      }

      emitRoom(room, { note: "GARĀM" });
      return ack?.({ ok: true });
    }

    // ŅEMT GALDU / ZOLE / MAZĀ
    room.bigSeat = seat;

    if (bidName === "ŅEMT GALDU") {
      room.contract = "ŅEMT GALDU";
      room.phase = "DISCARD";

      room.hands[seat] = (room.hands[seat] || []).concat(room.talon);
      room.turnSeat = seat;

      emitRoom(room, { note: "NEMT_SELECTED" });
      return ack?.({ ok: true });
    }

    if (bidName === "ZOLE") {
      room.contract = "ZOLE";
      preparePlayPhase(room);
      emitRoom(room, { note: "ZOLE_SELECTED" });
      return ack?.({ ok: true });
    }

    if (bidName === "MAZĀ") {
      room.contract = "MAZĀ";
      preparePlayPhase(room);
      emitRoom(room, { note: "MAZA_SELECTED" });
      return ack?.({ ok: true });
    }

    ack?.({ ok: true });
  });

  socket.on("zole:discard", (payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || typeof seat !== "number") return ack?.({ ok: false, error: "NOT_IN_ROOM" });

    if (room.phase !== "DISCARD") return ack?.({ ok: false, error: "NOT_DISCARD" });
    if (room.bigSeat !== seat) return ack?.({ ok: false, error: "NOT_BIG" });
    if (room.contract !== "ŅEMT GALDU") return ack?.({ ok: false, error: "NOT_NEMT" });

    const discard = Array.isArray(payload?.discard) ? payload.discard : [];
    if (discard.length !== 2) return ack?.({ ok: false, error: "NEED_2" });

    const hand = room.hands[seat] || [];
    const picked = [];

    for (const x of discard) {
      const c = normalizeCard(x);
      if (!c) return ack?.({ ok: false, error: "BAD_CARD" });

      const idx = hand.findIndex((h) => sameCard(h, c));
      if (idx === -1) return ack?.({ ok: false, error: "NOT_IN_HAND" });

      picked.push(hand.splice(idx, 1)[0]);
    }

    room.discard = picked;

    ack?.({ ok: true });

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

    const follow = room.trickPlays.length ? leadFollow(room, room.trickPlays[0].card) : null;
    if (!isLegalPlay(hand, follow, c, room)) return ack?.({ ok: false, error: "ILLEGAL" });

    const played = hand.splice(idx, 1)[0];
    room.trickPlays.push({ seat, card: played });

    ack?.({ ok: true });

    if (room.trickPlays.length < 3) {
      room.turnSeat = nextSeatCW(room.turnSeat);
      emitRoom(room, { note: "PLAY" });
      return;
    }

    const winnerSeat = pickTrickWinner(room, room.trickPlays);
    for (const p of room.trickPlays) room.taken[winnerSeat].push(p.card);

    room.trickPlays = [];
    room.leaderSeat = winnerSeat;
    room.turnSeat = winnerSeat;

    // GALDS: talons 1./2. stiķa uzvarētājam
    if (room.contract === "GALDS") {
      room.galdsTrickNo += 1;
      if (room.galdsTrickNo <= 2 && room.galdsTalonIndex < room.talon.length) {
        room.taken[winnerSeat].push(room.talon[room.galdsTalonIndex]);
        room.galdsTalonIndex += 1;
      }
    }

    emitRoom(room, { note: "TRICK_WIN", trickWinner: winnerSeat });

    // MAZĀ: ja lielais paņem 1 stiķi -> tūlītējs zaudējums
    if (room.contract === "MAZĀ" && winnerSeat === room.bigSeat) {
      return scoreMaza(room, "TOOK_TRICK");
    }

    const allHandsEmpty = room.hands.every((h) => (h?.length || 0) === 0);
    if (!allHandsEmpty) return;

    if (room.contract === "ŅEMT GALDU" || room.contract === "ZOLE") return scoreTakeOrZole(room);
    if (room.contract === "MAZĀ") return scoreMaza(room, "END");
    if (room.contract === "GALDS") return scoreGalds(room);

    scoreTakeOrZole(room);
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
  if (!x) return null;

  if (typeof x === "object" && x.r && x.s) {
    const r = String(x.r).toUpperCase();
    const s = String(x.s).toUpperCase();
    if (!["C", "S", "H", "D"].includes(s)) return null;
    return { r, s };
  }

  if (typeof x === "string") {
    const s = x.trim().toUpperCase();
    const m = s.match(/^(10|[AKQJ987])([CSHD])$/);
    if (!m) return null;
    return { r: m[1], s: m[2] };
  }

  return null;
}

server.listen(PORT, () => {
  console.log(`[zole] listening on :${PORT}`);
  console.log(`[zole] GALDS_LOSER_PTS=${GALDS_LOSER_PTS}`);
  console.log(`[zole] CORS_ORIGINS: ${CORS_ORIGINS.length ? CORS_ORIGINS.join(", ") : "ANY"}`);
});
