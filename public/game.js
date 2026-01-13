// ================== KONFIGS ==================
"use strict";

// Ja UI tiek servēts no tā paša servera (Render/Node), lietojam "same-origin"
const API_BASE = "";

const $ = (s) => document.querySelector(s);

// drošs crypto pārlūkā
const CRYPTO =
  typeof globalThis !== "undefined" && globalThis.crypto ? globalThis.crypto : null;

function safeText(el, txt) {
  if (!el) return;
  el.textContent = String(txt ?? "");
}
function safeHtml(el, html) {
  if (!el) return;
  el.innerHTML = String(html ?? "");
}

const roomIdRaw = new URLSearchParams(location.search).get("room") || "";
const ROOM_ID = String(roomIdRaw).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

if (!ROOM_ID) location.href = "./index.html";

const roomLabelEl = $("#roomLabel");
safeText(roomLabelEl, ROOM_ID);

const connDot = $("#connDot");
const connLabel = $("#connLabel");
const statusChip = $("#statusChip");

const seatLeft = $("#seatLeft");
const seatRight = $("#seatRight");
const seatBottom = $("#seatBottom");

const metaLine = $("#metaLine");
const turnLine = $("#turnLine");

const slotLeft = $("#slotLeft");
const slotRight = $("#slotRight");
const slotBottom = $("#slotBottom");
const talonPile = $("#talonPile");

const overlay = $("#overlay");
const overlayTitle = $("#overlayTitle");
const overlayNote = $("#overlayNote");
const bidPanel = $("#bidPanel");
const discardPanel = $("#discardPanel");
const btnConfirmDiscard = $("#btnConfirmDiscard");
const btnClearDiscard = $("#btnClearDiscard");

const handInfo = $("#handInfo");
const handEl = $("#hand");

const stateBox = $("#stateBox");
const logBox = $("#logBox");

const btnLeaveToLobby = $("#btnLeaveToLobby");
const btnReadyToggle = $("#btnReadyToggle");
const btnPtsToggle = $("#btnPtsToggle");
const btnHelp = $("#btnHelp");

// FULLSCREEN poga (no game.html)
const btnFullscreen = $("#btnFullscreen");

// Rezultāta toast (to atstājam)
const resultToast = $("#resultToast");
const hudToast = $("#hudToast");

const helpModal = $("#helpModal");
const helpBody = $("#helpBody");
const btnHelpClose = $("#btnHelpClose");

// Card images (SVG data-uri) cache
const _cardImgCache = new Map(); // key -> data-uri
let _cardBackUri = "";

let socket = null;
let roomState = null;
let mySeat = null;

let myNick = localStorage.getItem("zole_nick") || "";
let myAvatarUrl = localStorage.getItem("zole_avatarUrl") || "";
let mySeed = localStorage.getItem("zole_seed") || "";

let readyOn = false;
let discardPick = [];

let lastShownResultTs = 0;
let toastTimer = null;

// Mobile UX: double-tap uz kārts DISCARD režīmā
let _lastTapKey = "";
let _lastTapAt = 0;

// Trick UX: pēc 3. kārts stiķis ir pamanāms, bet pēc ~2.5s pazūd (nekarājas līdz nākamajam gājienam)
const TRICK_HIDE_MS = 2500;
let _trickHold = null; // { key: string, plays: Array<{seat,card}>, hideAt: number }
let _trickAutoHideTimer = 0;

// Turn taimeris UI (server sūta turnEndsAt)
let _turnUiTicker = 0;

// Hand UX: nobīde, lai nekas neiet ārā no ekrāna (mobile īpaši DISCARD)
let _handClampRaf = 0;
let _handShiftPx = 0;

// Bankrots: ja PTS nokrīt līdz 0, izvedam uz lobby (tikai lokāli)
let _bustedHandled = false;

// PTS HUD toggle (lai netraucē uz mobīlā)
let _showPtsHud = true;
try {
  const saved = localStorage.getItem("zole_showPtsHud");
  if (saved === "0") _showPtsHud = false;
  if (saved === "1") _showPtsHud = true;
} catch {}

function isLandscape() {
  try {
    return window.matchMedia && window.matchMedia("(orientation: landscape)").matches;
  } catch {
    return false;
  }
}

function clampHandToViewport() {
  if (!handEl) return;
  if (_handClampRaf) return;

  _handClampRaf = requestAnimationFrame(() => {
    _handClampRaf = 0;

    try {
      const isMobile =
        typeof window !== "undefined" && window.matchMedia
          ? window.matchMedia("(max-width: 720px)").matches
          : false;
      if (!isMobile) {
        _handShiftPx = 0;
        handEl.style.setProperty("--hand-shift", "0px");
        return;
      }

      const buttons = Array.from(handEl.querySelectorAll("button.zg-cardbtn"));
      if (!buttons.length) {
        _handShiftPx = 0;
        handEl.style.setProperty("--hand-shift", "0px");
        return;
      }

      const pad = 6; // px drošības mala
      const vw = Math.max(320, window.innerWidth || 0);

      // paņemam reālo bbox (iekļauj transform/margin)
      let leftMost = Infinity;
      let rightMost = -Infinity;
      for (const b of buttons) {
        const r = b.getBoundingClientRect();
        if (r.left < leftMost) leftMost = r.left;
        if (r.right > rightMost) rightMost = r.right;
      }

      let shift = _handShiftPx || 0;

      // ja iziet pa kreisi, bīdam pa labi
      if (leftMost < pad) shift += Math.ceil(pad - leftMost);
      // ja iziet pa labi, bīdam pa kreisi
      if (rightMost > vw - pad) shift -= Math.ceil(rightMost - (vw - pad));

      // saprātīgs limits (palielināts, lai Android zoom gadījumos arī spēj izkoriģēt)
      shift = Math.max(-420, Math.min(420, shift));
      _handShiftPx = shift;
      handEl.style.setProperty("--hand-shift", `${shift}px`);
    } catch {}
  });
}

/* ============================
   FULLSCREEN + AUTO-FIT (desktop + mobile where supported)
   ============================ */

let _fitRaf = 0;

function getViewportHeight() {
  const vv = window.visualViewport;
  return Math.floor(vv && vv.height ? vv.height : window.innerHeight);
}

function getElHeight(el) {
  if (!el) return 0;
  try {
    return Math.ceil(el.getBoundingClientRect().height);
  } catch {
    return 0;
  }
}

function findFeltEl() {
  return (
    document.querySelector(".zg-felt") ||
    document.querySelector(".zl-felt") ||
    document.querySelector("#felt") ||
    document.querySelector("#zoleFelt") ||
    document.querySelector(".zole-felt") ||
    document.querySelector(".zg-table") ||
    document.querySelector(".zg-board") ||
    null
  );
}

function fitFeltToScreen() {
  const felt = findFeltEl();
  if (!felt) return;
 
  const topBar =
    document.querySelector("header.zg-top") || document.getElementById("topBar") || null;
 
  const vh = getViewportHeight();
  const topH = getElHeight(topBar);
 
  // Android Chrome: address bar/keyboard maina viewport; turam rezervi un arī ieliekam CSS mainīgos
  const reserve = 18;
  const h = Math.max(260, vh - topH - reserve);
 
  try {
    felt.style.setProperty("height", `${h}px`, "important");
    felt.style.setProperty("max-height", "none", "important");
  } catch {}

  // CSS mainīgie (lai arī layout var rēķināt no tiem)
  try {
    const root = document.documentElement;
    root.style.setProperty("--vvh", `${vh}px`);
    root.style.setProperty("--topbar-h", `${topH}px`);
  } catch {}
}

function scheduleFit() {
  if (_fitRaf) return;
  _fitRaf = requestAnimationFrame(() => {
    _fitRaf = 0;
    try {
      fitFeltToScreen();
    } catch {}
  });
}

function supportsFullscreen() {
  const d = document;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

function isFullscreenNow() {
  const d = document;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

async function toggleFullscreen() {
  try {
    const d = document;
    const el = document.documentElement;

    if (!isFullscreenNow()) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) await req.call(el);
    } else {
      const exit = d.exitFullscreen || d.webkitExitFullscreen;
      if (exit) await exit.call(d);
    }
  } catch {}

  setTimeout(() => scheduleFit(), 50);
}

