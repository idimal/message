let ws;
let pc;
let dataChannel;

let myId;
let peerId;

let candidateQueue = [];

myId = localStorage.getItem("myId") || myId;
peerId = localStorage.getItem("peerId") || peerId;

localStorage.setItem("myId",myId);
localStorage.setItem("peerId",peerId);

const log = (msg) => {
    document.getElementById("log").textContent += msg + "\n";
};

function connect(){

    myId = document.getElementById("myId").value;
    peerId = null;

    ws = new WebSocket("ws://" + location.host);

    ws.onopen = () => {

        ws.send(JSON.stringify({
            type:"register",
            id: myId
        }));
    
        log("Connected to signaling server");
    
        // автоматически пробуем создать P2P
        setTimeout(() => {
    
            if(peerId){
                startConnection();
            }
    
        },1000);
    
    };

    ws.onmessage = async (event) => {

        const msg = JSON.parse(event.data);

        if(msg.type === "signal"){
            await handleSignal(msg.data);
        }
        
        if(msg.type === "users"){
        
            const others = msg.users.filter(u => u !== myId);
        
            if(others.length > 0){
        
                peerId = others[0];
        
                log("Discovered peer: " + peerId);
        
                if(!pc){
                    startConnection();
                }
        
            }
        
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
    
        if(pc.connectionState === "failed" || pc.connectionState === "disconnected"){
    
            log("Reconnecting P2P...");
    
            setTimeout(()=>{
                startConnection();
            },3000);
    
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
    if(pc && pc.connectionState === "connected"){
        return;
    }

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

        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

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

        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));

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

async function sendMessage(){
    if(!dataChannel || dataChannel.readyState !== "open"){
        log("P2P not ready, trying reconnect");
        startConnection();
    }

    const msg = document.getElementById("message").value;

    if(dataChannel && dataChannel.readyState === "open"){

        dataChannel.send(msg);

        log("Me: " + msg);

    }else{

        log("P2P unavailable → sending via server");

        await fetch("/send",{

            method:"POST",
            headers:{
                "Content-Type":"application/json"
            },
            body:JSON.stringify({

                sender:myId,
                receiver:peerId,
                text:msg

            })

        });

    }

}


async function checkInbox(){

    const res = await fetch("/inbox/"+myId);

    const msgs = await res.json();

    for(const m of msgs){

        log("Offline msg: "+m.text);

        await fetch("/delivered",{

            method:"POST",
            headers:{
                "Content-Type":"application/json"
            },
            body:JSON.stringify({id:m.id})

        });

    }

}


setInterval(checkInbox,4000);

window.onload = () => {

    connect();

};