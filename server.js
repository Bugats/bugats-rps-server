// server.js
// Bugats RPS — 3 rooms, best of 3, READY sistēma,
// 10s sagatavošanās + 15s raunds, pēdējā partija paziņojums pretiniekam,
// avataru sūtīšana caur WS, AFK auto-kick

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3001;

const clients = new Set();

// rindas pa istabām
const waiting = {
  "1": null,
  "2": null,
  "3": null,
};

// aktīvie mači
const matches = new Map();

// top tabula
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
  ws.afkStrikes = 0;
  ws.avatar = null; // te glabāsim dataURL

  clients.add(ws);
  broadcastOnline();

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    switch (data.type) {
      case "hello": {
        if (data.id) ws.id = data.id;
        if (data.name) ws.name = sanitizeName(data.name);
        if (data.room && ["1","2","3"].includes(String(data.room))) {
          ws.room = String(data.room);
        }
        if (data.avatar) {
          // nelielu ierobežojumu uzliekam
          if (typeof data.avatar === "string" && data.avatar.length < 200000) {
            ws.avatar = data.avatar;
          }
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

      case "avatarUpload": {
        if (typeof data.avatar === "string" && data.avatar.startsWith("data:image/") && data.avatar.length < 200000) {
          ws.avatar = data.avatar;
          // ja viņš ir mačā – paziņojam otram
          if (ws.matchId) {
            const match = matches.get(ws.matchId);
            if (match) {
              const other = match.p1 === ws ? match.p2 : match.p1;
              send(other, { type: "opponentAvatar", avatar: ws.avatar });
            }
          }
        }
        break;
      }

      case "ready": {
        if (!ws.matchId) return;
        const match = matches.get(ws.matchId);
        if (!match) return;
        if (match.p1 === ws) match.p1ready = true;
        if (match.p2 === ws) match.p2ready = true;

        // paziņo abiem, kurš gatavs
        broadcastToMatch(match, {
          type: "readyState",
          p1ready: match.p1ready,
          p2ready: match.p2ready
        });

        // ja abi gatavi -> startējam sagatavošanās 10s
        if (match.p1ready && match.p2ready) {
          startRoundWithCountdown(match);
        }
        break;
      }

      case "move": {
        ws.afkStrikes = 0;
        handleMove(ws, data.move);
        break;
      }

      case "lastGame": {
        ws.leaveAfterMatch = true;
        send(ws, { type: "lastGameAck" });

        // ja viņš ir mačā – paziņojam otram
        if (ws.matchId) {
          const match = matches.get(ws.matchId);
          if (match) {
            const other = match.p1 === ws ? match.p2 : match.p1;
            send(other, { type: "opponentLastGame", name: ws.name });
          }
        }
        break;
      }

      case "changeRoom": {
        const newRoom = String(data.room || "1");
        if (!["1","2","3"].includes(newRoom)) return;

        // ja mačā – nelaižam
        if (ws.matchId) {
          send(ws, { type: "error", message: "Nevar mainīt istabu mača laikā." });
          return;
        }

        // ja rindā – izņemam
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

    if (waiting[ws.room] === ws) {
      waiting[ws.room] = null;
    }

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

// ================= LOĢIKA =================

function findMatch(ws) {
  const room = ws.room || "1";
  const w = waiting[room];

  if (w && w !== ws) {
    // neļaujam spēlēt pašam ar sevi
    if (
      w.id === ws.id ||
      (w.name && ws.name && w.name.toLowerCase() === ws.name.toLowerCase())
    ) {
      send(ws, { type: "blockedSelf" });
      return;
    }

    const matchId = Math.random().toString(36).slice(2, 9);
    const match = {
      id: matchId,
      room,
      p1: w,
      p2: ws,
      p1move: null,
      p2move: null,
      p1score: 0,
      p2score: 0,
      p1ready: false,
      p2ready: false,
      roundTimer: null,
      prepTimer: null,
    };
    matches.set(matchId, match);

    w.matchId = matchId;
    ws.matchId = matchId;

    // sūtam abiem: mačs izveidots, bet jāspiež "gatavs"
    const payload = {
      type: "matchStart",
      needReady: true,
      room,
      p1: { id: match.p1.id, name: match.p1.name, score: match.p1score, avatar: match.p1.avatar || null },
      p2: { id: match.p2.id, name: match.p2.name, score: match.p2score, avatar: match.p2.avatar || null },
    };
    send(match.p1, payload);
    send(match.p2, payload);

    waiting[room] = null;
  } else {
    waiting[room] = ws;
    send(ws, { type: "waiting", room });
  }
}

function startRoundWithCountdown(match) {
  // vispirms 10 sek sagatavošanās
  broadcastToMatch(match, { type: "roundPrepare", in: 10 });
  // ja bija kāds vecs timers – noņemam
  if (match.prepTimer) clearTimeout(match.prepTimer);
  match.prepTimer = setTimeout(() => {
    startRealRound(match);
  }, 10000);
}

function startRealRound(match) {
  match.prepTimer = null;
  match.p1move = null;
  match.p2move = null;

  broadcastToMatch(match, { type: "roundStart", duration: 15 });

  // 15 sek raunda laiks
  if (match.roundTimer) clearTimeout(match.roundTimer);
  match.roundTimer = setTimeout(() => {
    forceFinishRound(match);
  }, 15000);
}

function handleMove(ws, move) {
  const matchId = ws.matchId;
  if (!matchId) return;
  const match = matches.get(matchId);
  if (!match) return;

  // ja raunds vēl nav sācies (gatavošanās fāze) – ignorējam
  if (match.prepTimer) return;

  if (match.p1 === ws) {
    if (match.p1move) return;
    match.p1move = move;
  } else if (match.p2 === ws) {
    if (match.p2move) return;
    match.p2move = move;
  }

  // ja abi ir nospieduši – pabeidzam pirms 15s
  if (match.p1move && match.p2move) {
    finishRound(match);
  }
}

function forceFinishRound(match) {
  match.roundTimer = null;

  // ja kāds nenospieda – ieliekam random un skaitām kā AFK
  if (!match.p1move) {
    match.p1move = randomMove();
    match.p1.afkStrikes = (match.p1.afkStrikes || 0) + 1;
    if (match.p1.afkStrikes >= 3) {
      kickForAfk(match.p1);
      return; // mačs tiks izjaukts on close
    }
  }
  if (!match.p2move) {
    match.p2move = randomMove();
    match.p2.afkStrikes = (match.p2.afkStrikes || 0) + 1;
    if (match.p2.afkStrikes >= 3) {
      kickForAfk(match.p2);
      return;
    }
  }

  finishRound(match);
}

function kickForAfk(ws) {
  send(ws, { type: "kicked", reason: "AFK 3x" });
  ws.close();
}

function finishRound(match) {
  // noņemam raunda taimeri
  if (match.roundTimer) {
    clearTimeout(match.roundTimer);
    match.roundTimer = null;
  }

  // vispirms pasakām klientiem "rādām gājienus"
  broadcastToMatch(match, { type: "rps-show" });

  setTimeout(() => {
    const res = resolveRPS(match.p1move, match.p2move);
    let winnerName = null;

    if (res === 1) {
      match.p1score++;
      winnerName = match.p1.name;
    } else if (res === 2) {
      match.p2score++;
      winnerName = match.p2.name;
    }

    broadcastToMatch(match, {
      type: "rps-reveal",
      p1: { name: match.p1.name, move: match.p1move, score: match.p1score },
      p2: { name: match.p2.name, move: match.p2move, score: match.p2score },
      winner: winnerName
    });

    // vai mačs beidzies?
    if (match.p1score >= 2 || match.p2score >= 2) {
      const finalWinner = match.p1score > match.p2score ? match.p1 : match.p2;

      // ŠEIT tagad +1 punkts, nevis +3
      addToLeaderboard(finalWinner.id, finalWinner.name, getScore(finalWinner.id) + 1);

      broadcastToMatch(match, {
        type: "matchEnd",
        winner: finalWinner.name,
        p1: match.p1.name,
        p2: match.p2.name,
        p1score: match.p1score,
        p2score: match.p2score,
        countdown: 15
      });

      match.p1.matchId = null;
      match.p2.matchId = null;
      matches.delete(match.id);

      broadcastLeaderboard();

      // pēc mača – atpakaļ rindā vai beidz
      if (!match.p1.leaveAfterMatch) {
        findMatch(match.p1);
      } else {
        match.p1.leaveAfterMatch = false;
      }
      if (!match.p2.leaveAfterMatch) {
        findMatch(match.p2);
      } else {
        match.p2.leaveAfterMatch = false;
      }

    } else {
      // turpinām, bet atkal jābūt ready
      match.p1ready = false;
      match.p2ready = false;
      broadcastToMatch(match, {
        type: "needReadyAgain"
      });
    }

  }, 800);
}

// ======== utils ========

function randomMove() {
  const arr = ["rock", "paper", "scissors"];
  return arr[Math.floor(Math.random() * arr.length)];
}

function resolveRPS(a, b) {
  if (a === b) return 0;
  if (a === "rock" && b === "scissors") return 1;
  if (a === "scissors" && b === "paper") return 1;
  if (a === "paper" && b === "rock") return 1;
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

function broadcastToMatch(match, obj) {
  send(match.p1, obj);
  send(match.p2, obj);
}

function broadcastOnline() {
  const perRoom = { "1":0, "2":0, "3":0 };
  for (const c of clients) {
    const r = c.room || "1";
    if (perRoom[r] != null) perRoom[r]++;
  }
  broadcast({ type: "online", total: clients.size, rooms: perRoom });
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
    .sort((a,b)=>b.score-a.score)
    .slice(0,12);
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
