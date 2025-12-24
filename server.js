/* ============================
   THEZONE.LV — ZOLE v1.5 (BEZ PULĒM) — PILNĀ LOĢIKA
   - 3 spēlētāji, 26 kārtis
   - READY lobby → NEW_HAND → BIDDING → (TAKE: DISCARD2) → PLAY 8 stiķi → SCORE → LOBBY
   - Bidding: PASS / TAKE / ZOLE / MAZA
   - TAKE: paņem talonu + NOROK 2 (tikai lielais)
   - ZOLE: bez talona (talons pieskaitās mazajiem)
   - MAZĀ ZOLE: bez talona, BEZ TRUMPJIEM, mērķis 0 stiķi (tūlītējs zaudējums, ja paņem 1 stiķi)
   - Visi PASS: GALDIŅŠ (talons 1./2. stiķim, sods ar GALDINS_PAY)
   - Commit–reveal fairness (serverCommit + 3 client seed → deterministisks shuffle)
   - Seat "spoku" FIX: join/create vispirms atgriež seat pēc username (ja bija atvienots), tikai tad ņem tukšu.
   - FIX: KĀRTIS IZDALĀS UZREIZ PIE NEW_HAND (pēc READY), nevis tikai pēc pirmā bid
   - FIX: GĀJIENI/ROTĀCIJA iet PULKSTEŅRĀDĪTĀJA VIRZIENĀ (CW) (seat → (seat+2)%3)
   ============================ */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const PORT = process.env.PORT || 10080;

// Galdiņa sods “uz vieninieku”
const GALDINS_PAY = Math.max(
  1,
  Math.min(5, parseInt(process.env.GALDINS_PAY || "1", 10) || 1)
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
   PALĪGHELPERI — SEAT ROTĀCIJA (CW)
   UI mapping tev: left=(mySeat+2)%3, right=(mySeat+1)%3
   Lai gājiens vizuāli ietu pulksteņrādītāja virzienā: next = (seat+2)%3
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

// Bez trumpjiem (Mazā zole) stiprums: A > 10 > K > Q > J > 9 > 8 > 7
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
  if (contract === "MAZA") return { trumps: false };
  return { trumps: true }; // TAKE/ZOLE/GALDINS
}

function leadFollow(room, leadCard) {
  if (!leadCard) return null;
  const { trumps } = rulesForContract(room.contract);
  if (!trumps) return leadCard.s; // bez trumpjiem: vienmēr masts
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

    fairness: null, // { serverCommit, serverSecret, serverReveal, combinedHash }

    bids: [],
    bidTurnSeat: 0,

    contract: null,   // TAKE / ZOLE / MAZA / GALDINS
    bigSeat: null,    // TAKE/ZOLE/MAZA gadījumā

    deck: null,
    hands: [[], [], []],
    talon: [],
    discard: [],
    taken: [[], [], []],

    leaderSeat: null,
    turnSeat: null,
    trickPlays: [],

    // galdiņš
    galdinsTrickNo: 0,
    galdinsTalonIndex: 0
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
  // ✅ CW: nākamais pēc dīlera ir (dealer+2)%3
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

  room.galdinsTrickNo = 0;
  room.galdinsTalonIndex = 0;
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

  // ✅ CW: pirmais gājiens (leader) = nākamais pēc dīlera
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

  // ✅ BIDDING sākas no nākamā pēc dīlera (CW)
  room.turnSeat = room.bidTurnSeat;

  // ✅ FIX: izdalām uzreiz pie NEW_HAND, lai UI uzreiz rāda kārtis
  const didDeal = dealIfReady(room);

  emitRoom(room, { note: didDeal ? "NEW_HAND_DEALT" : "NEW_HAND_WAIT_SEEDS" });
}

function preparePlayPhase(room) {
  room.phase = "PLAY";
  room.trickPlays = [];
  room.turnSeat = room.leaderSeat;
}

function applyPayout(room, bigSeat, pay, bigWins) {
  if (bigWins) {
    room.players[bigSeat].matchPts += pay * 2;
    for (const p of room.players) if (p.seat !== bigSeat) p.matchPts -= pay;
  } else {
    room.players[bigSeat].matchPts -= pay * 2;
    for (const p of room.players) if (p.seat !== bigSeat) p.matchPts += pay;
  }
}

function endToLobby(room, extraNote) {
  room.phase = "LOBBY";
  for (const p of room.players) p.ready = false;

  // ✅ CW dīlera rotācija
  room.dealerSeat = nextSeatCW(room.dealerSeat);
  resetHandState(room);

  emitRoom(room, { note: extraNote || "BACK_TO_LOBBY" });
}

