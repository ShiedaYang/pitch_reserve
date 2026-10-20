import {test} from 'node:test';
import assert from 'node:assert/strict';
import {networkAccess} from '../src/network-access.ts';
import {startupHost} from '../src/startup-options.ts';
import type {NetworkInterfaceInfo} from 'node:os';
const nic=(address:string,cidr:string,internal=false):NetworkInterfaceInfo=>({address,cidr,internal,family:'IPv4',netmask:'255.255.255.0',mac:'00:00:00:00:00:00'});
const interfaces={lo:[nic('127.0.0.1','127.0.0.1/8',true)],eth0:[nic('192.168.2.10','192.168.2.10/24')],public:[nic('203.0.113.5','203.0.113.5/24')]};
test('shared Windows/Linux startup defaults to local and LAN is an explicit flag',()=>{
 assert.equal(startupHost([],{}),'127.0.0.1');assert.equal(startupHost(['--lan'],{}),'0.0.0.0');assert.equal(startupHost(['--local'],{PITCH_HOST:'0.0.0.0'}),'127.0.0.1');assert.equal(startupHost([],{PITCH_HOST:'192.168.2.10'}),'192.168.2.10');assert.throws(()=>startupHost(['--lan','--local'],{}));assert.throws(()=>startupHost(['--broadcast'],{}));
});
test('local mode does not advertise LAN or accept remote LAN clients',()=>{
 const config=networkAccess({},interfaces);assert.equal(config.host,'127.0.0.1');assert.deepEqual(config.lanUrls,[]);assert.equal(config.allows('127.0.0.1'),true);assert.equal(config.allows('::ffff:127.0.0.1'),true);assert.equal(config.allows('::1'),true);assert.equal(config.allows('192.168.2.20'),false);assert.equal(config.hosts.has('example.com:4318'),false);
});
test('LAN mode advertises private interfaces and admits only clients on allowed subnets',()=>{
 const config=networkAccess({PITCH_HOST:'0.0.0.0'},interfaces);
 assert.deepEqual(config.lanUrls,['http://192.168.2.10:4318']);assert.deepEqual(config.allowedSubnets,['192.168.2.0/24']);
 for(const ip of ['192.168.2.20','::ffff:192.168.2.20','127.0.0.1'])assert.equal(config.allows(ip),true);
 for(const ip of ['192.168.3.20','8.8.8.8','203.0.113.5','172.16.2.3','100.64.0.1','fe80::1','garbage',undefined])assert.equal(config.allows(ip),false);
 assert.equal(config.hosts.has('192.168.2.10:4318'),true);assert.equal(config.origins.has('http://192.168.2.10:4318'),true);assert.equal(config.hosts.has('evil.example'),false);
});
test('explicit private CIDRs restrict LAN clients and invalid/public ranges fail closed',()=>{
 const config=networkAccess({PITCH_HOST:'0.0.0.0',PITCH_LAN_CIDRS:'192.168.2.0/28',PORT:'4320'},interfaces);assert.equal(config.allows('192.168.2.12'),true);assert.equal(config.allows('192.168.2.20'),false);assert.equal(config.allows('192.168.2.10'),true);assert.equal(config.localUrl,'http://127.0.0.1:4320');
 for(const cidr of ['0.0.0.0/0','8.8.8.0/24','10.0.0.0/7','192.168.0.0/15','172.16.0.0/11','192.168.2.0/33','192.168.2.0/x'])assert.throws(()=>networkAccess({PITCH_HOST:'0.0.0.0',PITCH_LAN_CIDRS:cidr},interfaces));
 assert.throws(()=>networkAccess({PITCH_HOST:'203.0.113.5'},interfaces));assert.throws(()=>networkAccess({PORT:'0'},interfaces));assert.throws(()=>networkAccess({PITCH_PUBLIC_ORIGIN:'http://example.com/path'},interfaces));
});
