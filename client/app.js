// app.js - multi-chat, auth, multi-peer (pc per peer)
let ws;
let myUserId = null;
let token = null;

// data structures
const pcs = {};            // peerId -> RTCPeerConnection
const dataChannels = {};   // peerId -> RTCDataChannel (if initiated locally)
const candidateQueues = {}; // peerId -> [candidates]
const onlineInChat = {};   // chatId -> [userIds]

let activeChatId = null;
let chatsList = []; // {chatId, name, members}

// UI helpers
const logEl = id => document.getElementById(id);
const log = msg => { logEl("log").textContent += msg + "\n"; logEl("log").scrollTop = 99999; };
const renderChats = () => {
  const cont = logEl("chats"); cont.innerHTML = "";
  chatsList.forEach(c => {
    const el = document.createElement("div");
    el.className = "chat-item";
    el.textContent = c.name + " (" + c.members.join(",") + ")";
    el.onclick = () => { openChat(c.chatId); };
    cont.appendChild(el);
  });
};

const renderActiveChat = () => {
  const title = activeChatId ? (chatsList.find(c=>c.chatId===activeChatId)?.name || activeChatId) : "No chat";
  logEl("chatTitle").textContent = title;
  // participants
  const parts = onlineInChat[activeChatId] || (activeChatId ? chatsList.find(c=>c.chatId===activeChatId)?.members || [] : []);
  logEl("participants").textContent = "Participants: " + parts.join(", ");
  // messages will be appended by checkInbox and incoming data channel
};

// AUTH + connect
document.getElementById("btnLogin").onclick = async () => {
  const user = document.getElementById("loginUser").value.trim();
  const pass = document.getElementById("loginPass").value.trim();
  if(!user || !pass) return alert("enter user/pass");
  // try register, then login (simple UX)
  await fetch("/auth/register", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ userId:user, password:pass }) })
    .catch(()=>{});
  const res = await fetch("/auth/login", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ userId:user, password:pass }) });
  const j = await res.json();
  if(j.error) return alert("auth failed: "+j.error);
  token = j.token; myUserId = j.userId;
  localStorage.setItem("token", token); localStorage.setItem("userId", myUserId);
  log("Logged in as " + myUserId);
  startWebSocket();
  await loadChats();
};

async function loadChats(){
  if(!token) return;
  const res = await fetch("/chats?token="+encodeURIComponent(token));
  chatsList = await res.json();
  renderChats();
}

document.getElementById("btnCreateChat").onclick = async () => {
  if(!token) return alert("login first");
  const name = document.getElementById("chatName").value.trim();
  const membersRaw = document.getElementById("chatMembers").value.trim();
  const members = membersRaw ? membersRaw.split(",").map(s=>s.trim()).filter(Boolean) : [];
  const res = await fetch("/chats", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ token, name, members })});
  const j = await res.json();
  if(j.chatId) {
    log("Chat created: " + j.chatId);
    await loadChats();
  } else {
    log("Chat create failed");
  }
};

// WebSocket signaling
function startWebSocket(){
  ws = new WebSocket("ws://" + location.host);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type:"register", userId: myUserId, token }));
    log("WS connected");
  };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if(msg.type === "chats"){
      chatsList = msg.chats;
      renderChats();
    }
    if(msg.type === "chat-participants"){
      onlineInChat[msg.chatId] = msg.users;
      renderActiveChat();
      // If active chat, try connect to online peers in that chat
      if(activeChatId === msg.chatId){
        tryAutoConnectToChatPeers(msg.chatId);
      }
    }
    if(msg.type === "signal"){
      // { from, chatId, data }
      await handleSignal(msg.from, msg.chatId, msg.data);
    }
  };
  ws.onclose = () => {
    log("WS closed, retry in 3s");
    setTimeout(startWebSocket, 3000);
  };
}

// open chat in UI
function openChat(chatId){
  activeChatId = chatId;
  renderActiveChat();
  // request inbox for this chat
  checkInboxForChat(chatId);
  // try connect to participants
  tryAutoConnectToChatPeers(chatId);
}

// try to connect to peers in chat
function tryAutoConnectToChatPeers(chatId){
  const users = onlineInChat[chatId] || [];
  for(const peer of users){
    if(peer === myUserId) continue;
    if(!pcs[peer]) {
      // start connection as caller if myUserId < peer to avoid double-offer race (simple tie-break)
      if(myUserId < peer) {
        startConnectionToPeer(peer, chatId);
      }
    }
  }
}

// WebRTC config (TURN/STUN)
const configuration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    // your TURN here
    // { urls: "turn:YOUR_TURN:3478", username: "...", credential: "..." }
  ]
};

