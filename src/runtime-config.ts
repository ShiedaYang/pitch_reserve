import type {LaunchOptions} from 'playwright';

export function browserOptions(platform:NodeJS.Platform=process.platform,env:NodeJS.ProcessEnv=process.env):LaunchOptions{
  const headless=env.PITCH_HEADLESS===undefined?platform!=='win32'&&!env.DISPLAY:env.PITCH_HEADLESS==='1';
  const channel=env.PITCH_BROWSER_CHANNEL||(platform==='win32'?'msedge':undefined);
  return {headless,channel,chromiumSandbox:true,timeout:30000,...(env.PITCH_BROWSER_EXECUTABLE?{executablePath:env.PITCH_BROWSER_EXECUTABLE}:{})};
}
export function manualBrowserUrl(env:NodeJS.ProcessEnv=process.env){
  if(!env.PITCH_MANUAL_BROWSER_URL)return null;
  const url=new URL(env.PITCH_MANUAL_BROWSER_URL);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('人工浏览器地址必须为 HTTP 或 HTTPS');
  return url.href;
}
