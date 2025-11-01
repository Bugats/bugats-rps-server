// Bugats Akmens-Šķēres-Papīrīts ONLINE serveris
// palaist ar: node server.js
const WebSocket = require("ws");
const PORT = process.env.PORT || 3001;
const wss = new WebSocket.Server({ port: PORT });

console.log("🚀 Bugats RPS serveris klausās uz porta", PORT);

// spēlētāju dati
// player = { ws, id, name, score, waiting, lastSeen }
const players = new Map();
let waitingPlayer = null; // viens gaidošais spēlētājs

function broadcastLeaderboard() {
  const leaderboard = Array.from(players.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 7)
    .map(p => ({ name: p.name, score: p.score }));

  const msg = JSON.stringify({
    type: "leaderboard",
    leaderboard
  });

  for (const p of players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  }
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function getId() {
  return "p" + Math.random().toString(16).slice(2, 8);
}

function winner(move1, move2) {
  // akmens, šķēres, papīrīts
  if (move1 === move2) return 0;
  if (
    (move1 === "akmens" && move2 === "šķēres") ||
    (move1 === "šķēres" && move2 === "papīrīts") ||
    (move1 === "papīrīts" && move2 === "akmens")
  ) {
    return 1;
  }
  return 2;
}

wss.on("connection", (ws) => {
  const id = getId();
  const player = {
    ws,
    id,
    name: "Spēlētājs-" + id.slice(1, 5),
    score: 0,
    waiting: false,
    lastSeen: Date.now()
  };
  players.set(ws, player);

  // nosūtam welcome
  send(ws, {
    type: "welcome",
    id: player.id,
    name: player.name,
    message: "Sveiks Bugata RPS!",
  });

  broadcastLeaderboard();

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    player.lastSeen = Date.now();

    // vārda iestatīšana
    if (data.type === "setName") {
      player.name = (data.name || "").trim() || player.name;
      broadcastLeaderboard();
      return;
    }

    // spēles gājiens
    if (data.type === "play") {
      const myMove = data.move; // akmens/šķēres/papīrīts

      // ja nav neviena kas gaida -> es gaidu
      if (!waitingPlayer) {
        waitingPlayer = { player, move: myMove };
        send(ws, { type: "waiting", message: "Gaidām pretinieku..." });
      } else {
        // ir jau viens gaidītājs — spēlējam
        const opponent = waitingPlayer.player;
        const opponentMove = waitingPlayer.move;
        waitingPlayer = null; // atbrīvojam rindu

        const res = winner(myMove, opponentMove);

        if (res === 0) {
          // neizšķirts
          send(player.ws, {
            type: "result",
            result: "draw",
            yourMove: myMove,
            opponent: opponent.name,
            opponentMove
          });
          send(opponent.ws, {
            type: "result",
            result: "draw",
            yourMove: opponentMove,
            opponent: player.name,
            opponentMove: myMove
          });
        } else if (res === 1) {
          // pirmais uzvar
          player.score++;
          send(player.ws, {
            type: "result",
            result: "win",
            yourMove: myMove,
            opponent: opponent.name,
            opponentMove
          });
          send(opponent.ws, {
            type: "result",
            result: "lose",
            yourMove: opponentMove,
            opponent: player.name,
            opponentMove: myMove
          });
        } else {
          // otrais uzvar
          opponent.score++;
          send(player.ws, {
            type: "result",
            result: "lose",
            yourMove: myMove,
            opponent: opponent.name,
            opponentMove
          });
          send(opponent.ws, {
            type: "result",
            result: "win",
            yourMove: opponentMove,
            opponent: player.name,
            opponentMove: myMove
          });
        }

        broadcastLeaderboard();
      }
    }
  });

  ws.on("close", () => {
    // ja viņš bija gaidītājs
    if (waitingPlayer && waitingPlayer.player.ws === ws) {
      waitingPlayer = null;
    }

    players.delete(ws);
    broadcastLeaderboard();
  });
});
