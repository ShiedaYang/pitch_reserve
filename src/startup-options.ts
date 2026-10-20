export function startupHost(args:string[],env:NodeJS.ProcessEnv=process.env){
  if(args.length>1||args.some(arg=>!['--lan','--local'].includes(arg)))throw new Error('Usage: start [--lan | --local]');
  return args[0]==='--lan'?'0.0.0.0':args[0]==='--local'?'127.0.0.1':env.PITCH_HOST||'127.0.0.1';
}
