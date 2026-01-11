/* ============================
   THEZONE.LV — ZOLE (BEZ PULĒM) — PILNĀ LOĢIKA (LV nosaukumi)
   (Bugats baseline)
   ============================ */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 10080;

/* ============================
   COOKIE AUTH (lai /me strādā ar credentials:include)
   ============================ */
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "zole_token";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "1") !== "0"; // prod: 1
const COOKIE_SAMESITE = process.env.COOKIE_SAMESITE || "None"; // cross-site: None
const COOKIE_MAX_AGE_SEC = Math.max(
  60,
  Math.min(
    60 * 60 * 24 * 365,
    parseInt(
      process.env.COOKIE_MAX_AGE_SEC || String(60 * 60 * 24 * 30),
      10
    ) || (60 * 60 * 24 * 30)
  )
);

function parseCookies(header) {
  const out = Object.create(null);
  const s = String(header || "");
  if (!s) return out;
  const parts = s.split(";");
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v || "");
  }
  return out;
}

function setAuthCookie(res, token) {
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(String(token || ""))}`,
    `Path=/`,
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
    `HttpOnly`,
    `SameSite=${COOKIE_SAMESITE}`,
  ];
  if (COOKIE_SAMESITE.toLowerCase() === "none") {
    if (COOKIE_SECURE) bits.push("Secure");
  } else {
    if (COOKIE_SECURE) bits.push("Secure");
  }
  res.setHeader("Set-Cookie", bits.join("; "));
}

function clearAuthCookie(res) {
  const bits = [
    `${COOKIE_NAME}=`,
    `Path=/`,
    `Max-Age=0`,
    `HttpOnly`,
    `SameSite=${COOKIE_SAMESITE}`,
  ];
  if (COOKIE_SAMESITE.toLowerCase() === "none") {
    if (COOKIE_SECURE) bits.push("Secure");
  } else {
    if (COOKIE_SECURE) bits.push("Secure");
  }
  res.setHeader("Set-Cookie", bits.join("; "));
}

function getTokenFromReq(req) {
  const auth = String(req.headers.authorization || "").trim();
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return m[1].trim();
  }
  const cookies = parseCookies(req.headers.cookie);
  return String(
    cookies[COOKIE_NAME] || cookies.token || cookies.auth_token || ""
  ).trim();
}

/* ============================
   START PTS (katram spēlētājam sākuma punkti)
   ============================ */
const START_PTS = Math.max(
  0,
  Math.min(1_000_000_000, parseInt(process.env.START_PTS || "1000", 10) || 1000)
);

/* ============================
   AUTO-START / AUTO-NEXT HAND
   ============================ */
const AUTO_START_MS = Math.max(
  250,
  Math.min(15000, parseInt(process.env.AUTO_START_MS || "1200", 10) || 1200)
);

const AUTO_NEXT_HAND_MS = Math.max(
  250,
  Math.min(20000, parseInt(process.env.AUTO_NEXT_HAND_MS || "2000", 10) || 2000)
);

// Dev/house-rule: atļaut "atmesties" (nepildīt mastu) izspēlē
// 0 (default) = jāiet mastā (klasiskie noteikumi)
// 1 = brīvā izspēle (var mest jebkuru kārti)
const ALLOW_ATMESTIES = String(process.env.ALLOW_ATMESTIES || "0") === "1";

// “Galda/Galdiņa” pamata likme
const GALDS_PAY = Math.max(
  1,
  Math.min(
    5,
    parseInt(process.env.GALDS_PAY || process.env.GALDINS_PAY || "1", 10) || 1
  )
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

// Statiskā UI (lai "galds" var būt pilnekrāna klientā)
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/api/ping", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({ ok: true }));

/* ============================
   GLOBAL LEADERBOARD (TOP10)
   ============================ */
const DATA_DIR = path.join(__dirname, "data");
const LB_PATH = path.join(DATA_DIR, "zole_leaderboard.json");

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
}
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  } catch {}
}

ensureDir(DATA_DIR);

let LB = readJson(LB_PATH, { players: {} });
// LB.players[username] = { username, avatarUrl, pts, hands, updatedAt }

function lbSave() {
  writeJson(LB_PATH, LB);
}

function lbTouch(username, avatarUrl, initPtsIfNew) {
  if (!username) return { player: null, changed: false };

  const now = Date.now();
  let changed = false;

  let p = LB.players[username];
  if (!p) {
    p = {
      username,
      avatarUrl: avatarUrl || "",
      pts:
        typeof initPtsIfNew === "number" && Number.isFinite(initPtsIfNew)
          ? initPtsIfNew
          : START_PTS,
      hands: 0,
      updatedAt: now,
    };
    LB.players[username] = p;
    changed = true;
  }

  if (avatarUrl && avatarUrl !== p.avatarUrl) {
    p.avatarUrl = avatarUrl;
    changed = true;
  }

  if (typeof p.pts !== "number" || !Number.isFinite(p.pts)) {
    p.pts = START_PTS;
    changed = true;
  }

  if (typeof p.hands !== "number" || !Number.isFinite(p.hands)) {
    p.hands = 0;
    changed = true;
  }

  p.updatedAt = now;
  return { player: p, changed };
}

function lbApplyDeltas(roomPlayers, deltasByUsername) {
  let any = false;

  for (const rp of roomPlayers || []) {
    const u = rp?.username;
    if (!u) continue;

    const { player, changed } = lbTouch(u, rp.avatarUrl, rp.matchPts);
    if (!player) continue;

    const d = Number(deltasByUsername?.[u] ?? 0) || 0;

    player.hands = Number(player.hands || 0) + 1;
    player.updatedAt = Date.now();
    any = true;

    if (d !== 0) {
      player.pts = Number(player.pts || 0) + d;
    } else if (changed) {
      any = true;
    }
  }

  if (any) lbSave();
}

function lbTop10() {
  const arr = Object.values(LB.players || {});
  arr.sort(
    (a, b) =>
      Number(b.pts || 0) - Number(a.pts || 0) ||
      Number(b.hands || 0) - Number(a.hands || 0) ||
      String(a.username || "").localeCompare(String(b.username || ""))
  );
  return arr.slice(0, 10);
}

function lbPts(username) {
  if (!username) return START_PTS;
  const p = LB.players?.[username];
  return typeof p?.pts === "number" && Number.isFinite(p.pts)
    ? p.pts
    : START_PTS;
}

// Leaderboard routes (aliases)
app.get(
  ["/leaderboard", "/api/leaderboard", "/auth/leaderboard", "/api/auth/leaderboard"],
  (_req, res) => {
    const top10 = lbTop10();
    res.json({ ok: true, top10, top: top10, ts: Date.now() });
  }
);

/* ============================
   AUTH (signup/login)
   ============================ */
const USERS_PATH = path.join(DATA_DIR, "zole_users.json");
let USERS = readJson(USERS_PATH, { users: {} });

function usersSave() {
  writeJson(USERS_PATH, USERS);
}

function safeUsernameAuth(u) {
  return String(u || "").trim().slice(0, 18);
}
function safeAvatarUrlAuth(u) {
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

function pwHash(password, saltHex) {
  const salt = saltHex || crypto.randomBytes(16).toString("hex");
  const dk = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256");
  return `${salt}:${dk.toString("hex")}`;
}

function pwVerify(password, stored) {
  try {
    const [salt, hex] = String(stored || "").split(":");
    if (!salt || !hex) return false;
    const dk = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256");
    const a = Buffer.from(hex, "hex");
    const b = Buffer.from(dk.toString("hex"), "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecodeToUtf8(s) {
  const str = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str + pad, "base64").toString("utf8");
}

function signToken(payload) {
  const secret =
    process.env.AUTH_SECRET ||
    process.env.JWT_SECRET ||
    "ZOLE_AUTH_SECRET_CHANGE_ME";

  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 60 * 60 * 24 * 30;

  const body = { ...payload, iat: now, exp };
  const base = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;

  const sig = crypto
    .createHmac("sha256", secret)
    .update(base)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${base}.${sig}`;
}

