// server.js
// Bugats RPS ar 3 istabām, rindām, best-of-3,
// 10s prepare + 15s cīņa, "Es esmu gatavs" tikai sākumā,
// avataru augšupielāde, auto-kick ja 15s nav gatavs,
// “dienas karalis”, broadcast uzvaras,
// ČATS per istaba,
// + PĒC-MAČA POGAS: rematch / spēlēt vēlreiz / iziet (spectate)

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3001;

const clients = new Set();
const playersById = new Map();

// rindas (pa istabām)
const waiting = {
  "1": [],
  "2": [],
  "3": [],
};

// mači pēc id
const matches = new Map();

// leaderboard
const leaderboard = new Map();

// statistika RAMā
const playerStats = new Map();

// “dienas” uzvaras
const dailyWins = new Map();
let todayKing = null;

// čata slow-mode
const chatSlow = new Map();

// primitīvs filtrs
const BAD_WORDS = [
  "dir", "dirš", "pimp", "nah", "nahui", "nahuj",
  "bļ", "pizd", "pidr", "hlam", "fuck", "shit",
  "http://", "https://"
];

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bugats RPS serveris darbojas.");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2, 9);
  ws.name = "Spēlētājs";
  ws.room = "1";
  ws.matchId = null;
  ws.leaveAfterMatch = false;
  ws.afkStrikes = 0;
  ws.avatar = null;

  clients.add(ws);
  broadcastOnline();
  broadcastQueues();

  if (todayKing) {
    send(ws, { type: "dailyKing", king: todayKing });
  }

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    switch (data.type) {

      // ===== HELLO =====
      case "hello": {
        if (data.id) {
          const existing = playersById.get(data.id);
          if (existing && existing !== ws) {
            removeFromQueues(existing);
            if (existing.matchId) {
              const m = matches.get(existing.matchId);
              if (m) {
                const other = m.p1 === existing ? m.p2 : m.p1;
                send(other, { type: "opponentLeft" });
                sendChatSystem(m.room, `⚠ ${existing.name} atvienojās.`);
                other.matchId = null;
                matches.delete(m.id);
                if (!other.leaveAfterMatch) queuePlayer(other);
              }
            }
            try { existing.close(); } catch (e) {}
          }
          ws.id = data.id;
          playersById.set(data.id, ws);
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

        getPlayerStats(ws.id, ws.name);
        addToLeaderboard(ws.id, ws.name, getScore(ws.id));
        broadcastLeaderboard();

        queuePlayer(ws);
        broadcastOnline();
        break;
      }

      // ===== MAINĪT NIKU =====
      case "setName": {
        ws.name = sanitizeName(data.name || "Spēlētājs");
        addToLeaderboard(ws.id, ws.name, getScore(ws.id));
        getPlayerStats(ws.id, ws.name);
        broadcastLeaderboard();
        broadcastQueues();
        break;
      }

      // ===== AVATĀRS =====
      case "avatarUpload": {
        if (typeof data.avatar === "string" &&
            data.avatar.startsWith("data:image/") &&
            data.avatar.length < 200000) {
          ws.avatar = data.avatar;
          if (ws.matchId) {
            const m = matches.get(ws.matchId);
            if (m) {
              const other = m.p1 === ws ? m.p2 : m.p1;
              send(other, { type: "opponentAvatar", avatar: ws.avatar });
            }
          }
        }
        break;
      }

      // ===== READY =====
      case "ready": {
        if (!ws.matchId) return;
        const match = matches.get(ws.matchId);
        if (!match || match.ended) return;

        if (match.p1 === ws) match.p1ready = true;
        else if (match.p2 === ws) match.p2ready = true;

        broadcastToMatch(match, {
          type: "readyState",
          p1ready: match.p1ready,
          p2ready: match.p2ready
        });

        if (match.p1ready && match.p2ready) {
          if (match.readyTimeout) {
            clearTimeout(match.readyTimeout);
            match.readyTimeout = null;
          }
          startRoundWithCountdown(match);
        }
        break;
      }

      // ===== MOVE =====
      case "move": {
        ws.afkStrikes = 0;
        handleMove(ws, data.move);
        break;
      }

      // ===== PĒDĒJĀ PARTIJA =====
      case "lastGame": {
        ws.leaveAfterMatch = true;
        send(ws, { type: "lastGameAck" });
        if (ws.matchId) {
          const m = matches.get(ws.matchId);
          if (m) {
            const other = m.p1 === ws ? m.p2 : m.p1;
            send(other, { type: "opponentLastGame", name: ws.name });
          }
        }
        break;
      }

      // ===== MAINĪT ISTABU =====
      case "changeRoom": {
        const newRoom = String(data.room || "1");
        if (!["1","2","3"].includes(newRoom)) return;
        if (ws.matchId) {
          send(ws, { type: "error", message: "Nevar mainīt istabu mača laikā." });
          return;
        }
        removeFromQueues(ws);
        ws.room = newRoom;
        ws.leaveAfterMatch = false;
        queuePlayer(ws);
        broadcastOnline();
        break;
      }

      // ===== ČATS =====
      case "chat": {
        const text = String(data.text || "").trim();
        handleChat(ws, text);
        break;
      }

      // ===== REMATCH =====
      case "rematchRequest": {
        handlePostMatchChoice(ws, "rematch");
        break;
      }

      // ===== SPĒLĒT VĒLREIZ =====
      case "playAgain": {
        handlePostMatchChoice(ws, "queue");
        break;
      }

      // ===== IZ IET / SKATĪTIES =====
      case "leaveToSpectate": {
        handlePostMatchChoice(ws, "spectate");
        break;
      }

    }
  });

  ws.on("close", () => {
    clients.delete(ws);

    if (playersById.get(ws.id) === ws) {
      playersById.delete(ws.id);
    }

    removeFromQueues(ws);

    if (ws.matchId) {
      const m = matches.get(ws.matchId);
      if (m) {
        const other = m.p1 === ws ? m.p2 : m.p1;
        send(other, { type: "opponentLeft" });
        sendChatSystem(m.room, `⚠ ${ws.name} pameta maču.`);
        other.matchId = null;
        matches.delete(m.id);
        if (!other.leaveAfterMatch) queuePlayer(other);
      }
    }

    broadcastOnline();
    broadcastQueues();
  });
});

