// server.js
// Bugats RPS – online, best of 3, ar animāciju, ar aizliegumu spēlēt pašam ar sevi
// + auto-round (ja otrs 7s laikā neizvēlas gājienu, serveris izvēlas viņam random)

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3001;

const clients = new Set();        // visi pieslēgtie
let waiting = null;               // viens gaidītājs rindā
const leaderboard = new Map();    // id -> {id,name,score}
const matches = new Map();        // matchId -> { ... }

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bugats RPS serveris strādā.");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2, 9);
  ws.name = "Spēlētājs";
  ws.matchId = null;

  clients.add(ws);
  broadcastOnline();

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      return;
    }

    // klients pasaka kas viņš ir
    if (data.type === "hello") {
      if (data.id) ws.id = data.id;
      if (data.name) ws.name = sanitizeName(data.name);

      // ieliekam TOPā, ja nav
      addToLeaderboard(ws.id, ws.name, getScore(ws.id));

      // uzreiz atjaunojam, lai frontā rāda Online: 1
      broadcastOnline();
      broadcastLeaderboard();

      findMatch(ws);
    }

    // klients maina niku
    if (data.type === "setName") {
      ws.name = sanitizeName(data.name || "Spēlētājs");
      addToLeaderboard(ws.id, ws.name, getScore(ws.id));
      broadcastLeaderboard();
    }

    // klients nospieda gājienu
    if (data.type === "move") {
      handleMove(ws, data.move);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    if (waiting && waiting === ws) {
      waiting = null;
    }
    broadcastOnline();
  });
});

// =================== MAČA LOĢIKA ===================

function findMatch(ws) {
  if (waiting && waiting !== ws) {
    // NEĻAUJ spēlēt pret sevi (tas pats id vai tas pats niks)
    if (
      waiting.id === ws.id ||
      (waiting.name && ws.name && waiting.name.toLowerCase() === ws.name.toLowerCase())
    ) {
      send(ws, { type: "blockedSelf" });
      return;
    }

    const matchId = Math.random().toString(36).slice(2, 9);
    const match = {
      id: matchId,
      p1: waiting,
      p2: ws,
      p1move: null,
      p2move: null,
      p1score: 0,
      p2score: 0,
      roundTimer: null
    };
    matches.set(matchId, match);
    waiting.matchId = matchId;
    ws.matchId = matchId;

    const payload = {
      type: "matchStart",
      p1: { id: match.p1.id, name: match.p1.name, score: match.p1score },
      p2: { id: match.p2.id, name: match.p2.name, score: match.p2score }
    };
    send(match.p1, payload);
    send(match.p2, payload);

    waiting = null;
  } else {
    // nav oponenta – ieliekam rindā
    waiting = ws;
  }
}

function handleMove(ws, move) {
  const matchId = ws.matchId;
  if (!matchId) return;
  const match = matches.get(matchId);
  if (!match) return;

  // saglabā gājienu
  if (match.p1 === ws) {
    if (match.p1move) return; // jau nospiedis
    match.p1move = move;
  } else if (match.p2 === ws) {
    if (match.p2move) return;
    match.p2move = move;
  }

  // ja tas ir PIRMĀS puses gājiens → ieliekam 7s timeri,
  // lai otrs, ja neuzspiež, saņem random
  if (!match.roundTimer && (match.p1move || match.p2move)) {
    match.roundTimer = setTimeout(() => {
      forceFinishRound(match);
    }, 7000); // 7 sekundes
  }

  // ja abi ir nospieduši, var uzreiz pabeigt
  if (match.p1move && match.p2move) {
    finishRound(match);
  }
}

// ja viens nospieda, otrs – nē → šis piespiež raundu
function forceFinishRound(match) {
  match.roundTimer = null;
  if (!match.p1move) match.p1move = randomMove();
  if (!match.p2move) match.p2move = randomMove();
  finishRound(match);
}

function finishRound(match) {
  // ja bija timers – izslēdzam
  if (match.roundTimer) {
    clearTimeout(match.roundTimer);
    match.roundTimer = null;
  }

  // 1) vispirms parādām ❔ (lai frontam ir animācijas sākums)
  broadcastToMatch(match, { type: "rps-show" });

  // 2) pēc nelielas pauzes – atklājam abus
  setTimeout(() => {
    const result = resolveRPS(match.p1move, match.p2move);
    let winnerName = null;

    if (result === 1) {
      match.p1score++;
      winnerName = match.p1.name;
    } else if (result === 2) {
      match.p2score++;
      winnerName = match.p2.name;
    }

    broadcastToMatch(match, {
      type: "rps-reveal",
      p1: { name: match.p1.name, move: match.p1move, score: match.p1score },
      p2: { name: match.p2.name, move: match.p2move, score: match.p2score },
      winner: winnerName
    });

    // sagatavojam nākamo raundu
    match.p1move = null;
    match.p2move = null;

    // best of 3
    if (match.p1score >= 2 || match.p2score >= 2) {
      const finalWinner = match.p1score > match.p2score ? match.p1 : match.p2;

      // +3 punkti uz TOP
      addToLeaderboard(
        finalWinner.id,
        finalWinner.name,
        getScore(finalWinner.id) + 3
      );

      broadcastToMatch(match, {
        type: "matchEnd",
        winner: finalWinner.name,
        p1: match.p1.name,
        p2: match.p2.name,
        p1score: match.p1score,
        p2score: match.p2score
      });

      // notīram
      match.p1.matchId = null;
      match.p2.matchId = null;
      matches.delete(match.id);

      // izsūtam atjaunināto TOP
      broadcastLeaderboard();

      // abus liekam atpakaļ rindā, lai var turpināt
      findMatch(match.p1);
      findMatch(match.p2);
    }
  }, 900);
}

// =================== PALĪGFUNKCIJAS ===================

function randomMove() {
  const arr = ["rock", "paper", "scissors"];
  return arr[Math.floor(Math.random() * arr.length)];
}

function broadcastToMatch(match, obj) {
  send(match.p1, obj);
  send(match.p2, obj);
}

function resolveRPS(m1, m2) {
  if (m1 === m2) return 0;
  if (m1 === "rock" && m2 === "scissors") return 1;
  if (m1 === "scissors" && m2 === "paper") return 1;
  if (m1 === "paper" && m2 === "rock") return 1;
  return 2;
}

function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const str = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(str);
  }
}

function broadcastOnline() {
  broadcast({ type: "online", count: clients.size });
}

function addToLeaderboard(id, name, score) {
  leaderboard.set(id, { id, name, score });
}

function getScore(id) {
  const r = leaderboard.get(id);
  return r ? r.score : 0;
}

function broadcastLeaderboard() {
  const list = Array.from(leaderboard.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  broadcast({ type: "leaderboard", list });
}

function sanitizeName(n) {
  return (n || "Spēlētājs")
    .toString()
    .replace(/https?:\/\//g, "")
    .replace(/[\n\r\t]+/g, " ")
    .slice(0, 20);
}

server.listen(PORT, () => {
  console.log("RPS serveris klausās uz porta", PORT);
});