function verifyToken(token) {
  try {
    const secret =
      process.env.AUTH_SECRET ||
      process.env.JWT_SECRET ||
      "ZOLE_AUTH_SECRET_CHANGE_ME";

    const t = String(token || "");
    const parts = t.split(".");
    if (parts.length !== 3) return { ok: false };

    const [h, p, s] = parts;
    const base = `${h}.${p}`;

    const sig = crypto
      .createHmac("sha256", secret)
      .update(base)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    // timing-safe compare
    const a = Buffer.from(sig);
    const b = Buffer.from(String(s || ""));
    if (a.length !== b.length) return { ok: false };
    if (!crypto.timingSafeEqual(a, b)) return { ok: false };

    const json = b64urlDecodeToUtf8(p);
    const payload = JSON.parse(json);

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now > payload.exp) return { ok: false, error: "TOKEN_EXPIRED" };

    return { ok: true, payload };
  } catch {
    return { ok: false };
  }
}

function normalizeUserKey(username) {
  return String(username || "").trim();
}
function userGet(username) {
  const key = normalizeUserKey(username);
  return USERS.users[key] || null;
}
function userSet(u) {
  const key = normalizeUserKey(u.username);
  USERS.users[key] = u;
  usersSave();
}

function authResponse(res, user) {
  const token = signToken({ username: user.username, avatarUrl: user.avatarUrl || "" });

  // nodrošina LB ierakstu un pts
  const t = lbTouch(user.username, user.avatarUrl || "", START_PTS);
  if (t.changed) lbSave();
  const pts = Number(t.player?.pts ?? START_PTS) || START_PTS;
  const hands = Number(t.player?.hands ?? 0) || 0;

  // cookie
  try {
    setAuthCookie(res, token);
  } catch {}

  return res.json({
    ok: true,
    token,
    pts,
    hands,
    user: { username: user.username, avatarUrl: user.avatarUrl || "", pts, hands },
    ts: Date.now(),
  });
}

