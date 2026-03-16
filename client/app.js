// client/app.js — обновлённый
let ws;
let myUserId = null;
let token = null;

// peer state
const pcs = {};            // peerId -> RTCPeerConnection
const dataChannels = {};   // peerId -> RTCDataChannel
const candidateQueues = {}; // peerId -> [candidates]
const reconnectTimers = {}; // peerId -> { attempts, timerId }

// chat state
let activeChatId = null;
let chatsList = []; // {chatId, name, members}
const onlineInChat = {}; // chatId -> [userIds]

// UI helpers
const logEl = id => document.getElementById(id);
const log = msg => { logEl("log").textContent += msg + "\n"; logEl("log").scrollTop = 99999; };

// initial auth check — redirect to login if no token
window.addEventListener("load", () => {
  token = localStorage.getItem("token");
  myUserId = localStorage.getItem("userId");
  if(!token || !myUserId){
    // redirect to login page
    location.href = "/login.html";
    return;
  }
  // show account info
  logEl("accountInfo").textContent = "You: " + myUserId + " (token loaded)";
  startWebSocket();
  loadChats();
  // periodic sync of chat list
  setInterval(loadChats, 20000);
});

// ---------- UI: create chat ----------
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

// ---------- load chats ----------
async function loadChats(){
  if(!token) return;
  try{
    const res = await fetch("/chats?token="+encodeURIComponent(token));
    if(!res.ok) throw new Error("no auth");
    chatsList = await res.json();
    renderChats();
  }catch(e){
    console.error(e);
    // token invalid -> force login
    localStorage.removeItem("token");
    localStorage.removeItem("userId");
    location.href = "/login.html";
  }
}

function renderChats(){
  const cont = logEl("chats"); cont.innerHTML = "";
  chatsList.forEach(c => {
    const el = document.createElement("div");
    el.className = "chat-item";
    el.textContent = c.name + " (" + c.members.join(",") + ")";
    el.onclick = () => { openChat(c.chatId); };
    cont.appendChild(el);
  });
}

// ---------- websocket signaling ----------
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
    } else if(msg.type === "chat-participants"){
      onlineInChat[msg.chatId] = msg.users;
      if(msg.chatId === activeChatId) renderActiveChat();
      if(msg.chatId === activeChatId) tryAutoConnectToChatPeers(msg.chatId);
    } else if(msg.type === "signal"){
      await handleSignal(msg.from, msg.chatId, msg.data);
    } else if(msg.type === "error"){
      log("Server error: " + (msg.error||""));
    }
  };
  ws.onclose = () => {
    log("WS closed, retry in 3s");
    setTimeout(startWebSocket, 3000);
  };
}

// ---------- open chat ----------
function openChat(chatId){
  activeChatId = chatId;
  renderActiveChat();
  loadHistoryForChat(chatId);
  tryAutoConnectToChatPeers(chatId);
}

// render active chat metadata
function renderActiveChat(){
  const title = activeChatId ? (chatsList.find(c=>c.chatId===activeChatId)?.name || activeChatId) : "No chat";
  logEl("chatTitle").textContent = title;
  const parts = onlineInChat[activeChatId] || (activeChatId ? chatsList.find(c=>c.chatId===activeChatId)?.members || [] : []);
  logEl("participants").textContent = "Participants: " + parts.join(", ");
}

// ---------- load history ----------
async function loadHistoryForChat(chatId){
  if(!token) return;
  try{
    const res = await fetch(`/chats/${encodeURIComponent(chatId)}/history?token=${encodeURIComponent(token)}&limit=200`);
    if(!res.ok) throw new Error("history failed");
    const msgs = await res.json();
    // clear messages view
    logEl("messages").innerHTML = "";
    for(const m of msgs){
      const isLocal = (m.sender === myUserId);
      appendMessageToUi(m.sender, m.text, isLocal, m.timestamp);
    }
    // scroll bottom
    logEl("messages").scrollTop = 999999;
  }catch(e){
    console.warn("history load error", e);
  }
}

// ---------- WebRTC config ----------
const configuration = {
  iceServers: [

    { urls: "stun:stun.l.google.com:19302" },

    {
      urls: "turn:193.42.113.15:3478",
      username: "server",
      credential: "pserver"
    }

  ]
};

