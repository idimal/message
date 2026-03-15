const express = require("express");
const WebSocket = require("ws");

const app = express();
const port = 3000;

app.use(express.json());

app.get("/status", (req, res) => {
  res.send({ status: "ok" });
});

const server = app.listen(port, () => {
  console.log("Server running on port", port);
});

const wss = new WebSocket.Server({ server });

let clients = {};

wss.on("connection", (ws) => {

  ws.on("message", (message) => {

    const data = JSON.parse(message);

    if (data.type === "register") {
      clients[data.id] = ws;
    }

    if (data.type === "signal") {
      const target = clients[data.target];
      if (target) {
        target.send(JSON.stringify(data));
      }
    }

  });

  ws.on("close", () => {
    for (let id in clients) {
      if (clients[id] === ws) {
        delete clients[id];
      }
    }
  });

});