// create peer connection for specific peer
function createPeerFor(peerId, chatId){
  const pc = new RTCPeerConnection(configuration);
  pcs[peerId] = pc;
  candidateQueues[peerId] = candidateQueues[peerId] || [];

  pc.onicecandidate = ev => {
    if(ev.candidate){
      ws.send(JSON.stringify({ type:"signal", target: peerId, from: myUserId, chatId, data: { type:"candidate", candidate: ev.candidate } }));
    }
  };

  pc.onconnectionstatechange = () => {
    log(`PC[${peerId}] state: ${pc.connectionState}`);
    if(pc.connectionState === "failed" || pc.connectionState === "disconnected"){
      // clean and try again later
      // close existing
      try { pc.close(); } catch(e){}
      delete pcs[peerId];
      delete dataChannels[peerId];
      setTimeout(()=> tryAutoConnectToChatPeers(chatId), 3000);
    }
  };

  pc.ondatachannel = (ev) => {
    dataChannels[peerId] = ev.channel;
    setupDataChannel(peerId);
  };

  return pc;
}

function setupDataChannel(peerId){
  const dc = dataChannels[peerId];
  if(!dc) return;
  dc.onopen = () => log(`DC[${peerId}] open`);
  dc.onmessage = ev => {
    appendMessageToUi(peerId, ev.data, false);
  };
  dc.onclose = () => log(`DC[${peerId}] closed`);
}

// start connection to a single peer (caller)
async function startConnectionToPeer(peerId, chatId){
  if(pcs[peerId]) return;
  const pc = createPeerFor(peerId, chatId);
  const channel = pc.createDataChannel("chat");
  dataChannels[peerId] = channel;
  setupDataChannel(peerId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({ type:"signal", target: peerId, from: myUserId, chatId, data: { type:"offer", offer } }));
}

// handle incoming signals (callee side or candidate)
async function handleSignal(from, chatId, data){
  const peerId = from;
  if(data.type === "offer"){
    // create PC if missing
    if(!pcs[peerId]) createPeerFor(peerId, chatId);
    const pc = pcs[peerId];
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type:"signal", target: peerId, from: myUserId, chatId, data: { type:"answer", answer } }));
    // flush queued candidates
    if(candidateQueues[peerId]){
      for(const c of candidateQueues[peerId]) await pc.addIceCandidate(c);
      candidateQueues[peerId]=[];
    }
    return;
  }
  if(data.type === "answer"){
    const pc = pcs[peerId];
    if(pc){
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      // flush candidates
      if(candidateQueues[peerId]){
        for(const c of candidateQueues[peerId]) await pc.addIceCandidate(c);
        candidateQueues[peerId]=[];
      }
    }
    return;
  }
  if(data.type === "candidate"){
    const pc = pcs[peerId];
    if(pc && pc.remoteDescription){
      await pc.addIceCandidate(data.candidate);
    } else {
      candidateQueues[peerId] = candidateQueues[peerId] || [];
      candidateQueues[peerId].push(data.candidate);
    }
    return;
  }
}

// send message (to active chat). If there are open DCs to peers, send P2P to each; otherwise fallback server.
document.getElementById("btnSend").onclick = async () => {
  const text = document.getElementById("message").value.trim();
  if(!activeChatId) return alert("open a chat");
  const chat = chatsList.find(c=>c.chatId===activeChatId);
  if(!chat) return;
  const peers = chat.members.filter(m=>m!==myUserId);

  // try P2P to every peer with open DC
  let sentP2P = false;
  for(const p of peers){
    const dc = dataChannels[p];
    if(dc && dc.readyState === "open"){
      dc.send(text);
      appendMessageToUi(p, text, true);
      sentP2P = true;
    }
  }

  if(!sentP2P){
    // fallback: store-on-server for each receiver
    for(const r of peers){
      await fetch(`/chats/${activeChatId}/messages`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ token, receiver: r, text })
      });
    }
    appendMessageToUi(null, text, true);
    log("Sent via server fallback");
  }
  document.getElementById("message").value = "";
};

// append message UI
function appendMessageToUi(peerId, text, isLocal){
  const m = document.createElement("div");
  m.textContent = (isLocal ? "Me" : peerId) + ": " + text;
  logEl("messages").appendChild(m);
  logEl("messages").scrollTop = 99999;
}

// check inbox for active chat
async function checkInboxForChat(chatId){
  if(!token || !myUserId) return;
  const res = await fetch(`/inbox/${myUserId}?token=${encodeURIComponent(token)}&chatId=${encodeURIComponent(chatId)}`);
  const msgs = await res.json();
  for(const m of msgs){
    appendMessageToUi(m.sender, m.text, false);
    await fetch("/delivered", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ token, id: m.id }) });
  }
}

// periodic polling for active chat
setInterval(() => {
  if(activeChatId) checkInboxForChat(activeChatId);
}, 4000);

// start WS if token in storage
window.addEventListener("load", () => {
  token = localStorage.getItem("token") || token;
  myUserId = localStorage.getItem("userId") || myUserId;
  if(token && myUserId) {
    startWebSocket();
    loadChats();
  }
});