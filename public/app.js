"use strict";

// Ja UI tiek servēts no tā paša servera (Render/Node), lietojam "same-origin"
const API_BASE = "";
const AUTH_URL = "/auth.html";

const $ = (s) => document.querySelector(s);

// DOM
const connDot = $("#connDot");
const connLabel = $("#connLabel");

const nickEl = $("#nick"); // hidden
const avatarUrlEl = $("#avatarUrl");
const roomIdEl = $("#roomId");

const btnCreate = $("#btnCreate");
const btnJoin = $("#btnJoin");
const btnLastRoom = $("#btnLastRoom");
const btnQuick = $("#btnQuick");
const btnFeedback = $("#btnFeedback");

const errBox = $("#errBox");

const btnRefreshRooms = $("#btnRefreshRooms");
const roomsEmpty = $("#roomsEmpty");
const roomsList = $("#roomsList");

const btnRefreshTop10 = $("#btnRefreshTop10");
const top10Empty = $("#top10Empty");
const top10List = $("#top10List");
const btnTopAll = $("#btnTopAll");
const btnTopMonth = $("#btnTopMonth");
const btnTopWeek = $("#btnTopWeek");

// Feedback modal
const feedbackModal = $("#feedbackModal");
const btnFeedbackClose = $("#btnFeedbackClose");
const btnFeedbackSend = $("#btnFeedbackSend");
const feedbackType = $("#feedbackType");
const feedbackMsg = $("#feedbackMsg");
const feedbackHint = $("#feedbackHint");

// Profile UI
const profileNameEl = $("#profileName");
const profilePtsEl = $("#profilePts");
const profileAvatarEl = $("#profileAvatar");

// NAV pogas
const btnBackAuth = $("#btnBackAuth");
const btnChangeProfile = $("#btnChangeProfile");

// Storage keys
const K_USER = "zole_username";
const K_AVATAR = "zole_avatarUrl";
const K_PTS = "zole_pts";
const K_SEED = "zole_seed";
const K_LASTROOM = "zole_lastRoom";
const K_LBSCOPE = "zole_lbScope";

// socket
let socket = null;

