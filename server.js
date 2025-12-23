// thezone-zole-server — Bugats baseline (v1.1)
// Features: 3-player rooms, READY lobby, fairness commit-reveal shuffle,
// bidding: PASS / ŅEM (parastā) / ZOLE / MAZĀ ZOLE / LIELĀ ZOLE,
// legal-move validation + trick winner, scoring + match points, avatars,
// GET / + /health for Render.

const express = require("express");
const http = require("http");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 10080;

// ===== CORS =====
function parseCorsOrigins() {
  const raw = (process.env.CORS_ORIGINS || "").trim();
  if (!raw) return { any: true, list: [] };
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes("*")) return { any: true, list: [] };
  return { any: false, list };
}
const CORS = parseCorsOrigins();

function corsOriginCheck(origin, cb) {
  if (!origin) return cb(null, true); // server-to-server / curl
  if (CORS.any) return cb(null, true);
  if (CORS.list.includes(origin)) return cb(null, true);
  return cb(new Error("CORS blocked: " + origin), false);
}

const app = express();
app.use(cors({ origin: corsOriginCheck, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => res.type("text").send("thezone-zole-server OK"));
app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// Optional: serve static if /public exists in repo
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

const server = http.createServer(app);

const { Server } = require("socket.io");
const io = new Server(server, {
  cors: {
    origin: corsOriginCheck,
    credentials: true
  }
});

// ===== Cards / Rules =====
const SUITS = ["C", "S", "H", "D"]; // clubs, spades, hearts, diamonds
const RANKS_6 = ["A", "K", "Q", "J", "10", "9"]; // piquet subset
// Zole deck: all A,K,Q,J,10,9 of each suit + 8♦ + 7♦ = 26 cards.
function buildDeck26() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS_6) deck.push(cardOf(r, s));
  }
  deck.push(cardOf("8", "D"));
  deck.push(cardOf("7", "D"));
  return deck;
}
function cardOf(rank, suit) {
  return { id: `${rank}${suit}`, rank, suit };
}
function isTrump(card) {
  if (!card) return false;
  if (card.suit === "D") return true;
  if (card.rank === "Q" || card.rank === "J") return true;
  return false;
}

// Trump strength order (highest first):
// Q♣ Q♠ Q♥ Q♦ J♣ J♠ J♥ J♦ A♦ 10♦ K♦ 9♦ 8♦ 7♦
const TRUMP_ORDER = [
  "QC", "QS", "QH", "QD",
  "JC", "JS", "JH", "JD",
  "AD", "10D", "KD", "9D", "8D", "7D"
];
const TRUMP_INDEX = new Map(TRUMP_ORDER.map((id, i) => [id, i]));

// Non-trump suit order (highest first): A,10,K,9
const NONTRUMP_ORDER = ["A", "10", "K", "9"];
const NONTRUMP_INDEX = new Map(NONTRUMP_ORDER.map((r, i) => [r, i]));

// Card points: A11, 10=10, K4, Q3, J2, 9/8/7=0
function cardPoints(c) {
  if (!c) return 0;
  if (c.rank === "A") return 11;
  if (c.rank === "10") return 10;
  if (c.rank === "K") return 4;
  if (c.rank === "Q") return 3;
  if (c.rank === "J") return 2;
  return 0;
}

// Lead type:
// - If lead is trump => must play trump if possible
// - Else => must follow lead suit with NON-trumps of that suit if possible (Q/J are trumps)
function leadKey(card) {
  if (isTrump(card)) return { type: "TRUMP", suit: "D" };
  return { type: "SUIT", suit: card.suit };
}

function legalCardsForHand(hand, leadCard) {
  if (!leadCard) return hand.slice();

  const lk = leadKey(leadCard);
  if (lk.type === "TRUMP") {
    const trumps = hand.filter(isTrump);
    return trumps.length ? trumps : hand.slice();
  } else {
    const sameSuitNonTrump = hand.filter(
      (c) => !isTrump(c) && c.suit === lk.suit
    );
    return sameSuitNonTrump.length ? sameSuitNonTrump : hand.slice();
  }
}

