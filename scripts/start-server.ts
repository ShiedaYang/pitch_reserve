import {startupHost} from '../src/startup-options.ts';
try{
 if(Number(process.versions.node.split('.')[0])<24)throw new Error('Node.js 24+ is required.');
 process.env.PITCH_HOST=startupHost(process.argv.slice(2));
 await import('../src/server.ts');
}catch(error){console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;}
