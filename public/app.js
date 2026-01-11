/* global io */

function setConnBadge(text, ok) {
  const el = document.getElementById("connBadge");
  if (!el) return;
  el.textContent = text;
  el.style.background = ok ? "rgba(50, 220, 140, 0.16)" : "rgba(255, 90, 90, 0.16)";
  el.style.borderColor = ok ? "rgba(50, 220, 140, 0.28)" : "rgba(255, 90, 90, 0.28)";
}

function cardEl(label, isBack) {
  const el = document.createElement("div");
  el.className = `card${isBack ? " card--back" : ""}`;
  el.textContent = isBack ? "🂠" : String(label || "");
  return el;
}

function renderDemoLayout() {
  const handBottom = document.getElementById("handBottom");
  const handTop = document.getElementById("handTop");
  const handLeft = document.getElementById("handLeft");
  const handRight = document.getElementById("handRight");
  const trick = document.getElementById("trick");
  const talon = document.getElementById("talon");
  const discard = document.getElementById("discard");

  if (!handBottom || !handTop || !handLeft || !handRight || !trick || !talon || !discard) return;

  handBottom.replaceChildren(
    cardEl("A♣"),
    cardEl("K♠"),
    cardEl("Q♦"),
    cardEl("J♥"),
    cardEl("10♦"),
    cardEl("9♣"),
    cardEl("8♦"),
    cardEl("7♦")
  );

  handTop.replaceChildren(
    cardEl("", true),
    cardEl("", true),
    cardEl("", true),
    cardEl("", true),
    cardEl("", true),
    cardEl("", true),
    cardEl("", true),
    cardEl("", true)
  );

  handLeft.replaceChildren(cardEl("", true), cardEl("", true), cardEl("", true), cardEl("", true));
  handRight.replaceChildren(cardEl("", true), cardEl("", true), cardEl("", true), cardEl("", true));

  trick.replaceChildren(cardEl("Q♣"), cardEl("J♦"), cardEl("A♦"));

  talon.replaceChildren(cardEl("", true), cardEl("", true));
  discard.replaceChildren();
}

renderDemoLayout();

try {
  const socket = io();

  setConnBadge("Savienojas…", false);

  socket.on("connect", () => setConnBadge("Savienots", true));
  socket.on("disconnect", () => setConnBadge("Nav savienojuma", false));
  socket.on("connect_error", () => setConnBadge("Kļūda savienojumā", false));
} catch {
  setConnBadge("Nav Socket.IO klienta", false);
}

