// server.js
// Bugats RPS (Akmens · Šķēres · Papīrīts)
// Funkcijas:
// - max 3 rooms, spēlētājs izvēlas kuru
// - best of 3 (pirmais līdz 2 uzvarām)
// - auto-round: ja otrs 7s nenospiež, serveris izvēlas random
// - "pēdējā partija" – pēc šī mača vairs neliek rindā
// - aizliegts spēlēt pašam ar sevi (pēc id + nika)
// - online skaits + pa istabām
// - ja pretinieks aiziet mača laikā → otram paziņojums

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3001;

// visi pieslēgtie
const clients = new Set();

// gaidītāji pa istabām
const waiting = {
  "1": null,
  "2": null,
  "3": null
};

// aktīvie mači
const matches = new Map();

// TOP
const leaderboard = new Map();

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bugats RPS serveris strādā.");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  // sākotnējie dati
  ws.id = Math.random().toString(36).slice(2, 9);
  ws.name = "Spēlētājs";
  ws.room = "1";              // pēc noklusējuma 1. room
  ws.matchId = null;
  ws.leaveAfterMatch = false; // “pēdējā partija” vēl ne

  clients.add(ws);
  broadcastOnline();

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return;
    }

    // GALVENAIS SWITCH
    switch (data.type) {
      case "hello": {
        if (data.id) ws.id = data.id;
        if (data.name) ws.name = sanitizeName(data.name);
        if (data.room && ["1","2","3"].includes(data.room+"")) {
          ws.room = data.room + "";
        }

        // ieliekam TOPā ja nav
        addToLeaderboard(ws.id, ws.name, getScore(ws.id));

        broadcastOnline();
        broadcastLeaderboard();

        // mēģinām atrast pretinieku TAJĀ ISTABĀ
        findMatch(ws);
        break;
      }

      case "setName": {
        ws.name = sanitizeName(data.name || "Spēlētājs");
        addToLeaderboard(ws.id, ws.name, getScore(ws.id));
        broadcastLeaderboard();
        // lai neatstāj mapē veco vārdu
        break;
      }

      case "move": {
        handleMove(ws, data.move);
        break;
      }

      case "lastGame": {
        // spēlētājs saka: pēc šī mača nevajag vairs
        ws.leaveAfterMatch = true;
        send(ws, { type: "lastGameAck" });
        break;
      }

      case "changeRoom": {
        const newRoom = (data.room || "1") + "";
        if (!["1","2","3"].includes(newRoom)) return;

        // ja viņš šobrīd ir mačā – nedrīkst mainīt room
        if (ws.matchId) {
          send(ws, { type: "error", message: "Nevar mainīt istabu mača laikā." });
          return;
        }

        // ja viņš bija gaidītājs vecajā room -> noņemam
        if (waiting[ws.room] === ws) {
          waiting[ws.room] = null;
        }

        ws.room = newRoom;
        ws.leaveAfterMatch = false; // ja maina room – sākam no jauna
        findMatch(ws);
        broadcastOnline();
        break;
      }
    }
  });

  ws.on("close", () => {
    // izmetam no kopējā saraksta
    clients.delete(ws);

    // ja viņš bija gaidītājs savā room → noņemam
    if (waiting[ws.room] === ws) {
      waiting[ws.room] = null;
    }

    // ja viņš bija mačā → otram paziņojam
    if (ws.matchId) {
      const match = matches.get(ws.matchId);
      if (match) {
        const other = match.p1 === ws ? match.p2 : match.p1;
        send(other, { type: "opponentLeft" });
        other.matchId = null;
        matches.delete(match.id);

        // ja otrs NEBIJA nospiedis "pēdējā partija" → liekam atpakaļ rindā
        if (!other.leaveAfterMatch) {
          findMatch(other);
        } else {
          other.leaveAfterMatch = false;
        }
      }
    }

    broadcastOnline();
  });
});

// ======================== FUNKCIJAS ========================