// ===== ČATS =====
function handleChat(ws, text) {
  if (!text) return;
  const now = Date.now();
  const last = chatSlow.get(ws.id) || 0;
  if (now - last < 2000) {
    send(ws, { type: "chatError", message: "Slow mode 2s" });
    return;
  }
  if (text.length > 120) {
    send(ws, { type: "chatError", message: "Ziņa par gara (max 120)" });
    return;
  }
  const lowered = text.toLowerCase();
  for (const bad of BAD_WORDS) {
    if (lowered.includes(bad)) {
      send(ws, { type: "chatError", message: "Ziņa nav atļauta" });
      return;
    }
  }
  chatSlow.set(ws.id, now);

  const room = ws.room || "1";
  broadcastToRoom(room, {
    type: "chat",
    from: { id: ws.id, name: ws.name },
    text,
    ts: now
  });
}

function sendChatSystem(room, text) {
  broadcastToRoom(room, {
    type: "chatSystem",
    text,
    ts: Date.now()
  });
}

// ===== RINDAS =====
function queuePlayer(ws) {
  const room = ws.room || "1";
  const arr = waiting[room];
  if (!arr.includes(ws)) {
    arr.push(ws);
  }
  broadcastQueues();
  tryMatchRoom(room);
}

function removeFromQueues(ws) {
  for (const r of ["1","2","3"]) {
    const arr = waiting[r];
    const i = arr.indexOf(ws);
    if (i !== -1) arr.splice(i, 1);
  }
  broadcastQueues();
}

function tryMatchRoom(room) {
  const arr = waiting[room];
  while (arr.length >= 2) {
    const p1 = arr.shift();
    let idx = arr.findIndex(p =>
      p !== p1 &&
      p.id !== p1.id &&
      p.name.toLowerCase() !== p1.name.toLowerCase()
    );
    if (idx === -1) {
      arr.unshift(p1);
      break;
    }
    const p2 = arr.splice(idx, 1)[0];
    createMatch(room, p1, p2);
  }
}

