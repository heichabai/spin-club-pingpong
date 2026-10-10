import http from 'node:http';
import { attachLiveRelay } from './live.mjs';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoomDatabase } from './database.mjs';
const DB=createRoomDatabase();
globalThis.__roomNodeEnv={DB};
const {POST}=await import('../dist-render/rooms.mjs');
const root=path.resolve(fileURLToPath(new URL('../dist-render/client/',import.meta.url)));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2'};
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('ok');return}
    if(url.pathname==='/api/rooms'){
      if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});res.end();return}
      const response=await POST(new Request(url,{method:'POST',headers:req.headers,body:Readable.toWeb(req),duplex:'half'}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
    const requested=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(requested!==root&&!requested.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
    let file=requested;
    try{if(!(await fs.stat(file)).isFile())file=path.join(root,'index.html')}catch{if(path.extname(file)){res.writeHead(404);res.end();return}file=path.join(root,'index.html')}
    const data=await fs.readFile(file);
    res.writeHead(200,{'Content-Type':mime[path.extname(file)]??'application/octet-stream','Cache-Control':file.includes('/assets/')?'public,max-age=31536000,immutable':'no-cache','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:data);
  }catch(error){console.error('Request failed',error.message);if(!res.headersSent)res.writeHead(500);res.end('Internal server error')}
});
const stopLive=attachLiveRelay(server,POST);
server.listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('SPIN CLUB ready'));
process.on('SIGTERM',()=>{stopLive();server.close(()=>{DB.close();process.exit(0)});setTimeout(()=>process.exit(0),10000).unref()});
