import {startupHost} from '../src/startup-options.ts';
import {resolve} from 'node:path';
import {supervise} from '../src/supervisor.ts';
try{
 if(Number(process.versions.node.split('.')[0])<24)throw new Error('Node.js 24+ is required.');
 process.env.PITCH_HOST=startupHost(process.argv.slice(2));
 process.exitCode=await supervise({entry:resolve(import.meta.dirname,'../src/server.ts'),cwd:resolve(import.meta.dirname,'..')});
}catch(error){console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;}
