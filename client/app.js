let ws;
let pc;
let dataChannel;

let myId;
let peerId;

const log = (msg) => {
    document.getElementById("log").textContent += msg + "\n";
};

function connect(){

    myId = document.getElementById("myId").value;
    peerId = document.getElementById("peerId").value;

    ws = new WebSocket("ws://" + location.host);

    ws.onopen = () => {

        ws.send(JSON.stringify({
            type:"register",
            id: myId
        }));

        log("Connected to signaling server");

    };

    ws.onmessage = async (event) => {

        const msg = JSON.parse(event.data);

        if(msg.type === "signal"){

            await handleSignal(msg.data);

        }

    };

}

const configuration = {

    iceServers: [

        {
            urls: "stun:stun.l.google.com:19302"
        },

        {
            urls: "turn:192.168.10.216:3478",
            username: "server",
            credential: "pserver"
        }

    ]

};

function createPeer(){

    pc = new RTCPeerConnection(configuration);

    pc.onicecandidate = (event)=>{

        if(event.candidate){

            ws.send(JSON.stringify({
                type:"signal",
                target:peerId,
                data:{
                    type:"candidate",
                    candidate:event.candidate
                }
            }));

        }

    };

    pc.ondatachannel = (event)=>{

        dataChannel = event.channel;

        dataChannel.onmessage = (event)=>{
            log("Peer: " + event.data);
        };

    };

}


async function startConnection(){

    createPeer();

    dataChannel = pc.createDataChannel("chat");

    dataChannel.onmessage = (event)=>{
        log("Peer: " + event.data);
    };

    const offer = await pc.createOffer();

    await pc.setLocalDescription(offer);

    ws.send(JSON.stringify({
        type:"signal",
        target:peerId,
        data:{
            type:"offer",
            offer:offer
        }
    }));

}

async function handleSignal(data){

    if(data.type === "offer"){

        createPeer();

        await pc.setRemoteDescription(data.offer);

        const answer = await pc.createAnswer();

        await pc.setLocalDescription(answer);

        ws.send(JSON.stringify({
            type:"signal",
            target:peerId,
            data:{
                type:"answer",
                answer:answer
            }
        }));

    }

    if(data.type === "answer"){

        await pc.setRemoteDescription(data.answer);

    }

    if(data.type === "candidate"){

        await pc.addIceCandidate(data.candidate);

    }

}

function sendMessage(){

    const msg = document.getElementById("message").value;

    dataChannel.send(msg);

    log("Me: " + msg);

}