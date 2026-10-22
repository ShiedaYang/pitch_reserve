import {browserOptions} from './runtime-config.ts';

export async function preflightBrowser(prepare:()=>Promise<unknown>,platform:NodeJS.Platform=process.platform,env:NodeJS.ProcessEnv=process.env){
  if(env.PITCH_START_PAUSED==='1')return;
  try{await prepare();}
  catch(error){
    const detail=error instanceof Error?error.message:String(error);const options=browserOptions(platform,env);
    const browser=options.channel||'chromium';
    const install=`npx playwright install ${platform==='linux'?'--with-deps ':''}${browser}`;
    if(/executable (?:doesn't|does not) exist|browser distribution .+ (?:not found|not installed)/i.test(detail)){
      if(options.executablePath)throw new Error('浏览器启动检查失败：PITCH_BROWSER_EXECUTABLE 指向的文件不存在，请修正该路径，或取消该设置后安装所选浏览器。');
      throw new Error(`浏览器启动检查失败：当前项目所需的浏览器尚未安装或版本已变化。\n请以运行服务的同一用户，在项目目录执行：\n  ${install}\n浏览器缓存按用户区分，不要用 sudo 执行整条浏览器下载命令；更换 Playwright 版本或 PLAYWRIGHT_BROWSERS_PATH 后需要重新安装。`);
    }
    if(/host system is missing dependencies|error while loading shared libraries|cannot open shared object file/i.test(detail))throw new Error(`浏览器启动检查失败：缺少系统依赖。\n请在项目目录执行：\n  npx playwright install-deps ${browser}\n然后重新启动服务。`);
    throw new Error('浏览器启动检查失败：请检查图形桌面/DISPLAY、运行用户权限、浏览器路径，以及是否已有实例占用专用 profile。');
  }
}
