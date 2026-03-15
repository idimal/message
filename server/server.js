const express = require("express");
const WebSocket = require("ws");
const http = require("http");

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

app.use(express.static("../client"));

let clients = {};

wss.on("connection", (ws) => {

    let clientId = null;

    ws.on("message", (message) => {

        const data = JSON.parse(message);

        switch(data.type){

            case "register":

                clientId = data.id;
                clients[clientId] = ws;

                console.log("Client registered:", clientId);

                break;

            case "signal":

                const target = clients[data.target];

                if(target){

                    target.send(JSON.stringify({
                        type: "signal",
                        from: clientId,
                        data: data.data
                    }));

                }

                break;

        }

    });

    ws.on("close", () => {

        if(clientId){
            delete clients[clientId];
            console.log("Client disconnected:", clientId);
        }

    });

});

server.listen(3000, () => {
    console.log("Signaling server running on port 3000");
});