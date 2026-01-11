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

const seatLeft = $("#seatLeft");
const seatRight = $("#seatRight");
const seatBottom = $("#seatBottom");

const metaLine = $("#metaLine");
const turnLine = $("#turnLine");

const slotLeft = $("#slotLeft");
const slotRight = $("#slotRight");
const slotBottom = $("#slotBottom");

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

// FULLSCREEN poga (no game.html)
const btnFullscreen = $("#btnFullscreen");

// Rezultāta toast (to atstājam)
const resultToast = $("#resultToast");

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
 
  const reserve = 18;
  const h = Math.max(260, vh - topH - reserve);
 
  try {
    felt.style.setProperty("height", `${h}px`, "important");
    felt.style.setProperty("max-height", "none", "important");
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
  const OLD_ID = "bugatsZoleUiStyle_v2_tableHand";
  const id = "bugatsZoleUiStyle_v6_centerBigCards_fullscreenFit_zfix";

  try {
    document.getElementById(OLD_ID)?.remove();
  } catch {}
  try {
    document.getElementById("bugatsZoleUiStyle_v3_meLeft")?.remove();
  } catch {}
  try {
    document.getElementById("bugatsZoleUiStyle_v4_centerBigCards")?.remove();
  } catch {}
  try {
    document.getElementById("bugatsZoleUiStyle_v5_centerBigCards_fullscreenFit")?.remove();
  } catch {}

  if (document.getElementById(id)) return;

  const st = document.createElement("style");
  st.id = id;
  st.textContent = `
/* ===== BUGATS ZOLE — v6: Fullscreen-fit + kārtis centrā + lielākas + z-index fix ===== */
.zg-felt, .zl-felt, #felt, #zoleFelt, .zole-felt, .zg-table, .zg-board{
  width: min(1700px, 98vw) !important;
  max-width: none !important;
}
#metaLine, #turnLine{
  font-size: 12px !important;
  opacity: 0.85 !important;
}
#stateBox, #logBox{ display:none !important; }

/* Hand stack vienmēr virs player dock (fix overlap) */
#zgBottomStack{
  position: absolute;
  left: 50%;
  bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  width: min(1400px, 92vw);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  z-index: 90; /* bija 70 */
  pointer-events: none;
}
#zgBottomStack #handInfo{
  font-size: 12px !important;
  opacity: 0.85 !important;
  text-align: center;
  padding: 0 10px;
  margin: 0;
  pointer-events: none;
}
#zgBottomStack #hand{
  position: relative;
  width: 100%;
  height: 220px;
  display: flex;
  justify-content: center;
  align-items: flex-end;
  padding-bottom: 2px;
  pointer-events: auto;
}
#zgBottomStack #hand .zg-cardbtn{
  width: 118px;
  height: 166px;
  margin-left: -72px;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  transition: transform 120ms ease, filter 120ms ease;
  transform: none !important;
}
#zgBottomStack #hand .zg-cardbtn:first-child{ margin-left: 0; }
#zgBottomStack #hand .zg-cardbtn:hover{
  transform: translateY(-16px) scale(1.02) !important;
  z-index: 9999 !important;
}
#zgBottomStack #hand .zg-cardbtn.zg-selected{
  transform: translateY(-20px) scale(1.02) !important;
  z-index: 9999 !important;
}
#zgBottomStack #hand .zg-cardbtn.zg-disabled{
  opacity: 0.35 !important;
  filter: grayscale(0.15);
  pointer-events: none;
}
#zgBottomStack #hand .zg-cardbtn.zg-legal{
  filter: drop-shadow(0 0 10px rgba(124,255,178,0.25));
}

#zgMeDock{
  position: absolute;
  left: 12px;
  bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  width: min(360px, 30vw);
  z-index: 80; /* bija 80, bet stack tagad 90 */
  pointer-events: none;
}
#zgMeDock #seatBottom{ width: 100%; }
#zgMeDock #seatBottom .zg-seat-inner{
  transform: scale(0.92);
  transform-origin: bottom left;
}

#seatLeft .zg-seat-inner, #seatRight .zg-seat-inner{
  transform: scale(0.90);
  transform-origin: top left;
}
#seatRight .zg-seat-inner{ transform-origin: top right; }

@media (max-width: 900px){
  #zgMeDock{ width: min(320px, 44vw); left: 10px; bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
  #zgBottomStack{
    width: min(1200px, 96vw);
    bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  }
  #zgBottomStack #hand{ height: 200px; }
  #zgBottomStack #hand .zg-cardbtn{
    width: 108px;
    height: 152px;
    margin-left: -66px;
  }
}

@media (max-width: 600px){
  /* vēl mazāks “TU” dock, lai nelien iekš kārtīm */
  #zgMeDock{
    width: min(260px, 46vw);
    left: 8px;
    bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  }
  #zgMeDock #seatBottom .zg-seat-inner{
    transform: scale(0.82);
  }
}
`;
  document.head.appendChild(st);
}