const SIGNUP_ROUTES = [
  "/signup", "/api/signup", "/auth/signup", "/api/auth/signup",
  "/register", "/api/register", "/auth/register", "/api/auth/register",
];

const LOGIN_ROUTES = [
  "/login", "/api/login", "/auth/login", "/api/auth/login",
  "/signin", "/api/signin", "/auth/signin", "/api/auth/signin",
];

app.post(SIGNUP_ROUTES, (req, res) => {
  const username = safeUsernameAuth(req.body?.username);
  const password = String(req.body?.password || "");
  const avatarUrl = safeAvatarUrlAuth(req.body?.avatarUrl);

  if (!username) return res.status(400).json({ ok: false, error: "NICK_REQUIRED" });
  if (password.length < 4) return res.status(400).json({ ok: false, error: "PASS_TOO_SHORT" });

  const existing = userGet(username);
  if (existing) return res.status(409).json({ ok: false, error: "USER_EXISTS" });

  const user = {
    username,
    pass: pwHash(password),
    avatarUrl: avatarUrl || "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  userSet(user);

  return authResponse(res, user);
});

app.post(LOGIN_ROUTES, (req, res) => {
  const username = safeUsernameAuth(req.body?.username);
  const password = String(req.body?.password || "");

  if (!username) return res.status(400).json({ ok: false, error: "NICK_REQUIRED" });

  const u = userGet(username);
  if (!u) return res.status(401).json({ ok: false, error: "BAD_LOGIN" });

  if (!pwVerify(password, u.pass)) {
    return res.status(401).json({ ok: false, error: "BAD_LOGIN" });
  }

  const avatarUrl = safeAvatarUrlAuth(req.body?.avatarUrl);
  if (avatarUrl && avatarUrl !== (u.avatarUrl || "")) {
    u.avatarUrl = avatarUrl;
    u.updatedAt = Date.now();
    userSet(u);
  }

  return authResponse(res, u);
});

app.post(["/logout", "/auth/logout", "/api/logout", "/api/auth/logout"], (_req, res) => {
  try {
    clearAuthCookie(res);
  } catch {}
  res.json({ ok: true, ts: Date.now() });
});

// /me — pieņem Bearer vai cookie; atgriež arī pts/hands
app.get(["/me", "/auth/me", "/api/me", "/api/auth/me"], (req, res) => {
  const token = getTokenFromReq(req);
  const v = verifyToken(token);
  if (!v.ok) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });

  const username = String(v.payload?.username || "").trim();
  const u = userGet(username);

  const avatarUrl = String(u?.avatarUrl || v.payload?.avatarUrl || "");
  const t = lbTouch(username, avatarUrl, START_PTS);
  if (t.changed) lbSave();

  const pts = Number(t.player?.pts ?? START_PTS) || START_PTS;
  const hands = Number(t.player?.hands ?? 0) || 0;

  return res.json({
    ok: true,
    username,
    avatarUrl,
    pts,
    hands,
    user: { username, avatarUrl, pts, hands },
    ts: Date.now(),
  });
});

/* ============================
   HTTP + Socket.IO
   ============================ */
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOptions.origin, credentials: true },
});

function broadcastLeaderboardUpdate() {
  try {
    const top10 = lbTop10();
    io.emit("leaderboard:update", { top10, top: top10, ts: Date.now() });
  } catch {}
}

function snapshotSeatPts(room) {
  return (room.players || []).map((p) => ({
    username: p?.username || null,
    pts: typeof p?.matchPts === "number" ? p.matchPts : START_PTS,
  }));
}

function deltaMapFromSnapshot(room, snap) {
  const map = Object.create(null);
  for (let i = 0; i < (room.players || []).length; i++) {
    const p = room.players[i];
    const u = p?.username;
    if (!u) continue;
    const before = typeof snap?.[i]?.pts === "number" ? snap[i].pts : START_PTS;
    const after = typeof p.matchPts === "number" ? p.matchPts : before;
    map[u] = (map[u] || 0) + (after - before);
  }
  return map;
}

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