// ---------- peer helpers ----------
function createPeerFor(peerId, chatId){
  const pc = new RTCPeerConnection(configuration);
  pcs[peerId] = pc;
  candidateQueues[peerId] = candidateQueues[peerId] || [];
  // clear reconnect attempts on success
  if(reconnectTimers[peerId]){ clearTimeout(reconnectTimers[peerId].timerId); reconnectTimers[peerId].attempts = 0; }

  pc.onicecandidate = ev => {
    if(ev.candidate){
      safeSendSignal(peerId, chatId, { type:"candidate", candidate: ev.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    log(`PC[${peerId}] state: ${pc.connectionState}`);
    if(pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed"){
      // cleanup and schedule reconnect attempts
      try{ pc.close(); }catch(e){}
      delete pcs[peerId];
      delete dataChannels[peerId];
      scheduleReconnect(peerId, chatId);
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
  dc.onmessage = ev => appendMessageToUi(peerId, ev.data, false, Date.now());
  dc.onclose = () => { log(`DC[${peerId}] closed`); scheduleReconnect(peerId, activeChatId); };
}

// ---------- signaling helper ----------
function safeSendSignal(target, chatId, data){
  if(!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type:"signal", target, from: myUserId, chatId, data }));
}

// ---------- start connection as caller ----------
async function startConnectionToPeer(peerId, chatId){
  if(pcs[peerId]) return;
  // caller tie-break: deterministic to avoid double-offer: only smaller id starts
  if(!(myUserId < peerId)) return;
  const pc = createPeerFor(peerId, chatId);
  const channel = pc.createDataChannel("chat");
  dataChannels[peerId] = channel;
  setupDataChannel(peerId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  safeSendSignal(peerId, chatId, { type:"offer", offer });
}

// ---------- handle incoming signals ----------
async function handleSignal(from, chatId, data){
  const peerId = from;
  if(data.type === "offer"){
    if(!pcs[peerId]) createPeerFor(peerId, chatId);
    const pc = pcs[peerId];
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    safeSendSignal(peerId, chatId, { type:"answer", answer });
    // flush candidates
    if(candidateQueues[peerId]){
      for(const c of candidateQueues[peerId]) await pc.addIceCandidate(c);
      candidateQueues[peerId] = [];
    }
    return;
  }
  if(data.type === "answer"){
    const pc = pcs[peerId];
    if(pc){
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      if(candidateQueues[peerId]){
        for(const c of candidateQueues[peerId]) await pc.addIceCandidate(c);
        candidateQueues[peerId] = [];
      }
    }
    return;
  }
  if(data.type === "candidate"){
    const pc = pcs[peerId];
    if(pc && pc.remoteDescription){
      await pc.addIceCandidate(data.candidate);
    }else{
      candidateQueues[peerId] = candidateQueues[peerId] || [];
      candidateQueues[peerId].push(data.candidate);
    }
    return;
  }
}

// ---------- reconnect scheduling ----------
function scheduleReconnect(peerId, chatId){
  // if already scheduled — do nothing
  if(reconnectTimers[peerId] && reconnectTimers[peerId].timerId) return;
  reconnectTimers[peerId] = reconnectTimers[peerId] || { attempts:0, timerId:null };
  const state = reconnectTimers[peerId];
  state.attempts = Math.min(10, state.attempts + 1);
  const delay = Math.min(30000, 1000 * Math.pow(2, state.attempts)); // exponential backoff
  log(`Scheduling reconnect to ${peerId} in ${Math.round(delay/1000)}s (attempt ${state.attempts})`);
  state.timerId = setTimeout(async () => {
    state.timerId = null;
    // try connect if peer is online and active chat
    const online = (onlineInChat[chatId] || []).includes(peerId);
    if(online && activeChatId === chatId){
      await startConnectionToPeer(peerId, chatId);
    } else {
      // reschedule later
      scheduleReconnect(peerId, chatId);
    }
  }, delay);
}

// try connect to all online peers in chat
function tryAutoConnectToChatPeers(chatId){
  const users = onlineInChat[chatId] || [];
  for(const peer of users){
    if(peer === myUserId) continue;
    if(!pcs[peer]){
      // attempt start if tie-break
      startConnectionToPeer(peer, chatId);
    }
  }
}

// ---------- send message (button) ----------
document.getElementById("btnSend").onclick = async () => {
  const text = document.getElementById("message").value.trim();
  if(!activeChatId || !token) return alert("open a chat");
  if(!text) return;
  const chat = chatsList.find(c=>c.chatId===activeChatId);
  if(!chat) return;

  const peers = chat.members.filter(m=>m!==myUserId);
  let sentP2P = false;
  for(const p of peers){
    const dc = dataChannels[p];
    if(dc && dc.readyState === "open"){
      dc.send(text);
      appendMessageToUi(p, text, true, Date.now());
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
    appendMessageToUi(null, text, true, Date.now());
    log("Sent via server fallback");
  }
  document.getElementById("message").value = "";
};

// append message UI
function appendMessageToUi(peerId, text, isLocal, ts){
  const m = document.createElement("div");
  const who = isLocal ? "Me" : (peerId || "Server");
  const cls = isLocal ? "msg-local" : "msg-remote";
  m.className = cls;
  const time = ts ? new Date(ts).toLocaleTimeString() : "";
  m.textContent = `${who}: ${text} ${time ? "(" + time + ")" : ""}`;
  logEl("messages").appendChild(m);
  logEl("messages").scrollTop = 99999;
}

// ---------- inbox polling for active chat ----------
async function checkInboxForChat(chatId){
  if(!token || !myUserId) return;
  try{
    const res = await fetch(`/inbox/${encodeURIComponent(myUserId)}?token=${encodeURIComponent(token)}&chatId=${encodeURIComponent(chatId)}`);
    if(!res.ok) return;
    const msgs = await res.json();
    for(const m of msgs){
      appendMessageToUi(m.sender, m.text, false, m.timestamp);
      await fetch("/delivered", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ token, id: m.id }) });
    }
  }catch(e){
    console.warn("inbox error", e);
  }
}
setInterval(() => {
  if(activeChatId) checkInboxForChat(activeChatId);
}, 4000);