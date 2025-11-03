const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Static (index.html, style.css, client.js)
const publicPath = path.join(__dirname);
app.use(express.static(publicPath));
app.get("/", (req, res) => res.sendFile(path.join(publicPath, "index.html")));

// ===== Duraks core =====
const SUITS = ["♠","♥","♦","♣"];
const R36 = ["6","7","8","9","10","J","Q","K","A"];
const R52 = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const RV = Object.fromEntries(R52.map((r,i)=>[r,i]));
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=crypto.randomInt(0,i+1);[a[i],a[j]]=[a[j],a[i]]}return a}
function makeDeck(n){const ranks=n===36?R36:R52;const d=[];for(const s of SUITS){for(const r of ranks){d.push({r,s})}}return shuffle(d)}
function beats(a,b,tr){if(a.s===b.s&&RV[a.r]>RV[b.r])return true; if(a.s===tr&&b.s!==tr)return true; return false}
function lowestTrump(hand,tr){return hand.filter(c=>c.s===tr).sort((a,b)=>RV[a.r]-RV[b.r])[0]}

const rooms = new Map();
function code(){const abc="ABCDEFGHJKMNPQRSTUVWXYZ23456789";let s="";for(let i=0;i<5;i++)s+=abc[Math.floor(Math.random()*abc.length)];return s}
function makeRoom(deckSize){const c=code();const room={code:c,deckSize,deck:[],trump:null,players:[],table:[],attacker:null,defender:null,phase:"lobby"};rooms.set(c,room);return room}
function deal(room){
  room.deck=makeDeck(room.deckSize);
  room.trump=room.deck[room.deck.length-1].s;
  room.players.forEach(p=>p.hand=[]);
  for(let i=0;i<6;i++){for(const p of room.players){p.hand.push(room.deck.shift())}}
  const lt=room.players.map(p=>({p,lt:lowestTrump(p.hand,room.trump)})).sort((a,b)=>{
    if(!a.lt&&!b.lt)return 0; if(!a.lt)return 1; if(!b.lt)return -1; return RV[a.lt.r]-RV[b.lt.r];
  })[0].p;
  room.attacker=lt.id;
  room.defender=room.players.find(p=>p.id!==lt.id).id;
  room.table=[]; room.phase="attack";
}
function baseRanks(room){const set=new Set();room.table.forEach(p=>{set.add(p.atk.r);if(p.def)set.add(p.def.r)});return set}
function canAddMore(room){const def=room.players.find(p=>p.id===room.defender);const limit=Math.min(6,def.hand.length);return room.table.length<limit}
function drawUpTo6(room,id){const P=room.players.find(p=>p.id===id);while(P&&P.hand.length<6&&room.deck.length)P.hand.push(room.deck.shift())}
function sync(room){
  const payload={code:room.code,trump:{s:room.trump},stock:room.deck.length,
    players:room.players.map(p=>({id:p.id,nick:p.nick,hand:p.hand.map(c=>c),handCount:p.hand.length})),
    table:room.table.map(t=>({atk:t.atk,def:t.def||null})),
    attacker:room.attacker,defender:room.defender,phase:room.phase};
  room.players.forEach(p=>{
    const view=JSON.parse(JSON.stringify(payload));
    view.players.forEach(q=>{if(q.id!==p.id)q.hand=q.hand.map(()=>({hidden:true}))});
    io.to(p.id).emit("game.state",view);
  });
}
function endAttack(room){
  if(!room.table.length||!room.table.every(p=>p.def))return;
  room.table=[];
  drawUpTo6(room,room.attacker); drawUpTo6(room,room.defender);
  [room.attacker,room.defender]=[room.defender,room.attacker];
  room.phase="attack"; checkOver(room); sync(room);
}
function takeCards(room,defId){
  const D=room.players.find(p=>p.id===defId);
  room.table.forEach(p=>{D.hand.push(p.atk); if(p.def)D.hand.push(p.def)});
  room.table=[];
  room.attacker=room.players.find(p=>p.id!==defId).id;
  room.defender=defId;
  drawUpTo6(room,room.attacker); drawUpTo6(room,room.defender);
  room.phase="attack"; checkOver(room); sync(room);
}
function checkOver(room){
  const a=room.players[0]?.hand.length??0, b=room.players[1]?.hand.length??0;
  if((a===0&&room.deck.length===0)||(b===0&&room.deck.length===0)){room.phase="over"}
}