const NON_TRUMP_RANK_STD = { A: 4, "10": 3, K: 2, "9": 1 };
function nonTrumpStrengthStd(c) {
  return NON_TRUMP_RANK_STD[c.r] ?? 0;
}

const NO_TRUMP_RANK = { A: 7, "10": 6, K: 5, Q: 4, J: 3, "9": 2, "8": 1, "7": 0 };
function noTrumpStrength(c) {
  return NO_TRUMP_RANK[c.r] ?? 0;
}

function buildDeck() {
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

function isTrumpStd(c) {
  return c.s === "D" || c.r === "Q" || c.r === "J";
}

const TRUMP_ORDER = [
  { r: "Q", s: "C" }, { r: "Q", s: "S" }, { r: "Q", s: "H" }, { r: "Q", s: "D" },
  { r: "J", s: "C" }, { r: "J", s: "S" }, { r: "J", s: "H" }, { r: "J", s: "D" },
  { r: "A", s: "D" }, { r: "10", s: "D" }, { r: "K", s: "D" }, { r: "9", s: "D" },
  { r: "8", s: "D" }, { r: "7", s: "D" },
];
const TRUMP_INDEX = new Map(TRUMP_ORDER.map((c, i) => [cardKey(c), i]));
function trumpStrengthStd(c) {
  return TRUMP_INDEX.get(cardKey(c));
}

/* ============================
   LV kontrakti
   ============================ */
const CONTRACT_TAKE = "ŅEMT GALDU";
const CONTRACT_ZOLE = "ZOLE";
const CONTRACT_MAZA = "MAZĀ";
const CONTRACT_GALDS = "GALDS";

function rulesForContract(contract) {
  if (contract === CONTRACT_MAZA) return { trumps: false };
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
  if (ALLOW_ATMESTIES) return false;
  const { trumps } = rulesForContract(room.contract);

  if (!trumps) return hand.some((c) => c.s === follow);

  if (follow === "TRUMP") return hand.some(isTrumpStd);
  return hand.some((c) => !isTrumpStd(c) && c.s === follow);
}

function isLegalPlay(hand, follow, c, room) {
  if (!follow) return true;
  if (ALLOW_ATMESTIES) return true;

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
  for (let i = 0; i < 4; i++) s += chars[crypto.randomInt(0, chars.length)];
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

/* ============================
   PUNKTI per USERNAME
   ============================ */
function getUserPts(room, username) {
  if (!username) return START_PTS;
  const v = room.userPts?.[username];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return lbPts(username);
}
function setUserPts(room, username, pts) {
  if (!username) return;
  if (!room.userPts) room.userPts = Object.create(null);
  room.userPts[username] = pts;

  if (!room.userPtsOrder) room.userPtsOrder = [];
  if (!room.userPtsOrder.includes(username)) room.userPtsOrder.push(username);

  const LIMIT = 300;
  while (room.userPtsOrder.length > LIMIT) {
    const old = room.userPtsOrder.shift();
    if (old && room.userPts[old] != null) delete room.userPts[old];
  }
}
function syncAllUserPts(room) {
  for (const p of room.players) {
    if (p?.username) setUserPts(room, p.username, p.matchPts);
  }
}

/* ============================
   AUTO-START helperi
   ============================ */
function roomAllConnected(room) {
  return room.players.every((p) => !!p.username && !!p.connected);
}
function roomAllSeeded(room) {
  return room.players.every((p) => typeof p.seed === "string" && p.seed.length > 0);
}
function clearAutoStart(room) {
  if (room.autoTimer) {
    clearTimeout(room.autoTimer);
    room.autoTimer = null;
  }
}
function roomHasAllPlayers(room) {
  return room.players.every((p) => !!p.username);
}
function roomAllReady(room) {
  return room.players.every((p) => !!p.username && p.ready);
}
function scheduleAutoStart(room) {
  clearAutoStart(room);

  if (room.phase !== "LOBBY") return;
  if (!roomHasAllPlayers(room)) return;
  if (!roomAllConnected(room)) return;
  if (!roomAllReady(room)) return;
  if (!roomAllSeeded(room)) return;

  const delayMs =
    typeof room.autoDelayOverrideMs === "number" && room.autoDelayOverrideMs >= 0
      ? room.autoDelayOverrideMs
      : AUTO_START_MS;

  room.autoDelayOverrideMs = null;

  room.autoTimer = setTimeout(() => {
    room.autoTimer = null;

    if (room.phase !== "LOBBY") return;
    if (!roomHasAllPlayers(room)) return;
    if (!roomAllConnected(room)) return;
    if (!roomAllReady(room)) return;
    if (!roomAllSeeded(room)) return;

    startNewHand(room);
  }, delayMs);
}

/* ============================
   LOBBY ROOMS LIST (PUBLIKĀ INFO)
   ============================ */
function getRoomSummary(room) {
  const seats = [0, 1, 2];

  const occ = new Map();
  for (const p of room.players || []) {
    if (p && typeof p.seat === "number" && p.username) occ.set(p.seat, p);
  }

  const openSeats = seats.filter((s) => !occ.has(s));
  const occupiedSeats = occ.size;

  return {
    roomId: room.roomId,
    phase: room.phase || "LOBBY",
    handNo: typeof room.handNo === "number" ? room.handNo : 0,
    contract: room.contract || "",
    bigSeat: typeof room.bigSeat === "number" ? room.bigSeat : null,
    dealerSeat: typeof room.dealerSeat === "number" ? room.dealerSeat : 0,

    occupiedSeats,
    openSeatsCount: openSeats.length,
    playerCount: occupiedSeats,

    openSeats,
    players: seats.map((seat) => {
      const p = occ.get(seat);
      if (!p) return { seat, empty: true };
      return {
        seat,
        username: p.username,
        connected: !!p.connected,
        ready: !!p.ready,
        matchPts: typeof p.matchPts === "number" ? p.matchPts : START_PTS,
        avatarUrl: p.avatarUrl || "",
      };
    }),

    updatedAt: room.updatedAt || Date.now(),
  };
}

function listPublicRooms() {
  const out = [];
  for (const room of rooms.values()) {
    if (!room) continue;
    const cnt = (room.players || []).filter((p) => p && p.username).length;
    if (cnt <= 0) continue;
    out.push(getRoomSummary(room));
  }

  out.sort((a, b) => {
    const aOpen = a.openSeatsCount ?? (a.openSeats?.length || 0);
    const bOpen = b.openSeatsCount ?? (b.openSeats?.length || 0);
    if (aOpen !== bOpen) return bOpen - aOpen;
    return String(a.roomId).localeCompare(String(b.roomId));
  });

  return out;
}

function broadcastRoomsUpdate() {
  const payload = { ok: true, rooms: listPublicRooms(), ts: Date.now() };
  io.to("lobby").emit("rooms:update", payload);
}

// Rooms routes (aliases)
app.get(
  ["/rooms", "/api/rooms", "/auth/rooms", "/api/auth/rooms"],
  (_req, res) => {
    res.json({ ok: true, rooms: listPublicRooms(), ts: Date.now() });
  }
);

function roomIsEmpty(room) {
  const cnt = (room.players || []).filter((p) => p && p.username).length;
  return cnt <= 0;
}

function newRoom(roomId) {
  return {
    roomId,
    phase: "LOBBY",

    autoTimer: null,
    autoDelayOverrideMs: null,

    userPts: Object.create(null),
    userPtsOrder: [],

    players: [
      { seat: 0, username: null, avatarUrl: "", ready: false, connected: false, socketId: null, seed: null, matchPts: START_PTS },
      { seat: 1, username: null, avatarUrl: "", ready: false, connected: false, socketId: null, seed: null, matchPts: START_PTS },
      { seat: 2, username: null, avatarUrl: "", ready: false, connected: false, socketId: null, seed: null, matchPts: START_PTS },
    ],

    dealerSeat: 0,
    handNo: 0,

    fairness: null,

    bids: [],
    bidTurnSeat: 0,

    contract: null,
    bigSeat: null,

    deck: null,
    hands: [[], [], []],
    talon: [],
    discard: [],
    taken: [[], [], []],

    leaderSeat: null,
    turnSeat: null,
    trickPlays: [],

    galdsTrickNo: 0,
    galdsTalonIndex: 0,

    lastResult: null,
    updatedAt: Date.now(),
  };
}

function getOrCreateRoom(roomId) {
  const id = normRoomId(roomId) || randomRoomId();
  if (!rooms.has(id)) rooms.set(id, newRoom(id));
  return rooms.get(id);
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
  clearAutoStart(room);

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
  room.players[bigSeat].matchPts += payEachSigned * 2;
  for (const p of room.players) if (p.seat !== bigSeat) p.matchPts -= payEachSigned;
  syncAllUserPts(room);
}

function finishHandToLobby(room, lastResult, extraNote) {
  room.lastResult = lastResult || null;
  room.phase = "LOBBY";

  for (const p of room.players) {
    if (p.username) p.ready = true;
  }

  room.autoDelayOverrideMs = AUTO_NEXT_HAND_MS;

  room.dealerSeat = nextSeatCW(room.dealerSeat);
  resetHandState(room);

  emitRoom(room, { note: extraNote || "BACK_TO_LOBBY" });
}

/* ============================
   SCORE — TAKE/ZOLE (Bugats tabula)
   ============================ */
function scoreTakeOrZole(room) {
  const snap = snapshotSeatPts(room);

  const contract = room.contract;
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

  if (contract === CONTRACT_TAKE) {
    bigWins = bigEyes >= 61;

    if (bigWins) {
      if (bigTricks === 8) { payEachSigned = +6; status = "UZVAR BEZTUKŠĀ"; }
      else if (bigEyes >= 91) { payEachSigned = +4; status = "UZVAR JAŅOS"; }
      else { payEachSigned = +2; status = "UZVAR"; }
    } else {
      if (bigTricks === 0) { payEachSigned = -8; status = "ZAUDĒ BEZTUKŠĀ"; }
      else if (bigEyes <= 30) { payEachSigned = -6; status = "ZAUDĒ JAŅOS"; }
      else { payEachSigned = -4; status = "ZAUDĒ"; }
    }
  }

  if (contract === CONTRACT_ZOLE) {
    bigWins = bigEyes >= 61;

    if (!bigWins) {
      payEachSigned = -12;
      status = "ZAUDĒ";
    } else {
      if (bigTricks === 8) { payEachSigned = +14; status = "UZVAR BEZTUKŠĀ"; }
      else if (bigEyes >= 91) { payEachSigned = +12; status = "UZVAR JAŅOS"; }
      else { payEachSigned = +10; status = "UZVAR"; }
    }
  }

  applyPayEachSigned(room, bigSeat, payEachSigned);

  const deltas = deltaMapFromSnapshot(room, snap);
  lbApplyDeltas(room.players, deltas);
  broadcastLeaderboardUpdate();

  const names = room.players.map((p) => p.username || null);
  const res = {
    ts: Date.now(),
    handNo: room.handNo,
    contract,
    bigSeat,
    bigWins,
    status,
    payEach: payEachSigned,
    bigEyes,
    oppEyes,
    bigTricks,
    oppTricks,
    talonEyes,
    discardEyes,
    names,
  };

  finishHandToLobby(room, res, "HAND_FINISHED");
}

/* ============================
   SCORE — MAZĀ
   ============================ */
function scoreMaza(room, reason) {
  const snap = snapshotSeatPts(room);

  const bigSeat = room.bigSeat;
  const bigTricks = trickCount(room.taken[bigSeat]);
  const bigWins = bigTricks === 0;

  const payEachSigned = bigWins ? +12 : -12;
  const status = bigWins ? "UZVAR" : "ZAUDĒ";

  applyPayEachSigned(room, bigSeat, payEachSigned);

  const deltas = deltaMapFromSnapshot(room, snap);
  lbApplyDeltas(room.players, deltas);
  broadcastLeaderboardUpdate();

  const names = room.players.map((p) => p.username || null);
  const res = {
    ts: Date.now(),
    handNo: room.handNo,
    contract: CONTRACT_MAZA,
    bigSeat,
    bigWins,
    status,
    payEach: payEachSigned,
    bigTricks,
    reason: reason || "END",
    names,
  };

  finishHandToLobby(room, res, "HAND_FINISHED");
}

/* ============================
   SCORE — GALDS
   ============================ */
function scoreGalds(room) {
  const tricks = room.taken.map((t) => trickCount(t));
  const eyes = room.taken.map((t) => sumEyes(t));

  const maxTr = Math.max(...tricks);
  let losers = [0, 1, 2].filter((s) => tricks[s] === maxTr);

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
    note = `GALDS: all equal`;
  }

  for (let s = 0; s < 3; s++) room.players[s].matchPts += deltas[s];
  syncAllUserPts(room);

  const deltaByUsername = Object.create(null);
  for (let s = 0; s < 3; s++) {
    const u = room.players[s]?.username;
    if (!u) continue;
    deltaByUsername[u] = (deltaByUsername[u] || 0) + (Number(deltas[s]) || 0);
  }
  lbApplyDeltas(room.players, deltaByUsername);
  broadcastLeaderboardUpdate();

  const winnerSeat = deltas.indexOf(Math.max(...deltas));
  const names = room.players.map((p) => p.username || null);

  const res = {
    ts: Date.now(),
    handNo: room.handNo,
    contract: CONTRACT_GALDS,
    tricks,
    eyes,
    loserSeats,
    winnerSeat,
    galdsPay: GALDS_PAY,
    note,
    names,
  };

  finishHandToLobby(room, res, "HAND_FINISHED");
}

function computeLegalForSeat(room, seat) {
  if (room.phase !== "PLAY") return [];
  if (room.turnSeat !== seat) return [];
  const hand = room.hands[seat] || [];
  if (ALLOW_ATMESTIES) return hand.slice();
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
    matchPts: typeof p.matchPts === "number" ? p.matchPts : START_PTS,
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
          combinedHash: room.fairness.combinedHash,
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
      galdsSplitLoserPts: -GALDS_PAY,
      startPts: START_PTS,
      allowAtmesties: ALLOW_ATMESTIES,
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
      takenTricks: room.taken.map((t) => trickCount(t)),
    },

    lastResult: room.lastResult,
  };
}

