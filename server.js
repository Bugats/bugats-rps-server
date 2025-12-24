/* ============================
   THEZONE.LV — ZOLE (BEZ PULĒM) — PILNĀ LOĢIKA (LV nosaukumi)
   - 3 spēlētāji, 26 kārtis
   - READY lobby → NEW_HAND → BIDDING → (ŅEMT GALDU: DISCARD2) → PLAY 8 stiķi → LOBBY
   - Solīšana: GARĀM / ŅEMT GALDU / ZOLE / MAZĀ
   - ŅEMT GALDU: paņem talonu + NOROK 2 (tikai Lielais)
   - ZOLE: bez talona (talons “paliek mazajiem” caur oppEyes = 120 - bigEyes)
   - MAZĀ: bez talona, BEZ TRUMPJIEM, mērķis 0 stiķi (tūlītējs zaudējums, ja paņem 1 stiķi)
   - Visi GARĀM: GALDS (primāri stiķi, ja vienādi -> acis; ja arī vienādi -> dalīts)
   - Commit–reveal fairness (serverCommit + 3 client seed → deterministisks shuffle)
   - Seat “spoku” FIX: join/create vispirms atgriež seat pēc username (ja bija atvienots), tikai tad ņem tukšu.
   - FIX: KĀRTIS IZDALĀS UZREIZ pie NEW_HAND (pēc READY)
   - FIX: ROTĀCIJA PULKSTEŅRĀDĪTĀJA VIRZIENĀ (CW): next = (seat+2)%3
   ============================ */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const PORT = process.env.PORT || 10080;

// “Galda/Galdiņa” pamata likme (uz vieninieku = 1)
const GALDS_PAY = Math.max(
  1,
  Math.min(5, parseInt(process.env.GALDS_PAY || process.env.GALDINS_PAY || "1", 10) || 1)
);

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
  cors: { origin: corsOptions.origin, credentials: true }
});

/* ============================
   SEAT ROTĀCIJA (CW)
   next = (seat+2)%3
   ============================ */
function nextSeatCW(seat) {
  return (seat + 2) % 3;
}

/* ============================
   KĀRTIS + NOTEIKUMI
   ============================ */

const EYES = { A: 11, "10": 10, K: 4, Q: 3, J: 2, "9": 0, "8": 0, "7": 0 };

// Standarta (ar trumpjiem) “parastā masta” stiprums: A > 10 > K > 9
const NON_TRUMP_RANK_STD = { A: 4, "10": 3, K: 2, "9": 1 };
function nonTrumpStrengthStd(c) {
  return NON_TRUMP_RANK_STD[c.r] ?? 0;
}

// Bez trumpjiem (Mazā) stiprums: A > 10 > K > Q > J > 9 > 8 > 7
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
  return (cards || []).reduce((acc, c) => acc + cardEyes(c), 0);
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

/* ============================
   LV kontrakti (kanoniskie)
   ============================ */
const CONTRACT_TAKE = "ŅEMT GALDU";
const CONTRACT_ZOLE = "ZOLE";
const CONTRACT_MAZA = "MAZĀ";
const CONTRACT_GALDS = "GALDS";

