import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {createHash} from 'node:crypto';
import type {Server} from 'node:http';
import {DesktopProxy,desktopUpstream} from '../src/desktop-proxy.ts';
import {desktopSettings} from '../src/desktop-session.ts';
import {manualBrowserUrl} from '../src/runtime-config.ts';
async function listen(server:Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
test('remote desktop configuration accepts loopback only and validates display and ports',()=>{
 assert.equal(desktopUpstream({}),null);for(const url of ['https://127.0.0.1:6080','http://example.test:6080','http://127.0.0.1/path','http://user:password@localhost:6080'])assert.throws(()=>desktopUpstream({PITCH_DESKTOP_UPSTREAM:url}));assert.equal(desktopUpstream({PITCH_DESKTOP_UPSTREAM:'http://127.0.0.1:6080'})!.hostname,'127.0.0.1');
 assert.match(manualBrowserUrl({PITCH_DESKTOP_UPSTREAM:'http://127.0.0.1:6080'})!,/^\/desktop\/vnc.html/);assert.throws(()=>manualBrowserUrl({PITCH_MANUAL_BROWSER_URL:'/desktop/../../secret'}));assert.throws(()=>desktopSettings('.', {PITCH_DESKTOP_DISPLAY:':99 -ac'}));assert.throws(()=>desktopSettings('.', {PITCH_DESKTOP_PORT:'5901'}));
});
test('HTTP assets stay on fixed loopback upstream and never forward console cookies or authorization',async()=>{
 const paths:string[]=[];const upstream=createServer((req,res)=>{paths.push(req.url!);assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.authorization,undefined);res.setHeader('Content-Type','text/html');res.end('<html>noVNC</html>');});const base=await listen(upstream);const proxy=new DesktopProxy(new URL(base));const server=createServer((req,res)=>proxy.http(req,res,new URL(req.url!,base)));const local=await listen(server);
 try{assert.equal((await proxy.check()).reachable,true);const response=await fetch(local+'/desktop/vnc.html',{headers:{Cookie:'session=private',Authorization:'Bearer private'}});assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy')!,/script-src 'self' 'unsafe-inline'/);await response.text();await (await fetch(local+'/desktop//example.test/asset')).text();assert.ok(paths.includes('//example.test/asset'));assert.equal((await fetch(local+'/desktop/vnc.html',{method:'POST'})).status,405);}finally{await close(server);await close(upstream);}
});
test('WebSocket relay preserves handshake and bidirectional bytes without leaking auth headers',{timeout:10000},async()=>{
 const upstream=createServer();upstream.on('upgrade',(req,socket)=>{assert.equal(req.url,'/websockify');assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.authorization,undefined);socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: fixture\r\n\r\n');socket.on('data',data=>socket.write(data));socket.on('end',()=>socket.destroy());socket.on('error',()=>{});});const base=await listen(upstream);const proxy=new DesktopProxy(new URL(base));const server=createServer();server.on('upgrade',(req,socket,head)=>proxy.upgrade(req,socket,head));const local=await listen(server);
 try{await new Promise<void>((resolve,reject)=>{const req=request(local+'/desktop/websockify',{headers:{Connection:'Upgrade',Upgrade:'websocket',Origin:local,Cookie:'secret',Authorization:'secret'}});req.once('error',reject);req.once('upgrade',(response,socket)=>{assert.equal(response.statusCode,101);socket.once('data',data=>{assert.equal(data.toString(),'test-bytes');socket.destroy();resolve();});socket.write('test-bytes');});req.end();});}finally{await close(server);await close(upstream);}
});
test('an unconfigured desktop reports unavailable without exposing any external resource',async()=>{
 const proxy=new DesktopProxy(null);assert.deepEqual(await proxy.check(),{configured:false,reachable:false});const server=createServer((req,res)=>proxy.http(req,res,new URL(req.url!,'http://localhost')));const base=await listen(server);try{assert.equal((await fetch(base+'/desktop/vnc.html')).status,503);}finally{await close(server);}
});

test('a standard WebSocket client receives the binary VNC greeting through the console relay',{timeout:10000},async()=>{
 const remotes=new Set<import('node:stream').Duplex>();const upstream=createServer();
 upstream.on('upgrade',(req,socket)=>{remotes.add(socket);socket.once('close',()=>remotes.delete(socket));socket.on('end',()=>socket.destroy());socket.on('error',()=>{});const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: '+accept+'\r\nSec-WebSocket-Protocol: binary\r\n\r\n');socket.write(Buffer.concat([Buffer.from([0x82,12]),Buffer.from('RFB 003.008\n')]));});
 const base=await listen(upstream),proxy=new DesktopProxy(new URL(base)),server=createServer();server.on('upgrade',(req,socket,head)=>proxy.upgrade(req,socket,head));const local=await listen(server);const ws=new WebSocket(local.replace('http:','ws:')+'/desktop/websockify','binary');ws.binaryType='arraybuffer';
 try{await new Promise<void>((resolve,reject)=>{ws.onerror=()=>reject(new Error('Standard WebSocket handshake failed'));ws.onmessage=event=>{try{assert.equal(Buffer.from(event.data).toString(),'RFB 003.008\n');assert.equal(ws.protocol,'binary');resolve();}catch(error){reject(error);}};});}finally{ws.close();for(const socket of remotes)socket.destroy();await close(server);await close(upstream);}
});