function syncFullscreenButton() {
  if (!btnFullscreen) return;

  if (!supportsFullscreen()) {
    btnFullscreen.style.display = "none";
    return;
  }
  btnFullscreen.style.display = "";
  btnFullscreen.textContent = isFullscreenNow() ? "EXIT" : "FULL";

  // UI hooks (kārtis lielākas fullscreen)
  try {
    document.body.classList.toggle("zg-fullscreen", isFullscreenNow());
  } catch {}
}

function initFullscreenAndFit() {
  scheduleFit();

  window.addEventListener("resize", () => scheduleFit());

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => scheduleFit());
    window.visualViewport.addEventListener("scroll", () => scheduleFit());
  }

  document.addEventListener("fullscreenchange", () => {
    syncFullscreenButton();
    scheduleFit();
  });
  document.addEventListener("webkitfullscreenchange", () => {
    syncFullscreenButton();
    scheduleFit();
  });

  if (btnFullscreen) {
    syncFullscreenButton();
    btnFullscreen.addEventListener("click", () => {
      if (!supportsFullscreen()) return;
      toggleFullscreen();
    });
  }

  window.addEventListener("keydown", (e) => {
    const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : "";
    const typing = tag === "input" || tag === "textarea" || e.target?.isContentEditable;
    if (typing) return;

    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      if (!supportsFullscreen()) return;
      toggleFullscreen();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleFit();
  });

  // Android: pēc load/reflow reizēm vajag vēlreiz (address bar)
  setTimeout(() => scheduleFit(), 120);
  setTimeout(() => scheduleFit(), 420);
  setTimeout(() => scheduleFit(), 1100);
}

/* ============================
   SCORE/LIKMEŅU UI: IZŅEMT SKAIDROJOŠO TABULU
   ============================ */

function removeById(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const parent = el.closest("#scoreBox") || el.closest("#scorePanel") || null;
  if (parent && parent !== document.body) parent.remove();
  else el.remove();
}
removeById("scoreTable");
removeById("scoreLast");
removeById("allPassPayLabel"); // game.html v32+

/* ============================
   UI TWEAKS (galds lielāks, debug nost, kārtis CENTRĀ un LIELĀKAS, player card PA KREISI)
   + FIX: telefonā player card vairs NEPĀRKLĀJ kārtis (z-index + @media)
   ============================ */

let _layoutAppliedOnce = false;

function ensureBugatsZoleUiStyle() {
  // Legacy: agrāk UI izskatu injicējām no JS ar lielu `<style>` bloku.
  // Tagad izskats ir tikai `public/style.css`, lai nebūtu “laboju vienu failu, bet rāda citu”.
  const ids = [
    "bugatsZoleUiStyle_v2_tableHand",
    "bugatsZoleUiStyle_v3_meLeft",
    "bugatsZoleUiStyle_v4_centerBigCards",
    "bugatsZoleUiStyle_v5_centerBigCards_fullscreenFit",
    "bugatsZoleUiStyle_v6_centerBigCards_fullscreenFit_zfix",
  ];
  for (const id of ids) {
    try {
      document.getElementById(id)?.remove();
    } catch {}
  }
}

function ensurePrettyCardsStyle() {
  // Legacy: agrāk kāršu “pretty” CSS injicējām no JS.
  // Tagad tas ir `public/style.css` (viena vieta, kur labot dizainu).
  try {
    document.getElementById("zgPrettyCardsStyle_v1")?.remove();
  } catch {}
}

function removeDebugUiHard() {
  try {
    const d1 = stateBox?.closest("details") || null;
    const d2 = logBox?.closest("details") || null;
    (d1 || d2)?.remove?.();
  } catch {}

  try {
    const all = Array.from(document.querySelectorAll("details"));
    for (const d of all) {
      const txt = (d.textContent || "").toLowerCase();
      if (txt.includes("debug")) {
        d.remove();
        break;
      }
    }
  } catch {}

  try {
    document.getElementById("stateBox")?.remove();
  } catch {}
  try {
    document.getElementById("logBox")?.remove();
  } catch {}
}

function applyTableHandLayout() {


  const felt = findFeltEl();
  if (!felt) return;

  let stack = document.getElementById("zgBottomStack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "zgBottomStack";
    felt.appendChild(stack);
  } else if (stack.parentElement !== felt) {
    felt.appendChild(stack);
  }

  if (handInfo && handInfo.parentElement !== stack) stack.appendChild(handInfo);
  if (handEl && handEl.parentElement !== stack) stack.appendChild(handEl);

  let dock = document.getElementById("zgMeDock");
  if (!dock) {
    dock = document.createElement("div");
    dock.id = "zgMeDock";
    felt.appendChild(dock);
  } else if (dock.parentElement !== felt) {
    felt.appendChild(dock);
  }
  if (seatBottom && seatBottom.parentElement !== dock) dock.appendChild(seatBottom);

  if (!_layoutAppliedOnce) {
    _layoutAppliedOnce = true;
    removeDebugUiHard();
  }

  scheduleFit();
}

window.addEventListener("resize", () => scheduleFit());

/* ============================
   MINI PTS HUD (PROTOKOLS) — bottom-right
   ============================ */

let miniPtsHudEl = null;
let ptsHistory = [];

function abbr3(s) {
  const v = String(s || "").trim();
  if (!v) return "—";
  return v.slice(0, 3).toUpperCase();
}
function fmtSigned(n) {
  const x = Number(n) || 0;
  if (x > 0) return `+${x}`;
  if (x < 0) return `${x}`;
  return "0";
}
function fmtPts(n) {
  const x = Number(n) || 0;
  return String(x);
}

function ensureMiniPtsHud() {
  if (miniPtsHudEl) return miniPtsHudEl;

  miniPtsHudEl = document.getElementById("miniPtsHud");
  if (!miniPtsHudEl) {
    miniPtsHudEl = document.createElement("div");
    miniPtsHudEl.id = "miniPtsHud";
    document.body.appendChild(miniPtsHudEl);
  }

  // Legacy: agrāk PTS HUD CSS injicējām no JS.
  // Tagad to pilnībā kontrolē `public/style.css`.
  try {
    document.getElementById("miniPtsHudStyle")?.remove();
  } catch {}

  return miniPtsHudEl;
}

