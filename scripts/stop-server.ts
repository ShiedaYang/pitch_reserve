import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
try{
 const metadata=JSON.parse(readFileSync(resolve(process.env.PITCH_DATA_DIR||resolve(root,'.local'),'server.json'),'utf8'));
 const port=Number(metadata.port||new URL(metadata.url).port);
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error();
 const host=metadata.host&&metadata.host!=='0.0.0.0'?metadata.host:'127.0.0.1';const base=`http://${host}:${port}`;const response=await fetch(`${base}/api/state`,{signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error();const state=await response.json();
 if(state.readOnly!==true||state.policy?.autoHold!==false||typeof state.csrf!=='string')throw new Error();
 const stopped=await fetch(`${base}/api/shutdown`,{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':state.csrf},body:'{}',signal:AbortSignal.timeout(10000)});
 if(!stopped.ok)throw new Error();console.log('已请求正常停止，会话保存后退出。');
}catch{console.error('未能正常停止：请确认服务正在运行，且 PITCH_DATA_DIR 与启动时一致。');process.exitCode=1;}