function rulesForContract(contract) {
  if (contract === CONTRACT_MAZA) return { trumps: false };
  return { trumps: true }; // ŅEMT GALDU/ZOLE/GALDS
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

  if (!trumps) return hand.some((c) => c.s === follow);

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
        if ((a ?? 999) < (b ?? 999)) best = p; // mazāks indekss = stiprāks
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
  return Math.floor(((cards || []).length) / 3);
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

    fairness: null, // { serverCommit, serverSecret, serverReveal, combinedHash }

    bids: [],
    bidTurnSeat: 0,

    contract: null,   // ŅEMT GALDU / ZOLE / MAZĀ / GALDS
    bigSeat: null,    // ŅEMT GALDU/ZOLE/MAZĀ gadījumā

    deck: null,
    hands: [[], [], []],
    talon: [],
    discard: [],
    taken: [[], [], []],

    leaderSeat: null,
    turnSeat: null,
    trickPlays: [],

    // GALDS (talons 1./2. stiķim)
    galdsTrickNo: 0,
    galdsTalonIndex: 0,

    // pēdējais rezultāts (lai UI var parādīt toast + scoreLast)
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

function applyPayEachSigned(room, bigSeat, payEachSigned) {
  // payEachSigned: +2 => lielais saņem +2 no katra; -2 => lielais maksā -2 katram
  room.players[bigSeat].matchPts += payEachSigned * 2;
  for (const p of room.players) if (p.seat !== bigSeat) p.matchPts -= payEachSigned;
}

function finishHandToLobby(room, lastResult, extraNote) {
  room.lastResult = lastResult || null;

  room.phase = "LOBBY";
  for (const p of room.players) p.ready = false;

  room.dealerSeat = nextSeatCW(room.dealerSeat);
  resetHandState(room);

  emitRoom(room, { note: extraNote || "BACK_TO_LOBBY" });
}

/* ============================
   SCORE — ŅEMT GALDU / ZOLE (pēc tavas tabulas)
   payEachSigned vienmēr ir “cik Lielais saņem no katra Mazā”
   ============================ */
function scoreTakeOrZole(room) {
  const contract = room.contract; // ŅEMT GALDU / ZOLE
  const bigSeat = room.bigSeat;

  const totalEyes = 120;

  const bigTaken = room.taken[bigSeat];
  const bigTricks = trickCount(bigTaken);

  const discardEyes = sumEyes(room.discard);
  const talonEyes = sumEyes(room.talon);

  let bigEyes = sumEyes(bigTaken);
  if (contract === CONTRACT_TAKE) bigEyes += discardEyes;

  const oppEyes = totalEyes - bigEyes;
  const oppTricks = 8 - bigTricks;

  let payEachSigned = 0;
  let bigWins = false;
  let status = "";

  // ŅEMT GALDU (Parastā spēle)
  if (contract === CONTRACT_TAKE) {
    bigWins = bigEyes >= 61; // 60 = zaudējums

    if (bigWins) {
      if (bigTricks === 8) {
        // Lielais +6, katrs Mazais -3 => payEach = +3
        payEachSigned = +3;
        status = "UZVAR BEZTUKŠĀ";
      } else if (bigEyes >= 91) {
        // Lielais +4, katrs Mazais -2 => payEach = +2
        payEachSigned = +2;
        status = "UZVAR JAŅOS";
      } else {
        // Lielais +2, katrs Mazais -1 => payEach = +1
        payEachSigned = +1;
        status = "UZVAR";
      }
    } else {
      if (bigTricks === 0) {
        // Lielais -8, katrs Mazais +4 => payEach = -4
        payEachSigned = -4;
        status = "ZAUDĒ BEZTUKŠĀ";
      } else if (bigEyes <= 30) {
        // Lielais -6, katrs Mazais +3 => payEach = -3
        payEachSigned = -3;
        status = "ZAUDĒ JAŅOS";
      } else {
        // Lielais -4, katrs Mazais +2 => payEach = -2
        payEachSigned = -2;
        status = "ZAUDĒ";
      }
    }
  }

  // ZOLE
  if (contract === CONTRACT_ZOLE) {
    bigWins = bigEyes >= 61;

    if (!bigWins) {
      // Lielais -12, katrs Mazais +6 => payEach = -6
      payEachSigned = -6;
      status = "ZAUDĒ";
    } else {
      if (bigTricks === 8) {
        // Lielais +14, katrs Mazais -7 => payEach = +7
        payEachSigned = +7;
        status = "UZVAR BEZTUKŠĀ";
      } else if (bigEyes >= 91) {
        // Lielais +12, katrs Mazais -6 => payEach = +6
        payEachSigned = +6;
        status = "UZVAR JAŅOS";
      } else {
        // Lielais +10, katrs Mazais -5 => payEach = +5
        payEachSigned = +5;
        status = "UZVAR";
      }
    }
  }

  applyPayEachSigned(room, bigSeat, payEachSigned);

  const names = room.players.map((p) => p.username || null);
  const res = {
    ts: Date.now(),
    contract,
    bigSeat,
    bigWins,
    status,
    payEach: payEachSigned, // signed (per-mazais)
    bigEyes,
    oppEyes,
    bigTricks,
    oppTricks,
    talonEyes,
    discardEyes,
    names
  };

  finishHandToLobby(room, res, "HAND_FINISHED");
}

/* ============================
   SCORE — MAZĀ (pēc tavas tabulas)
   +12 ja 0 stiķi, citādi -12
   ============================ */
function scoreMaza(room, reason) {
  const bigSeat = room.bigSeat;
  const bigTricks = trickCount(room.taken[bigSeat]);
  const bigWins = bigTricks === 0;

  // Lielais +12 / -12 => payEach = +6 / -6
  const payEachSigned = bigWins ? +6 : -6;
  const status = bigWins ? "UZVAR" : "ZAUDĒ";

  applyPayEachSigned(room, bigSeat, payEachSigned);

  const names = room.players.map((p) => p.username || null);
  const res = {
    ts: Date.now(),
    contract: CONTRACT_MAZA,
    bigSeat,
    bigWins,
    status,
    payEach: payEachSigned,
    bigTricks,
    reason: reason || "END",
    names
  };

  finishHandToLobby(room, res, "HAND_FINISHED");
}

/* ============================
   SCORE — GALDS (visi GARĀM)
   primāri: visvairāk stiķu zaudē
   ja 2 vienādi max stiķi -> tie-break acis
   ja arī acis vienādi -> abi “dalīti” maksā
   Punkti (bāze = GALDS_PAY):
   - 1 zaudētājs: viņš -2*base, pārējie +base
   - 2 zaudētāji: abi -base, trešais +2*base
   ============================ */
function scoreGalds(room) {
  const tricks = room.taken.map((t) => trickCount(t));
  const eyes = room.taken.map((t) => sumEyes(t));

  const maxTr = Math.max(...tricks);
  let losers = [0, 1, 2].filter((s) => tricks[s] === maxTr);

  // tie-break pēc acīm, ja 2 (vai 3) ir max-tricks
  if (losers.length > 1) {
    const maxEyesAmong = Math.max(...losers.map((s) => eyes[s]));
    losers = losers.filter((s) => eyes[s] === maxEyesAmong);
  }

  const deltas = [0, 0, 0];
  let loserSeats = [];
  let note = "";

  if (losers.length === 1) {
    const L = losers[0];
    deltas[L] = -2 * GALDS_PAY;
    for (let s = 0; s < 3; s++) if (s !== L) deltas[s] = +GALDS_PAY;
    loserSeats = [L];
    note = `GALDS: loser=seat${L}`;
  } else if (losers.length === 2) {
    const [a, b] = losers;
    deltas[a] = -GALDS_PAY;
    deltas[b] = -GALDS_PAY;
    const w = [0, 1, 2].find((s) => s !== a && s !== b);
    deltas[w] = +2 * GALDS_PAY;
    loserSeats = [a, b];
    note = `GALDS: split losers seat${a}&seat${b}`;
  } else {
    // teorētiski: pilnīgs neizšķirts
    note = `GALDS: all equal`;
  }

  for (let s = 0; s < 3; s++) room.players[s].matchPts += deltas[s];

  const winnerSeat = deltas.indexOf(Math.max(...deltas)); // informācijai UI (tas ar +2 vai viens no +1)
  const names = room.players.map((p) => p.username || null);

  const res = {
    ts: Date.now(),
    contract: CONTRACT_GALDS,
    tricks,
    eyes,
    loserSeats,
    winnerSeat,
    galdsPay: GALDS_PAY,
    note,
    names
  };

  finishHandToLobby(room, res, "HAND_FINISHED");
}

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
      galdsPay: GALDS_PAY,
      galdsLoserPts: -(GALDS_PAY * 2),
      galdsSplitLoserPts: -GALDS_PAY
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
    // 1) atgriež seat pēc username, ja tas bija atvienots
    let seat = room.players.findIndex((p) => p.username === username && !p.connected);
    if (seat !== -1) return seat;

    // 2) aizliedz dublikātu nick, ja tas jau pieslēgts
    const dup = room.players.find((p) => p.username === username && p.connected);
    if (dup) return -2;

    // 3) ņem brīvu seat
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

    // lock seed pēc izdalīšanas (fairness)
    if (room.deck && room.deck.length) return;

    const seed = String(seedRaw || "").trim().slice(0, 64);
    if (!seed) return;

    room.players[seat].seed = seed;

    // ja hand jau ir sācies un vēl nav izdalīts, izdalām tiklīdz pēdējais seed atnāk
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

    // drošībai, ja nav izdalīts
    if (!room.deck) {
      const did = dealIfReady(room);
      if (!did) return ack?.({ ok: false, error: "WAIT_SEEDS" });
      emitRoom(room, { note: "DEAL_OK" });
    }

    let bidRaw = String(payload?.bid || "").toUpperCase().trim();

    // pieņem arī vecos alias
    if (bidRaw === "PASS") bidRaw = "GARĀM";
    if (bidRaw === "TAKE") bidRaw = "ŅEMT GALDU";

    // MAZĀ alias
    if (bidRaw === "MAZA_ZOLE" || bidRaw === "MAZA ZOLE" || bidRaw === "MAZA" || bidRaw === "MAZĀ ZOLE")
      bidRaw = "MAZĀ";

    const allowed = new Set(["GARĀM", "ŅEMT GALDU", "ZOLE", "MAZĀ"]);
    if (!allowed.has(bidRaw)) return ack?.({ ok: false, error: "BAD_BID" });

    room.bids.push({ seat, bid: bidRaw });

    if (bidRaw === "GARĀM") {
      room.turnSeat = nextSeatCW(room.turnSeat);

      const passCount = room.bids.filter((b) => b.bid === "GARĀM").length;
      if (passCount >= 3) {
        room.contract = CONTRACT_GALDS;
        room.bigSeat = null;

        room.phase = "PLAY";
        room.trickPlays = [];
        room.turnSeat = room.leaderSeat;

        room.galdsTrickNo = 0;
        room.galdsTalonIndex = 0;

        emitRoom(room, { note: "ALL_GARAM_GALDS" });
        return ack?.({ ok: true, allPass: true, mode: CONTRACT_GALDS });
      }

      emitRoom(room, { note: "GARAM" });
      return ack?.({ ok: true });
    }

    // ŅEMT GALDU / ZOLE / MAZĀ beidz solīšanu uzreiz
    room.bigSeat = seat;

    if (bidRaw === "ŅEMT GALDU") {
      room.contract = CONTRACT_TAKE;
      room.phase = "DISCARD";

      room.hands[seat] = (room.hands[seat] || []).concat(room.talon);
      room.turnSeat = seat;

      emitRoom(room, { note: "TAKE_SELECTED" });
      return ack?.({ ok: true });
    }

    if (bidRaw === "ZOLE") {
      room.contract = CONTRACT_ZOLE;
      preparePlayPhase(room);
      emitRoom(room, { note: "ZOLE_SELECTED" });
      return ack?.({ ok: true });
    }

    if (bidRaw === "MAZĀ") {
      room.contract = CONTRACT_MAZA;
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
    if (room.contract !== CONTRACT_TAKE) return ack?.({ ok: false, error: "NOT_TAKE" });

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

    // GALDS: talona kārtis pieliek 1. un 2. stiķim (uzvarētājam)
    if (room.contract === CONTRACT_GALDS) {
      room.galdsTrickNo += 1;
      if (room.galdsTrickNo <= 2 && room.galdsTalonIndex < room.talon.length) {
        room.taken[winnerSeat].push(room.talon[room.galdsTalonIndex]);
        room.galdsTalonIndex += 1;
      }
    }

    emitRoom(room, { note: "TRICK_WIN", trickWinner: winnerSeat });

    // MAZĀ: ja lielais paņem 1 stiķi -> tūlītējs zaudējums
    if (room.contract === CONTRACT_MAZA && winnerSeat === room.bigSeat) {
      return scoreMaza(room, "TOOK_TRICK");
    }

    const allHandsEmpty = room.hands.every((h) => (h?.length || 0) === 0);
    if (!allHandsEmpty) return;

    if (room.contract === CONTRACT_TAKE || room.contract === CONTRACT_ZOLE) return scoreTakeOrZole(room);
    if (room.contract === CONTRACT_MAZA) return scoreMaza(room, "END");
    if (room.contract === CONTRACT_GALDS) return scoreGalds(room);

    // fallback
    return scoreTakeOrZole(room);
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
  console.log(`[zole] GALDS_PAY=${GALDS_PAY}`);
  console.log(`[zole] CORS_ORIGINS: ${CORS_ORIGINS.length ? CORS_ORIGINS.join(", ") : "ANY"}`);
});