// atrod pretinieku tajā pašā room
function findMatch(ws) {
  const room = ws.room || "1";
  const waitingPlayer = waiting[room];

  if (waitingPlayer && waitingPlayer !== ws) {
    // aizliegums spēlēt ar sevi
    if (
      waitingPlayer.id === ws.id ||
      (waitingPlayer.name && ws.name && waitingPlayer.name.toLowerCase() === ws.name.toLowerCase())
    ) {
      // šim sakām lai pagaida citu
      send(ws, { type: "blockedSelf" });
      return;
    }

    // izveidojam maču
    const matchId = Math.random().toString(36).slice(2, 9);
    const match = {
      id: matchId,
      p1: waitingPlayer,
      p2: ws,
      p1move: null,
      p2move: null,
      p1score: 0,
      p2score: 0,
      roundTimer: null,
      room: room
    };
    matches.set(matchId, match);

    waitingPlayer.matchId = matchId;
    ws.matchId = matchId;

    // paziņojam abiem
    const payload = {
      type: "matchStart",
      room: room,
      p1: { id: match.p1.id, name: match.p1.name, score: match.p1score },
      p2: { id: match.p2.id, name: match.p2.name, score: match.p2score }
    };
    send(match.p1, payload);
    send(match.p2, payload);

    // šajā room vairs neviens negaida
    waiting[room] = null;
  } else {
    // nav otra – ieliekam rindā
    waiting[room] = ws;
    send(ws, { type: "waiting", room });
  }
}

function handleMove(ws, move) {
  const matchId = ws.matchId;
  if (!matchId) return;

  const match = matches.get(matchId);
  if (!match) return;

  // iereģistrējam gājienu
  if (match.p1 === ws) {
    if (match.p1move) return;
    match.p1move = move;
  } else if (match.p2 === ws) {
    if (match.p2move) return;
    match.p2move = move;
  }

  // ja tas ir pirmais gājiens šajā raundā – ieliekam 7s auto
  if (!match.roundTimer && (match.p1move || match.p2move)) {
    match.roundTimer = setTimeout(() => {
      forceFinishRound(match);
    }, 7000);
  }

  // ja abi jau ir izdarījuši gājienu → var pabeigt
  if (match.p1move && match.p2move) {
    finishRound(match);
  }
}

// ja viens neizdara gājienu – serveris ieliek random
function forceFinishRound(match) {
  match.roundTimer = null;
  if (!match.p1move) match.p1move = randomMove();
  if (!match.p2move) match.p2move = randomMove();
  finishRound(match);
}

function finishRound(match) {
  // iztīram timeri
  if (match.roundTimer) {
    clearTimeout(match.roundTimer);
    match.roundTimer = null;
  }

  // 1) parādam “show” lai frontends var taisīt anim
  broadcastToMatch(match, { type: "rps-show" });

  // 2) pēc mazas pauzes atklājam
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

    // nākamajam raundam
    match.p1move = null;
    match.p2move = null;

    // best of 3
    if (match.p1score >= 2 || match.p2score >= 2) {
      const finalWinner = match.p1score > match.p2score ? match.p1 : match.p2;

      // +3 TOPā (vari mierīgi nomainīt uz +1)
      addToLeaderboard(finalWinner.id, finalWinner.name, getScore(finalWinner.id) + 3);

      broadcastToMatch(match, {
        type: "matchEnd",
        winner: finalWinner.name,
        p1: match.p1.name,
        p2: match.p2.name,
        p1score: match.p1score,
        p2score: match.p2score
      });

      // noņemam maču
      match.p1.matchId = null;
      match.p2.matchId = null;
      matches.delete(match.id);

      broadcastLeaderboard();

      // p1 atpakaļ rindā?
      if (!match.p1.leaveAfterMatch) {
        findMatch(match.p1);
      } else {
        match.p1.leaveAfterMatch = false;
      }

      // p2 atpakaļ rindā?
      if (!match.p2.leaveAfterMatch) {
        findMatch(match.p2);
      } else {
        match.p2.leaveAfterMatch = false;
      }

    }
  }, 900);
}

function randomMove() {
  const arr = ["rock", "paper", "scissors"];
  return arr[Math.floor(Math.random() * arr.length)];
}

function broadcastToMatch(match, obj) {
  send(match.p1, obj);
  send(match.p2, obj);
}

// ======================== UTIL ========================

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
  const perRoom = { "1": 0, "2": 0, "3": 0 };
  for (const c of clients) {
    const r = c.room || "1";
    if (perRoom[r] != null) perRoom[r]++;
  }
  broadcast({
    type: "online",
    total: clients.size,
    rooms: perRoom
  });
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