io.on("connection",(sock)=>{
  sock.on("room.create",({nick,deckSize})=>{
    const r=makeRoom(deckSize===52?52:36);
    r.players.push({id:sock.id,nick:nick||"Spēlētājs",hand:[]});
    sock.join(r.code);
    io.to(sock.id).emit("room.created",{room:r.code});
    io.to(r.code).emit("room.update",{players:r.players.map(p=>({id:p.id,nick:p.nick}))});
  });

  sock.on("room.join",({nick,room})=>{
    const r=rooms.get(room); if(!r) return io.to(sock.id).emit("error.msg","Istaba neeksistē");
    if(r.players.length>=2)return io.to(sock.id).emit("error.msg","Istaba pilna");
    r.players.push({id:sock.id,nick:nick||"Spēlētājs",hand:[]});
    sock.join(room);
    io.to(sock.id).emit("room.joined",{room,players:r.players.map(p=>({id:p.id,nick:p.nick}))});
    io.to(room).emit("room.update",{players:r.players.map(p=>({id:p.id,nick:p.nick}))});
  });

  sock.on("game.start",({room})=>{
    const r=rooms.get(room); if(!r)return;
    if(r.players.length!==2)return io.to(sock.id).emit("error.msg","Nepieciešami 2 spēlētāji");
    deal(r); sync(r);
  });

  sock.on("game.play",({room,idx,defendIdx})=>{
    const r=rooms.get(room); if(!r)return;
    const P=r.players.find(p=>p.id===sock.id); if(!P)return;
    if(r.phase==="attack"&&r.attacker===sock.id){
      if(!canAddMore(r))return io.to(sock.id).emit("error.msg","Metiena limits");
      const c=P.hand[idx]; if(!c)return;
      const bases=baseRanks(r);
      if(r.table.length===0||bases.has(c.r)){P.hand.splice(idx,1); r.table.push({atk:c}); r.phase="defend"; sync(r)}
      else io.to(sock.id).emit("error.msg","Drīkst mest tikai esošos ciparus");
    } else if(r.phase==="defend"&&r.defender===sock.id){
      const ti=Number.isInteger(defendIdx)?defendIdx:r.table.findIndex(t=>!t.def);
      const target=r.table[ti]; if(!target||target.def)return;
      const c=P.hand[idx]; if(!c)return;
      if(beats(c,target.atk,r.trump)){P.hand.splice(idx,1); target.def=c; sync(r)}
      else io.to(sock.id).emit("error.msg","Šī kārts nenosit");
    }
  });

  sock.on("game.take",({room})=>{
    const r=rooms.get(room); if(!r)return;
    if(r.defender!==sock.id||r.phase!=="defend")return;
    takeCards(r,sock.id);
  });

  sock.on("game.endAttack",({room})=>{
    const r=rooms.get(room); if(!r)return;
    if(r.attacker!==sock.id)return;
    if(r.table.length&&r.table.every(p=>p.def)) endAttack(r);
  });

  sock.on("game.pass",({room})=>{
    const r=rooms.get(room); if(!r)return;
    if(r.attacker!==sock.id)return;
    if(r.table.length&&r.table.every(p=>p.def)) endAttack(r);
  });

  sock.on("chat",({room,msg})=>{
    const r=rooms.get(room); if(!r)return;
    const P=r.players.find(p=>p.id===sock.id); if(!P)return;
    io.to(room).emit("chat",{nick:P.nick,msg:String(msg).slice(0,300)});
  });

  sock.on("disconnect",()=>{
    for(const [c,r] of rooms){
      const i=r.players.findIndex(p=>p.id===sock.id);
      if(i>-1){r.players.splice(i,1); io.to(c).emit("room.update",{players:r.players.map(p=>({id:p.id,nick:p.nick}))})}
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log("Duraks Online listening on "+PORT));
