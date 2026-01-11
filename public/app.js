/* global io */

function setConnBadge(text, ok) {
  const el = document.getElementById("connBadge");
  if (!el) return;
  el.textContent = text;
  el.style.background = ok ? "rgba(50, 220, 140, 0.16)" : "rgba(255, 90, 90, 0.16)";
  el.style.borderColor = ok ? "rgba(50, 220, 140, 0.28)" : "rgba(255, 90, 90, 0.28)";
}

try {
  const socket = io();

  setConnBadge("Savienojas…", false);

  socket.on("connect", () => setConnBadge("Savienots", true));
  socket.on("disconnect", () => setConnBadge("Nav savienojuma", false));
  socket.on("connect_error", () => setConnBadge("Kļūda savienojumā", false));
} catch {
  setConnBadge("Nav Socket.IO klienta", false);
}