/* ===== Score: TAKE/ZOLE (pēc tavas tabulas) =====
   TAKE:
   - Uzvara 61–90: pay=2
   - Šmulis 91+: pay=4
   - Sausā (8 stiķi): pay=6
   - Zaudējums 31–60: pay=2
   - Zaudējums 0–30: pay=4

   ZOLE:
   - Uzvara: pay=10
   - Zaudējums: pay=12
*/
function scoreStandardHand(room) {
  const contract = room.contract; // TAKE/ZOLE
  const bigSeat = room.bigSeat;

  const totalEyes = 120;

  const bigTaken = room.taken[bigSeat];
  const bigTricks = trickCount(bigTaken);

  const discardEyes = sumEyes(room.discard);
  const talonEyes = sumEyes(room.talon);

  let bigEyes = sumEyes(bigTaken);
  if (contract === "TAKE") bigEyes += discardEyes; // TAKE: noraktās kārtis skaitās lielajam

  const oppEyes = totalEyes - bigEyes;

  let pay = 0;
  let bigWins = false;
  let note = "";

  if (contract === "TAKE") {
    bigWins = bigEyes >= 61;

    if (bigWins) {
      if (bigTricks === 8) pay = 6;      // sausā (visi stiķi)
      else if (bigEyes >= 91) pay = 4;   // šmulis (91+)
      else pay = 2;                      // 61–90
    } else {
      if (bigEyes <= 30) pay = 4;        // zaudējums šmuļos (0–30)
      else pay = 2;                      // 31–60
    }

    note = `TAKE: bigEyes=${bigEyes}, oppEyes=${oppEyes}, discardEyes=${discardEyes}, bigTricks=${bigTricks}, pay=${pay}, ${bigWins ? "WIN" : "LOSE"}`;
  }

  if (contract === "ZOLE") {
    bigWins = bigEyes >= 61;
    pay = bigWins ? 10 : 12;

    note = `ZOLE: bigEyes=${bigEyes}, oppEyes=${oppEyes}, talonEyes=${talonEyes}, bigTricks=${bigTricks}, pay=${pay}, ${bigWins ? "WIN" : "LOSE"}`;
  }

  applyPayout(room, bigSeat, pay, bigWins);

  room.phase = "SCORE";
  emitRoom(room, {
    note,
    scoring: { contract, bigSeat, bigEyes, oppEyes, talonEyes, discardEyes, bigTricks, pay, bigWins }
  });

  endToLobby(room, "BACK_TO_LOBBY");
}

/* ===== Score: MAZĀ ZOLE (pēc tavas tabulas) =====
   - Uzvara (0 stiķi): pay=12
   - Zaudējums (>=1 stiķis): pay=14
*/
function scoreMazaZole(room, reason) {
  const bigSeat = room.bigSeat;
  const bigTricks = trickCount(room.taken[bigSeat]);

  const bigWins = bigTricks === 0;
  const pay = bigWins ? 12 : 14;

  applyPayout(room, bigSeat, pay, bigWins);

  room.phase = "SCORE";
  emitRoom(room, {
    note: `MAZA: bigTricks=${bigTricks}, ${bigWins ? "WIN" : "LOSE"} (${reason || "END"}) pay=${pay}`,
    scoring: { contract: "MAZA", bigSeat, bigTricks, pay, bigWins, reason: reason || "END" }
  });

  endToLobby(room, "BACK_TO_LOBBY");
}