function renderMiniPtsHud() {
  const el = ensureMiniPtsHud();

  // Uz mobīlā pēc noklusējuma slēpjam (lai netraucē), bet landscape var rādīt
  try {
    const isMobile =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(max-width: 720px)").matches
        : false;
    if (isMobile && localStorage.getItem("zole_showPtsHud") == null) {
      _showPtsHud = isLandscape(); // portrait: off, landscape: on
    }
  } catch {}

  if (!_showPtsHud) {
    el.style.display = "none";
    return;
  }

  if (!roomState || typeof mySeat !== "number") {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";

  const { left, right } = viewSeats();
  const cols = [left, mySeat, right];
  const colNames = cols.map((seat) => abbr3(playerBySeat(seat)?.username || "—"));

  const phaseTxt =
    roomState?.phase === "LOBBY"
      ? "Lobby"
      : roomState?.phase === "BIDDING"
        ? "Solīšana"
        : roomState?.phase === "DISCARD"
          ? "Norakšana"
          : roomState?.phase === "PLAY"
            ? "Izspēle"
            : roomState?.phase === "SCORE"
              ? "Rezultāts"
              : String(roomState?.phase || "—");

  let html = `<div class="mph-title"><b>ΔPTS</b><span class="mph-muted">${escapeHtml(
    phaseTxt
  )}</span></div>`;
  html += `<div class="mph-grid">`;

  html += `<div class="mph-cell"></div>`;
  html += `<div class="mph-cell mph-head">${escapeHtml(colNames[0])}</div>`;
  html += `<div class="mph-cell mph-head">${escapeHtml(colNames[1])}</div>`;
  html += `<div class="mph-cell mph-head">${escapeHtml(colNames[2])}</div>`;

  const isMobile =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(max-width: 720px)").matches
      : false;

  // tabula mazāka (mazāk rindas), lai nepārklāj spēli
  const rows = isMobile ? ptsHistory.slice(0, 1) : ptsHistory.slice(0, 2);
  if (!rows.length) {
    html += `<div class="mph-cell mph-n">—</div>`;
    html += `<div class="mph-cell mph-val mph-zero">0</div>`;
    html += `<div class="mph-cell mph-val mph-zero">0</div>`;
    html += `<div class="mph-cell mph-val mph-zero">0</div>`;
  } else {
    for (const r of rows) {
      const n = typeof r.handNo === "number" && r.handNo > 0 ? String(r.handNo) : "—";

      const dA = Number(r.deltas?.[cols[0]] ?? 0) || 0;
      const dB = Number(r.deltas?.[cols[1]] ?? 0) || 0;
      const dC = Number(r.deltas?.[cols[2]] ?? 0) || 0;

      const clsA = dA > 0 ? "mph-pos" : dA < 0 ? "mph-neg" : "mph-zero";
      const clsB = dB > 0 ? "mph-pos" : dB < 0 ? "mph-neg" : "mph-zero";
      const clsC = dC > 0 ? "mph-pos" : dC < 0 ? "mph-neg" : "mph-zero";

      html += `<div class="mph-cell mph-n">${escapeHtml(n)}</div>`;
      html += `<div class="mph-cell mph-val ${clsA}">${escapeHtml(fmtSigned(dA))}</div>`;
      html += `<div class="mph-cell mph-val ${clsB}">${escapeHtml(fmtSigned(dB))}</div>`;
      html += `<div class="mph-cell mph-val ${clsC}">${escapeHtml(fmtSigned(dC))}</div>`;
    }
  }

  html += `</div>`;
  el.innerHTML = html;
}

/* ============================
   LABELI (servera kodi → UI)
   ============================ */

function norm(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function isTakeContract(c) {
  const v = norm(c);
  return v === "TAKE" || v === "ŅEMT GALDU" || v === "NEMT GALDU";
}
function isMazaContract(c) {
  const v = norm(c);
  return v === "MAZA" || v === "MAZĀ" || v === "MAZA ZOLE" || v === "MAZĀ ZOLE";
}
function isZoleContract(c) {
  const v = norm(c);
  return v === "ZOLE";
}
function isGaldinsContract(c) {
  const v = norm(c);
  return v === "GALDINS" || v === "GALDIŅŠ" || v === "GALDS";
}

function contractLabel(c) {
  const v = norm(c);
  if (!v) return "—";
  if (v === "TAKE" || v === "ŅEMT GALDU" || v === "NEMT GALDU") return "ŅEMT GALDU";
  if (v === "ZOLE") return "ZOLE";
  if (v === "MAZA" || v === "MAZĀ" || v === "MAZA ZOLE" || v === "MAZĀ ZOLE") return "MAZĀ";
  if (v === "GALDINS" || v === "GALDIŅŠ" || v === "GALDS") return "GALDIŅŠ";
  if (v === "GARĀM" || v === "PASS") return "GARĀM";
  return String(c);
}

function phaseLabel(p) {
  const v = norm(p);
  if (v === "LOBBY") return "LOBBY";
  if (v === "BIDDING") return "SOLĪŠANA";
  if (v === "DISCARD") return "NORAKŠANA";
  if (v === "PLAY") return "IZSPĒLE";
  if (v === "SCORE") return "REZULTĀTS";
  return String(p || "—");
}

function seatRoleLabel(seat) {
  const c = roomState?.contract;
  const big = roomState?.bigSeat;

  if (isGaldinsContract(c)) return "GALDIŅŠ";

  if (typeof big === "number" && (isTakeContract(c) || isZoleContract(c) || isMazaContract(c))) {
    return seat === big ? "LIELAIS" : "MAZAIS";
  }
  return "";
}

function seatContractBadgeLabel(seat) {
  const c = roomState?.contract;
  const big = roomState?.bigSeat;

  if (isGaldinsContract(c)) return "";

  if (
    typeof big === "number" &&
    seat === big &&
    (isTakeContract(c) || isZoleContract(c) || isMazaContract(c))
  ) {
    return contractLabel(c);
  }
  return "";
}

function seatActionLabel(seat) {
  const ph = roomState?.phase;
  if (ph === "BIDDING" && roomState?.turnSeat === seat) return "SOLĪ";
  if (ph === "DISCARD" && roomState?.bigSeat === seat) return "NOROK";
  if (ph === "PLAY" && roomState?.turnSeat === seat) return "GĀJIENS";
  return "";
}

/* ============================
   KĀRŠU ŠĶIROŠANA
   ============================ */

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
  { r: "7", s: "D" },
];
const TRUMP_INDEX = new Map(TRUMP_ORDER.map((c, i) => [`${c.r}${c.s}`, i]));

const NON_TRUMP_RANK_STD = { A: 4, "10": 3, K: 2, "9": 1 };
const NO_TRUMP_RANK = { A: 7, "10": 6, K: 5, Q: 4, J: 3, "9": 2, "8": 1, "7": 0 };
// UI suit ordering (non-trump suits). Zolē bieži gribas redzēt ♠,♣,♥ secību.
const SUIT_ORDER = { S: 0, C: 1, H: 2, D: 3 };

function isTrumpStd(c) {
  return c?.s === "D" || c?.r === "Q" || c?.r === "J";
}
function trumpStrengthStd(c) {
  const idx = TRUMP_INDEX.get(`${c.r}${c.s}`);
  return typeof idx === "number" ? idx : 999;
}

function sortHandByStrength(hand, contract) {
  const h = (hand || []).slice();
  // Zolē trumpji ir vienmēr, neatkarīgi no līguma nosaukuma.
  // (Tāpēc roka vienmēr šķirojas ar trumpjiem priekšā.)
  const noTrumps = false;

  h.sort((a, b) => {
    if (!a || !b) return 0;

    if (!noTrumps) {
      const at = isTrumpStd(a);
      const bt = isTrumpStd(b);
      if (at !== bt) return at ? -1 : 1;

      if (at && bt) return trumpStrengthStd(a) - trumpStrengthStd(b);

      const sa = SUIT_ORDER[a.s] ?? 9;
      const sb = SUIT_ORDER[b.s] ?? 9;
      if (sa !== sb) return sa - sb;

      const ra = NON_TRUMP_RANK_STD[a.r] ?? 0;
      const rb = NON_TRUMP_RANK_STD[b.r] ?? 0;
      return rb - ra;
    }

    const sa = SUIT_ORDER[a.s] ?? 9;
    const sb = SUIT_ORDER[b.s] ?? 9;
    if (sa !== sb) return sa - sb;

    const ra = NO_TRUMP_RANK[a.r] ?? 0;
    const rb = NO_TRUMP_RANK[b.r] ?? 0;
    return rb - ra;
  });

  return h;
}

/* ============================
   UTIL
   ============================ */

function log(line) {
  const t = new Date();
  const ts = t.toTimeString().slice(0, 8);
  try {
    if (logBox) logBox.textContent = `[${ts}] ${line}\n` + logBox.textContent;
  } catch {}
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function suitSym(s) {
  if (s === "C") return "♣";
  if (s === "S") return "♠";
  if (s === "H") return "♥";
  if (s === "D") return "♦";
  return "?";
}

function svgDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(svg || ""))}`;
}

function cardSvg(c) {
  const r = String(c?.r || "").toUpperCase();
  const s = String(c?.s || "").toUpperCase();
  const sym = suitSym(s);
  const isRed = s === "H" || s === "D";
  const fg = isRed ? "#c1121f" : "#121316";
  const bg = "#ffffff";

  // 240x336 ~ klasiskā kārts proporcija
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="336" viewBox="0 0 240 336">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#f2f6fb"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="239" height="335" rx="0" ry="0" fill="url(#g)" stroke="rgba(0,0,0,0.22)"/>
  <rect x="10" y="10" width="220" height="316" fill="none" stroke="rgba(0,0,0,0.06)"/>

  <!-- watermark -->
  <text x="120" y="190" text-anchor="middle" font-size="150" font-weight="900"
        font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial"
        fill="${fg}" opacity="0.16">${sym}</text>

  <!-- top-left corner -->
  <text x="18" y="44" font-size="34" font-weight="900"
        font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial"
        fill="${fg}">${r}</text>
  <text x="20" y="76" font-size="28" font-weight="900"
        font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial"
        fill="${fg}">${sym}</text>

  <!-- bottom-right corner -->
  <g transform="translate(222 320) rotate(180)">
    <text x="0" y="0" font-size="34" font-weight="900"
          font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial"
          fill="${fg}">${r}</text>
    <text x="2" y="32" font-size="28" font-weight="900"
          font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial"
          fill="${fg}">${sym}</text>
  </g>
</svg>
`.trim();
}

