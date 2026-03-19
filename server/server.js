// server.js
require("./db/init");
require("dotenv").config();
const users = require("./users");

const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const https = require("https");
const fs = require("fs");
const cors = require("cors");
const crypto = require("crypto");
const webpush = require("web-push");

const messages = require("./messages"); // оставляем твою реализацию, но она должна поддерживать chatId
const pushStore = require("./pushSubscriptions");

const webpush = require("web-push");

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:idimal@internet.ru",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const app = express();
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:idimal@internet.ru";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("Push disabled: VAPID keys are missing.");
}

const useHttps = process.env.HTTPS_ENABLED === "1";

const server = useHttps
  ? https.createServer(
      {
        key: fs.readFileSync(process.env.SSL_KEY),
        cert: fs.readFileSync(process.env.SSL_CERT),
      },
      app
    )
  : http.createServer(app);

const wss = new WebSocket.Server({ server });

// const server = http.createServer(app);
// const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static("../client"));
app.get("/push/public-key", (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(500).send({ error: "push disabled" });
  }
  res.send({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/push/subscribe", (req, res) => {
  const { token, subscription } = req.body;
  const userId = tokens[token];

  if (!userId) return res.status(403).send({ error: "not auth" });
  if (!subscription) return res.status(400).send({ error: "no subscription" });

  pushStore.saveSubscription(userId, subscription, ok => {
    if (!ok) return res.status(500).send({ error: "save failed" });
    res.send({ status: "ok" });
  });
});

app.post("/push/unsubscribe", (req, res) => {
  const { token, endpoint } = req.body;
  const userId = tokens[token];

  if (!userId) return res.status(403).send({ error: "not auth" });
  if (!endpoint) return res.status(400).send({ error: "no endpoint" });

  pushStore.deleteSubscription(endpoint, () => {
    res.send({ status: "ok" });
  });
});

// In-memory stores (replace with DB for production)
const usersMem = {};      // userId -> { password }  (demo only: plaintext)
const tokens = {};     // token -> userId
const chats = {};      // chatId -> { name, members: [userId] }
const clients = {};    // userId -> ws

// helper: generate token
function genToken() {
  return crypto.randomBytes(16).toString("hex");
}

// ----------- HTTP API: auth / chats / messages ---------------

// Register (demo: no email)
app.post("/auth/register", (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password) return res.status(400).send({ error: "invalid" });
  if (usersMem[userId]) return res.status(400).send({ error: "exists" });

  usersMem[userId] = { password };
  return res.send({ status: "ok" });
});

// Login -> returns token
app.post("/auth/login", (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password) return res.status(400).send({ error: "invalid" });
  const u = usersMem[userId];
  if (!u || u.password !== password) return res.status(403).send({ error: "bad credentials" });
  const token = genToken();
  tokens[token] = userId;
  return res.send({ token, userId });
});

// Create chat
app.post("/chats", (req, res) => {
  const { token, name, members } = req.body;
  const userId = tokens[token];
  if (!userId) return res.status(403).send({ error: "not auth" });
  const chatId = crypto.randomBytes(8).toString("hex");
  const uniqueMembers = Array.from(new Set([userId, ...(members||[])]));
  chats[chatId] = { name: name||("chat-"+chatId), members: uniqueMembers };
  // notify members who are online
  broadcastChatParticipants(chatId);
  return res.send({ chatId, chat: chats[chatId] });
});

app.post("/register",(req,res)=>{

    const {id,password} = req.body;

    users.createUser(id,password,(ok)=>{

        if(ok){
            res.send({status:"ok"});
        }else{
            res.send({status:"error"});
        }

    });

});

app.post("/login",(req,res)=>{

    const {id,password} = req.body;

    users.authUser(id,password,(ok)=>{

        if(ok){
            res.send({status:"ok"});
        }else{
            res.send({status:"fail"});
        }

    });

});

app.get("/users",(req,res)=>{

    users.getAllUsers((list)=>{

        res.send(list);

    });

});

// List chats for user
app.get("/chats", (req, res) => {
  const token = req.query.token;
  const userId = tokens[token];
  if (!userId) return res.status(403).send({ error: "not auth" });
  const myChats = Object.entries(chats).filter(([id,ch]) => ch.members.includes(userId)).map(([id,ch])=>({ chatId:id, ...ch }));
  return res.send(myChats);
});

// Add member to chat
app.post("/chats/:chatId/add", (req, res) => {
  const { token, member } = req.body;
  const userId = tokens[token];
  if (!userId) return res.status(403).send({ error: "not auth" });
  const chat = chats[req.params.chatId];
  if(!chat) return res.status(404).send({ error: "no chat" });
  if(!chat.members.includes(userId)) return res.status(403).send({ error: "not member" });
  if(!chat.members.includes(member)) chat.members.push(member);
  broadcastChatParticipants(req.params.chatId);
  return res.send({ status: "ok" });
});

