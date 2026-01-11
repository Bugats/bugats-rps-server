/* global io */

function qs(id) {
  return document.getElementById(id);
}

function showErr(msg) {
  const box = qs("errBox");
  if (!box) return;
  if (!msg) {
    box.style.display = "none";
    box.textContent = "";
    return;
  }
  box.style.display = "block";
  box.textContent = String(msg);
}

function setConn(ok) {
  const dot = qs("connDot");
  const label = qs("connLabel");
  if (dot) {
    dot.classList.toggle("zl-dot-on", !!ok);
    dot.classList.toggle("zl-dot-off", !ok);
  }
  if (label) label.textContent = ok ? "Savienots" : "Nav savienojuma";
}

function seedGetOrMake() {
  const key = "zole_seed";
  let s = "";
  try {
    s = String(localStorage.getItem(key) || "");
  } catch {
    s = "";
  }
  if (s && s.length >= 8) return s.slice(0, 64);

  const rnd = new Uint8Array(12);
  try {
    crypto.getRandomValues(rnd);
  } catch {
    // fallback
    for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(rnd)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  try {
    localStorage.setItem(key, hex);
  } catch {}
  return hex;
}

async function loadMe() {
  const nick = qs("nick");
  const profileName = qs("profileName");
  const profilePts = qs("profilePts");
  const profileAvatar = qs("profileAvatar");

  try {
    const res = await fetch("/me", { credentials: "include" });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.error || "UNAUTHORIZED");

    const username = String(data.username || data.user?.username || "").trim();
    const pts = data.pts ?? data.user?.pts;
    const avatarUrl = String(data.avatarUrl || data.user?.avatarUrl || "").trim();

    if (nick) nick.value = username;
    if (profileName) profileName.textContent = username || "—";
    if (profilePts) profilePts.textContent = typeof pts === "number" ? String(pts) : String(pts ?? "—");

    if (profileAvatar) {
      if (avatarUrl) {
        profileAvatar.textContent = "";
        profileAvatar.style.backgroundImage = `url("${avatarUrl.replaceAll('"', "")}")`;
        profileAvatar.style.backgroundSize = "cover";
        profileAvatar.style.backgroundPosition = "center";
      } else {
        profileAvatar.textContent = (username || "Z").slice(0, 1).toUpperCase();
      }
    }

    showErr("");
    return { ok: true, username, avatarUrl };
  } catch (e) {
    showErr("Nav ielogošanās (/me). Atver login/reģistrāciju un ielogojies.");
    if (nick) nick.value = "";
    if (profileName) profileName.textContent = "—";
    if (profilePts) profilePts.textContent = "—";
    if (profileAvatar) profileAvatar.textContent = "Z";
    return { ok: false, error: String(e?.message || e || "") };
  }
}

function roomRow(r) {
  const div = document.createElement("div");
  div.style.padding = "10px 12px";
  div.style.borderRadius = "14px";
  div.style.background = "rgba(0,0,0,0.18)";
  div.style.border = "1px solid rgba(255,255,255,0.12)";
  div.style.display = "flex";
  div.style.alignItems = "center";
  div.style.justifyContent = "space-between";
  div.style.gap = "10px";

  const left = document.createElement("div");
  left.innerHTML = `<div style="font-weight:900;">ROOM: ${String(r.roomId || "")}</div>
    <div style="opacity:0.85; font-size:13px;">Spēlētāji: ${String(r.playerCount ?? r.occupiedSeats ?? 0)}/3 • Phase: ${String(r.phase || "")}</div>`;

  const btn = document.createElement("button");
  btn.className = "zl-btn";
  btn.type = "button";
  btn.textContent = "Pievienoties";
  btn.addEventListener("click", () => {
    const roomId = qs("roomId");
    if (roomId) roomId.value = String(r.roomId || "");
    qs("btnJoin")?.click();
  });

  div.append(left, btn);
  return div;
}

async function refreshRooms() {
  const list = qs("roomsList");
  const empty = qs("roomsEmpty");
  if (!list || !empty) return;

  try {
    const res = await fetch("/rooms", { credentials: "include" });
    const data = await res.json();
    const rooms = Array.isArray(data?.rooms) ? data.rooms : [];
    list.replaceChildren(...rooms.map(roomRow));
    empty.style.display = rooms.length ? "none" : "block";
  } catch {
    list.replaceChildren();
    empty.style.display = "block";
  }
}

function top10Row(p) {
  const li = document.createElement("li");
  li.style.display = "flex";
  li.style.alignItems = "center";
  li.style.justifyContent = "space-between";
  li.style.gap = "10px";
  li.style.padding = "6px 0";
  const u = String(p?.username || "—");
  const pts = Number(p?.pts || 0);
  li.innerHTML = `<span style="font-weight:800;">${u}</span><span style="opacity:0.85;">${pts}</span>`;
  return li;
}

async function refreshTop10() {
  const list = qs("top10List");
  const empty = qs("top10Empty");
  if (!list || !empty) return;

  try {
    const res = await fetch("/leaderboard", { credentials: "include" });
    const data = await res.json();
    const top10 = Array.isArray(data?.top10) ? data.top10 : Array.isArray(data?.top) ? data.top : [];
    list.replaceChildren(...top10.map(top10Row));
    empty.style.display = top10.length ? "none" : "block";
  } catch {
    list.replaceChildren();
    empty.style.display = "block";
  }
}

function goToGame(roomId, seat) {
  try {
    sessionStorage.setItem("zole_roomId", String(roomId || ""));
    sessionStorage.setItem("zole_seat", String(seat ?? ""));
  } catch {}
  // Spēles pilnekrāna galds ir "/"
  window.location.href = "/";
}

(async function main() {
  const me = await loadMe();

  const btnRefreshRooms = qs("btnRefreshRooms");
  const btnRefreshTop10 = qs("btnRefreshTop10");
  btnRefreshRooms?.addEventListener("click", refreshRooms);
  btnRefreshTop10?.addEventListener("click", refreshTop10);

  await refreshRooms();
  await refreshTop10();

  let socket = null;
  try {
    socket = io();
    setConn(false);

    socket.on("connect", () => setConn(true));
    socket.on("disconnect", () => setConn(false));

    socket.on("rooms:update", () => refreshRooms());
    socket.on("leaderboard:update", () => refreshTop10());
    socket.emit("lobby:join");
  } catch {
    setConn(false);
  }

  const btnCreate = qs("btnCreate");
  const btnJoin = qs("btnJoin");

  function payloadCommon() {
    const username = String(qs("nick")?.value || "").trim();
    const avatarUrl = String(qs("avatarUrl")?.value || me.avatarUrl || "").trim();
    const roomId = String(qs("roomId")?.value || "").trim();
    const seed = seedGetOrMake();
    return { username, avatarUrl, roomId, seed };
  }

  btnCreate?.addEventListener("click", () => {
    showErr("");
    if (!socket) return showErr("Nav Socket.IO savienojuma.");
    socket.emit("room:create", payloadCommon(), (ack) => {
      if (!ack?.ok) return showErr(ack?.error || "CREATE_FAILED");
      goToGame(ack.roomId, ack.seat);
    });
  });

  btnJoin?.addEventListener("click", () => {
    showErr("");
    if (!socket) return showErr("Nav Socket.IO savienojuma.");
    socket.emit("room:join", payloadCommon(), (ack) => {
      if (!ack?.ok) return showErr(ack?.error || "JOIN_FAILED");
      goToGame(ack.roomId, ack.seat);
    });
  });
})();

