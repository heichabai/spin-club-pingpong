import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { RoomConnection } from '../lib/network.js';
const base=process.env.LIVE_TEST_URL||'http://127.0.0.1:3000';
const nativeFetch=globalThis.fetch;
globalThis.fetch=(url,...args)=>nativeFetch(new URL(url,base),...args);
globalThis.location=new URL(base);
const until=async(check,ms=6000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw Error('Timed out');await new Promise(r=>setTimeout(r,10))}};
const received=[],statuses=[];
const host=new RoomConnection({onMessage:x=>received.push({role:'host',...x}),onStatus:x=>statuses.push(['host',x])});
const guest=new RoomConnection({onMessage:x=>received.push({role:'guest',...x}),onStatus:x=>statuses.push(['guest',x])});
try {
 await host.create();await guest.join(host.room.code);
 await until(()=>host._socketOpen()&&guest._socketOpen()&&host.peerConnected&&guest.peerConnected);
 assert.equal(host._rtcOpen(),false,'test must use the WebSocket relay without WebRTC');
 const start=performance.now();
 // Thirty positions must be forwarded immediately, not at the old 125ms polling interval.
 for(let i=0;i<30;i++){guest.send({type:'input',input:{x:i}});await new Promise(r=>setTimeout(r,5))}
 await until(()=>received.filter(x=>x.role==='host'&&x.type==='input').length===30);
 const duration=performance.now()-start;
 assert.ok(duration<1000,`relay unexpectedly slow: ${duration}`);
 host.send({type:'state',state:{ball:{x:500,y:400}}});guest.send({type:'serve',gesture:{brushY:-2}});
 await until(()=>received.some(x=>x.role==='guest'&&x.type==='state')&&received.some(x=>x.role==='host'&&x.type==='serve'));
 await until(()=>guest.reliable.length===0);
 assert.equal(received.filter(x=>x.type==='serve').length,1,'commands must not be duplicated across socket and polling');
 assert.deepEqual(received.find(x=>x.role==='host'&&x.type==='serve').gesture,{brushY:-2},'serve brush must travel in the reliable command, independently of motion updates');
 // A burst must converge to its newest position without losing a command
 // placed among the motion packets. Stale positions may be coalesced.
 const burstStart=performance.now();
 for(let i=100;i<140;i++){guest.send({type:'input',input:{x:i}});if(i===120)guest.send({type:'pause'})}
 await until(()=>received.some(x=>x.role==='host'&&x.type==='input'&&x.input.x===139)&&received.filter(x=>x.type==='pause').length===1&&guest.reliable.length===0);
 assert.ok(performance.now()-burstStart<1000,'a burst must not build a long motion backlog');
 const previousSocket=guest.socket;
 previousSocket.close();
 await until(()=>!guest._socketOpen());
 guest.send({type:'restart'});
 await until(()=>guest._socketOpen()&&guest.socket!==previousSocket);
 await until(()=>received.filter(x=>x.type==='restart').length===1&&guest.reliable.length===0);
 guest.send({type:'input',input:{x:99}});
 await until(()=>received.some(x=>x.role==='host'&&x.type==='input'&&x.input.x===99));
 const code=host.room.code,oldToken=guest.token;
 guest.close();await new Promise(r=>setTimeout(r,100));
 const bad=new WebSocket(base.replace(/^http/,'ws')+'/api/live');
 await new Promise((resolve,reject)=>{bad.on('open',()=>bad.send(JSON.stringify({kind:'bind',code,token:oldToken})));bad.on('close',code=>{try{assert.equal(code,1008);resolve()}catch(e){reject(e)}});bad.on('error',reject)});
 const reconnect=new RoomConnection();try {await reconnect.join(code);await until(()=>reconnect._socketOpen());}finally{reconnect.close()}
 console.log(`PASS: actual RoomConnection clients: 30 immediate updates in ${Math.round(duration)}ms, bidirectional traffic, 40-position burst with ordered command, ACK/deduplication, socket recovery, token revocation, rejoin`);
} finally {host.close();guest.close();globalThis.fetch=nativeFetch;delete globalThis.location}
