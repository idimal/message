let ws;
let pc;
let dataChannel;

let myId;
let peerId;

let candidateQueue = [];

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

    ws.onclose = () => {

        log("Signaling disconnected");

        setTimeout(connect,3000);

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

    pc.onconnectionstatechange = ()=>{

        log("Connection state: " + pc.connectionState);

        if(pc.connectionState === "failed"){

            log("Connection failed");

        }

    };

    pc.ondatachannel = (event)=>{

        dataChannel = event.channel;

        setupChannel();

    };

}

function setupChannel(){

    dataChannel.onopen = ()=>{

        log("DataChannel opened");

    };

    dataChannel.onmessage = (event)=>{

        log("Peer: " + event.data);

    };

    dataChannel.onclose = ()=>{

        log("DataChannel closed");

    };

}

async function startConnection(){

    createPeer();

    dataChannel = pc.createDataChannel("chat");

    setupChannel();

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

        await flushCandidates();

    }

    if(data.type === "answer"){

        await pc.setRemoteDescription(data.answer);

        await flushCandidates();

    }

    if(data.type === "candidate"){

        if(pc.remoteDescription){

            await pc.addIceCandidate(data.candidate);

        }else{

            candidateQueue.push(data.candidate);

        }

    }

}

async function flushCandidates(){

    for(const c of candidateQueue){

        await pc.addIceCandidate(c);

    }

    candidateQueue = [];

}

function sendMessage(){

    const msg = document.getElementById("message").value;

    if(dataChannel && dataChannel.readyState === "open"){

        dataChannel.send(msg);

        log("Me: " + msg);

    }else{

        log("Channel not ready");

    }

}

