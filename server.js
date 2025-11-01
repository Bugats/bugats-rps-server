// server.js
// Bugats RPS – online, best of 3, ar animāciju, ar aizliegumu spēlēt pašam ar sevi

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3001;

// visi pieslēgtie klienti
const clients = new Set();

// gaidītāji rindā
let waiting = null;

// rezultāti TOPam (RAM, 24h pietiks)
const leaderboard = new Map();
// struktūra: id -> {id, name, score}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bugats RPS serveris strādā.");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  ws.id = Math.random().toString(36).slice(2,9);
  ws.name = "Spēlētājs";
  ws.isAlive = true;
  ws.matchId = null;

  clients.add(ws);
  broadcastOnline();

  ws.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch(e) { return; }

    if (data.type === "hello") {
      if (data.id) ws.id = data.id;
      if (data.name) ws.name = sanitizeName(data.name);
      addToLeaderboard(ws.id, ws.name, 0);
      findMatch(ws);
    }

    if (data.type === "setName") {
      ws.name = sanitizeName(data.name || "Spēlētājs");
      addToLeaderboard(ws.id, ws.name, getScore(ws.id));
      broadcastLeaderboard();
    }

    if (data.type === "move") {
      handleMove(ws, data.move);
    }

    if (data.type === "ping") {
      ws.isAlive = true;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    // ja viņš bija rindā, iztīram
    if (waiting && waiting === ws) {
      waiting = null;
    }
    // ja viņš bija mačā, varētu paziņot otram
    broadcastOnline();
  });
});

// maču glabāšana
const matches = new Map(); // matchId -> {p1, p2, p1move, p2move, p1score, p2score}

function findMatch(ws) {
  // ja jau ir gaidītājs
  if (waiting && waiting !== ws) {
    // NEĻAUJ spēlēt pret sevi (niks vai id vienādi)
    if (waiting.name.toLowerCase() === ws.name.toLowerCase() || waiting.id === ws.id) {
      // pirmais spēlētājs paliek gaidītājs, otram sakām gaidīt citu
      send(ws, { type: "blockedSelf" });
      return;
    }

    // izveidojam maču
    const matchId = Math.random().toString(36).slice(2,9);
    const match = {
      id: matchId,
      p1: waiting,
      p2: ws,
      p1move: null,
      p2move: null,
      p1score: 0,
      p2score: 0
    };
    matches.set(matchId, match);
    waiting.matchId = matchId;
    ws.matchId = matchId;

    // paziņojam abiem
    const payload = {
      type: "matchStart",
      p1: { id: match.p1.id, name: match.p1.name, score: match.p1score },
      p2: { id: match.p2.id, name: match.p2.name, score: match.p2score },
    };
    send(match.p1, payload);
    send(match.p2, payload);

    waiting = null;
  } else {
    // nav gaidītāja, šis kļūst par gaidītāju
    waiting = ws;
  }
}

function handleMove(ws, move) {
  const matchId = ws.matchId;
  if (!matchId) return;
  const match = matches.get(matchId);
  if (!match) return;

  // uzstādām gājienu
  if (match.p1 === ws) {
    if (match.p1move) return; // jau nospieda
    match.p1move = move;
  } else if (match.p2 === ws) {
    if (match.p2move) return;
    match.p2move = move;
  }

  // ja abi jau izvēlējušies → izrēķinam
  if (match.p1move && match.p2move) {
    // vispirms parādām visiem (abiem) ka parāda kārtis (animācijas starts)
    broadcastToMatch(match, { type: "rps-show" });

    setTimeout(() => {
      const result = resolveRPS(match.p1move, match.p2move);
      let winnerName = null;

      if (result === 1) { // p1 uzvar
        match.p1score++;
        winnerName = match.p1.name;
      } else if (result === 2) { // p2 uzvar
        match.p2score++;
        winnerName = match.p2.name;
      }

      // sūtam atklāšanu
      broadcastToMatch(match, {
        type: "rps-reveal",
        p1: { name: match.p1.name, move: match.p1move, score: match.p1score },
        p2: { name: match.p2.name, move: match.p2move, score: match.p2score },
        winner: winnerName
      });

      // pārliekam uz nākamo raundu
      match.p1move = null;
      match.p2move = null;

      // best of 3 (pirmais līdz 2)
      if (match.p1score >= 2 || match.p2score >= 2) {
        // mačs beidzies
        const finalWinner = match.p1score > match.p2score ? match.p1 : match.p2;
        // piešķiram punktus TOP
        addToLeaderboard(finalWinner.id, finalWinner.name, getScore(finalWinner.id) + 3);

        broadcastToMatch(match, {
          type: "matchEnd",
          winner: finalWinner.name,
          p1: match.p1.name,
          p2: match.p2.name,
          p1score: match.p1score,
          p2score: match.p2score
        });

        // izmetam maču
        match.p1.matchId = null;
        match.p2.matchId = null;
        matches.delete(match.id);

        broadcastLeaderboard();

        // liksim abus atpakaļ rindā
        findMatch(match.p1);
        findMatch(match.p2);
      } else {
        // turpinām maču, abi atkal var izvēlēties
        // šeit var nosūtīt "tu vari spēlēt tālāk"
        // lai klients atbloķē pogas
      }
    }, 900); // animācijas pauze
  }
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
    if (c.readyState === WebSocket.OPEN) {
      c.send(str);
    }
  }
}

function broadcastOnline() {
  broadcast({ type: "online", count: clients.size });
}

function addToLeaderboard(id, name, score) {
  leaderboard.set(id, { id, name, score });
}

function getScore(id) {
  const row = leaderboard.get(id);
  return row ? row.score : 0;
}

function broadcastLeaderboard() {
  const list = Array.from(leaderboard.values())
    .sort((a,b) => b.score - a.score)
    .slice(0, 12);
  broadcast({
    type: "leaderboard",
    list
  });
}

function sanitizeName(n) {
  return (n || "Spēlētājs").toString()
    .replace(/https?:\/\//g, "")
    .replace(/[\n\r\t]+/g, " ")
    .slice(0, 20);
}

server.listen(PORT, () => {
  console.log("RPS serveris klausās uz porta", PORT);
});
