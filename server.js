// server.js
// Bugats RPS – ar 3 room, best of 3, auto-round, pēdējā partija,
// raunda paziņojumi, AFK auto-kick un pretinieka-aiziešanas paziņojumu

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3001;

const clients = new Set();

// gaidītāji pa istabām
const waiting = {
  "1": null,
  "2": null,
  "3": null
};

// aktīvie mači
const matches = new Map();

// TOP tabula
const leaderboard = new Map();

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bugats RPS serveris strādā.");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2, 9);
  ws.name = "Spēlētājs";
  ws.room = "1";
  ws.matchId = null;
  ws.leaveAfterMatch = false;
  ws.afkStrikes = 0; // cik reizes pēc kārtas serveris viņam ielicis random

  clients.add(ws);
  broadcastOnline();

  ws.on("message", (message) => {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }

    switch (data.type) {
      case "hello": {
        if (data.id) ws.id = data.id;
        if (data.name) ws.name = sanitizeName(data.name);
        if (data.room && ["1","2","3"].includes(String(data.room))) {
          ws.room = String(data.room);
        }

        addToLeaderboard(ws.id, ws.name, getScore(ws.id));
        broadcastOnline();
        broadcastLeaderboard();
        findMatch(ws);
        break;
      }

      case "setName": {
        ws.name = sanitizeName(data.name || "Spēlētājs");
        addToLeaderboard(ws.id, ws.name, getScore(ws.id));
        broadcastLeaderboard();
        break;
      }

      case "move": {
        // viņš ir kustīgs – vairs nav AFK
        ws.afkStrikes = 0;
        handleMove(ws, data.move);
        break;
      }

      case "lastGame": {
        ws.leaveAfterMatch = true;
        send(ws, { type: "lastGameAck" });
        break;
      }

      case "changeRoom": {
        const newRoom = String(data.room || "1");
        if (!["1","2","3"].includes(newRoom)) return;

        // ja viņš ir mačā – neļaujam
        if (ws.matchId) {
          send(ws, { type: "error", message: "Nevar mainīt istabu mača laikā." });
          return;
        }

        // ja viņš bija rindā vecajā istabā – izņemam
        if (waiting[ws.room] === ws) {
          waiting[ws.room] = null;
        }

        ws.room = newRoom;
        ws.leaveAfterMatch = false;
        findMatch(ws);
        broadcastOnline();
        break;
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);

    // ja viņš bija rindā – noņemam
    if (waiting[ws.room] === ws) {
      waiting[ws.room] = null;
    }

    // ja viņš bija mačā – otram paziņojam
    if (ws.matchId) {
      const match = matches.get(ws.matchId);
      if (match) {
        const other = match.p1 === ws ? match.p2 : match.p1;
        send(other, { type: "opponentLeft" });
        other.matchId = null;
        matches.delete(match.id);

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

// =================== MAČU LOĢIKA ===================

function findMatch(ws) {
  const room = ws.room || "1";
  const waitingPlayer = waiting[room];

  if (waitingPlayer && waitingPlayer !== ws) {
    // neļaujam spēlēt pašam ar sevi
    if (
      waitingPlayer.id === ws.id ||
      (waitingPlayer.name && ws.name && waitingPlayer.name.toLowerCase() === ws.name.toLowerCase())
    ) {
      send(ws, { type: "blockedSelf" });
      return;
    }

    // izveidojam jaunu maču
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
      room
    };
    matches.set(matchId, match);

    waitingPlayer.matchId = matchId;
    ws.matchId = matchId;

    // paziņojam abiem
    const payload = {
      type: "matchStart",
      room,
      p1: { id: match.p1.id, name: match.p1.name, score: match.p1score },
      p2: { id: match.p2.id, name: match.p2.name, score: match.p2score }
    };
    send(match.p1, payload);
    send(match.p2, payload);

    // paziņojums, ka sācies pirmais raunds
    broadcastToMatch(match, { type: "roundStart" });

    // atbrīvojam vietu rindā
    waiting[room] = null;
  } else {
    waiting[room] = ws;
    send(ws, { type: "waiting", room });
  }
}

function handleMove(ws, move) {
  const matchId = ws.matchId;
  if (!matchId) return;
  const match = matches.get(matchId);
  if (!match) return;

  if (match.p1 === ws) {
    if (match.p1move) return;
    match.p1move = move;
  } else if (match.p2 === ws) {
    if (match.p2move) return;
    match.p2move = move;
  }

  // ja tas ir 1. gājiens – ieliekam 7s auto
  if (!match.roundTimer && (match.p1move || match.p2move)) {
    match.roundTimer = setTimeout(() => {
      forceFinishRound(match);
    }, 7000);
  }

  // ja abi jau nospieda -> pabeidzam
  if (match.p1move && match.p2move) {
    finishRound(match);
  }
}

function forceFinishRound(match) {
  match.roundTimer = null;

  // p1 neizdarīja -> serveris ieliek random -> AFK skaits
  if (!match.p1move) {
    match.p1move = randomMove();
    match.p1.afkStrikes = (match.p1.afkStrikes || 0) + 1;
    if (match.p1.afkStrikes >= 3) {
      kickForAfk(match.p1);
    }
  }

  // p2 neizdarīja
  if (!match.p2move) {
    match.p2move = randomMove();
    match.p2.afkStrikes = (match.p2.afkStrikes || 0) + 1;
    if (match.p2.afkStrikes >= 3) {
      kickForAfk(match.p2);
    }
  }

  finishRound(match);
}

function kickForAfk(ws) {
  send(ws, { type: "kicked", reason: "AFK 3x" });
  // aizvēršana aktivizēs on("close") un sakops maču
  ws.close();
}

function finishRound(match) {
  // noņemam timeri
  if (match.roundTimer) {
    clearTimeout(match.roundTimer);
    match.roundTimer = null;
  }

  // 1) dodam signālu animācijai
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

    // sagatavojamies nākamajam raundam
    match.p1move = null;
    match.p2move = null;

    // vai mačs ir pabeigts?
    if (match.p1score >= 2 || match.p2score >= 2) {
      const finalWinner = match.p1score > match.p2score ? match.p1 : match.p2;

      // +3 punkti TOP
      addToLeaderboard(finalWinner.id, finalWinner.name, getScore(finalWinner.id) + 3);

      broadcastToMatch(match, {
        type: "matchEnd",
        winner: finalWinner.name,
        p1: match.p1.name,
        p2: match.p2.name,
        p1score: match.p1score,
        p2score: match.p2score,
        countdown: 15
      });

      // notīram
      match.p1.matchId = null;
      match.p2.matchId = null;
      matches.delete(match.id);

      broadcastLeaderboard();

      // p1 atpakaļ rindā, ja nevēlējās iziet
      if (!match.p1.leaveAfterMatch) {
        findMatch(match.p1);
      } else {
        match.p1.leaveAfterMatch = false;
      }
      // p2
      if (!match.p2.leaveAfterMatch) {
        findMatch(match.p2);
      } else {
        match.p2.leaveAfterMatch = false;
      }

    } else {
      // mačs turpinās – sūtam, ka sācies nākamais raunds
      broadcastToMatch(match, { type: "roundStart" });
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