function cardImgUri(c) {
  const key = `${String(c?.r || "").toUpperCase()}${String(c?.s || "").toUpperCase()}`;
  const cached = _cardImgCache.get(key);
  if (cached) return cached;
  const uri = svgDataUri(cardSvg(c));
  _cardImgCache.set(key, uri);
  return uri;
}

function cardBackSvg() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="336" viewBox="0 0 240 336">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#162033"/>
      <stop offset="1" stop-color="#0b1220"/>
    </linearGradient>
    <pattern id="p" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
      <rect width="16" height="16" fill="rgba(255,255,255,0.02)"/>
      <rect x="0" y="0" width="8" height="16" fill="rgba(255,255,255,0.05)"/>
    </pattern>
  </defs>
  <rect x="0.5" y="0.5" width="239" height="335" fill="url(#bg)" stroke="rgba(255,255,255,0.16)"/>
  <rect x="10" y="10" width="220" height="316" fill="url(#p)" stroke="rgba(255,255,255,0.10)"/>
  <text x="120" y="190" text-anchor="middle" font-size="120" font-weight="1000"
        font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial"
        fill="rgba(255,255,255,0.20)">Z</text>
</svg>
`.trim();
}

function ensureCardImages() {
  if (!_cardBackUri) _cardBackUri = svgDataUri(cardBackSvg());
  try {
    document.documentElement.style.setProperty("--cardback-img", `url("${_cardBackUri}")`);
  } catch {}
}

function currentFollowInfo() {
  try {
    if (!roomState) return null;
    if (roomState.phase !== "PLAY") return null;
    if (!Array.isArray(roomState.trickPlays) || roomState.trickPlays.length === 0) return null;

    const lead = roomState.trickPlays[0]?.card;
    if (!lead) return null;

    // Zolē trumpji ir vienmēr.
    const follow = isTrumpStd(lead) ? "TRUMP" : String(lead.s || "").toUpperCase();
    if (follow === "TRUMP") return { kind: "TRUMP", label: "TRUMPIS", sym: "♦" };
    const sym = suitSym(follow);
    return { kind: "SUIT", label: sym, sym };
  } catch {
    return null;
  }
}
function isRedSuit(s) {
  return s === "H" || s === "D";
}
function cardToKey(c) {
  return `${c.r}${c.s}`;
}
function sameCard(a, b) {
  return a && b && a.r === b.r && a.s === b.s;
}
function safeNick(s) {
  return String(s || "").trim().slice(0, 18);
}
function safeAvatar(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}
function seedGen() {
  // ja kaut kā CRYPTO nav pieejams, uztaisām fallback no Math.random (sliktāk fairness, bet labāk nekā crash)
  if (!CRYPTO?.getRandomValues) {
    return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  }
  const a = new Uint8Array(8);
  CRYPTO.getRandomValues(a);
  return Array.from(a).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function viewSeats() {
  const left = (mySeat + 2) % 3;
  const right = (mySeat + 1) % 3;
  return { left, right };
}
function playerBySeat(seat) {
  return (roomState?.players || []).find((p) => p.seat === seat) || null;
}
function nameBySeat(seat) {
  const p = playerBySeat(seat);
  return p?.username || `seat${seat}`;
}

/* ============================
   RENDER
   ============================ */

function renderPlayerCard(p, whereLabel) {
  if (!p || !p.username) {
    return `<div class="zg-seat-inner">
      <div class="zg-seat-topline">
        <div class="zg-name">—</div>
        <div class="zg-pts">—</div>
      </div>
      <div class="zg-subline"><span class="zg-badges"><span class="zg-badge">tukšs</span></span></div>
    </div>`;
  }

  const pts = typeof p.matchPts === "number" ? p.matchPts : 0;
  const ready =
    roomState?.phase === "LOBBY" && p.ready ? `<span class="zg-badge zg-badge-on">READY</span>` : "";
  const off =
    !p.connected && p.username
      ? `<span class="zg-badge zg-badge-warn" title="Nav savienojuma">OFFLINE</span>`
      : "";

  const c = roomState?.contract;
  const big = roomState?.bigSeat;
  const role =
    typeof big === "number" && !isGaldinsContract(c)
      ? p.seat === big
        ? "LIELAIS"
        : "MAZAIS"
      : "";
  const roleBadge = role ? `<span class="zg-badge">${escapeHtml(role)}</span>` : "";

  const contractBadge =
    typeof big === "number" && p.seat === big && c
      ? `<span class="zg-badge">${escapeHtml(contractLabel(c))}</span>`
      : "";

  const act = seatActionLabel(p.seat);
  const actBadge = act ? `<span class="zg-badge zg-badge-on">${escapeHtml(act)}</span>` : "";

  const turnSeat = roomState?.turnSeat;
  const isTurn = typeof turnSeat === "number" && turnSeat === p.seat && roomState?.phase !== "LOBBY";
  const turnIcon = isTurn ? `<span class="zg-ico zg-ico-turn" title="Gājiens">▶</span>` : "";

  const isBig = typeof big === "number" && big === p.seat && !isGaldinsContract(c);
  const bigIcon = isBig ? `<span class="zg-ico zg-ico-big" title="LIELAIS">★</span>` : "";
  const who = whereLabel === "tu" ? `<span class="zg-badge zg-badge-dim">TU</span>` : "";
  const badges = [who, roleBadge, contractBadge, actBadge, ready, off].filter(Boolean).join(" ");

  return `<div class="zg-seat-inner">
    <div class="zg-seat-topline">
      <div class="zg-nameblock">
        <div class="zg-name">${bigIcon}${turnIcon}${escapeHtml(p.username)}</div>
      </div>
      <div class="zg-pts" title="PTS">${escapeHtml(String(pts))}</div>
    </div>
    <div class="zg-subline">
      ${badges ? `<span class="zg-badges">${badges}</span>` : ""}
    </div>
  </div>`;
}

/* ====== SMUKĀS KĀRTIS ====== */
function renderCardFace(c) {
  if (!c) return "";
  const uri = cardImgUri(c);
  const sym = suitSym(String(c.s || "").toUpperCase());
  const alt = `${String(c.r || "")}${sym}`;
  return `<div class="zg-card zg-img"><img src="${escapeHtml(uri)}" alt="${escapeHtml(alt)}" /></div>`;
}

function isMyTurn() {
  return roomState && roomState.turnSeat === mySeat;
}

function isMyDiscardPhase() {
  return (
    roomState &&
    roomState.phase === "DISCARD" &&
    isTakeContract(roomState.contract) &&
    roomState.bigSeat === mySeat
  );
}

function setDiscardUIVisibility() {
  const show = isMyDiscardPhase();
  if (discardPanel) discardPanel.style.display = show ? "grid" : "none";
  if (btnConfirmDiscard) btnConfirmDiscard.style.display = show ? "" : "none";
  if (btnClearDiscard) btnClearDiscard.style.display = show ? "" : "none";
  if (!show) {
    discardPick = [];
    updateDiscardButtons();
  }
}

function renderTrick() {
  if (slotLeft) slotLeft.innerHTML = "";
  if (slotRight) slotRight.innerHTML = "";
  if (slotBottom) slotBottom.innerHTML = "";

  // ārpus PLAY stiķi nerādam (citādi “iestrēgst” uz ekrāna spēles beigās)
  if (!roomState || roomState.phase !== "PLAY") {
    _trickHold = null;
    if (_trickAutoHideTimer) {
      try { clearTimeout(_trickAutoHideTimer); } catch {}
      _trickAutoHideTimer = 0;
    }
    return;
  }

  const now = Date.now();
  const live = Array.isArray(roomState?.trickPlays) ? roomState.trickPlays : [];
  const trickKey = (arr) => {
    try {
      return (arr || [])
        .map((p) => `${p?.seat ?? "?"}:${p?.card?.r ?? "?"}${p?.card?.s ?? "?"}`)
        .join("|");
    } catch {
      return "";
    }
  };

  // kad ir 3 kārtis, sākam lokālo “auto-hide” taimeri uz 2.5s
  if (live.length === 3) {
    const k = trickKey(live);
    if (!_trickHold || _trickHold.key !== k) {
      _trickHold = { key: k, plays: live.slice(), hideAt: now + TRICK_HIDE_MS };
      if (_trickAutoHideTimer) {
        try { clearTimeout(_trickAutoHideTimer); } catch {}
        _trickAutoHideTimer = 0;
      }
      _trickAutoHideTimer = setTimeout(() => {
        _trickAutoHideTimer = 0;
        try { renderTrick(); } catch {}
      }, TRICK_HIDE_MS + 40);
    }
  }

  // ja auto-hide termiņš ir beidzies, neko nerādām (pat ja serveris vēl nav atsūtījis jaunu stāvokli)
  if (live.length === 3 && _trickHold && now >= _trickHold.hideAt) return;

  const plays = live.length > 0 ? live : [];

  if (!plays.length) return;

  const { left, right } = viewSeats();

  const lastSeat = plays[plays.length - 1]?.seat;
  for (const pl of plays) {
    const wrapCls = pl.seat === lastSeat ? "zg-trickwrap zg-last-played" : "zg-trickwrap";
    const html = `<div class="${wrapCls}">${renderCardFace(pl.card)}</div>`;
    if (pl.seat === mySeat) safeHtml(slotBottom, html);
    else if (pl.seat === left) safeHtml(slotLeft, html);
    else if (pl.seat === right) safeHtml(slotRight, html);
  }
}

function setReadyButton() {
  if (!btnReadyToggle) return;

  const phase = roomState?.phase || "";
  if (phase !== "LOBBY") {
    btnReadyToggle.disabled = true;
    btnReadyToggle.textContent = "READY: —";
    btnReadyToggle.classList.remove("zg-ready-on");
    return;
  }

  btnReadyToggle.disabled = false;
  btnReadyToggle.textContent = readyOn ? "READY: ON" : "READY: OFF";
  btnReadyToggle.classList.toggle("zg-ready-on", readyOn);
}

function renderOverlay() {
  if (!overlay || !bidPanel || !discardPanel || !overlayTitle || !overlayNote) return;

  overlay.style.display = "none";
  bidPanel.style.display = "none";
  discardPanel.style.display = "none";
  overlayTitle.textContent = "";
  overlayNote.textContent = "";

  if (!roomState) return;

  const contractTxt = contractLabel(roomState.contract);

  const bigSeat = roomState.bigSeat;
  const bigName = typeof bigSeat === "number" ? nameBySeat(bigSeat) : "—";

  const dealerSeat = roomState.dealerSeat;
  const dealerName = typeof dealerSeat === "number" ? nameBySeat(dealerSeat) : "—";

  safeText(
    metaLine,
    `Līgums: ${contractTxt} • Lielais: ${bigName} • Dīleris: ${dealerName} • Hand #${roomState.handNo}`
  );

  const turnP = typeof roomState.turnSeat === "number" ? nameBySeat(roomState.turnSeat) : "—";
  safeText(
    turnLine,
    roomState.phase === "PLAY" ? `Kam jāiet: ${turnP}` : `Stāvoklis: ${phaseLabel(roomState.phase)}`
  );

  if (roomState.phase === "LOBBY") {
    overlay.style.display = "block";
    overlayTitle.textContent = "Lobby";
    overlayNote.textContent =
      "Kad visi 3 spēlētāji ir klāt un READY: ON, automātiski sāksies jaunā partija.";
    setDiscardUIVisibility();
    return;
  }

  if (roomState.phase === "BIDDING") {
    overlay.style.display = "block";
    bidPanel.style.display = "grid";
    overlayTitle.textContent = "Solīšana";
    overlayNote.textContent = isMyTurn() ? "Tavs gājiens (SOLĪ)" : `Gaida: ${turnP}`;

    bidPanel.querySelectorAll("button[data-bid]").forEach((b) => {
      b.disabled = !isMyTurn();
    });

    setDiscardUIVisibility();
    return;
  }

  if (roomState.phase === "DISCARD") {
    overlay.style.display = "block";
    overlayTitle.textContent = "Norakšana";

    if (isMyDiscardPhase()) {
      discardPanel.style.display = "grid";
      overlayTitle.textContent = `Norakšana (${contractLabel(roomState.contract)})`;
      overlayNote.textContent = "Izvēlies 2 kārtis no rokas un nospied Norakt.";
    } else {
      overlayNote.textContent = `Lielais (${bigName}) šobrīd norok 2 kārtis...`;
    }

    setDiscardUIVisibility();
    return;
  }

  // PLAY / SCORE: overlay slēpts, bet discard UI joprojām pareizi noslēpjam
  setDiscardUIVisibility();
}