function trickWinnerSeat(trickCards, leadCard) {
  // trickCards: [{seat, card}, ...] length 3
  // If any trump in trick => highest trump (lowest TRUMP_INDEX) wins
  const trumps = trickCards.filter((x) => isTrump(x.card));
  if (trumps.length) {
    trumps.sort((a, b) => {
      const ai = TRUMP_INDEX.get(a.card.id);
      const bi = TRUMP_INDEX.get(b.card.id);
      return ai - bi;
    });
    return trumps[0].seat;
  }

  // Else highest in lead suit among NON-trumps
  const lk = leadKey(leadCard);
  const suited = trickCards.filter(
    (x) => !isTrump(x.card) && x.card.suit === lk.suit
  );
  suited.sort((a, b) => {
    const ai = NONTRUMP_INDEX.get(a.card.rank);
    const bi = NONTRUMP_INDEX.get(b.card.rank);
    return ai - bi;
  });
  return suited[0].seat;
}

// ===== Deterministic shuffle (commit-reveal) =====
function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function seedToUint32(seedHex) {
  const h = crypto.createHash("sha256").update(seedHex).digest();
  // take 4 bytes
  return h.readUInt32LE(0) >>> 0;
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleDeterministic(arr, seedHex) {
  const a = arr.slice();
  const rnd = mulberry32(seedToUint32(seedHex));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ===== Scoring system =====
// Šis ir “žetonu” variants, ko Latvijā bieži izmanto (parastā +1/+2/+3,
// zole +5/+6/+7, un zaudējumiem stingrāks mīnuss; mazā zole +6/-7).
// Aprakstus par “zole / mazā zole” un šiem skaitļiem var atrast dažādos noteikumu kopsavilkumos. :contentReference[oaicite:3]{index=3}
const SCORE = {
  NORMAL: {
    WIN: { base: 1, jani: 2, allTricks: 3 },
    LOSE: { base: 2, jani: 3, noTricks: 4 } // zaudējumi ir dārgāki
  },
  ZOLE: {
    WIN: { base: 5, jani: 6, allTricks: 7 },
    LOSE: { base: 6, jani: 7, noTricks: 8 }
  },
  MAZA: {
    WIN: 6,
    LOSE: 7
  },
  LIELA: {
    // Interpretācija: “Lielā zole” = līgums uz VISIEM STIĶIEM (8/8),
    // un, ja neizdodas, sods kā zoles smagākais zaudējums.
    WIN: 7,
    LOSE: 8
  }
};

function payoutPerDefender(contract, outcome) {
  // returns a signed integer "a", so that:
  // defender: matchPts -= a; big: matchPts += a
  // If big loses, we return negative to subtract from big and add to defenders.
  return outcome;
}

// ===== Rooms =====
const rooms = new Map(); // roomId -> room

function makeRoom(roomId) {
  return {
    roomId,
    phase: "LOBBY",
    handNo: 0,
    dealerSeat: 0,

    players: [
      makeSeat(),
      makeSeat(),
      makeSeat()
    ],

    // fairness
    serverSecret: null,
    serverCommit: null,

    // per-hand state
    seeds: [null, null, null], // client seeds
    deck: null,
    talon: [],
    hands: [[], [], []],
    discardPile: [],

    bids: [null, null, null],
    bidTurnSeat: null,
    highestBid: { seat: null, bid: "PASS" },
    contract: null,
    bigSeat: null,

    trick: { leaderSeat: null, cards: [] },
    turnSeat: null,
    taken: [[], [], []],
    tricksWon: [0, 0, 0],

    // match points (persistent per room)
    matchPts: [0, 0, 0],

    lastHand: null
  };
}
function makeSeat() {
  return {
    sid: null,
    cid: null,
    username: null,
    avatarUrl: null,
    ready: false,
    connected: false
  };
}

function normalizeRoomId(raw) {
  return String(raw || "").toUpperCase().trim();
}
function validRoomId(roomId) {
  return /^[A-Z0-9]{2,8}$/.test(roomId);
}
function normalizeUsername(raw) {
  return String(raw || "").trim().slice(0, 24);
}
function normalizeAvatarUrl(raw) {
  const s = String(raw || "").trim().slice(0, 400);
  if (!s) return null;
  // allow https/http and data:image
  if (/^https?:\/\/.+/i.test(s)) return s;
  if (/^data:image\/(png|jpg|jpeg|webp|gif);base64,/i.test(s)) return s;
  return null;
}

function publicState(room) {
  return {
    roomId: room.roomId,
    phase: room.phase,
    handNo: room.handNo,
    dealerSeat: room.dealerSeat,

    players: room.players.map((p, i) => ({
      seat: i,
      username: p.username,
      avatarUrl: p.avatarUrl,
      ready: p.ready,
      connected: p.connected,
      matchPts: room.matchPts[i]
    })),

    serverCommit: room.serverCommit,

    bids: room.bids,
    bidTurnSeat: room.bidTurnSeat,
    highestBid: room.highestBid,
    contract: room.contract,
    bigSeat: room.bigSeat,

    trick: {
      leaderSeat: room.trick.leaderSeat,
      cards: room.trick.cards.map((x) => ({ seat: x.seat, card: x.card }))
    },
    turnSeat: room.turnSeat,

    // for UI display only (no secrets)
    talonCount: room.talon.length,
    handCounts: room.hands.map((h) => h.length),

    lastHand: room.lastHand
  };
}

function emitRoom(room) {
  io.to(room.roomId).emit("room:state", publicState(room));
}
function emitPrivateHand(room, seat) {
  const p = room.players[seat];
  if (!p || !p.sid) return;
  io.to(p.sid).emit("hand:you", {
    hand: room.hands[seat],
    seat,
    roomId: room.roomId,
    phase: room.phase,
    contract: room.contract,
    bigSeat: room.bigSeat
  });
}
function emitLegal(room) {
  if (room.phase !== "PLAY") return;
  const seat = room.turnSeat;
  if (seat == null) return;
  const p = room.players[seat];
  if (!p || !p.sid) return;

  const leadCard = room.trick.cards.length ? room.trick.cards[0].card : null;
  const legal = legalCardsForHand(room.hands[seat], leadCard).map((c) => c.id);

  io.to(p.sid).emit("legal:you", { legalIds: legal, turnSeat: seat });
  io.to(room.roomId).emit("turn:update", { turnSeat: seat });
}

// ===== Hand flow =====
const BID_RANK = { PASS: 0, TAKE: 1, ZOLE: 2, MAZA: 3, LIELA: 4 };

function startHand(room) {
  room.handNo += 1;
  room.phase = "BIDDING";

  room.serverSecret = crypto.randomBytes(16).toString("hex");
  room.serverCommit = sha256Hex(room.serverSecret);

  room.seeds = [null, null, null];
  room.deck = null;

  room.talon = [];
  room.hands = [[], [], []];
  room.discardPile = [];

  room.bids = [null, null, null];
  room.bidTurnSeat = (room.dealerSeat + 1) % 3;
  room.highestBid = { seat: null, bid: "PASS" };
  room.contract = null;
  room.bigSeat = null;

  room.trick = { leaderSeat: null, cards: [] };
  room.turnSeat = null;
  room.taken = [[], [], []];
  room.tricksWon = [0, 0, 0];

  room.lastHand = null;

  // ask seeds
  emitRoom(room);
  io.to(room.roomId).emit("fair:needSeed", { commit: room.serverCommit });
}

function maybeDealIfReady(room) {
  const allSeated =
    room.players.every((p) => !!p.username) &&
    room.players.every((p) => p.connected);

  const allReady = room.players.every((p) => p.ready);

  if (!allSeated || !allReady) return;

  // If we are in LOBBY, start bidding/hand immediately
  if (room.phase === "LOBBY") startHand(room);
}

function tryFinalizeDeal(room) {
  if (room.phase !== "BIDDING") return;
  if (!room.serverSecret || !room.serverCommit) return;
  if (room.seeds.some((s) => !s)) return;

  // combine seed: serverSecret + 3 client seeds by seat
  const combined = sha256Hex(
    room.serverSecret + "|" + room.seeds.join("|")
  );

  const deck = shuffleDeterministic(buildDeck26(), combined);
  // Deal 8 each + 2 talon at end
  room.hands[0] = deck.slice(0, 8);
  room.hands[1] = deck.slice(8, 16);
  room.hands[2] = deck.slice(16, 24);
  room.talon = deck.slice(24, 26);

  // reveal server secret to clients (fairness)
  io.to(room.roomId).emit("fair:reveal", {
    serverSecret: room.serverSecret,
    combinedSeed: combined
  });

  // Send private hands
  emitPrivateHand(room, 0);
  emitPrivateHand(room, 1);
  emitPrivateHand(room, 2);

  emitRoom(room);
}

function endBidding(room) {
  const hb = room.highestBid;
  if (!hb || BID_RANK[hb.bid] === 0) {
    // Everyone passed -> redeal, rotate dealer
    room.phase = "LOBBY";
    room.dealerSeat = (room.dealerSeat + 1) % 3;
    room.players.forEach((p) => (p.ready = true)); // auto-ready keep flow
    emitRoom(room);
    // start immediately
    startHand(room);
    return;
  }

  room.bigSeat = hb.seat;
  room.contract = hb.bid;

  if (room.contract === "TAKE") {
    room.phase = "TAKE_SKAT";
    emitRoom(room);
    const big = room.players[room.bigSeat];
    if (big && big.sid) {
      io.to(big.sid).emit("skat:show", {
        talon: room.talon,
        note: "Tu esi LIELAIS. Paņem talonu un atmet 2 kārtis."
      });
    }
    return;
  }

  // ZOLE / MAZA / LIELA: no talon pickup
  room.phase = "PLAY";
  room.trick = { leaderSeat: (room.dealerSeat + 1) % 3, cards: [] };
  room.turnSeat = room.trick.leaderSeat;

  emitRoom(room);
  emitLegal(room);
}

function allPlayersBid(room) {
  return room.bids.every((b) => b !== null);
}

function nextSeat(seat) {
  return (seat + 1) % 3;
}

function computeHandResult(room) {
  const big = room.bigSeat;
  const defenders = [0, 1, 2].filter((s) => s !== big);

  // pile points
  let bigPile = room.taken[big].slice();
  if (room.contract === "TAKE") {
    bigPile = bigPile.concat(room.discardPile);
  } else {
    // talon goes to defenders
  }

  let defendersPile = room.taken[defenders[0]].concat(room.taken[defenders[1]]);
  if (room.contract !== "TAKE") defendersPile = defendersPile.concat(room.talon);

  const bigPts = bigPile.reduce((sum, c) => sum + cardPoints(c), 0);
  const defPts = defendersPile.reduce((sum, c) => sum + cardPoints(c), 0);

  const bigTricks = room.tricksWon[big];
  const defTricks = room.tricksWon[defenders[0]] + room.tricksWon[defenders[1]];

  let bigWins = false;
  if (room.contract === "MAZA") bigWins = (bigTricks === 0);
  else if (room.contract === "LIELA") bigWins = (bigTricks === 8);
  else bigWins = (bigPts >= 61);

  const defendersNoTricks = (defTricks === 0); // big took all 8
  const bigNoTricks = (bigTricks === 0);

  const defInJani = defPts < 30; // big got 90+
  const bigInJani = bigPts < 31; // defenders got 90+

  // payout per defender (signed for big)
  let a = 0;

  if (room.contract === "TAKE") {
    if (bigWins) {
      if (defendersNoTricks) a = SCORE.NORMAL.WIN.allTricks;
      else if (defInJani) a = SCORE.NORMAL.WIN.jani;
      else a = SCORE.NORMAL.WIN.base;
    } else {
      if (bigNoTricks) a = -SCORE.NORMAL.LOSE.noTricks;
      else if (bigInJani) a = -SCORE.NORMAL.LOSE.jani;
      else a = -SCORE.NORMAL.LOSE.base;
    }
  } else if (room.contract === "ZOLE") {
    if (bigWins) {
      if (defendersNoTricks) a = SCORE.ZOLE.WIN.allTricks;
      else if (defInJani) a = SCORE.ZOLE.WIN.jani;
      else a = SCORE.ZOLE.WIN.base;
    } else {
      if (bigNoTricks) a = -SCORE.ZOLE.LOSE.noTricks;
      else if (bigInJani) a = -SCORE.ZOLE.LOSE.jani;
      else a = -SCORE.ZOLE.LOSE.base;
    }
  } else if (room.contract === "MAZA") {
    a = bigWins ? SCORE.MAZA.WIN : -SCORE.MAZA.LOSE;
  } else if (room.contract === "LIELA") {
    a = bigWins ? SCORE.LIELA.WIN : -SCORE.LIELA.LOSE;
  }

  // apply match points
  for (const d of defenders) {
    room.matchPts[big] += a;
    room.matchPts[d] -= a;
  }

  return {
    contract: room.contract,
    bigSeat: big,
    bigWins,
    payoutPerDefender: Math.abs(a),
    payoutSigned: a,
    bigPts,
    defPts,
    bigTricks,
    defTricks
  };
}

function finishHand(room) {
  const res = computeHandResult(room);
  room.lastHand = res;

  room.phase = "LOBBY";
  room.dealerSeat = (room.dealerSeat + 1) % 3;

  // reset ready (lai pēc partijas var saskaņot nākamo)
  room.players.forEach((p) => (p.ready = false));

  // clear per-hand secrets (hands stay until next deal; but we will clear for safety)
  room.serverSecret = null;
  room.serverCommit = null;
  room.seeds = [null, null, null];

  room.deck = null;
  room.talon = [];
  room.hands = [[], [], []];
  room.discardPile = [];

  room.bids = [null, null, null];
  room.bidTurnSeat = null;
  room.highestBid = { seat: null, bid: "PASS" };
  room.contract = null;
  room.bigSeat = null;

  room.trick = { leaderSeat: null, cards: [] };
  room.turnSeat = null;
  room.taken = [[], [], []];
  room.tricksWon = [0, 0, 0];

  emitRoom(room);
}

// ===== Socket.IO =====
io.on("connection", (socket) => {
  socket.emit("server:hello", { ok: true, ts: Date.now() });

  function getRoomBySocket() {
    const rid = socket.data.roomId;
    if (!rid) return null;
    return rooms.get(rid) || null;
  }

  socket.on("room:create", (payload, cb) => {
    try {
      const roomId = normalizeRoomId(payload?.roomId);
      if (!validRoomId(roomId)) return cb?.({ ok: false, error: "Nederīgs ROOM (2–8 burti/cipari)." });

      let room = rooms.get(roomId);
      if (!room) {
        room = makeRoom(roomId);
        rooms.set(roomId, room);
      }

      cb?.({ ok: true, roomId });
    } catch (e) {
      cb?.({ ok: false, error: String(e?.message || e) });
    }
  });

  socket.on("room:join", (payload, cb) => {
    try {
      const roomId = normalizeRoomId(payload?.roomId);
      const username = normalizeUsername(payload?.username);
      const cid = String(payload?.cid || "").trim().slice(0, 80);
      const avatarUrl = normalizeAvatarUrl(payload?.avatarUrl);

      if (!validRoomId(roomId)) return cb?.({ ok: false, error: "Nederīgs ROOM (2–8 burti/cipari)." });
      if (!username) return cb?.({ ok: false, error: "Ievadi niku." });
      if (!cid) return cb?.({ ok: false, error: "Nav CID (localStorage). Atver lapu vēlreiz." });

      let room = rooms.get(roomId);
      if (!room) {
        room = makeRoom(roomId);
        rooms.set(roomId, room);
      }

      // Reconnect by CID
      let seat = room.players.findIndex((p) => p.cid === cid);
      if (seat === -1) {
        // No duplicate usernames allowed (except same CID)
        const dupe = room.players.find((p) => p.username && p.username.toLowerCase() === username.toLowerCase());
        if (dupe) return cb?.({ ok: false, error: "Šāds niks jau ir istabā. Izvēlies citu (testam)." });

        seat = room.players.findIndex((p) => !p.username);
        if (seat === -1) return cb?.({ ok: false, error: "Istaba pilna (3/3)." });

        room.players[seat].cid = cid;
      }

      // Assign seat
      room.players[seat].sid = socket.id;
      room.players[seat].connected = true;
      room.players[seat].username = username;
      room.players[seat].avatarUrl = avatarUrl;

      socket.data.roomId = roomId;
      socket.data.seat = seat;

      socket.join(roomId);

      cb?.({ ok: true, roomId, seat });

      emitRoom(room);

      // In lobby, allow ready flow; if in bidding/play, send state + (no private hand unless already dealt)
      // NOTE: we purposely do not send old hands on reconnect for safety;
      // next hand will deal fresh.
    } catch (e) {
      cb?.({ ok: false, error: String(e?.message || e) });
    }
  });

  socket.on("room:leave", (payload, cb) => {
    const room = getRoomBySocket();
    if (!room) return cb?.({ ok: true });

    const seat = socket.data.seat;
    if (seat != null && room.players[seat]) {
      room.players[seat].connected = false;
      room.players[seat].sid = null;
      room.players[seat].ready = false;
    }
    socket.leave(room.roomId);
    socket.data.roomId = null;
    socket.data.seat = null;

    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on("zole:ready", (payload, cb) => {
    const room = getRoomBySocket();
    if (!room) return cb?.({ ok: false, error: "Nav istabas." });
    const seat = socket.data.seat;
    if (seat == null) return cb?.({ ok: false, error: "Nav seat." });

    room.players[seat].ready = !!payload?.ready;
    emitRoom(room);
    cb?.({ ok: true, ready: room.players[seat].ready });

    maybeDealIfReady(room);
  });

  socket.on("fair:seed", (payload, cb) => {
    const room = getRoomBySocket();
    if (!room) return cb?.({ ok: false, error: "Nav istabas." });
    const seat = socket.data.seat;
    if (seat == null) return cb?.({ ok: false, error: "Nav seat." });
    if (room.phase !== "BIDDING") return cb?.({ ok: false, error: "Seed nav vajadzīgs šajā fāzē." });

    const seed = String(payload?.seed || "").trim().slice(0, 128);
    if (!seed) return cb?.({ ok: false, error: "Seed tukšs." });

    room.seeds[seat] = seed;
    cb?.({ ok: true });

    tryFinalizeDeal(room);
  });

  socket.on("bid:make", (payload, cb) => {
    const room = getRoomBySocket();
    if (!room) return cb?.({ ok: false, error: "Nav istabas." });
    const seat = socket.data.seat;
    if (seat == null) return cb?.({ ok: false, error: "Nav seat." });
    if (room.phase !== "BIDDING") return cb?.({ ok: false, error: "Nav bidding fāze." });
    if (seat !== room.bidTurnSeat) return cb?.({ ok: false, error: "Nav tava kārta." });

    const bid = String(payload?.bid || "PASS").toUpperCase();
    if (!BID_RANK.hasOwnProperty(bid)) return cb?.({ ok: false, error: "Nederīgs bids." });

    room.bids[seat] = bid;

    // update highest
    const curRank = BID_RANK[bid];
    const highRank = BID_RANK[room.highestBid.bid];
    if (curRank > highRank) {
      room.highestBid = { seat, bid };
    }

    // next
    room.bidTurnSeat = nextSeat(room.bidTurnSeat);

    emitRoom(room);
    cb?.({ ok: true });

    // If everyone has placed a bid once, end bidding
    if (allPlayersBid(room)) {
      endBidding(room);
    }
  });

  socket.on("skat:discard", (payload, cb) => {
    const room = getRoomBySocket();
    if (!room) return cb?.({ ok: false, error: "Nav istabas." });
    const seat = socket.data.seat;
    if (seat == null) return cb?.({ ok: false, error: "Nav seat." });
    if (room.phase !== "TAKE_SKAT") return cb?.({ ok: false, error: "Nav TAKE_SKAT fāze." });
    if (seat !== room.bigSeat) return cb?.({ ok: false, error: "Tikai LIELAIS drīkst." });

    const ids = Array.isArray(payload?.discardIds) ? payload.discardIds : [];
    const discardIds = ids.map(String);
    if (discardIds.length !== 2) return cb?.({ ok: false, error: "Jāatmet tieši 2 kārtis." });

    // Big takes talon into hand (only now)
    room.hands[seat] = room.hands[seat].concat(room.talon);
    room.talon = [];

    const hand = room.hands[seat];
    const hasAll = discardIds.every((id) => hand.some((c) => c.id === id));
    if (!hasAll) return cb?.({ ok: false, error: "Atmestās kārtis nav tavā rokā." });

    // remove from hand
    const disc = [];
    room.hands[seat] = hand.filter((c) => {
      if (discardIds.includes(c.id)) {
        disc.push(c);
        // remove only once per id
        discardIds.splice(discardIds.indexOf(c.id), 1);
        return false;
      }
      return true;
    });

    if (disc.length !== 2) return cb?.({ ok: false, error: "Atmešana neizdevās." });

    room.discardPile = room.discardPile.concat(disc);

    // go to PLAY
    room.phase = "PLAY";
    room.trick = { leaderSeat: (room.dealerSeat + 1) % 3, cards: [] };
    room.turnSeat = room.trick.leaderSeat;

    // send private updated hand
    emitPrivateHand(room, seat);

    emitRoom(room);
    emitLegal(room);

    cb?.({ ok: true });
  });

  socket.on("card:play", (payload, cb) => {
    const room = getRoomBySocket();
    if (!room) return cb?.({ ok: false, error: "Nav istabas." });
    const seat = socket.data.seat;
    if (seat == null) return cb?.({ ok: false, error: "Nav seat." });
    if (room.phase !== "PLAY") return cb?.({ ok: false, error: "Nav PLAY fāze." });
    if (seat !== room.turnSeat) return cb?.({ ok: false, error: "Nav tava kārta." });

    const cardId = String(payload?.cardId || "").trim();
    if (!cardId) return cb?.({ ok: false, error: "Nav cardId." });

    const hand = room.hands[seat];
    const card = hand.find((c) => c.id === cardId);
    if (!card) return cb?.({ ok: false, error: "Šīs kārts nav tavā rokā." });

    const leadCard = room.trick.cards.length ? room.trick.cards[0].card : null;
    const legal = legalCardsForHand(hand, leadCard).map((c) => c.id);
    if (!legal.includes(cardId)) return cb?.({ ok: false, error: "Neleģisks gājiens (jāseko mastam / trumpim, ja vari)." });

    // remove card from hand
    room.hands[seat] = hand.filter((c) => c.id !== cardId);

    // add to trick
    if (room.trick.cards.length === 0) room.trick.leaderSeat = seat;
    room.trick.cards.push({ seat, card });

    emitPrivateHand(room, seat);
    emitRoom(room);

    cb?.({ ok: true });

    if (room.trick.cards.length < 3) {
      room.turnSeat = nextSeat(room.turnSeat);
      emitLegal(room);
      return;
    }

    // Trick complete
    const lead = room.trick.cards[0].card;
    const winner = trickWinnerSeat(room.trick.cards, lead);

    // collect trick cards to winner
    const cardsWon = room.trick.cards.map((x) => x.card);
    room.taken[winner] = room.taken[winner].concat(cardsWon);
    room.tricksWon[winner] += 1;

    io.to(room.roomId).emit("trick:complete", {
      winnerSeat: winner,
      cards: room.trick.cards.map((x) => ({ seat: x.seat, card: x.card }))
    });

    // next trick
    room.trick = { leaderSeat: winner, cards: [] };
    room.turnSeat = winner;

    emitRoom(room);

    // End of hand?
    const emptyAll = room.hands.every((h) => h.length === 0);
    if (emptyAll) {
      finishHand(room);
      return;
    }

    emitLegal(room);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    if (!roomId || seat == null) return;

    const room = rooms.get(roomId);
    if (!room) return;

    if (room.players[seat] && room.players[seat].sid === socket.id) {
      room.players[seat].connected = false;
      room.players[seat].sid = null;
      room.players[seat].ready = false;
    }
    emitRoom(room);
  });
});

server.listen(PORT, () => {
  console.log("thezone-zole-server listening on", PORT);
});