function createMatch(room, p1, p2) {
  const matchId = Math.random().toString(36).slice(2, 9);
  const match = {
    id: matchId,
    room,
    p1,
    p2,
    p1move: null,
    p2move: null,
    p1score: 0,
    p2score: 0,
    p1ready: false,
    p2ready: false,
    prepTimer: null,
    roundTimer: null,
    readyTimeout: null,
    ended: false,
    p1Post: "none",
    p2Post: "none",
    endTimeout: null,
  };
  matches.set(matchId, match);
  p1.matchId = matchId;
  p2.matchId = matchId;

  const payload = {
    type: "matchStart",
    needReady: true,
    room,
    p1: { id: p1.id, name: p1.name, score: 0, avatar: p1.avatar || null },
    p2: { id: p2.id, name: p2.name, score: 0, avatar: p2.avatar || null },
  };
  send(p1, payload);
  send(p2, payload);

  sendChatSystem(room, `🎮 Jauns mačs: ${p1.name} vs ${p2.name}`);

  match.readyTimeout = setTimeout(() => {
    checkNotReadyTimeout(match.id);
  }, 15000);

  broadcastQueues();
}

function checkNotReadyTimeout(matchId) {
  const match = matches.get(matchId);
  if (!match || match.ended) return;
  if (match.p1ready && match.p2ready) return;

  const notReady = [];
  const readyOnes = [];
  if (!match.p1ready) notReady.push(match.p1);
  else readyOnes.push(match.p1);
  if (!match.p2ready) notReady.push(match.p2);
  else readyOnes.push(match.p2);

  notReady.forEach(pl => {
    send(pl, { type: "notReadyKicked", message: "Tu 15s neapstiprināji GATAVS" });
    sendChatSystem(pl.room || match.room, `⚠ ${pl.name} tika izmests – nebija gatavs.`);
    pl.matchId = null;
    if (!pl.leaveAfterMatch) queuePlayer(pl); else pl.leaveAfterMatch = false;
  });

  readyOnes.forEach(pl => {
    send(pl, { type: "opponentNotReady", message: "Pretinieks nebija gatavs, meklējam jaunu." });
    pl.matchId = null;
    if (!pl.leaveAfterMatch) queuePlayer(pl); else pl.leaveAfterMatch = false;
  });

  matches.delete(match.id);
  broadcastQueues();
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
  if (!match || match.ended) return;
  if (match.prepTimer) return;
  if (!["rock","paper","scissors"].includes(move)) return;

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
  try { ws.close(); } catch (e) {}
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

    if (match.p1score >= 2 || match.p2score >= 2) {
      endFullMatch(match);
    } else {
      startRoundWithCountdown(match);
    }

  }, 800);
}

function endFullMatch(match) {
  match.ended = true;

  const finalWinner = match.p1score > match.p2score ? match.p1 : match.p2;
  const loser = match.p1 === finalWinner ? match.p2 : match.p1;
  const room = match.room;

  // leaderboard +1
  addToLeaderboard(finalWinner.id, finalWinner.name, getScore(finalWinner.id) + 1);

  // statistika
  const wStats = getPlayerStats(finalWinner.id, finalWinner.name);
  wStats.wins += 1;
  wStats.matches += 1;
  wStats.streak += 1;
  if (wStats.streak > wStats.bestStreak) wStats.bestStreak = wStats.streak;

  const lStats = getPlayerStats(loser.id, loser.name);
  lStats.loses += 1;
  lStats.matches += 1;
  lStats.streak = 0;

  // dienas karalis
  const prev = dailyWins.get(finalWinner.id) || 0;
  const now = prev + 1;
  dailyWins.set(finalWinner.id, now);
  let newKing = false;
  if (!todayKing || now > todayKing.wins) {
    todayKing = { id: finalWinner.id, name: finalWinner.name, wins: now };
    newKing = true;
  }

  // paziņojums abiem + post-mača režīms
  broadcastToMatch(match, {
    type: "matchEnd",
    winner: finalWinner.name,
    p1: match.p1.name,
    p2: match.p2.name,
    p1score: match.p1score,
    p2score: match.p2score,
    postMenu: true,
    countdown: 15
  });

  // istabas announcement + čats
  const winText = `🏆 ${finalWinner.name} uzvarēja ${loser.name} (${match.p1score}:${match.p2score}) istabā ${room}`;
  broadcastToRoom(room, {
    type: "announcement",
    room,
    text: winText
  });
  sendChatSystem(room, winText);

  if (newKing) {
    broadcast({
      type: "dailyKing",
      king: todayKing
    });
  }

  broadcastLeaderboard();
  broadcastQueues();

  // tagad 15 sekundes gaidām spēlētāju izvēles (rematch / queue / spectate)
  match.endTimeout = setTimeout(() => {
    finalizePostMatch(match.id);
  }, 15000);
}