function updateDiscardButtons() {
  if (!btnConfirmDiscard) return;

  const show = isMyDiscardPhase();

  if (!show) {
    btnConfirmDiscard.disabled = true;
    btnConfirmDiscard.textContent = "Norakt (0/2)";
    return;
  }

  btnConfirmDiscard.disabled = discardPick.length !== 2;
  btnConfirmDiscard.textContent = `Norakt (${discardPick.length}/2)`;
}

/* ============================
   ROKA (HAND)
   ============================ */

function renderHand() {
  if (!handEl) return;

  handEl.innerHTML = "";
  discardPick = discardPick.filter(Boolean);

  if (!roomState) return;

  const handSorted = sortHandByStrength(roomState.myHand || [], roomState.contract);
  const legal = new Set((roomState.legal || []).map(cardToKey));
  // lai CSS var pielāgot rokas izkārtojumu (PLAY vs DISCARD)
  try {
    handEl.dataset.phase = String(roomState.phase || "");
    handEl.style.setProperty("--hand-n", String(handSorted.length));
  } catch {}

  // Dinamisks rokas izmērs/overlap, lai neiet ārā no ekrāna (PC + mobile)
  try {
    const isMobile =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(max-width: 720px)").matches
        : false;
    const isFs = (() => {
      try {
        return isFullscreenNow();
      } catch {
        return false;
      }
    })();

    const n = Math.max(1, handSorted.length);
    const vw = Math.max(320, window.innerWidth || 0);

    // Mobilajā atstājam vietu “galda kārtīm” (talons) un PTS HUD, lai roka neiet tiem virsū.
    let reserveLeft = 12;
    let reserveRight = 12;
    if (isMobile) {
      try {
        const tal = document.getElementById("talonPile");
        if (tal && tal.classList.contains("is-visible")) {
          // talons parasti stāv kreisajā pusē
          reserveLeft = Math.max(reserveLeft, 64);
        }
      } catch {}
      try {
        const hud = document.getElementById("miniPtsHud");
        if (hud && hud.style.display !== "none") {
          const r = hud.getBoundingClientRect();
          reserveRight = Math.max(reserveRight, Math.ceil((r.width || 0) + 12));
        } else {
          // CSS mobilajā HUD ~118px, turam konservatīvi mazāku rezervi
          reserveRight = Math.max(reserveRight, 128);
        }
      } catch {
        reserveRight = Math.max(reserveRight, 128);
      }
    }

    // Mobile fan nobīde (CSS translateX) var “izstumt” galus ārpus ekrāna.
    // Tāpēc atņemam drošu rezervi abās pusēs.
    const FAN_X_MAX = isMobile ? 12 : 0; // px (jāsaskan ar CSS)
    const avail = Math.max(
      220,
      isMobile ? vw - reserveLeft - reserveRight - FAN_X_MAX * 2 : vw - 80
    );

    // Fullscreen: palielinam kārtis, bet joprojām turam fit (cwFit ierobežo).
    // Mobilajā fullscreenā gribi lielāku (lietotājs prasīja pamēģināt 3x).
    const fsMult = isFs ? (isMobile ? 3.0 : 1.32) : 1.0;

    // Mobilajā gribam lielākas kārtis, bet tikai tik daudz, lai vienmēr ietilpst.
    const base = Math.round((isMobile ? 112 : 120) * fsMult);
    const minW = Math.round((isMobile ? 78 : 82) * (isFs ? 1.16 : 1.0));

    const phaseNow = String(roomState.phase || "");
    // overlap koeficients (jo lielāks, jo ciešāk kārtis “saiet kopā”)
    const ratio =
      phaseNow === "DISCARD" ? (isMobile ? 0.80 : 0.62) : isMobile ? 0.68 : 0.50;

    // cwFit nodrošina, ka n kartis ar overlap ietilpst avail
    const denom = n - (n - 1) * ratio;
    const cwFit = denom > 0 ? Math.floor(avail / denom) : base;
    // nekad nedrīkst pārsniegt cwFit, citādi kārtis izies ārpus ekrāna
    const cw = Math.min(cwFit, Math.max(Math.min(minW, cwFit), Math.min(base, cwFit)));
    const ov = Math.max(0, Math.floor(cw * ratio));

    handEl.style.setProperty("--card-w", `${cw}px`);
    handEl.style.setProperty("--overlap", `${ov}px`);

    // Globālie UI izmēri (standarta sistēma no --card-w)
    try {
      const root = document.documentElement;
      const cardH = Math.round(cw * 1.4);
      const trickW = Math.round(cw * 0.92);
      const trickH = Math.round(trickW * 1.4);
      const talW = Math.round(cw * 0.55);
      const talH = Math.round(talW * 1.4);

      // Seat platums (vārdi + bedži)
      const seatW = isMobile
        ? Math.round(Math.min(168, Math.max(132, cw * 1.35)))
        : Math.round(Math.min(220, Math.max(170, cw * 1.55)));

      // Roka: augstums, lai paceltas kārtis negriežas
      const vh = Math.max(400, window.innerHeight || 0);
      const handAreaH = isMobile
        ? Math.round(Math.min(vh * 0.56, Math.max(180, cardH + 72)))
        : 220;

      root.style.setProperty("--card-w", `${cw}px`);
      root.style.setProperty("--card-h", `${cardH}px`);
      root.style.setProperty("--trick-card-w", `${trickW}px`);
      root.style.setProperty("--trick-card-h", `${trickH}px`);
      root.style.setProperty("--talon-w", `${talW}px`);
      root.style.setProperty("--talon-h", `${talH}px`);
      root.style.setProperty("--seat-w", `${seatW}px`);
      root.style.setProperty("--hand-area-h", `${handAreaH}px`);
    } catch {}

    // sākuma nobīde (precīzo korekciju pēc tam izdara clampHandToViewport)
    // pēc noklusējuma roka centrā; clampHandToViewport pabīda tikai ja vajag
    const initialShift = 0;
    _handShiftPx = initialShift;
    handEl.style.setProperty("--hand-shift", `${initialShift}px`);
  } catch {}

  const contract = contractLabel(roomState.contract);
  const phase = phaseLabel(roomState.phase);
  const tricks = roomState?.meta?.takenTricks?.[mySeat] ?? 0;

  safeText(
    handInfo,
    `Tu: ${roomState.myUsername || "—"} • Fāze: ${phase} • Līgums: ${contract} • Stiķi: ${tricks} • Kārtis: ${
      handSorted.length
    }`
  );

  for (let i = 0; i < handSorted.length; i++) {
    const c = handSorted[i];
    const key = cardToKey(c);

    const btn = document.createElement("button");
    btn.className = "zg-cardbtn";
    btn.type = "button";
    btn.style.zIndex = String(i);
    // fan/overlap: normalizēts t ∈ [-1..1]
    try {
      const n = Math.max(1, handSorted.length);
      const mid = (n - 1) / 2;
      const denom = mid === 0 ? 1 : mid;
      const t = (i - mid) / denom;
      btn.style.setProperty("--t", String(t));
    } catch {}

    const legalNow = roomState.phase === "PLAY" && isMyTurn() && legal.has(key);
    const disabledPlay = roomState.phase === "PLAY" && isMyTurn() && !legal.has(key);

    if (legalNow) btn.classList.add("zg-legal");
    if (disabledPlay) btn.classList.add("zg-disabled");

    const sel = discardPick.some((x) => sameCard(x, c));
    if (sel) btn.classList.add("zg-selected");

    btn.innerHTML = renderCardFace(c);

    btn.addEventListener("click", () => {
      if (isMyDiscardPhase()) {
        const now = Date.now();
        const isDbl = _lastTapKey === key && now - _lastTapAt <= 360;
        _lastTapKey = key;
        _lastTapAt = now;

        const exists = discardPick.findIndex((x) => sameCard(x, c));
        if (exists >= 0) discardPick.splice(exists, 1);
        else {
          if (discardPick.length >= 2) return;
          discardPick.push({ r: c.r, s: c.s });
        }
        updateDiscardButtons();
        renderHand();

        // dubulttaps: ja jau ir 2 izvēlētas, automātiski norok
        if (isDbl && discardPick.length === 2) {
          socket.emit(
            "zole:discard",
            { discard: discardPick.map((x) => ({ r: x.r, s: x.s })) },
            (res) => {
              if (!res?.ok) log(`zole:discard kļūda: ${res?.error || "UNKNOWN"}`);
              discardPick = [];
              updateDiscardButtons();
            }
          );
        }
        return;
      }

      if (roomState.phase === "PLAY" && isMyTurn()) {
        if (!legal.has(key)) {
          const f = currentFollowInfo();
          if (f) showToast(`JĀIET: ${f.label}`);
          return;
        }
        socket.emit("zole:play", { card: { r: c.r, s: c.s } }, (res) => {
          if (!res?.ok) log(`zole:play kļūda: ${res?.error || "UNKNOWN"}`);
        });
      }
    });

    handEl.appendChild(btn);
  }

  updateDiscardButtons();
  clampHandToViewport();
}