// helpers
function safeText(el, t) {
  if (!el) return;
  el.textContent = String(t ?? "");
}
function showErr(msg) {
  if (!errBox) return;
  if (!msg) {
    errBox.style.display = "none";
    errBox.textContent = "";
    return;
  }
  errBox.style.display = "block";
  errBox.textContent = String(msg);
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
  const CRYPTO =
    typeof globalThis !== "undefined" && globalThis.crypto ? globalThis.crypto : null;
  if (!CRYPTO?.getRandomValues) {
    return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  }
  const a = new Uint8Array(8);
  CRYPTO.getRandomValues(a);
  return Array.from(a).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function normRoom(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function loadProfileFromStorage() {
  const username = safeNick(localStorage.getItem(K_USER) || "");
  const avatarUrl = safeAvatar(localStorage.getItem(K_AVATAR) || "");
  const pts = Number(localStorage.getItem(K_PTS) || "0") || 0;
  return { username, avatarUrl, pts };
}

function saveProfileToStorage({ username, avatarUrl, pts }) {
  if (username) localStorage.setItem(K_USER, safeNick(username));
  localStorage.setItem(K_AVATAR, safeAvatar(avatarUrl || ""));
  if (typeof pts === "number" && Number.isFinite(pts)) localStorage.setItem(K_PTS, String(pts));
}

function renderProfileBar(profile) {
  safeText(profileNameEl, profile.username || "—");
  safeText(profilePtsEl, String(profile.pts ?? "—"));

  if (!profileAvatarEl) return;

  const av = safeAvatar(profile.avatarUrl || "");
  if (!av) {
    profileAvatarEl.innerHTML = (profile.username || "Z").slice(0, 1).toUpperCase();
    return;
  }
  profileAvatarEl.innerHTML = `<img src="${av}" alt="" style="width:100%;height:100%;object-fit:cover;" referrerpolicy="no-referrer" />`;
}

/**
 * Logout + uz auth (lai “Atpakaļ” tiešām paliek auth lapā)
 */
async function logoutAndGoAuth() {
  showErr("");

  try { socket?.disconnect(); } catch {}

  try {
    await fetch(`${API_BASE}/logout`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
    });
  } catch {}

  try {
    localStorage.removeItem(K_USER);
    localStorage.removeItem(K_AVATAR);
    localStorage.removeItem(K_PTS);
    localStorage.removeItem(K_LASTROOM);
    // ja gribi super-clean:
    // localStorage.removeItem(K_SEED);
  } catch {}

  const url = `${AUTH_URL}?switch=1&ts=${Date.now()}`;
  try {
    window.top.location.replace(url);
  } catch {
    window.location.replace(url);
  }
}

/**
 * FIX: nevis balstīties uz localStorage, bet vispirms mēģināt /me (cookie).
 * Tas NOŅEM redirect-loop un “raustīšanos”.
 */
async function ensureProfileOrRedirect() {
  let p = loadProfileFromStorage();
  if (p.username) return p;

  try {
    const r = await fetch(`${API_BASE}/me`, {
      credentials: "include",
      cache: "no-store",
    });

    if (r.ok) {
      const data = await r.json();
      if (data?.ok && data.username) {
        saveProfileToStorage({
          username: safeNick(data.username),
          avatarUrl: safeAvatar(data.avatarUrl || ""),
          pts: Number(data.pts ?? 0) || 0,
        });
      }
    }
  } catch {}

  p = loadProfileFromStorage();
  if (p.username) return p;

  // nav sesijas -> uz auth
  const url = `${AUTH_URL}?ts=${Date.now()}`;
  try {
    window.top.location.replace(url);
  } catch {
    window.location.replace(url);
  }
  return null;
}

async function refreshProfileFromServer() {
  try {
    const r = await fetch(`${API_BASE}/me`, { credentials: "include", cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    if (!data || data.ok === false) return;

    const username = safeNick(data.username || data.user || "");
    const avatarUrl = safeAvatar(data.avatarUrl || "");
    const pts = Number(data.pts ?? data.matchPts ?? data.points ?? 0) || 0;

    if (username) {
      saveProfileToStorage({ username, avatarUrl, pts });
      if (nickEl) nickEl.value = username;
      if (avatarUrlEl && !avatarUrlEl.value) avatarUrlEl.value = avatarUrl;
      renderProfileBar(loadProfileFromStorage());
    }
  } catch {}
}

function connectSocketAndSubscribe() {
  if (typeof io !== "function") {
    showErr("Socket.IO nav ielādēts (io nav definēts).");
    return;
  }

  const token = localStorage.getItem("zole_token") || localStorage.getItem("token") || "";
  socket = io({
    transports: ["websocket"],
    withCredentials: true,
    auth: { token },
  });

  socket.on("connect", () => {
    try {
      connDot?.classList?.remove("zl-dot-off");
      connDot?.classList?.add("zl-dot-on");
    } catch {}
    safeText(connLabel, "Savienots");
    showErr("");

    socket.emit("lobby:join", {});
    pullRooms();
    pullTop10();
  });

  socket.on("disconnect", () => {
    try {
      connDot?.classList?.remove("zl-dot-on");
      connDot?.classList?.add("zl-dot-off");
    } catch {}
    safeText(connLabel, "Nav savienojuma");
  });

  socket.on("rooms:update", (payload) => {
    renderRooms(payload?.rooms || payload || []);
  });

  socket.on("leaderboard:update", (payload) => {
    const scope = getLbScope();
    if (scope === "week" && Array.isArray(payload?.top10Week)) return renderTop10(payload.top10Week);
    if (scope === "month" && Array.isArray(payload?.top10Month))
      return renderTop10(payload.top10Month);
    renderTop10(payload?.top10All || payload?.top10 || payload || []);
  });
}

function getLbScope() {
  try {
    const s = String(localStorage.getItem(K_LBSCOPE) || "all").toLowerCase();
    if (s === "week" || s === "month") return s;
  } catch {}
  return "all";
}
function setLbScope(scope) {
  const s = scope === "week" || scope === "month" ? scope : "all";
  try {
    localStorage.setItem(K_LBSCOPE, s);
  } catch {}
  try {
    btnTopAll?.classList?.toggle("zl-primary", s === "all");
    btnTopMonth?.classList?.toggle("zl-primary", s === "month");
    btnTopWeek?.classList?.toggle("zl-primary", s === "week");
  } catch {}
}

function pullRooms() {
  if (socket && socket.connected) {
    socket.emit("room:list", {}, (res) => {
      if (res?.ok && Array.isArray(res.rooms)) {
        renderRooms(res.rooms);
        return;
      }
      pullRoomsHttpFallback();
    });
  } else {
    pullRoomsHttpFallback();
  }
}
async function pullRoomsHttpFallback() {
  try {
    const r = await fetch(`${API_BASE}/rooms`, { credentials: "include", cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    if (Array.isArray(data?.rooms)) renderRooms(data.rooms);
    else if (Array.isArray(data)) renderRooms(data);
  } catch {}
}

function renderRooms(rooms) {
  const arr = Array.isArray(rooms) ? rooms : [];
  if (!roomsList) return;

  roomsList.innerHTML = "";
  if (roomsEmpty) roomsEmpty.style.display = arr.length ? "none" : "block";

  for (const r of arr) {
    const roomId = normRoom(r.roomId || r.id || "");
    if (!roomId) continue;

    const openSeats = Number(r.openSeatsCount ?? r.openSeats ?? 0) || 0;
    const occ = Number(r.occupiedSeats ?? 0) || 0;

    const card = document.createElement("div");
    card.className = "zl-roomcard";
    card.style.cssText =
      "padding:10px 12px;border-radius:14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;gap:10px;";

    const left = document.createElement("div");
    left.innerHTML = `<div style="font-weight:900;">ROOM: ${roomId}</div>
      <div style="opacity:.85;font-size:13px;">Vietas: ${occ}/3 • Brīvas: ${openSeats}</div>`;

    const btn = document.createElement("button");
    btn.className = "zl-btn";
    btn.type = "button";
    btn.textContent = "Pievienoties";
    btn.addEventListener("click", () => {
      if (roomIdEl) roomIdEl.value = roomId;
      joinRoom(false);
    });

    card.appendChild(left);
    card.appendChild(btn);
    roomsList.appendChild(card);
  }
}

function pullTop10() {
  const scope = getLbScope();
  if (socket && socket.connected) {
    socket.emit("leaderboard:top10", { scope }, (res) => {
      if (res?.ok && Array.isArray(res.top10)) {
        renderTop10(res.top10);
        return;
      }
      pullTop10HttpFallback();
    });
  } else {
    pullTop10HttpFallback();
  }
}
async function pullTop10HttpFallback() {
  try {
    const scope = getLbScope();
    const r = await fetch(`${API_BASE}/leaderboard?scope=${encodeURIComponent(scope)}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!r.ok) return;
    const data = await r.json();
    if (Array.isArray(data?.top10)) renderTop10(data.top10);
    else if (Array.isArray(data)) renderTop10(data);
  } catch {}
}

function renderTop10(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!top10List) return;

  top10List.innerHTML = "";
  if (top10Empty) top10Empty.style.display = arr.length ? "none" : "block";

  const me = loadProfileFromStorage().username;
  const scope = getLbScope();

  for (const row of arr) {
    const li = document.createElement("li");
    li.className = "zl-top10-item";

    const name = safeNick(row.username || row.name || "—");
    const pts =
      scope === "week"
        ? Number(row.weekPts ?? row.pts ?? row.points ?? row.matchPts ?? 0) || 0
        : scope === "month"
          ? Number(row.monthPts ?? row.pts ?? row.points ?? row.matchPts ?? 0) || 0
          : Number(row.pts ?? row.points ?? row.matchPts ?? 0) || 0;

    li.innerHTML = `<span style="font-weight:900;">${name}</span>
      <span style="opacity:.9;">${pts}</span>`;

    if (me && name === me) {
      li.style.outline = "1px solid rgba(124,255,178,0.35)";
      li.style.background = "rgba(124,255,178,0.06)";
      saveProfileToStorage({ username: me, avatarUrl: loadProfileFromStorage().avatarUrl, pts });
      renderProfileBar(loadProfileFromStorage());
    }

    top10List.appendChild(li);
  }
}

function createOrJoinRoom(isCreate) {
  const prof = loadProfileFromStorage();
  if (!prof.username) {
    logoutAndGoAuth();
    return;
  }

  showErr("");
  const avatarUrl = safeAvatar(avatarUrlEl?.value || prof.avatarUrl || "");
  const roomId = normRoom(roomIdEl?.value || "");
  if (!roomId) return showErr("Ievadi ROOM (piem., A1B2).");

  localStorage.setItem(K_AVATAR, avatarUrl);
  localStorage.setItem(K_LASTROOM, roomId);

  let seed = localStorage.getItem(K_SEED) || "";
  if (!seed) {
    seed = seedGen();
    localStorage.setItem(K_SEED, seed);
  }

  // Iekļaujam username, lai nebūtu NICK_REQUIRED pat bez cookie/token
  const payload = { roomId, username: prof.username, avatarUrl, seed };

  if (!socket || !socket.connected) {
    location.href = `./game.html?room=${encodeURIComponent(roomId)}`;
    return;
  }

  const ev = isCreate ? "room:create" : "room:join";

  socket.emit(ev, payload, (res) => {
    if (!res?.ok) {
      showErr(res?.error || "Neizdevās.");
      return;
    }
    location.href = `./game.html?room=${encodeURIComponent(roomId)}`;
  });
}

function joinRoom(isCreate) {
  createOrJoinRoom(!!isCreate);
}

function quickPlay() {
  const prof = loadProfileFromStorage();
  if (!prof.username) {
    logoutAndGoAuth();
    return;
  }

  showErr("");
  const avatarUrl = safeAvatar(avatarUrlEl?.value || prof.avatarUrl || "");
  localStorage.setItem(K_AVATAR, avatarUrl);

  let seed = localStorage.getItem(K_SEED) || "";
  if (!seed) {
    seed = seedGen();
    localStorage.setItem(K_SEED, seed);
  }

  if (!socket || !socket.connected) return showErr("Nav Socket.IO savienojuma.");

  socket.emit("room:quick", { username: prof.username, avatarUrl, seed }, (res) => {
    if (!res?.ok) return showErr(res?.error || "QUICK_FAILED");
    const roomId = normRoom(res.roomId || "");
    if (!roomId) return showErr("QUICK_FAILED");
    try {
      localStorage.setItem(K_LASTROOM, roomId);
    } catch {}
    location.href = `./game.html?room=${encodeURIComponent(roomId)}`;
  });
}

function openFeedback() {
  if (!feedbackModal) return;
  feedbackModal.style.display = "grid";
  feedbackModal.setAttribute("aria-hidden", "false");
  try {
    const last = normRoom(localStorage.getItem(K_LASTROOM) || "");
    if (feedbackHint)
      feedbackHint.textContent = last ? `Room: ${last}` : "Room tiks pievienots automātiski (ja ir).";
  } catch {}
}
function closeFeedback() {
  if (!feedbackModal) return;
  feedbackModal.style.display = "none";
  feedbackModal.setAttribute("aria-hidden", "true");
}
async function sendFeedback() {
  const msg = String(feedbackMsg?.value || "").trim();
  if (!msg) return showErr("Atsauksme ir tukša.");

  const type = String(feedbackType?.value || "feedback").trim();
  const roomId = normRoom(localStorage.getItem(K_LASTROOM) || "");
  const meta = {
    ua: navigator.userAgent,
    lang: navigator.language,
    vw: window.innerWidth,
    vh: window.innerHeight,
    dpr: window.devicePixelRatio,
    ts: Date.now(),
  };

  try {
    const r = await fetch(`${API_BASE}/feedback`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, message: msg, roomId, page: "lobby", meta }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || data?.ok === false) throw new Error(data?.error || "FAILED");
    showErr("");
    if (feedbackMsg) feedbackMsg.value = "";
    closeFeedback();
    alert("Paldies! Atsauksme nosūtīta.");
  } catch (e) {
    showErr(`Neizdevās nosūtīt: ${String(e?.message || e || "ERROR")}`);
  }
}

async function boot() {
  if (window.__zlBooted) return;
  window.__zlBooted = true;

  // NAV pogas: logout + uz auth
  if (btnBackAuth) {
    btnBackAuth.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      logoutAndGoAuth();
    });
  }
  if (btnChangeProfile) {
    btnChangeProfile.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      logoutAndGoAuth();
    });
  }

  const prof = await ensureProfileOrRedirect();
  if (!prof) return;

  if (nickEl) nickEl.value = prof.username;
  if (avatarUrlEl) avatarUrlEl.value = prof.avatarUrl || (localStorage.getItem(K_AVATAR) || "");
  if (roomIdEl) roomIdEl.value = localStorage.getItem(K_LASTROOM) || "";

  // "Pēdējā istaba" pogas teksts
  try {
    const last = normRoom(localStorage.getItem(K_LASTROOM) || "");
    if (btnLastRoom) {
      btnLastRoom.style.display = last ? "" : "none";
      btnLastRoom.textContent = last ? `Pēdējā: ${last}` : "Pēdējā istaba";
    }
  } catch {}

  renderProfileBar(prof);

  // (optional) PTS refresh
  refreshProfileFromServer();

  connectSocketAndSubscribe();

  if (btnCreate) btnCreate.addEventListener("click", () => joinRoom(true));
  if (btnJoin) btnJoin.addEventListener("click", () => joinRoom(false));
  if (btnQuick) btnQuick.addEventListener("click", () => quickPlay());
  if (btnFeedback) btnFeedback.addEventListener("click", openFeedback);
  if (btnLastRoom) {
    btnLastRoom.addEventListener("click", () => {
      showErr("");
      const last = normRoom(localStorage.getItem(K_LASTROOM) || "");
      if (!last) return showErr("Nav saglabāta pēdējā istaba.");
      if (roomIdEl) roomIdEl.value = last;
      joinRoom(false);
    });
  }

  if (btnRefreshRooms) btnRefreshRooms.addEventListener("click", pullRooms);
  if (btnRefreshTop10) btnRefreshTop10.addEventListener("click", pullTop10);

  // Top10 “sezona”
  try {
    setLbScope(getLbScope());
    btnTopAll?.addEventListener("click", () => {
      setLbScope("all");
      pullTop10();
    });
    btnTopMonth?.addEventListener("click", () => {
      setLbScope("month");
      pullTop10();
    });
    btnTopWeek?.addEventListener("click", () => {
      setLbScope("week");
      pullTop10();
    });
  } catch {}

  if (avatarUrlEl) {
    avatarUrlEl.addEventListener("change", () => {
      const p = loadProfileFromStorage();
      const av = safeAvatar(avatarUrlEl.value || "");
      saveProfileToStorage({ username: p.username, avatarUrl: av, pts: p.pts });
      renderProfileBar(loadProfileFromStorage());
    });
  }

  // Feedback modal
  try {
    btnFeedbackClose?.addEventListener("click", closeFeedback);
    btnFeedbackSend?.addEventListener("click", sendFeedback);
    feedbackModal?.addEventListener("click", (e) => {
      if (e?.target === feedbackModal) closeFeedback();
    });
    document.addEventListener("keydown", (e) => {
      if (e?.key === "Escape") closeFeedback();
    });
  } catch {}
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => boot());
} else {
  boot();
}