function handlePostMatchChoice(ws, choice) {
  // choice: "rematch" | "queue" | "spectate"
  const matchId = ws.matchId;
  if (!matchId) {
    // ja nav mača, un viņš teica "playAgain" → ieliekam rindā
    if (choice === "queue") {
      ws.leaveAfterMatch = false;
      queuePlayer(ws);
    }
    return;
  }
  const match = matches.get(matchId);
  if (!match || !match.ended) return;

  if (match.p1 === ws) {
    match.p1Post = choice;
  } else if (match.p2 === ws) {
    match.p2Post = choice;
  }

  // ja abi izvēlējās rematch → uzreiz
  if (match.p1Post === "rematch" && match.p2Post === "rematch") {
    // notīram timeout
    if (match.endTimeout) clearTimeout(match.endTimeout);
    startRematch(match);
  }
}

function startRematch(oldMatch) {
  const room = oldMatch.room;
  const p1 = oldMatch.p1;
  const p2 = oldMatch.p2;
  // notīram veco
  matches.delete(oldMatch.id);
  p1.matchId = null;
  p2.matchId = null;
  // izveidojam jaunu ar tiem pašiem
  createMatch(room, p1, p2);
}

function finalizePostMatch(matchId) {
  const match = matches.get(matchId);
  if (!match) return;

  const p1 = match.p1;
  const p2 = match.p2;

  // ja kāds nav iesniedzis izvēli – default = "queue"
  if (match.p1Post === "none") match.p1Post = "queue";
  if (match.p2Post === "none") match.p2Post = "queue";

  // atkarībā no izvēles
  handleOnePost(p1, match.p1Post, match.room);
  handleOnePost(p2, match.p2Post, match.room);

  matches.delete(matchId);
  broadcastQueues();
}

function handleOnePost(player, choice, room) {
  if (!player) return;
  player.matchId = null;
  if (choice === "spectate") {
    player.leaveAfterMatch = true;
    send(player, { type: "youAreSpectator", room });
    // viņš paliek istabā, bet nav rindā
    return;
  }
  if (choice === "queue") {
    player.leaveAfterMatch = false;
    queuePlayer(player);
    return;
  }
  if (choice === "rematch") {
    // ja otrs negribēja rematch, mēs viņu ieliksim rindā
    player.leaveAfterMatch = false;
    queuePlayer(player);
  }
}

// ===== UTIL =====
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

function broadcastToRoom(room, obj) {
  const str = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN && c.room === room) {
      c.send(str);
    }
  }
}

function broadcastOnline() {
  const perRoom = { "1":0, "2":0, "3":0 };
  for (const c of clients) {
    const r = c.room || "1";
    if (perRoom[r] != null) perRoom[r]++;
  }
  broadcast({ type: "online", total: clients.size, rooms: perRoom });
}

function broadcastQueues() {
  const rooms = {};
  for (const r of ["1","2","3"]) {
    rooms[r] = waiting[r].map(w => ({ id: w.id, name: w.name }));
  }
  broadcast({ type: "queues", rooms });
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

function getPlayerStats(id, name) {
  if (!playerStats.has(id)) {
    playerStats.set(id, {
      id,
      name: name || "Spēlētājs",
      wins: 0,
      loses: 0,
      matches: 0,
      streak: 0,
      bestStreak: 0,
    });
  } else {
    const st = playerStats.get(id);
    if (name) st.name = name;
  }
  return playerStats.get(id);
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
