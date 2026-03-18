// app.js — унифицированный клиент (используется на index/create/chat pages)
let ws;
let myUserId = null;
let token = null;
let typingTimeout = null;

// peer state (частично сохранено из оригинала)
const pcs = {};
const dataChannels = {};
const candidateQueues = {};
const reconnectTimers = {};
const renderedMessageIds = {};

// chat state
let activeChatId = null;
let chatsList = []; // загружаются с сервера
const onlineInChat = {}; // chatId -> [userIds]

// UI helpers
const q = id => document.getElementById(id);
function log(msg){
  const el = q("log");
  if(!el) return console.log(msg);
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
}

function showTyping(){
  const el = document.getElementById("typing");
  if(!el) return;
  el.classList.remove("hidden");

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    el.classList.add("hidden");
  }, 2000);
}

// --- init проверка авторизации ---
// возвращает true если токен есть, иначе перенаправляет на login и возвращает false
function app_init(){
  token = localStorage.getItem("token");
  myUserId = localStorage.getItem("userId");
  if(!token || !myUserId){
    location.href = "/login.html";
    return false;
  }
  // show account info if exists
  const ai = q("accountInfo");
  if(ai) ai.textContent = "Вы: " + myUserId;
  // старт WS (страницы могут захотеть дополнительную инициализацию)
  startWebSocket();
  return true;
}

// --- Карты/загрузка списка чатов (index) ---
async function app_loadChats(){
  if(!token) return;
  try{
    const res = await fetch("/chats?token="+encodeURIComponent(token));
    if(!res.ok) throw new Error("no auth");
    chatsList = await res.json();
    renderChats();
  }catch(e){
    console.warn(e);
    localStorage.removeItem("token");
    localStorage.removeItem("userId");
    location.href = "/login.html";
  }
}

function isChatOnline(chat){
  const online = onlineInChat[chat.chatId] || [];
  return online.length > 1;
}

function renderChats(){
  
  const cont = q("chats");
  const empty = q("emptyHint");
  if(!cont) return;
  cont.innerHTML = "";
  if(!chatsList || chatsList.length === 0){
    if(empty) empty.style.display = "block";
    return;
  }
  if(empty) empty.style.display = "none";
  chatsList.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "chat-card";
    el.style.animationDelay = (i * 0.05) + "s";
    el.innerHTML = `
  <div style="display:flex;justify-content:space-between;">
    <div class="chat-name">${escapeHtml(c.name)}</div>
    <div class="status-dot ${isChatOnline(c) ? 'status-online' : ''}"></div>
  </div>
  <div class="chat-members">${escapeHtml((c.members||[]).join(", "))}</div>
`;
    el.onclick = () => { location.href = "/chat.html?chatId="+encodeURIComponent(c.chatId); };
    cont.appendChild(el);
  });
}

