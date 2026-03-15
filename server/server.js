const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const cors = require("cors");

const messages = require("./messages");

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

app.use(express.static("../client"));

let clients = {};

wss.on("connection",(ws)=>{

    let clientId = null;

    ws.on("message",(message)=>{

        const data = JSON.parse(message);

        switch(data.type){

            case "register":

                clientId = data.id;
                clients[clientId] = ws;

                console.log("Client registered:",clientId);

                break;

            case "signal":

                const target = clients[data.target];

                if(target){

                    target.send(JSON.stringify({
                        type:"signal",
                        from:clientId,
                        data:data.data
                    }));

                }

                break;

        }

    });

    ws.on("close",()=>{

        if(clientId){
            delete clients[clientId];
        }

    });

});


app.post("/send",(req,res)=>{

    const {sender,receiver,text} = req.body;

    if(!sender || !receiver || !text){

        return res.status(400).send("invalid");

    }

    messages.storeMessage(sender,receiver,text);

    res.send({status:"stored"});

});

app.get("/inbox/:user",(req,res)=>{

    messages.getMessages(req.params.user,(rows)=>{

        res.send(rows);

    });

});

app.post("/delivered",(req,res)=>{

    const {id} = req.body;

    messages.markDelivered(id);

    res.send({status:"ok"});

});

server.listen(3000,"0.0.0.0",()=>{

    console.log("Signaling + Store server running");

});