/* ============================
   REZULTĀTA TOAST
   ============================ */

function payLineFromSigned(payEachSigned) {
  const p = typeof payEachSigned === "number" ? payEachSigned : 0;
  const abs = Math.abs(p);
  const total = abs * 2;

  if (p > 0) return `Lielais saņem +${abs} no katra (kopā +${total})`;
  if (p < 0) return `Lielais maksā ${abs} katram (kopā -${total})`;
  return `0`;
}

function buildResultText(res) {
  if (!res) return "";

  const c = res.contract ?? "";
  const label = contractLabel(c);
  const status = String(res.status || (res.bigWins ? "UZVAR" : "ZAUDĒ")).trim();

  if (isTakeContract(c) || isZoleContract(c)) {
    const bigName = typeof res.bigSeat === "number" ? nameBySeat(res.bigSeat) : "—";
    const lines = [];
    lines.push(`${label} — LIELAIS: ${bigName} — ${status}`);

    if (typeof res.bigEyes === "number" && typeof res.oppEyes === "number")
      lines.push(`Acis: ${res.bigEyes}:${res.oppEyes}`);
    if (typeof res.bigTricks === "number" && typeof res.oppTricks === "number")
      lines.push(`Stiķi: ${res.bigTricks}:${res.oppTricks}`);
    if (typeof res.payEach === "number") lines.push(`Punkti: ${payLineFromSigned(res.payEach)}`);

    return lines.join("\n");
  }

  if (isMazaContract(c)) {
    const bigName = typeof res.bigSeat === "number" ? nameBySeat(res.bigSeat) : "—";
    const lines = [];
    lines.push(`${label} — LIELAIS: ${bigName} — ${status}`);
    if (typeof res.bigTricks === "number") lines.push(`Lielā stiķi: ${res.bigTricks}`);
    if (typeof res.payEach === "number") lines.push(`Punkti: ${payLineFromSigned(res.payEach)}`);
    return lines.join("\n");
  }

  if (isGaldinsContract(c)) {
    const namesArr = Array.isArray(res.names) ? res.names : null;
    const nm = (i) => (namesArr && namesArr[i] ? namesArr[i] : nameBySeat(i));

    const tricks = Array.isArray(res.tricks) ? res.tricks : [];
    const eyes = Array.isArray(res.eyes) ? res.eyes : [];
    const losers = Array.isArray(res.loserSeats) ? res.loserSeats : [];

    const lines = [];
    lines.push(`GALDIŅŠ (visi GARĀM)`);

    if (tricks.length === 3)
      lines.push(`Stiķi: ${tricks.map((t, i) => `${nm(i)}=${t}`).join(" • ")}`);
    if (eyes.length === 3) lines.push(`Acis: ${eyes.map((e, i) => `${nm(i)}=${e}`).join(" • ")}`);

    if (losers.length === 1) lines.push(`Zaudē: ${nm(losers[0])}`);
    else if (losers.length === 2) lines.push(`Dalīti zaudē: ${losers.map((s) => nm(s)).join(" & ")}`);
    else lines.push(`Neizšķirts`);

    return lines.join("\n");
  }

  return `Rezultāts: ${label}`;
}

function showToast(text) {
  if (!resultToast) return;

  resultToast.innerHTML = `<b>Rezultāts</b><br>${escapeHtml(text).replaceAll("\n", "<br>")}`;
  resultToast.style.display = "block";

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    resultToast.style.display = "none";
  }, 7000);
}

