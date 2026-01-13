// auth.js?v=37
"use strict";

const API_BASE = "https://thezone-zole-server.onrender.com";

// Saderība ar dažādām app.js versijām (daļa lieto zole_nick, daļa zole_username)
const LS_USER_A = "zole_nick";
const LS_USER_B = "zole_username";
const LS_AVATAR = "zole_avatarUrl";
const LS_SEED = "zole_seed";
const LS_PTS = "zole_pts"; // ja gribi rādīt PTS lobby
const $ = (id) => document.getElementById(id);

const elUser = $("au_user");
const elPass = $("au_pass");
const wrapPass2 = $("au_pass2_wrap");
const elPass2 = $("au_pass2");
const wrapAvatar = $("au_avatar_wrap");
const elAvatar = $("au_avatar");

const btnLogin = $("btnLogin");
const btnToggle = $("btnToggle");
const hint = $("au_hint");
const err = $("au_err");

let mode = "login"; // "login" | "signup"

const qs = new URLSearchParams(location.search);
const isSwitch = qs.get("switch") === "1"; // nāk no Lobby “Atpakaļ/Mainīt profilu”

function showErr(msg) {
  err.style.display = "block";
  err.textContent = msg;
}
function clearErr() {
  err.style.display = "none";
  err.textContent = "";
}

function mapErr(e) {
  switch (String(e || "")) {
    case "NICK_REQUIRED": return "Ievadi lietotājvārdu.";
    case "PASS_TOO_SHORT": return "Parole par īsu (min 4).";
    case "USER_EXISTS": return "Lietotājs jau eksistē.";
    case "BAD_LOGIN": return "Nepareizs lietotājvārds vai parole.";
    case "TOKEN_EXPIRED": return "Sesija beigusies. Ie-logojies vēlreiz.";
    default: return `Kļūda: ${e || "UNKNOWN"}`;
  }
}

function cryptoSeed() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function setMode(m) {
  mode = m;
  clearErr();

  const isSignup = mode === "signup";
  wrapPass2.style.display = isSignup ? "" : "none";
  wrapAvatar.style.display = isSignup ? "" : "none";

  btnLogin.textContent = isSignup ? "Reģistrēties" : "Pierakstīties";
  btnToggle.textContent = isSignup ? "Atpakaļ" : "Reģistrēties";

  hint.textContent = isSignup
    ? "Izveido kontu: ievadi lietotājvārdu, paroli (2x) un (ja gribi) avatāra URL."
    : "Pieraksties ar lietotājvārdu un paroli.";
}

btnToggle.addEventListener("click", () => {
  setMode(mode === "login" ? "signup" : "login");
});

function saveProfile({ username, avatarUrl, pts }) {
  const u = String(username || "").trim();
  const av = String(avatarUrl || "").trim();

  if (u) {
    localStorage.setItem(LS_USER_A, u);
    localStorage.setItem(LS_USER_B, u);
  }
  localStorage.setItem(LS_AVATAR, av);

  if (typeof pts === "number" && Number.isFinite(pts)) {
    localStorage.setItem(LS_PTS, String(pts));
  }

  if (!localStorage.getItem(LS_SEED)) {
    localStorage.setItem(LS_SEED, cryptoSeed());
  }
}

function clearLocalProfile() {
  localStorage.removeItem(LS_USER_A);
  localStorage.removeItem(LS_USER_B);
  localStorage.removeItem(LS_AVATAR);
  localStorage.removeItem(LS_PTS);
   localStorage.removeItem("zole_token");
  // seed vari atstāt, bet “switch” režīmā vari arī notīrīt, ja gribi:
  // localStorage.removeItem(LS_SEED);
}

async function doAuth() {
  clearErr();

  const username = String(elUser.value || "").trim();
  const password = String(elPass.value || "");
  const password2 = String(elPass2?.value || "");
  const avatarUrl = String(elAvatar?.value || "").trim();

  if (!username) return showErr("Ievadi lietotājvārdu.");
  if (password.length < 4) return showErr("Parolei jābūt vismaz 4 simboli.");

  if (mode === "signup") {
    if (password !== password2) return showErr("Paroles nesakrīt.");
  }

  btnLogin.disabled = true;
  btnToggle.disabled = true;

  try {
    const endpoint = mode === "signup" ? "signup" : "login";
    const r = await fetch(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify({ username, password, avatarUrl }),
    });

    const data = await r.json().catch(() => null);

    if (!r.ok || !data?.ok) {
      return showErr(mapErr(data?.error || `HTTP_${r.status}`));
    }
    
    localStorage.setItem("zole_token", data.token || "");

    const user = data.user || {};
    const pts = Number(user.pts ?? user.matchPts ?? user.points ?? 0) || 0;

    saveProfile({
      username: user.username || username,
      avatarUrl: user.avatarUrl || avatarUrl || "",
      pts,
    });

    // svarīgi: replace, lai nerodas “back bounce”
    location.replace(`./index.html?ts=${Date.now()}`);
  } catch (_e) {
    showErr("Neizdevās pieslēgties serverim (pārbaudi internet/saiti).");
  } finally {
    btnLogin.disabled = false;
    btnToggle.disabled = false;
  }
}

btnLogin.addEventListener("click", doAuth);

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doAuth();
});

/**
 * AUTO-REDIRECT uz lobby tikai tad, ja NAV switch=1.
 * switch=1 nozīmē: lietotājs spieda “Atpakaļ/Mainīt profilu” un grib palikt auth lapā.
 */
(async () => {
  if (isSwitch) {
    // drošībai: notīra lokālos datus un (ja vajag) arī cookie sesiju
    try { clearLocalProfile(); } catch {}
    try {
      await fetch(`${API_BASE}/logout`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
    } catch {}
    return;
  }

  // Ja jau ir cookie sesija, /me būs OK -> pārsūtam uz lobby bez mirgošanas
  try {
    const r = await fetch(`${API_BASE}/me`, {
      credentials: "include",
      cache: "no-store",
    });
    const d = await r.json().catch(() => null);

    if (r.ok && d?.ok && d.username) {
      saveProfile({
        username: d.username,
        avatarUrl: d.avatarUrl || "",
        pts: Number(d.pts ?? d.matchPts ?? 0) || 0,
      });
      location.replace(`./index.html?ts=${Date.now()}`);
    }
  } catch {
    // paliekam auth lapā
  }
})();

// default UI
setMode("login");
