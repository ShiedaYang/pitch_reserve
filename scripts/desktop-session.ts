import {resolve} from 'node:path';
import {runDesktop} from '../src/desktop-session.ts';
try{await runDesktop(resolve(import.meta.dirname,'..'),process.argv.slice(2));}
catch(error){console.error(error instanceof Error?error.message:'Remote desktop startup failed');process.exitCode=1;}
