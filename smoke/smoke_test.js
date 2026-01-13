/* eslint-disable no-console */
"use strict";

// Smoke test: spin up 3 socket clients and ensure the server
// accepts join, starts a hand, and enforces basic flow without crashing.

const { io } = require("socket.io-client");

const BASE_URL = process.env.SMOKE_URL || "http://127.0.0.1:10080";
const ROOM = process.env.SMOKE_ROOM || "SMK1";
const TIMEOUT_MS = Math.max(5000, Math.min(45000, parseInt(process.env.SMOKE_TIMEOUT_MS || "20000", 10) || 20000));

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function attachStateTracker(socket) {
  const state = {
    last: null,
    extra: null,
    listeners: new Set(),
  };
  socket.on("room:state", (st, extra) => {
    state.last = st;
    state.extra = extra || null;
    for (const fn of Array.from(state.listeners)) {
      try {
        fn();
      } catch {}
    }
  });
  return state;
}

function waitFor(stateTracker, predicate, ms = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      try {
        if (predicate(stateTracker.last, stateTracker.extra)) {
          cleanup();
          resolve(stateTracker.last);
          return;
        }
      } catch {}
      if (Date.now() - started > ms) {
        cleanup();
        reject(new Error("timeout waiting room state condition"));
      }
    };
    const cleanup = () => {
      try {
        stateTracker.listeners.delete(tick);
      } catch {}
    };
    stateTracker.listeners.add(tick);
    // immediate check (in case we already have the state)
    tick();
  });
}

function connectClient(name) {
  const socket = io(BASE_URL, {
    transports: ["websocket", "polling"],
    timeout: 5000,
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (e) => reject(e));
  }).then((s) => ({ name, socket: s }));
}

async function joinRoom(client) {
  const { name, socket } = client;
  const payload = { roomId: ROOM, username: name, avatarUrl: "", seed: `seed-${name}` };
  const res = await new Promise((resolve) => socket.emit("room:join", payload, resolve));
  if (res?.ok) return res;
  // if not found, create
  if (res?.error === "ROOM_NOT_FOUND") {
    const res2 = await new Promise((resolve) => socket.emit("room:create", payload, resolve));
    if (!res2?.ok) throw new Error(`create failed: ${res2?.error || "UNKNOWN"}`);
    return res2;
  }
  throw new Error(`join failed: ${res?.error || "UNKNOWN"}`);
}

async function setReady(client, ready) {
  const { socket } = client;
  const res = await new Promise((resolve) => socket.emit("zole:ready", { ready }, resolve));
  if (!res?.ok) throw new Error(`ready failed: ${res?.error || "UNKNOWN"}`);
}

function pickBidForSeat(state) {
  // Simple: first bidder takes to force game start quickly.
  // Others pass.
  const bidCount = Array.isArray(state?.bids) ? state.bids.length : 0;
  if (bidCount === 0) return "TAKE";
  return "PASS";
}

async function run() {
  const started = Date.now();
  const clients = [];

  try {
    // connect 3 clients
    clients.push(await connectClient("A"));
    clients.push(await connectClient("B"));
    clients.push(await connectClient("C"));
    for (const c of clients) c.state = attachStateTracker(c.socket);

    // join same room
    for (const c of clients) await joinRoom(c);

    // mark all ready
    for (const c of clients) await setReady(c, true);

    const endAt = Date.now() + TIMEOUT_MS;
    // Wait for bidding phase to appear
    let st = await waitFor(
      clients[0].state,
      (s) => !!s && (s.phase === "BIDDING" || s.phase === "DISCARD" || s.phase === "PLAY"),
      12000
    );
    if (st.phase !== "BIDDING") {
      // ok if auto-start quickly moved forward
      if (st.phase !== "DISCARD" && st.phase !== "PLAY") {
        throw new Error(`expected BIDDING/DISCARD/PLAY, got ${st.phase}`);
      }
    }

    // Bid loop: bid until phase changes away from BIDDING
    while (Date.now() < endAt && st?.phase === "BIDDING") {
      const turnSeat = st.turnSeat;
      const actor = clients.find((c) => {
        // each client receives mySeat in their own state; pick the client for the turn by comparing usernames
        const p = (st.players || []).find((x) => x.seat === turnSeat);
        return p?.username === c.name;
      });

      // If we can't map by name (edge), just let any client try; server will reject.
      const bidder = actor || clients[0];
      const bid = pickBidForSeat(st);
      await new Promise((resolve) => bidder.socket.emit("zole:bid", { bid }, resolve));
      st = await waitFor(clients[0].state, (s) => !!s && s.phase !== "BIDDING", 12000).catch(() => clients[0].state.last);
    }

    // If TAKE was chosen, there is a DISCARD phase. We won't try to discard; timer should auto-discard and proceed.
    if (st?.phase !== "PLAY") {
      st = await waitFor(clients[0].state, (s) => !!s && s.phase === "PLAY", 20000);
    }
    if (st?.phase !== "PLAY") throw new Error(`expected PLAY, got ${st?.phase || "?"}`);

    // Confirm server publishes turnEndsAt (timer)
    if (!st.turnEndsAt) throw new Error("turnEndsAt missing (turn timer not active)");

    console.log(`[smoke] OK: reached PLAY; turnSeat=${st.turnSeat}; elapsed=${Date.now() - started}ms`);
  } finally {
    for (const c of clients) {
      try {
        c.socket.disconnect();
      } catch {}
    }
  }
}

run().catch((e) => {
  console.error("[smoke] FAIL:", e?.stack || e?.message || e);
  process.exitCode = 1;
});