let _hudToastTimer = 0;
function showHudToast(text, ms = 2500) {
  if (!hudToast) return;
  hudToast.textContent = String(text || "");
  hudToast.style.display = "block";
  if (_hudToastTimer) {
    try { clearTimeout(_hudToastTimer); } catch {}
    _hudToastTimer = 0;
  }
  _hudToastTimer = setTimeout(() => {
    _hudToastTimer = 0;
    try { hudToast.style.display = "none"; } catch {}
  }, Math.max(600, Math.min(8000, ms | 0)));
}

function helpHtml() {
  // īss, skaidrs “kā spēlē” latviski (publiskai spēlei)
  return `
    <h3>Trumpji (Zolē vienmēr)</h3>
    <ul>
      <li>Trumpji ir: <code>visas dāmas</code>, tad <code>visi kalpi</code>, tad <code>visi kāravi</code>.</li>
      <li>Dāmas / kalpi pēc kārtības: <code>♣</code> → <code>♠</code> → <code>♥</code> → <code>♦</code>.</li>
      <li>Kāravi pēc kārtības: <code>A</code> → <code>10</code> → <code>K</code> → <code>9</code> → <code>8</code> → <code>7</code>.</li>
    </ul>

    <h3>Jāiet mastā (atmešanās)</h3>
    <ul>
      <li>Ja prasa mastu (♠/♣/♥) un tev rokā ir šī masta <b>netrumpji</b> (A/10/K/9), tad <b>obligāti</b> jāliek tas masts.</li>
      <li>Dāmas/kalpi vienmēr ir trumpji, tātad tie <b>neskaitās</b> kā “iet mastā”.</li>
      <li>Ja nav prasītā masta, drīkst <b>pārsist ar trumpi</b> vai <b>atmesties</b>.</li>
    </ul>

    <h3>Taimeris</h3>
    <ul>
      <li>Katram gājienam ir <b>25 sekundes</b>. Ja laiks beidzas, spēle izdara <b>auto-gājienu</b> (vājāko legālo).</li>
      <li>Ja kāds uztaisa refresh/atvienojas, spēle turpinās — viņš var pārpievienoties ar to pašu niku.</li>
    </ul>

    <h3>Punkti</h3>
    <ul>
      <li>Sākumā katram: <b>1000 PTS</b>.</li>
      <li>Pēc katras partijas punktu izmaiņa tiek parādīta rezultātā.</li>
    </ul>
  `.trim();
}

function openHelp() {
  if (!helpModal || !helpBody) return;
  helpBody.innerHTML = helpHtml();
  helpModal.style.display = "grid";
  helpModal.setAttribute("aria-hidden", "false");
}

function closeHelp() {
  if (!helpModal) return;
  helpModal.style.display = "none";
  helpModal.setAttribute("aria-hidden", "true");
}

function syncTurnCountdown() {
  if (!statusChip) return;
  const base = statusChip.dataset?.base || statusChip.textContent || "";
  const ends = Number(roomState?.turnEndsAt || 0) || 0;

  if (!ends) {
    statusChip.textContent = base;
    return;
  }

  const leftSec = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
  statusChip.textContent = base ? `${base} • ${leftSec}s` : `${leftSec}s`;
}

function startTurnUiTicker() {
  if (_turnUiTicker) return;
  _turnUiTicker = setInterval(() => {
    try {
      if (!roomState) return;
      if (!statusChip) return;
      if (!roomState.turnEndsAt) return;
      syncTurnCountdown();
    } catch {}
  }, 250);
}

function renderAll() {
  try {
    if (stateBox) stateBox.textContent = roomState ? JSON.stringify(roomState, null, 2) : "—";
  } catch {}

  if (!roomState || typeof mySeat !== "number") return;

  applyTableHandLayout();

  if (!isMyDiscardPhase() && discardPick.length) discardPick = [];

  const me = playerBySeat(mySeat);
  readyOn = !!me?.ready;
  setReadyButton();

  const { left, right } = viewSeats();
  const pL = playerBySeat(left);
  const pR = playerBySeat(right);

  if (seatLeft) seatLeft.innerHTML = renderPlayerCard(pL, "pretinieks");
  if (seatRight) seatRight.innerHTML = renderPlayerCard(pR, "pretinieks");
  if (seatBottom) seatBottom.innerHTML = renderPlayerCard(me, "tu");

  // izcel gājienu / lielo uz seat kartītēm
  try {
    const turn = roomState?.turnSeat;
    const big = roomState?.bigSeat;
    seatLeft?.classList?.toggle("zg-seat-turn", turn === left);
    seatRight?.classList?.toggle("zg-seat-turn", turn === right);
    seatBottom?.classList?.toggle("zg-seat-turn", turn === mySeat);
    seatLeft?.classList?.toggle("zg-seat-big", typeof big === "number" && big === left);
    seatRight?.classList?.toggle("zg-seat-big", typeof big === "number" && big === right);
    seatBottom?.classList?.toggle("zg-seat-big", typeof big === "number" && big === mySeat);
  } catch {}

  // status čips headerī (lai visi saprot kas notiek)
  try {
    if (statusChip) {
      const ph = phaseLabel(roomState?.phase);
      const c = contractLabel(roomState?.contract);
      const bigSeat = roomState?.bigSeat;
      const bigName = typeof bigSeat === "number" ? nameBySeat(bigSeat) : "—";
      const turnName =
        typeof roomState?.turnSeat === "number" ? nameBySeat(roomState.turnSeat) : "—";
      const showContract = roomState?.phase !== "LOBBY";
      let base = "";
      if (showContract && isGaldinsContract(roomState?.contract)) {
        base = `${ph} • GALDIŅŠ (visi GARĀM) • GĀJIENS: ${turnName}`;
      } else {
        const follow = currentFollowInfo();
        base =
          showContract && c && c !== "—"
            ? `${ph} • ${c} • LIELAIS: ${bigName} • GĀJIENS: ${turnName}${follow ? ` • JĀIET: ${follow.label}` : ""}`
            : `${ph} • GĀJIENS: ${turnName}${follow ? ` • JĀIET: ${follow.label}` : ""}`;
      }
      statusChip.dataset.base = base;
      statusChip.textContent = base;
      syncTurnCountdown();
    }
  } catch {}

  // 2 galda kārtis (talons): redzams tikai solīšanā
  try {
    const showTalon = roomState?.phase === "BIDDING";
    if (talonPile) talonPile.classList.toggle("is-visible", !!showTalon);
  } catch {}

  renderTrick();
  renderOverlay();
  renderHand();
  renderMiniPtsHud();
}

/* ============================
   SOCKET
   ============================ */

