import {networkInterfaces} from 'node:os';
import type {NetworkInterfaceInfo} from 'node:os';

function ipv4(address:string){
  const parts=address.split('.');if(parts.length!==4||parts.some(p=>!/^\d{1,3}$/.test(p)||Number(p)>255))return null;
  return parts.reduce((value,part)=>(value*256+Number(part))>>>0,0);
}
function privateAddress(address:string){const n=ipv4(address);return n!==null&&((n>>>24)===10||(n>>>20)===0xac1||(n>>>16)===0xc0a8);}
function subnet(cidr:string){
  const [address,prefix,...extra]=cidr.split('/');const n=ipv4(address);const bits=Number(prefix);
  if(extra.length||n===null||!/^\d{1,2}$/.test(prefix??'')||bits<0||bits>32)throw new Error('PITCH_LAN_CIDRS 必须是私有 IPv4 CIDR 列表');
  const mask=bits===0?0:(0xffffffff<<(32-bits))>>>0;const network=(n&mask)>>>0;const last=(network|~mask)>>>0;
  const format=(value:number)=>[24,16,8,0].map(shift=>(value>>>shift)&255).join('.');
  if(!privateAddress(format(network))||!privateAddress(format(last)))throw new Error('PITCH_LAN_CIDRS 只允许私有局域网网段');
  return {cidr:`${format(network)}/${bits}`,matches:(ip:string)=>{const value=ipv4(ip);return value!==null&&((value&mask)>>>0)===network;}};
}
export function networkAccess(env:NodeJS.ProcessEnv=process.env,interfaces:Record<string,NetworkInterfaceInfo[]|undefined>=networkInterfaces()){
  const port=Number(env.PORT||4318);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT 必须是1–65535之间的端口');
  const host=env.PITCH_HOST||'127.0.0.1';
  const local=Object.values(interfaces).flatMap(rows=>rows??[]).filter(row=>row.family==='IPv4'&&!row.internal&&privateAddress(row.address));
  if(!['127.0.0.1','0.0.0.0'].includes(host)&&!local.some(row=>row.address===host))throw new Error('PITCH_HOST 仅支持127.0.0.1、0.0.0.0或本机私有IPv4地址');
  const lan=host!=='127.0.0.1';
  const subnets=[...new Set(env.PITCH_LAN_CIDRS?env.PITCH_LAN_CIDRS.split(',').map(s=>s.trim()):local.filter(row=>host==='0.0.0.0'||row.address===host).map(row=>row.cidr!).filter(Boolean))].map(subnet);
  const localUrl=`http://127.0.0.1:${port}`;const lanUrls=lan?[...new Set(local.filter(row=>host==='0.0.0.0'||row.address===host).map(row=>`http://${row.address}:${port}`))]:[];
  const origin=env.PITCH_PUBLIC_ORIGIN||localUrl;
  if(new URL(origin).origin!==origin||!['http:','https:'].includes(new URL(origin).protocol))throw new Error('PITCH_PUBLIC_ORIGIN 必须是无路径的 HTTP(S) 来源');
  const origins=new Set([localUrl,`http://localhost:${port}`,origin,...lanUrls]);const hosts=new Set([...origins].map(value=>new URL(value).host));
  const allows=(remote:string|undefined)=>{const ip=(remote??'').replace(/^::ffff:/i,'');if(ip==='::1'||/^127\./.test(ip)&&ipv4(ip)!==null||local.some(row=>row.address===ip))return true;return lan&&privateAddress(ip)&&subnets.some(row=>row.matches(ip));};
  return {host,port,origin,localUrl,lanUrls,origins,hosts,allows,allowedSubnets:lan?subnets.map(row=>row.cidr):[]};
}