function emitRoom(room, extra) {
  room.updatedAt = Date.now();

  for (const p of room.players) {
    if (!p.socketId) continue;
    const s = io.sockets.sockets.get(p.socketId);
    if (!s) continue;
    s.emit("room:state", sanitizeStateForSeat(room, p.seat), extra || null);
  }

  broadcastRoomsUpdate();
  scheduleAutoStart(room);
}

/* ============================
   SOCKET.IO
   ============================ */
io.on("connection", (socket) => {
  socket.emit("server:hello", { ok: true, ts: Date.now() });

  function authFromSocket() {
    try {
      // Atbalstām gan: io({ auth: { token } }), gan cookie (ja tas tiek sūtīts handshake laikā)
      const token =
        String(socket?.handshake?.auth?.token || "").trim() ||
        String(socket?.handshake?.headers?.authorization || "")
          .trim()
          .match(/^Bearer\s+(.+)$/i)?.[1]
          ?.trim() ||
        String(parseCookies(socket?.handshake?.headers?.cookie)?.[COOKIE_NAME] || "").trim();

      if (!token) return { ok: false };
      const v = verifyToken(token);
      if (!v.ok) return { ok: false };

      const username = safeUsername(v.payload?.username);
      const avatarUrl = safeAvatarUrl(v.payload?.avatarUrl);

      if (!username) return { ok: false };
      return { ok: true, username, avatarUrl };
    } catch {
      return { ok: false };
    }
  }

  socket.on("lobby:join", (_payload, ack) => {
    socket.join("lobby");
    try { ack?.({ ok: true }); } catch {}
    try {
      socket.emit("rooms:update", { ok: true, rooms: listPublicRooms(), ts: Date.now() });
    } catch {}
  });

  socket.on("room:list", (_payload, ack) => {
    ack?.({ ok: true, rooms: listPublicRooms(), ts: Date.now() });
  });

  // leaderboard:top10 — saderīgs ar cb-only un payload+cb
  socket.on("leaderboard:top10", (a, b) => {
    const ack = typeof a === "function" ? a : (typeof b === "function" ? b : null);
    try {
      const top10 = lbTop10();
      ack && ack({ ok: true, top10, top: top10, ts: Date.now() });
    } catch {}
  });

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
      const authed = authFromSocket();
      const username = safeUsername(payload?.username) || (authed.ok ? authed.username : "");
      const avatarUrl =
        safeAvatarUrl(payload?.avatarUrl) || (authed.ok ? authed.avatarUrl : "");
      const clientSeed = String(payload?.seed || "").trim();

      if (!username) return ack?.({ ok: false, error: "NICK_REQUIRED" });

      const roomId = normRoomId(payload?.roomId) || randomRoomId();
      const room = getOrCreateRoom(roomId);

      const seat = pickSeat(room, username);
      if (seat === -2) return ack?.({ ok: false, error: "DUPLICATE_NICK" });
      if (seat === -1) return ack?.({ ok: false, error: "ROOM_FULL" });

      const wasRejoin = room.players[seat].username === username && !room.players[seat].connected;
      if (!wasRejoin) room.players[seat].matchPts = getUserPts(room, username);

      room.players[seat].username = username;
      room.players[seat].avatarUrl = avatarUrl || room.players[seat].avatarUrl || "";
      room.players[seat].ready = true;

      room.players[seat].connected = true;
      room.players[seat].socketId = socket.id;

      room.players[seat].seed =
        clientSeed || room.players[seat].seed || crypto.randomBytes(8).toString("hex");

      setUserPts(room, username, room.players[seat].matchPts);

      const t = lbTouch(username, room.players[seat].avatarUrl, room.players[seat].matchPts);
      if (t.changed) lbSave();

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
      const authed = authFromSocket();
      const username = safeUsername(payload?.username) || (authed.ok ? authed.username : "");
      const avatarUrl =
        safeAvatarUrl(payload?.avatarUrl) || (authed.ok ? authed.avatarUrl : "");
      const clientSeed = String(payload?.seed || "").trim();

      const roomId = normRoomId(payload?.roomId);
      if (!roomId) return ack?.({ ok: false, error: "ROOM_REQUIRED" });
      if (!username) return ack?.({ ok: false, error: "NICK_REQUIRED" });

      const room = rooms.get(roomId);
      if (!room) return ack?.({ ok: false, error: "ROOM_NOT_FOUND" });

      const seat = pickSeat(room, username);
      if (seat === -2) return ack?.({ ok: false, error: "DUPLICATE_NICK" });
      if (seat === -1) return ack?.({ ok: false, error: "ROOM_FULL" });

      const wasRejoin = room.players[seat].username === username && !room.players[seat].connected;
      if (!wasRejoin) room.players[seat].matchPts = getUserPts(room, username);

      room.players[seat].username = username;
      room.players[seat].avatarUrl = avatarUrl || room.players[seat].avatarUrl || "";
      room.players[seat].ready = true;

      room.players[seat].connected = true;
      room.players[seat].socketId = socket.id;

      room.players[seat].seed =
        clientSeed || room.players[seat].seed || crypto.randomBytes(8).toString("hex");

      setUserPts(room, username, room.players[seat].matchPts);

      const t = lbTouch(username, room.players[seat].avatarUrl, room.players[seat].matchPts);
      if (t.changed) lbSave();

      socket.join(room.roomId);
      socket.data.roomId = room.roomId;
      socket.data.seat = seat;

      ack?.({ ok: true, roomId: room.roomId, seat });
      emitRoom(room, { note: "JOIN" });
    } catch {
      ack?.({ ok: false, error: "JOIN_FAILED" });
    }
  });

  socket.on("room:leave", (_payload, ack) => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;

    if (room && typeof seat === "number") {
      clearAutoStart(room);

      const uname = room.players[seat].username;
      if (uname) setUserPts(room, uname, room.players[seat].matchPts);

      const leavingMidHand = room.phase !== "LOBBY";

      room.players[seat] = {
        seat,
        username: null,
        avatarUrl: "",
        ready: false,
        connected: false,
        socketId: null,
        seed: null,
        matchPts: START_PTS,
      };

      if (leavingMidHand) {
        room.lastResult = {
          ts: Date.now(),
          handNo: room.handNo,
          contract: room.contract || null,
          note: "ABORTED_PLAYER_LEFT",
        };
        room.phase = "LOBBY";
        resetHandState(room);
      }

      if (roomIsEmpty(room)) {
        rooms.delete(room.roomId);
        broadcastRoomsUpdate();
      } else {
        emitRoom(room, { note: "LEAVE" });
      }
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
    emitRoom(room, { note: "READY" });
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

    let bidRaw = String(payload?.bid || "").toUpperCase().trim();
    if (bidRaw === "PASS") bidRaw = "GARĀM";
    if (bidRaw === "TAKE") bidRaw = "ŅEMT GALDU";
    if (bidRaw === "MAZA_ZOLE" || bidRaw === "MAZA ZOLE" || bidRaw === "MAZA" || bidRaw === "MAZĀ ZOLE") {
      bidRaw = "MAZĀ";
    }

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

    if (room.contract === CONTRACT_GALDS) {
      room.galdsTrickNo += 1;
      if (room.galdsTrickNo <= 2 && room.galdsTalonIndex < room.talon.length) {
        room.taken[winnerSeat].push(room.talon[room.galdsTalonIndex]);
        room.galdsTalonIndex += 1;
      }
    }

    emitRoom(room, { note: "TRICK_WIN", trickWinner: winnerSeat });

    if (room.contract === CONTRACT_MAZA && winnerSeat === room.bigSeat) {
      return scoreMaza(room, "TOOK_TRICK");
    }

    const allHandsEmpty = room.hands.every((h) => (h?.length || 0) === 0);
    if (!allHandsEmpty) return;

    if (room.contract === CONTRACT_TAKE || room.contract === CONTRACT_ZOLE) return scoreTakeOrZole(room);
    if (room.contract === CONTRACT_MAZA) return scoreMaza(room, "END");
    if (room.contract === CONTRACT_GALDS) return scoreGalds(room);

    return scoreTakeOrZole(room);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const seat = socket.data.seat;
    const room = roomId ? rooms.get(roomId) : null;

    if (room && typeof seat === "number" && room.players[seat]) {
      clearAutoStart(room);

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

// drošības: saglabā leaderboard uz exit
process.on("SIGINT", () => {
  try { lbSave(); } catch {}
  process.exit(0);
});
process.on("SIGTERM", () => {
  try { lbSave(); } catch {}
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`[zole] listening on :${PORT}`);
  console.log(`[zole] START_PTS=${START_PTS}`);
  console.log(`[zole] AUTO_START_MS=${AUTO_START_MS}`);
  console.log(`[zole] AUTO_NEXT_HAND_MS=${AUTO_NEXT_HAND_MS}`);
  console.log(`[zole] GALDS_PAY=${GALDS_PAY}`);
  console.log(`[zole] CORS_ORIGINS: ${CORS_ORIGINS.length ? CORS_ORIGINS.join(", ") : "ANY"}`);
  console.log(`[zole] LEADERBOARD: ${LB_PATH}`);
});