function connect() {
  if (typeof io !== "function") {
    alert(
      'Socket.IO nav ielādēts (io nav definēts). Pārbaudi <script src="/socket.io/socket.io.js">.'
    );
    return;
  }

 
const token = localStorage.getItem("zole_token") || localStorage.getItem("token") || "";
socket = io({
  transports: ["websocket"],
  withCredentials: true,
  auth: { token },
});
    

  function joinOrCreateRoom(payload, cb) {
    socket.emit("room:join", payload, (res) => {
      if (res?.ok) return cb(res);

      if (res?.error === "ROOM_NOT_FOUND") {
        socket.emit("room:create", payload, (res2) => cb(res2));
        return;
      }
      if (res?.error === "UNAUTHORIZED") {
        location.href = "/auth.html?ts=" + Date.now();
        return;
      }
      cb(res);
    });
  }

  socket.on("connect_error", (err) => {
    log(`socket: connect_error ${err?.message || err || ""}`);
    safeText(connLabel, "Savienojuma kļūda");
    try {
      connDot?.classList?.remove("zl-dot-on");
      connDot?.classList?.add("zl-dot-off");
    } catch {}
  });

  socket.on("connect", () => {
    try {
      connDot?.classList?.remove("zl-dot-off");
      connDot?.classList?.add("zl-dot-on");
    } catch {}
    safeText(connLabel, "Savienots");
    log("socket: connect");

    // saglabājam pēdējo istabu (ērti lobby autofillam)
    try {
      localStorage.setItem("zole_lastRoom", ROOM_ID);
    } catch {}

    if (!mySeed) {
      mySeed = seedGen();
      localStorage.setItem("zole_seed", mySeed);
    }


    myAvatarUrl = safeAvatar(myAvatarUrl);

    localStorage.setItem("zole_avatarUrl", myAvatarUrl);

   const payload = { roomId: ROOM_ID, avatarUrl: myAvatarUrl, seed: mySeed };

    joinOrCreateRoom(payload, (res) => {
      if (!res?.ok) {
        log(`room:join/create kļūda: ${res?.error || "UNKNOWN"}`);
        alert(`Nevar pievienoties istabai: ${res?.error || "UNKNOWN"}`);
        location.href = "./index.html";
        return;
      }
      mySeat = res.seat;
      log(`room OK seat=${mySeat}`);

      // commit–reveal seed
      socket.emit("fair:seed", mySeed);

      applyTableHandLayout();
      scheduleFit();
    });
  });

  socket.on("disconnect", () => {
    try {
      connDot?.classList?.remove("zl-dot-on");
      connDot?.classList?.add("zl-dot-off");
    } catch {}
    safeText(connLabel, "Nav savienojuma");
    log("socket: disconnect");
  });

  socket.on("server:hello", () => log("server: hello OK"));

  socket.on("room:state", (st, extra) => {
    const prevTrick = Array.isArray(roomState?.trickPlays) ? roomState.trickPlays : [];
    const prevMap = new Map();
    try {
      if (Array.isArray(roomState?.players)) {
        for (const p of roomState.players) {
          prevMap.set(p.seat, typeof p.matchPts === "number" ? p.matchPts : 0);
        }
      }
    } catch {}

    roomState = st;
    if (typeof st?.mySeat === "number") mySeat = st.mySeat;

    // īsie paziņojumi (taimeris, auto-gājiens, u.c.)
    try {
      const note = String(extra?.note || "").trim();
      if (note) {
        const map = {
          GARAM_TIMEOUT: "Taimeris: GARĀM (auto)",
          DISCARD_TIMEOUT_AUTO: "Taimeris: noraksts (auto)",
          PLAY_TIMEOUT_AUTO: "Taimeris: auto-gājiens",
          DISCONNECT: "Kāds atvienojās (spēle turpinās)",
        };
        if (map[note]) showHudToast(map[note], 2400);
      }
    } catch {}

    // Stiķa “auto-hide” notiek renderTrick() (lai nepagarinās ar papildu hold pēc servera pauzes).

    const newTs = st?.lastResult?.ts || 0;
    const isNewResult = !!newTs && newTs !== lastShownResultTs;

    if (isNewResult) {
      try {
        const nowMap = new Map();
        if (Array.isArray(st?.players)) {
          for (const p of st.players) {
            nowMap.set(p.seat, typeof p.matchPts === "number" ? p.matchPts : 0);
          }
        }

        const d0 = (nowMap.get(0) ?? 0) - (prevMap.get(0) ?? 0);
        const d1 = (nowMap.get(1) ?? 0) - (prevMap.get(1) ?? 0);
        const d2 = (nowMap.get(2) ?? 0) - (prevMap.get(2) ?? 0);

        let hn = null;
        if (typeof st?.lastResult?.handNo === "number") hn = st.lastResult.handNo;
        else if (typeof st?.handNo === "number") hn = Math.max(1, st.handNo - 1);

        ptsHistory.unshift({
          ts: newTs,
          handNo: hn,
          deltas: { 0: d0, 1: d1, 2: d2 },
        });
        if (ptsHistory.length > 20) ptsHistory.length = 20;
      } catch {}
    }

    if (isNewResult) {
      lastShownResultTs = newTs;
      const txt = buildResultText(st.lastResult);
      if (txt) showToast(txt);
    }

    // Ja PTS nokrīt līdz 0, paziņojam un izvedam uz lobby (tikai šim klientam)
    try {
      if (!_bustedHandled && typeof mySeat === "number") {
        const me = (st?.players || []).find((p) => p.seat === mySeat) || null;
        const pts = typeof me?.matchPts === "number" ? me.matchPts : null;
        if (typeof pts === "number" && pts <= 0) {
          _bustedHandled = true;
          showToast("PTS=0 — tu izkriti no spēles. (atgriež uz Lobby)");
          setTimeout(() => {
            try { leaveToLobby(); } catch {}
          }, 900);
        }
      }
    } catch {}

    renderAll();
    scheduleFit();
  });
}

/* ============================
   UI EVENTI
   ============================ */

// Bid pogas
if (bidPanel) {
  bidPanel.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-bid]");
    if (!btn) return;
    if (!roomState || roomState.phase !== "BIDDING") return;
    if (!isMyTurn()) return;

    const bid = btn.getAttribute("data-bid");
    socket.emit("zole:bid", { bid }, (res) => {
      if (!res?.ok) log(`zole:bid kļūda: ${res?.error || "UNKNOWN"}`);
    });
  });
}

// Norakt (notīrīt)
if (btnClearDiscard) {
  btnClearDiscard.addEventListener("click", () => {
    if (!isMyDiscardPhase()) return;
    discardPick = [];
    updateDiscardButtons();
    renderHand();
  });
}

// Norakt (apstiprināt)
if (btnConfirmDiscard) {
  btnConfirmDiscard.addEventListener("click", () => {
    if (!isMyDiscardPhase()) return;
    if (discardPick.length !== 2) return;

    socket.emit(
      "zole:discard",
      { discard: discardPick.map((c) => ({ r: c.r, s: c.s })) },
      (res) => {
        if (!res?.ok) log(`zole:discard kļūda: ${res?.error || "UNKNOWN"}`);
        discardPick = [];
        updateDiscardButtons();
      }
    );
  });
}

// READY toggle
if (btnReadyToggle) {
  btnReadyToggle.addEventListener("click", () => {
    if (!roomState || roomState.phase !== "LOBBY") return;
    const next = !readyOn;
    socket.emit("zole:ready", { ready: next }, (res) => {
      if (!res?.ok) log(`zole:ready kļūda: ${res?.error || "UNKNOWN"}`);
    });
  });
}

// Iziet uz Lobby
function leaveToLobby() {
  try {
    if (!socket || !socket.connected) {
      location.href = "./index.html";
      return;
    }

    socket.emit("room:leave", {}, () => {
      try {
        socket.disconnect();
      } catch {}
      location.href = "./index.html";
    });

    setTimeout(() => {
      try {
        socket.disconnect();
      } catch {}
      location.href = "./index.html";
    }, 400);
  } catch {
    location.href = "./index.html";
  }
}

if (btnLeaveToLobby) btnLeaveToLobby.addEventListener("click", leaveToLobby);

// IMPORTANT:
// Ne-sūtam "room:leave" uz refresh/close, lai nepārtrauktu partiju pārējiem.
// Atvienošanos serveris apstrādā ar "disconnect" un spēlētājs var pārlādēt lapu un atgriezties.
window.addEventListener("beforeunload", () => {
  try {
    // neko nesūtām; ļaujam socketam vienkārši atvienoties
  } catch {}
});

/* ============================
   START
   ============================ */

function boot() {
  try {
    applyTableHandLayout();
  } catch {}
  try {
    initFullscreenAndFit();
  } catch {}
  try {
    ensureCardImages();
  } catch {}
  // Mobilajā: īsāki button teksti (mazāk vietas, vairāk kārtīm)
  try {
    const isMobile =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(max-width: 720px)").matches
        : false;
    if (isMobile) {
      if (btnLeaveToLobby) btnLeaveToLobby.textContent = "LOBBY";
      if (btnFullscreen) btnFullscreen.textContent = "FULL";
      // READY jau īss; atstājam
    }
  } catch {}

  // PTS toggle poga
  try {
    if (btnPtsToggle) {
      btnPtsToggle.addEventListener("click", () => {
        _showPtsHud = !_showPtsHud;
        try {
          localStorage.setItem("zole_showPtsHud", _showPtsHud ? "1" : "0");
        } catch {}
        renderMiniPtsHud();
      });
    }
  } catch {}

  // Palīdzība / noteikumi
  try {
    btnHelp?.addEventListener("click", openHelp);
    btnHelpClose?.addEventListener("click", closeHelp);
    helpModal?.addEventListener("click", (e) => {
      if (e?.target === helpModal) closeHelp();
    });
    document.addEventListener("keydown", (e) => {
      if (e?.key === "Escape") closeHelp();
    });
  } catch {}

  // Turn taimeris (25s) — redzams status čipā
  try {
    startTurnUiTicker();
  } catch {}

  connect();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
