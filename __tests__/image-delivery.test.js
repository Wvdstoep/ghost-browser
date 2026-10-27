import {describe,it,expect,vi} from 'vitest';
const {importHostedImage,syncAll}=require('../scripts/gb-sync-all');
const image='wvdstoep/ghost-browser:v678';
const prefix=['-n','byon-cp-ann','exec','-i','deployment/byon-ann','-c','k3s','--','kubectl'];
describe('signed browser artifact delivery',()=>{
 it('streams a validated image to the owned cluster using positional arguments and bounded execution',()=>{
  const exec=vi.fn();importHostedImage(image,prefix,exec);
  expect(exec.mock.calls[0][0]).toBe('sudo');expect(exec.mock.calls[0][1]).toEqual(['cosign','verify','--key',process.env.COSIGN_PUB || '/etc/cosign/cosign.pub','--insecure-ignore-tlog',image]);
  const [bin,args,options]=exec.mock.calls[1];
  expect(bin).toBe('bash');expect(args).toContain('pipefail');
  expect(args.slice(5)).toEqual([image,...prefix.slice(0,-1),'ctr','--address','/run/k3s/containerd/containerd.sock','-n','k8s.io','images','import','-']);
  expect(args[3]).not.toContain(image);expect(options.timeout).toBe(300000);
  expect(options.stdio).toEqual(['ignore','pipe','pipe']);
 });
 it.each(['wvdstoep/ghost-browser:latest','other/image:v678','wvdstoep/ghost-browser:v678;echo unsafe'])('rejects an unapproved image before executing: %s',bad=>{
  const exec=vi.fn();expect(()=>importHostedImage(bad,prefix,exec)).toThrow('Invalid');expect(exec).not.toHaveBeenCalled();
 });
 it('requires a generated kubectl prefix and suppresses raw transfer errors',()=>{
  expect(()=>importHostedImage(image,[],vi.fn())).toThrow('Invalid');
  expect(()=>importHostedImage(image,prefix,()=>{throw Error('private stderr');})).toThrow('signed browser image transfer failed');
 });
 const target=()=>({metadata:{namespace:'ghost-browser',name:'ghost-browser'},spec:{replicas:1,selector:{matchLabels:{app:'ghost-browser'}},template:{spec:{containers:[{name:'ghost-browser',image:'wvdstoep/ghost-browser:v677'}]}}},status:{availableReplicas:0}});
 const host={metadata:{namespace:'byon-cp-ann',name:'byon-ann'},spec:{template:{spec:{containers:[{name:'k3s'}]}}}};
 function runMock(){
  return vi.fn(args=>{
   if(args.includes('pods'))return JSON.stringify({items:[{status:{containerStatuses:[{state:{waiting:{reason:'ImagePullBackOff'}}}]}}]});
   if(args.includes('get'))return JSON.stringify({items:args.includes('--')?[target()]:[host]});
   return '';
  });
 }
 it('imports before switching the unavailable dedicated pod to its cached signed release',()=>{
  const run=runMock(),steps=[],importer=vi.fn((ref,where)=>{steps.push('import');expect(ref).toBe(image);expect(where).toEqual(prefix);});
  run.mockImplementationOnce(()=>JSON.stringify({items:[host]}));
  const original=run.getMockImplementation();run.mockImplementation(args=>{if(args.includes('patch'))steps.push('patch');return original(args);});
  expect(syncAll(image,run,()=>{},importer)).toBe(true);
  expect(steps).toEqual(['import','patch']);
  const patch=run.mock.calls.find(([args])=>args.includes('--type=strategic'))[0];
  expect(JSON.parse(patch.at(-1)).spec.template.spec.containers).toEqual([{name:'ghost-browser',image,imagePullPolicy:'IfNotPresent'}]);
  expect(run.mock.calls.some(([args])=>args.includes('set'))).toBe(false);
 });
 it('does not switch the image or report a rollout when artifact delivery fails',()=>{
  const run=runMock();
  expect(syncAll(image,run,()=>{},()=>{throw Error('transfer failed');})).toBe(false);
  expect(run.mock.calls.some(([args])=>args.includes('patch')||args.includes('set')||args.includes('rollout'))).toBe(false);
 });
});

it('never streams an image whose signature verification fails',()=>{
 const exec=vi.fn(()=>{throw Error('signature failed');});expect(()=>importHostedImage(image,prefix,exec)).toThrow('transfer failed');
 expect(exec).toHaveBeenCalledTimes(1);expect(exec.mock.calls[0][0]).toBe('sudo');
});
