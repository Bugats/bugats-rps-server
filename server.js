// server.js
// Bugats RPS — 3 rooms, best of 3, READY sistēma,
// 10s sagatavošanās + 15s raunds, pēdējā partija paziņojums pretiniekam,
// avataru sūtīšana caur WS, AFK auto-kick
// + JAUNS: tikai 1 aktīvs savienojums uz 1 spēlētāja ID (anti-refresh juceklis)

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3001;

const clients = new Set();

// jaunais: lai zinām, kurš ID jau ir online
const playersById = new Map();

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
  // pagaidu ID, īstais atnāks ar "hello"
  ws.id = Math.random().toString(36).slice(2, 9);
  ws.name = "Spēlētājs";
  ws.room = "1";
  ws.matchId = null;
  ws.leaveAfterMatch = false;
  ws.afkStrikes = 0;
  ws.avatar = null;

  clients.add(ws);
  broadcastOnline();

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    switch (data.type) {
      // ================= HELLO =================
      case "hello": {
        // ja atnāk ar saglabātu ID no localStorage
        if (data.id) {
          const newId = data.id;
          // paskatāmies – vai nav jau tāds spēlētājs online
          const existing = playersById.get(newId);
          if (existing && existing !== ws) {
            // 1) ja vecais bija rindā – izmetam no rindas
            if (waiting[existing.room] === existing) {
              waiting[existing.room] = null;
            }
            // 2) ja vecais bija mačā – pretiniekam paziņojam, ka tas “pazuda”
            if (existing.matchId) {
              const oldMatch = matches.get(existing.matchId);
              if (oldMatch) {
                const other = oldMatch.p1 === existing ? oldMatch.p2 : oldMatch.p1;
                send(other, { type: "opponentLeft" });
                other.matchId = null;
                matches.delete(oldMatch.id);
                // otru ieliekam rindā atpakaļ
                if (!other.leaveAfterMatch) {
                  findMatch(other);
                } else {
                  other.leaveAfterMatch = false;
                }
              }
            }
            // 3) veco aizveram
            try { existing.close(); } catch (e) {}
          }

          ws.id = newId;
          playersById.set(newId, ws);
        }

        if (data.name) ws.name = sanitizeName(data.name);
        if (data.room && ["1","2","3"].includes(String(data.room))) {
          ws.room = String(data.room);
        }
        if (data.avatar) {
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

      // ================= NICK =================
      case "setName": {
        ws.name = sanitizeName(data.name || "Spēlētājs");
        addToLeaderboard(ws.id, ws.name, getScore(ws.id));
        broadcastLeaderboard();
        break;
      }

      // ================= AVATAR =================
      case "avatarUpload": {
        if (typeof data.avatar === "string" && data.avatar.startsWith("data:image/") && data.avatar.length < 200000) {
          ws.avatar = data.avatar;
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

      // ================= READY =================
      case "ready": {
        if (!ws.matchId) return;
        const match = matches.get(ws.matchId);
        if (!match) return;

        if (match.p1 === ws) match.p1ready = true;
        if (match.p2 === ws) match.p2ready = true;

        broadcastToMatch(match, {
          type: "readyState",
          p1ready: match.p1ready,
          p2ready: match.p2ready
        });

        if (match.p1ready && match.p2ready) {
          startRoundWithCountdown(match);
        }
        break;
      }

      // ================= MOVE =================
      case "move": {
        ws.afkStrikes = 0;
        handleMove(ws, data.move);
        break;
      }

      // ================= LAST GAME =================
      case "lastGame": {
        ws.leaveAfterMatch = true;
        send(ws, { type: "lastGameAck" });
        if (ws.matchId) {
          const match = matches.get(ws.matchId);
          if (match) {
            const other = match.p1 === ws ? match.p2 : match.p1;
            send(other, { type: "opponentLastGame", name: ws.name });
          }
        }
        break;
      }

      // ================= CHANGE ROOM =================
      case "changeRoom": {
        const newRoom = String(data.room || "1");
        if (!["1","2","3"].includes(newRoom)) return;
        if (ws.matchId) {
          send(ws, { type: "error", message: "Nevar mainīt istabu mača laikā." });
          return;
        }
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

    // ja tieši šim ID mēs bijām reģistrējuši savienojumu – izņemam
    if (playersById.get(ws.id) === ws) {
      playersById.delete(ws.id);
    }

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

// ================= MAČU LOĢIKA =================

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
  broadcastToMatch(match, { type: "roundPrepare", in: 10 });
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

  // ja vēl sagatavošanās – nelaižam
  if (match.prepTimer) return;

  if (match.p1 === ws) {
    if (match.p1move) return;
    match.p1move = move;
  } else if (match.p2 === ws) {
    if (match.p2move) return;
    match.p2move = move;
  }

  if (match.p1move && match.p2move) {
    finishRound(match);
  }
}

function forceFinishRound(match) {
  match.roundTimer = null;

  if (!match.p1move) {
    match.p1move = randomMove();
    match.p1.afkStrikes = (match.p1.afkStrikes || 0) + 1;
    if (match.p1.afkStrikes >= 3) {
      kickForAfk(match.p1);
      return;
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
  try { ws.close(); } catch(e) {}
}

function finishRound(match) {
  if (match.roundTimer) {
    clearTimeout(match.roundTimer);
    match.roundTimer = null;
  }

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

    // best of 3 pabeigts?
    if (match.p1score >= 2 || match.p2score >= 2) {
      const finalWinner = match.p1score > match.p2score ? match.p1 : match.p2;

      // +1 punkts
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
      // mačs turpinās – atkal jāspiež gatavs
      match.p1ready = false;
      match.p2ready = false;
      broadcastToMatch(match, { type: "needReadyAgain" });
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