// --- WebSocket signaling (shared) ---
function startWebSocket(){
  if(ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try{
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  }catch(e){
    log("WS create error: " + e.message);
    return;
  }
  ws.onopen = () => {
    ws.send(JSON.stringify({ type:"register", userId: myUserId, token }));
    log("WS: подключено");
  };
  ws.onmessage = async (ev) => {
    try{
      const msg = JSON.parse(ev.data);
      if(msg.type === "chats"){
        chatsList = msg.chats;
        renderChats();
      } else if(msg.type === "chat-participants"){
        onlineInChat[msg.chatId] = msg.users;
      
        if(msg.chatId === activeChatId){
          renderActiveChat();
      
          // 🔥 всегда пробуем восстановить
          setTimeout(() => {
            tryAutoConnectToChatPeers(msg.chatId);
          }, 300);
        }
      } else if(msg.type === "signal"){
        await handleSignal(msg.from, msg.chatId, msg.data);
      } else if(msg.type === "error"){
        log("Сервер: " + (msg.error || ""));
      } else if(msg.type === "typing"){
        if(msg.userId !== myUserId && msg.chatId === activeChatId){
          showTyping();
        }
      }
    }catch(e){ console.warn("ws msg err", e); }
  };
  ws.onclose = () => {
    log("WS: закрыт, пробуем переподключиться...");
    setTimeout(startWebSocket, 3000);
  };
  ws.onerror = (e) => { console.warn("ws error", e); };
}

// --- Chat page: открыть чат, загрузить историю, render ---
async function app_openChat(chatId){
  activeChatId = chatId;
  resetRenderedSet(chatId);
  await app_loadChats(); // убедимся, что список чатов загружен (для названия/участников)
  renderActiveChat();
  await app_loadHistory(chatId);
  tryAutoConnectToChatPeers(chatId);
  // запрашивать входящие сообщения каждые 4 сек
  if(typeof app_inboxInterval === 'undefined'){
    window.app_inboxInterval = setInterval(() => { if(activeChatId) checkInboxForChat(activeChatId); }, 4000);
  }
}

function renderActiveChat(){
  const titleEl = q("chatTitle");
  const partsEl = q("participants");
  if(titleEl){
    const title = activeChatId ? (chatsList.find(c=>c.chatId===activeChatId)?.name || activeChatId) : "Чат";
    titleEl.textContent = title;
  }
  if(partsEl){
    const parts = onlineInChat[activeChatId] || (activeChatId ? chatsList.find(c=>c.chatId===activeChatId)?.members || [] : []);
    partsEl.innerHTML = parts.map(p=>{
      const online = (onlineInChat[activeChatId]||[]).includes(p);
      return `<span>${p} <span class="status-dot ${online?'status-online':''}"></span></span>`;
    }).join(", ");
  }
}

// --- История сообщений и UI ---
async function app_loadHistory(chatId){
  if(!token) return;
  try{
    const res = await fetch(`/chats/${encodeURIComponent(chatId)}/history?token=${encodeURIComponent(token)}&limit=200`);
    if(!res.ok) throw new Error("history failed");
    const msgs = await res.json();
    // clear and append
    const mcont = q("messages");
    if(mcont) mcont.innerHTML = "";
    for(const m of msgs){
      const isLocal = (m.sender === myUserId);
      appendMessageToUi(m.sender, m.text, isLocal, m.timestamp, m.id, chatId);
    }
    if(mcont) mcont.scrollTop = mcont.scrollHeight;
  }catch(e){
    console.warn("history load error", e);
  }
}

function sendTyping(isTyping){
  if(!ws || ws.readyState !== WebSocket.OPEN || !activeChatId) return;
  ws.send(JSON.stringify({
    type: "typing",
    chatId: activeChatId,
    userId: myUserId,
    isTyping
  }));
}

// --- отправка сообщения (используется на chat.html) ---
async function app_sendMessage(){
  sendTyping(false);
  const txtInput = q("message");
  if(!txtInput) return;

  const text = txtInput.value.trim();
  if(!activeChatId || !token) { alert("Откройте чат"); return; }
  if(!text) return;

  const chat = chatsList.find(c => c.chatId === activeChatId);
  if(!chat) return;

  let messageId = null;
  let savedTimestamp = Date.now();

  try{
    const res = await fetch(`/chats/${encodeURIComponent(activeChatId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, text })
    });

    if(!res.ok) throw new Error("save failed");

    const data = await res.json();
    messageId = data.messageId;
    savedTimestamp = data.timestamp || savedTimestamp;
  }catch(e){
    console.warn("Server save failed:", e);
    alert("Не удалось сохранить сообщение на сервере.");
    return;
  }

  // показать локально один раз
  appendMessageToUi(myUserId, text, true, savedTimestamp, messageId, activeChatId);

  const peers = chat.members.filter(m => m !== myUserId);
  const payload = JSON.stringify({
    type: "chat-message",
    messageId,
    chatId: activeChatId,
    sender: myUserId,
    text,
    timestamp: savedTimestamp
  });

  let sentP2P = false;
  for(const p of peers){
    const dc = dataChannels[p];
    if(dc && dc.readyState === "open"){
      try{
        dc.send(payload);
        sentP2P = true;
      }catch(e){
        console.warn("send p2p err", e);
      }
    }
  }

  if(!sentP2P){
    log("Сохранено на сервере, доставка пойдёт через fallback.");
  }

  txtInput.value = "";
}

// append message UI helper
function appendMessageToUi(peerId, text, isLocal, ts, messageId, chatId){
  const targetChatId = chatId || activeChatId;
  if(messageId && targetChatId){
    const seen = getRenderedSet(targetChatId);
    const key = messageId
  ? String(messageId)
  : `${peerId}_${text}_${ts}`;
    if(seen.has(key)) return;
    seen.add(key);
  }

  const mcont = q("messages");
  if(!mcont){
    log((isLocal ? "Я" : (peerId||"Сервер")) + ": " + text);
    return;
  }

  const row = document.createElement("div");
  row.className = "msg-row";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble " + (isLocal ? "msg-local" : "msg-remote");
  bubble.textContent = text;
  row.appendChild(bubble);

  const meta = document.createElement("div");
  meta.className = "msg-meta small";
  const who = isLocal ? "Я" : (peerId || "Сервер");
  meta.textContent = who + (ts ? " • " + new Date(ts).toLocaleTimeString() : "");
  bubble.appendChild(meta);

  mcont.appendChild(row);
  mcont.scrollTop = mcont.scrollHeight;
}

// --- inbox polling (fallback) ---
async function checkInboxForChat(chatId){
  if(!token || !myUserId) return;
  try{
    const res = await fetch(`/inbox/${encodeURIComponent(myUserId)}?token=${encodeURIComponent(token)}&chatId=${encodeURIComponent(chatId)}`);
    if(!res.ok) return;
    const msgs = await res.json();
    for(const m of msgs){
      appendMessageToUi(
        m.sender,
        m.text,
        false,
        m.timestamp,
        m.id, // ВАЖНО
        chatId
      );
    
      await fetch("/delivered", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, messageId: m.id })
      });
    }
  }catch(e){ console.warn("inbox error", e); }
}

// --- WebRTC parts (перенесены из оригинала, сокращены, но функционал оставлен) ---
const configuration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "turn:193.42.113.15:3478", username: "server", credential: "pserver" }
  ]
};

function getRenderedSet(chatId){
  if(!renderedMessageIds[chatId]) renderedMessageIds[chatId] = new Set();
  return renderedMessageIds[chatId];
}

function resetRenderedSet(chatId){
  renderedMessageIds[chatId] = new Set();
}


function createPeerFor(peerId, chatId){
  const pc = new RTCPeerConnection(configuration);
  pcs[peerId] = pc;
  candidateQueues[peerId] = candidateQueues[peerId] || [];
  if(reconnectTimers[peerId]){ clearTimeout(reconnectTimers[peerId].timerId); reconnectTimers[peerId].attempts = 0; }

  pc.onicecandidate = ev => {
    if(ev.candidate){
      safeSendSignal(peerId, chatId, { type:"candidate", candidate: ev.candidate });
    }
  };
  pc.onconnectionstatechange = () => {
    log(`PC[${peerId}] ${pc.connectionState}`);
    if(pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed"){
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
  dc.onopen = () => {
    log(`DC[${peerId}] открыт`);
  
    // 🔥 сброс таймера реконнекта
    if(reconnectTimers[peerId]){
      clearTimeout(reconnectTimers[peerId].timerId);
      reconnectTimers[peerId].timerId = null;
      reconnectTimers[peerId].attempts = 0;
    }
  };
  dc.onmessage = ev => {
    try{
      const msg = JSON.parse(ev.data);
  
      if(msg.type === "chat-message"){
        appendMessageToUi(
          msg.sender,
          msg.text,
          msg.sender === myUserId,
          msg.timestamp,
          msg.messageId,
          msg.chatId
        );
      }
  
    }catch(e){
      console.warn("Invalid message format", ev.data);
    }
  };
  dc.onclose = () => { log(`DC[${peerId}] закрыт`); scheduleReconnect(peerId, activeChatId); };
}

function safeSendSignal(target, chatId, data){
  if(!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type:"signal", target, from: myUserId, chatId, data }));
}

async function startConnectionToPeer(peerId, chatId){
  if(isPeerAlive(peerId)) return;
   if(!(myUserId < peerId)) return; // tie-break
  const pc = createPeerFor(peerId, chatId);
  const channel = pc.createDataChannel("chat");
  dataChannels[peerId] = channel;
  setupDataChannel(peerId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  safeSendSignal(peerId, chatId, { type:"offer", offer });
}

async function handleSignal(from, chatId, data){
  const peerId = from;
  if(data.type === "offer"){
    if(!pcs[peerId]) createPeerFor(peerId, chatId);
    const pc = pcs[peerId];
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    safeSendSignal(peerId, chatId, { type:"answer", answer });
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

function scheduleReconnect(peerId, chatId){
  if(reconnectTimers[peerId] && reconnectTimers[peerId].timerId) return;
  reconnectTimers[peerId] = reconnectTimers[peerId] || { attempts:0, timerId:null };
  const state = reconnectTimers[peerId];
  state.attempts = Math.min(10, state.attempts + 1);
  const delay = Math.min(30000, 1000 * Math.pow(2, state.attempts));
  log(`Переподключение к ${peerId} через ${Math.round(delay/1000)}с (попытка ${state.attempts})`);
  state.timerId = setTimeout(async () => {
    state.timerId = null;
    const online = (onlineInChat[chatId] || []).includes(peerId);
    if(online && activeChatId === chatId){
      await startConnectionToPeer(peerId, chatId);
    } else {
      scheduleReconnect(peerId, chatId);
    }
  }, delay);
}

function isPeerAlive(peerId){
  const pc = pcs[peerId];
  const dc = dataChannels[peerId];

  if(!pc || !dc) return false;

  if(pc.connectionState !== "connected") return false;
  if(dc.readyState !== "open") return false;

  return true;
}

function tryAutoConnectToChatPeers(chatId){
  const users = onlineInChat[chatId] || [];

  for(const peer of users){
    if(peer === myUserId) continue;

    if(!isPeerAlive(peer)){
      console.log("Пересоздаём соединение с", peer);

      // 💣 ВАЖНО: убиваем старое соединение полностью
      if(pcs[peer]){
        try{ pcs[peer].close(); }catch(e){}
        delete pcs[peer];
      }

      if(dataChannels[peer]){
        try{ dataChannels[peer].close(); }catch(e){}
        delete dataChannels[peer];
      }

      startConnectionToPeer(peer, chatId);
    }
  }
}

setInterval(() => {
  if(!activeChatId) return;

  const users = onlineInChat[activeChatId] || [];

  for(const peer of users){
    if(peer === myUserId) continue;

    if(!isPeerAlive(peer)){
      console.log("Watchdog: reconnect to", peer);

      if(pcs[peer]){
        try{ pcs[peer].close(); }catch(e){}
        delete pcs[peer];
      }

      if(dataChannels[peer]){
        try{ dataChannels[peer].close(); }catch(e){}
        delete dataChannels[peer];
      }

      startConnectionToPeer(peer, activeChatId);
    }
  }

}, 5000);

// --- Утилиты ---
function escapeHtml(s){ if(!s) return ""; return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }

// --- Экспорт для страниц (вызываемые функции) ---
window.app_init = app_init;
window.app_loadChats = app_loadChats;
window.app_openChat = app_openChat;
window.app_loadHistory = app_loadHistory;
window.app_sendMessage = app_sendMessage;