// Send message via server (store-and-forward), supports chatId + receiver
app.post("/chats/:chatId/messages", (req, res) => {
  const { token, text } = req.body;
  const userId = tokens[token];
  if (!userId) return res.status(403).send({ error: "not auth" });

  const chatId = req.params.chatId;
  const chat = chats[chatId];
  if (!chat || !chat.members.includes(userId)) {
    return res.status(403).send({ error: "no access" });
  }

  if (!text || !text.trim()) {
    return res.status(400).send({ error: "empty text" });
  }

  const recipients = chat.members.filter(m => m !== userId);

  messages.storeMessage(userId, chatId, text.trim(), recipients, (ok, meta) => {
    if (!ok) return res.status(500).send({ error: "store failed" });

    res.send({
      status: "stored",
      messageId: meta.messageId,
      timestamp: meta.timestamp
    });

    const offlineRecipients = recipients.filter(r => !clients[r]);
    if (offlineRecipients.length === 0) return;

    const payload = {
      title: chat.name || "Новое сообщение",
      body: `${userId}: ${text.trim()}`.slice(0, 180),
      chatId,
      messageId: meta.messageId,
      url: `/chat.html?chatId=${encodeURIComponent(chatId)}`
    };

    for (const receiver of offlineRecipients) {
      sendPushToUser(receiver, payload);
    }
  });
});

// Get undelivered messages for user (optionally filtered by chat)
app.get("/inbox/:user", (req, res) => {
  const token = req.query.token;
  const userId = tokens[token];
  if (!userId || userId !== req.params.user) return res.status(403).send({ error: "not auth" });
  const chatId = req.query.chatId;
  messages.getMessagesForUser(userId, chatId, (rows) => {
    res.send(rows);
  });
});

// mark delivered
app.post("/delivered", (req, res) => {
  const { token, messageId } = req.body;
  const userId = tokens[token];
  if (!userId) return res.status(403).send({ error: "not auth" });
  messages.markDelivered(messageId, userId);
  res.send({ status: "ok" });
});

// history (chat)
app.get("/chats/:chatId/history", (req, res) => {
  const token = req.query.token;
  const userId = tokens[token];
  const chatId = req.params.chatId;
  const limit = parseInt(req.query.limit || "200", 10);
  if (!userId) return res.status(403).send({ error: "not auth" });
  const chat = chats[chatId];
  if(!chat || !chat.members.includes(userId)) return res.status(403).send({ error: "no access" });
  messages.getHistory(chatId, limit, (rows) => {
    res.send(rows);
  });
});

function sendPushToUser(userId, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  pushStore.getSubscriptionsForUser(userId, subs => {
    for (const row of subs) {
      const subscription = {
        endpoint: row.endpoint,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth,
        },
      };

      webpush.sendNotification(subscription, JSON.stringify(payload)).catch(err => {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) {
          pushStore.deleteSubscription(row.endpoint, () => {});
        } else {
          console.error("webpush error:", err.message || err);
        }
      });
    }
  });
}

// ------------------------------------------------------------

// WebSocket handling: register + signaling + chat participants broadcast
wss.on("connection", (ws) => {
  let userId = null;

  ws.on("message", (message) => {
    let data;
    try { data = JSON.parse(message); } catch(e){ return; }

    // register: { type:"register", userId, token }
    if (data.type === "register") {
      const token = data.token;
      const uid = tokens[token];
      if (!uid || uid !== data.userId) {
        ws.send(JSON.stringify({ type: "error", error: "auth failed" }));
        return;
      }
      userId = uid;
      clients[userId] = ws;
      console.log("WS: registered", userId);
      // send list of chats for this user
      sendChatListToUser(userId);
      // notify participants in chats
      Object.entries(chats).forEach(([chatId, chat]) => {
        if (chat.members.includes(userId)) broadcastChatParticipants(chatId);
      });
      return;
    }

    // signaling: { type:"signal", target, from, chatId, data }
    if (data.type === "signal") {
      const target = data.target;
      // validation: check both users are in same chat
      const chatId = data.chatId;
      const chat = chats[chatId];
      if (!userId || !chat || !chat.members.includes(userId)) {
        ws.send(JSON.stringify({ type: "error", error: "not in chat" }));
        return;
      }
      if (!chat.members.includes(target)) {
        ws.send(JSON.stringify({ type: "error", error: "target not in chat" }));
        return;
      }
      const targetWs = clients[target];
      if (targetWs) {
        targetWs.send(JSON.stringify({
          type: "signal",
          from: userId,
          chatId,
          data: data.data
        }));
      }
      return;
    }
  });

  ws.on("close", () => {
    if (userId) {
      delete clients[userId];
      console.log("WS: closed", userId);
      // notify chats
      Object.entries(chats).forEach(([chatId, chat]) => {
        if (chat.members.includes(userId)) broadcastChatParticipants(chatId);
      });
    }
  });

});

// helpers

function sendChatListToUser(userId){
  const ws = clients[userId];
  if(!ws) return;
  const myChats = Object.entries(chats)
    .filter(([id,ch]) => ch.members.includes(userId))
    .map(([id,ch]) => ({ chatId: id, name: ch.name, members: ch.members }));
  ws.send(JSON.stringify({ type: "chats", chats: myChats }));
}

function broadcastChatParticipants(chatId){

    const chat = chats[chatId];
    if(!chat) return;
  
    const online = chat.members.filter(u => clients[u]);
  
    const msg = JSON.stringify({
        type: "chat-participants",
        chatId,
        users: online
    });
  
    for(const u of chat.members){
        const ws = clients[u];
        if(ws) ws.send(msg);
    }
  
  }

  server.listen(3000, "0.0.0.0", () => {
    console.log(`Server running on 3000 (${useHttps ? "https" : "http"})`);
  });