/* ===== Score: GALDIŅŠ (bez pulēm) ===== */
function scoreGaldins(room) {
  const tricks = room.taken.map((t) => trickCount(t));
  const eyes = room.taken.map((t) => sumEyes(t));

  const maxTr = Math.max(...tricks);
  const minTr = Math.min(...tricks);

  const losers = [];
  for (let s = 0; s < 3; s++) if (tricks[s] === maxTr) losers.push(s);

  const winners = [];
  for (let s = 0; s < 3; s++) if (tricks[s] === minTr) winners.push(s);
  const winnerSeat = winners[0];

  let note = "";
  if (losers.length === 1) {
    const L = losers[0];
    room.players[L].matchPts -= GALDINS_PAY * 2;
    for (let s = 0; s < 3; s++) if (s !== L) room.players[s].matchPts += GALDINS_PAY;
    note = `GALDINS: loser=seat${L} (-${GALDINS_PAY * 2}), others +${GALDINS_PAY}`;
  } else {
    const [a, b] = losers;

    if (eyes[a] > eyes[b]) {
      room.players[a].matchPts -= GALDINS_PAY * 2;
      room.players[winnerSeat].matchPts += GALDINS_PAY * 2;
      note = `GALDINS: loser=seat${a} by eyes -> winner seat${winnerSeat} +${GALDINS_PAY * 2}`;
    } else if (eyes[b] > eyes[a]) {
      room.players[b].matchPts -= GALDINS_PAY * 2;
      room.players[winnerSeat].matchPts += GALDINS_PAY * 2;
      note = `GALDINS: loser=seat${b} by eyes -> winner seat${winnerSeat} +${GALDINS_PAY * 2}`;
    } else {
      room.players[a].matchPts -= GALDINS_PAY;
      room.players[b].matchPts -= GALDINS_PAY;
      room.players[winnerSeat].matchPts += GALDINS_PAY * 2;
      note = `GALDINS: tie (tricks & eyes). seat${a} and seat${b} pay ${GALDINS_PAY} to winner seat${winnerSeat}`;
    }
  }

  room.phase = "SCORE";
  emitRoom(room, { note, scoring: { contract: "GALDINS", tricks, eyes, galdinsPay: GALDINS_PAY } });

  endToLobby(room, "BACK_TO_LOBBY");
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
      galdinsPay: GALDINS_PAY
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
    }
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

    // ✅ lock seed pēc izdalīšanas (fairness)
    if (room.deck && room.deck.length) return;

    const seed = String(seedRaw || "").trim().slice(0, 64);
    if (!seed) return;

    room.players[seat].seed = seed;

    // ✅ ja hand jau ir sācies un vēl nav izdalīts, izdalām tiklīdz pēdējais seed atnāk
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

    // fallback (drošībai), ja kaut kā nav izdalīts
    if (!room.deck) {
      const did = dealIfReady(room);
      if (!did) return ack?.({ ok: false, error: "WAIT_SEEDS" });
      emitRoom(room, { note: "DEAL_OK" });
    }

    let bidRaw = String(payload?.bid || "").toUpperCase().trim();
    if (
      bidRaw === "MAZA_ZOLE" ||
      bidRaw === "MAZA ZOLE" ||
      bidRaw === "MAZĀ" ||
      bidRaw === "MAZĀ ZOLE"
    )
      bidRaw = "MAZA";

    const allowed = new Set(["PASS", "TAKE", "ZOLE", "MAZA"]);
    if (!allowed.has(bidRaw)) return ack?.({ ok: false, error: "BAD_BID" });

    room.bids.push({ seat, bid: bidRaw });

    if (bidRaw === "PASS") {
      // ✅ CW nākamais solītājs
      room.turnSeat = nextSeatCW(room.turnSeat);

      const passCount = room.bids.filter((b) => b.bid === "PASS").length;
      if (passCount >= 3) {
        room.contract = "GALDINS";
        room.bigSeat = null;
        room.phase = "PLAY";
        room.trickPlays = [];
        room.turnSeat = room.leaderSeat;
        room.galdinsTrickNo = 0;
        room.galdinsTalonIndex = 0;

        emitRoom(room, { note: "ALL_PASS_GALDINS" });
        return ack?.({ ok: true, allPass: true, mode: "GALDINS" });
      }

      emitRoom(room, { note: "PASS" });
      return ack?.({ ok: true });
    }

    // TAKE / ZOLE / MAZA beidz bidding uzreiz
    room.bigSeat = seat;

    if (bidRaw === "TAKE") {
      room.contract = "TAKE";
      room.phase = "DISCARD";

      room.hands[seat] = (room.hands[seat] || []).concat(room.talon);
      room.turnSeat = seat;

      emitRoom(room, { note: "TAKE_SELECTED" });
      return ack?.({ ok: true });
    }

    if (bidRaw === "ZOLE") {
      room.contract = "ZOLE";
      preparePlayPhase(room);
      emitRoom(room, { note: "ZOLE_SELECTED" });
      return ack?.({ ok: true });
    }

    if (bidRaw === "MAZA") {
      room.contract = "MAZA";
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
    if (room.contract !== "TAKE") return ack?.({ ok: false, error: "NOT_TAKE" });

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
      // ✅ CW nākamais spēlētājs stiķī
      room.turnSeat = nextSeatCW(room.turnSeat);
      emitRoom(room, { note: "PLAY" });
      return;
    }

    const winnerSeat = pickTrickWinner(room, room.trickPlays);
    for (const p of room.trickPlays) room.taken[winnerSeat].push(p.card);

    room.trickPlays = [];
    room.leaderSeat = winnerSeat;
    room.turnSeat = winnerSeat;

    // GALDIŅŠ: talona kārtis pieliek 1. un 2. stiķim (uzvarētājam)
    if (room.contract === "GALDINS") {
      room.galdinsTrickNo += 1;
      if (room.galdinsTrickNo <= 2 && room.galdinsTalonIndex < room.talon.length) {
        room.taken[winnerSeat].push(room.talon[room.galdinsTalonIndex]);
        room.galdinsTalonIndex += 1;
      }
    }

    emitRoom(room, { note: "TRICK_WIN", trickWinner: winnerSeat });

    // MAZĀ ZOLE: ja lielais paņem 1 stiķi -> tūlītējs zaudējums
    if (room.contract === "MAZA" && winnerSeat === room.bigSeat) {
      return scoreMazaZole(room, "TOOK_TRICK");
    }

    const allHandsEmpty = room.hands.every((h) => (h?.length || 0) === 0);
    if (!allHandsEmpty) return;

    if (room.contract === "TAKE" || room.contract === "ZOLE") return scoreStandardHand(room);
    if (room.contract === "MAZA") return scoreMazaZole(room, "END_0_TRICKS_CHECK");
    if (room.contract === "GALDINS") return scoreGaldins(room);

    scoreStandardHand(room);
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
  console.log(`[zole] GALDINS_PAY=${GALDINS_PAY}`);
  console.log(`[zole] CORS_ORIGINS: ${CORS_ORIGINS.length ? CORS_ORIGINS.join(", ") : "ANY"}`);
});
