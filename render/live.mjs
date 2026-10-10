import { WebSocketServer, WebSocket } from 'ws';
// Every packet uses the same token, session and role validation as HTTP.
// The socket carries no token in its URL and never trusts a client-supplied role.
export function attachLiveRelay(server, POST) {
  const wss=new WebSocketServer({noServer:true,maxPayload:40_000,perMessageDeflate:false});
  const send=(ws,value)=>{if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<(value.kind==='realtime'?4_096:65_536))ws.send(JSON.stringify(value))};
  const sync=async(auth,mailbox)=>{
    const response=await POST(new Request('http://localhost/api/rooms',{method:'POST',body:JSON.stringify({action:'sync',...auth,...(mailbox?{mailbox}:{})})}));
    const result=await response.json();if(!response.ok)throw new Error('Unauthorized room');return result;
  };
  server.on('upgrade',(req,socket,head)=>{
    let valid=false;
    try {valid=new URL(req.url,'http://localhost').pathname==='/api/live'&&(!req.headers.origin||new URL(req.headers.origin).host===req.headers.host)}catch{}
    if(!valid){socket.destroy();return}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
  });
  wss.on('connection',ws=>{
    let auth=null,role=null,chain=Promise.resolve(),mailbox=null,windowStart=Date.now(),count=0;
    let latestMotion=null,motionQueued=false;
    const deadline=setTimeout(()=>{if(!auth)ws.close(1008,'Authentication required')},5000);
    ws.alive=true;ws.on('pong',()=>{ws.alive=true});
    ws.on('error',()=>{});
    ws.on('close',()=>clearTimeout(deadline));
    ws.on('message',(raw,binary)=>{
      if(binary){ws.close(1008,'Text messages required');return}
      if(Date.now()-windowStart>1000){windowStart=Date.now();count=0}
      if(++count>120){ws.close(1008,'Rate limit');return}
      let packet;
      try {packet=JSON.parse(raw.toString());if(!packet||typeof packet!=='object')throw Error('Invalid packet')}catch{ws.close(1008,'Invalid packet');return}
      const motion=packet.kind==='realtime';
      if(motion){
        latestMotion=packet;
        if(motionQueued)return;
        motionQueued=true;
      }
      chain=chain.then(async()=>{
        // Under a burst, replace queued positions with the newest one. Reliable
        // commands retain their own ordered queue and are never coalesced.
        if(motion){packet=latestMotion;latestMotion=null;motionQueued=false}
        if(ws.readyState!==WebSocket.OPEN)return;
        if(!auth){
          if(packet.kind!=='bind'||typeof packet.code!=='string'||typeof packet.token!=='string')throw Error('Invalid bind');
          const credentials={code:packet.code,token:packet.token};
          const result=await sync(credentials);
          auth=credentials;role=result.room.role;ws.code=auth.code;ws.role=role;ws.auth=auth;
          clearTimeout(deadline);send(ws,{kind:'sync',result});return;
        }
        if(packet.kind==='ping'){send(ws,{kind:'pong',t:packet.t,session:packet.session});return}
        if(!Number.isSafeInteger(packet.seq)||packet.seq<1||typeof packet.session!=='string')throw Error('Invalid packet');
        const fresh=await sync(auth);
        if(!fresh.session||packet.session!==fresh.session)throw Error('Stale session');
        if(!mailbox||mailbox.session!==fresh.session)mailbox={session:fresh.session,realtime:null,reliable:[],ack:0};
        if(packet.kind==='realtime')mailbox.realtime={seq:packet.seq,data:packet.data};
        else if(packet.kind==='reliable'){
          mailbox.reliable=mailbox.reliable.filter(x=>x.seq!==packet.seq);
          mailbox.reliable.push({seq:packet.seq,data:packet.data});mailbox.reliable.sort((a,b)=>a.seq-b.seq);
          if(mailbox.reliable.length>32)throw Error('Too many commands');
        }else if(packet.kind==='ack')mailbox.ack=Math.max(mailbox.ack,packet.seq);
        else throw Error('Invalid packet kind');
        const result=await sync(auth,mailbox); // Checks message type and revocation again before forwarding.
        if(result.session!==packet.session)throw Error('Changed session');
        for(const peer of wss.clients){
          if(peer!==ws&&peer.code===auth.code&&peer.role!==role){
            let peerState;
            try { peerState=await sync(peer.auth); } catch {peer.close(1008,'Expired room');continue}
            if(peerState.session!==packet.session)continue;
            if(packet.kind==='ack'&&peer.mailbox)peer.mailbox.reliable=peer.mailbox.reliable.filter(x=>x.seq>packet.seq);
            send(peer,packet);
          }
        }
        ws.mailbox=mailbox;
      }).catch(()=>ws.close(1008,'Invalid or expired room message'));
    });
  });
  const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue}ws.alive=false;ws.ping()}},20000);heartbeat.unref();
  return ()=>{clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();wss.close()};
}