function ensurePrettyCardsStyle() {
  const id = "zgPrettyCardsStyle_v1";
  if (document.getElementById(id)) return;

  const st = document.createElement("style");
  st.id = id;
  st.textContent = `
/* ===== ZOLE: Pretty Cards v1 (no images, no layout shift) ===== */
.zg-card.zg-pretty{
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 16px;
  background: linear-gradient(180deg, #ffffff 0%, #f2f4f7 100%);
  border: 1px solid rgba(0,0,0,0.18);
  box-shadow:
    0 14px 30px rgba(0,0,0,0.28),
    inset 0 1px 0 rgba(255,255,255,0.85);
  overflow: hidden;
  color: #121316;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
}
.zg-card.zg-pretty::before{
  content:"";
  position:absolute;
  inset:10px;
  border-radius: 12px;
  border: 1px solid rgba(0,0,0,0.06);
  pointer-events:none;
}
.zg-card.zg-pretty::after{
  content:"";
  position:absolute;
  inset:-45%;
  background: radial-gradient(circle at 30% 25%, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0) 58%);
  transform: rotate(12deg);
  opacity: 0.55;
  pointer-events:none;
}
.zg-card.zg-pretty.zg-card-red{ color: #c1121f; }
.zg-card.zg-pretty .zg-corner{
  position:absolute;
  display:flex;
  flex-direction:column;
  align-items:center;
  line-height:1;
  font-weight: 950;
  letter-spacing: -0.3px;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 0 rgba(255,255,255,0.35);
  user-select:none;
}
.zg-card.zg-pretty .zg-tl{ top:10px; left:10px; }
.zg-card.zg-pretty .zg-br{ bottom:10px; right:10px; transform: rotate(180deg); }
.zg-card.zg-pretty .zg-crank{
  font-size: 24px;
  min-width: 28px;
  text-align:center;
}
.zg-card.zg-pretty .zg-csuit{
  font-size: 18px;
  margin-top: 3px;
}
.zg-card.zg-pretty .zg-pip{
  position:absolute;
  left:50%;
  top:52%;
  transform: translate(-50%, -50%);
  font-size: 62px;
  font-weight: 950;
  opacity: 0.18;
  line-height: 1;
  user-select:none;
}
`;
  document.head.appendChild(st);
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

  const styleId = "miniPtsHudStyle";
  if (!document.getElementById(styleId)) {
    const st = document.createElement("style");
    st.id = styleId;
    st.textContent = `
#miniPtsHud{
  position:fixed;
  right:12px;
  bottom:12px;
  z-index:9999;
  width:230px;
  padding:10px 10px 8px;
  border-radius:12px;
  background:rgba(0,0,0,0.55);
  border:1px solid rgba(255,255,255,0.14);
  backdrop-filter: blur(6px);
  color:#fff;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  box-shadow: 0 10px 30px rgba(0,0,0,0.35);
  pointer-events:none;
}
#miniPtsHud .mph-title{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:6px;
  font-size:12px;
  letter-spacing:0.4px;
  opacity:0.95;
}
#miniPtsHud .mph-title b{font-weight:900;}
#miniPtsHud .mph-muted{opacity:0.7;}

#miniPtsHud .mph-grid{
  display:grid;
  grid-template-columns: 34px repeat(3, 1fr);
  column-gap: 6px;
  row-gap: 4px;
  font-size:12px;
  line-height:1.1;
  font-variant-numeric: tabular-nums;
}
#miniPtsHud .mph-cell{ padding:2px 0; }
#miniPtsHud .mph-head{
  font-weight:900;
  text-align:center;
  opacity:0.95;
}
#miniPtsHud .mph-n{ opacity:0.75; }
#miniPtsHud .mph-val{
  text-align:center;
  font-weight:900;
  white-space:nowrap;
}
#miniPtsHud .mph-zero{ opacity:0.55; font-weight:800; }
#miniPtsHud .mph-pos{ color:#7CFFB2; }
#miniPtsHud .mph-neg{ color:#FF7C7C; }

#miniPtsHud .mph-total{
  margin-top:2px;
  padding-top:6px;
  border-top:1px solid rgba(255,255,255,0.14);
}
#miniPtsHud .mph-kopa{ font-weight:900; }
`;
    document.head.appendChild(st);
  }

  return miniPtsHudEl;
}

function renderMiniPtsHud() {
  const el = ensureMiniPtsHud();

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

  let html = `<div class="mph-title"><b>PTS</b><span class="mph-muted">${escapeHtml(
    phaseTxt
  )}</span></div>`;
  html += `<div class="mph-grid">`;

  html += `<div class="mph-cell"></div>`;
  html += `<div class="mph-cell mph-head">${escapeHtml(colNames[0])}</div>`;
  html += `<div class="mph-cell mph-head">${escapeHtml(colNames[1])}</div>`;
  html += `<div class="mph-cell mph-head">${escapeHtml(colNames[2])}</div>`;

  const rows = ptsHistory.slice(0, 6);
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

  const totA = Number(playerBySeat(cols[0])?.matchPts ?? 0) || 0;
  const totB = Number(playerBySeat(cols[1])?.matchPts ?? 0) || 0;
  const totC = Number(playerBySeat(cols[2])?.matchPts ?? 0) || 0;

  html += `<div class="mph-cell mph-total mph-kopa">KOPĀ</div>`;
  html += `<div class="mph-cell mph-total mph-val">${escapeHtml(fmtPts(totA))}</div>`;
  html += `<div class="mph-cell mph-total mph-val">${escapeHtml(fmtPts(totB))}</div>`;
  html += `<div class="mph-cell mph-total mph-val">${escapeHtml(fmtPts(totC))}</div>`;

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
const SUIT_ORDER = { C: 0, S: 1, H: 2, D: 3 };

function isTrumpStd(c) {
  return c?.s === "D" || c?.r === "Q" || c?.r === "J";
}
function trumpStrengthStd(c) {
  const idx = TRUMP_INDEX.get(`${c.r}${c.s}`);
  return typeof idx === "number" ? idx : 999;
}

function sortHandByStrength(hand, contract) {
  const h = (hand || []).slice();
  const noTrumps = isMazaContract(contract);

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
        <div class="zg-avatar zg-avatar-empty"></div>
        <div class="zg-name">—</div>
      </div>
      <div class="zg-seat-sub">tukšs</div>
    </div>`;
  }

  const initial = escapeHtml((p.username || "?").slice(0, 1).toUpperCase());
  const av = safeAvatar(p.avatarUrl || "");
  const avatarWrapCls = av ? "zg-avatar" : "zg-avatar zg-avatar-empty";
  const avatarInner = av
    ? `<img class="zg-avatar-img" src="${escapeHtml(av)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="zg-avatar-letter">${initial}</div>`;

  const cardsLeft = roomState?.meta?.handSizes?.[p.seat] ?? 0;
  const conn = p.connected ? "online" : "offline";
  const pts = typeof p.matchPts === "number" ? p.matchPts : 0;

  const role = seatRoleLabel(p.seat);
  const contractB = seatContractBadgeLabel(p.seat);
  const act = seatActionLabel(p.seat);

  const ready =
    roomState?.phase === "LOBBY"
      ? p.ready
        ? `<span class="zg-badge zg-badge-on">READY</span>`
        : `<span class="zg-badge">nav ready</span>`
      : "";

  const roleBadge = role ? `<span class="zg-badge">${escapeHtml(role)}</span>` : "";
  const contractBadge = contractB ? `<span class="zg-badge">${escapeHtml(contractB)}</span>` : "";
  const actBadge = act ? `<span class="zg-badge zg-badge-on">${escapeHtml(act)}</span>` : "";

  const backs = Array.from({ length: Math.min(8, cardsLeft) })
    .map(() => `<span class="zg-back"></span>`)
    .join("");

  const badges = [roleBadge, contractBadge, actBadge, ready].filter(Boolean).join(" ");

  return `<div class="zg-seat-inner">
    <div class="zg-seat-topline">
      <div class="${avatarWrapCls}">${avatarInner}</div>
      <div class="zg-nameblock">
        <div class="zg-name">${escapeHtml(p.username)}</div>
        <div class="zg-mini">${escapeHtml(whereLabel)} • ${escapeHtml(conn)} • PTS: ${escapeHtml(
    pts
  )}${badges ? " • " + badges : ""}</div>
      </div>
    </div>
    <div class="zg-backs">${backs}</div>
  </div>`;
}

/* ====== SMUKĀS KĀRTIS ====== */
function renderCardFace(c) {
  if (!c) return "";
  const red = isRedSuit(c.s) ? "zg-card-red" : "";
  const sym = suitSym(c.s);
  const rank = escapeHtml(c.r);

  return `<div class="zg-card zg-pretty ${red}">
    <div class="zg-corner zg-tl">
      <div class="zg-crank">${rank}</div>
      <div class="zg-csuit">${escapeHtml(sym)}</div>
    </div>

    <div class="zg-pip">${escapeHtml(sym)}</div>

    <div class="zg-corner zg-br">
      <div class="zg-crank">${rank}</div>
      <div class="zg-csuit">${escapeHtml(sym)}</div>
    </div>
  </div>`;
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

  if (!roomState?.trickPlays?.length) return;

  const { left, right } = viewSeats();

  for (const pl of roomState.trickPlays) {
    const html = renderCardFace(pl.card);
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

    const legalNow = roomState.phase === "PLAY" && isMyTurn() && legal.has(key);
    const disabledPlay = roomState.phase === "PLAY" && isMyTurn() && !legal.has(key);

    if (legalNow) btn.classList.add("zg-legal");
    if (disabledPlay) btn.classList.add("zg-disabled");

    const sel = discardPick.some((x) => sameCard(x, c));
    if (sel) btn.classList.add("zg-selected");

    btn.innerHTML = renderCardFace(c);

    btn.addEventListener("click", () => {
      if (isMyDiscardPhase()) {
        const exists = discardPick.findIndex((x) => sameCard(x, c));
        if (exists >= 0) discardPick.splice(exists, 1);
        else {
          if (discardPick.length >= 2) return;
          discardPick.push({ r: c.r, s: c.s });
        }
        updateDiscardButtons();
        renderHand();
        return;
      }

      if (roomState.phase === "PLAY" && isMyTurn()) {
        if (!legal.has(key)) return;
        socket.emit("zole:play", { card: { r: c.r, s: c.s } }, (res) => {
          if (!res?.ok) log(`zole:play kļūda: ${res?.error || "UNKNOWN"}`);
        });
      }
    });

    handEl.appendChild(btn);
  }

  updateDiscardButtons();
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

  socket.on("room:state", (st) => {
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

window.addEventListener("beforeunload", () => {
  try {
    if (socket && socket.connected) socket.emit("room:leave", {});
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
  connect();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
