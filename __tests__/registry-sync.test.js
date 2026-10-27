import {describe,it,expect,vi} from 'vitest';
const {syncRegistryCredentials,syncAll}=require('../scripts/gb-sync-all');
const source={metadata:{namespace:'pod-ann'},spec:{template:{spec:{imagePullSecrets:[{name:'regcred'}]}}}};
const target={metadata:{namespace:'ghost-browser',name:'ghost-browser'},spec:{template:{spec:{imagePullSecrets:[{name:'other'}]}}}};
const prefix=['-n','byon-cp-ann','exec','-i','deployment/byon-ann','-c','k3s','--','kubectl'];
describe('private browser image delivery',()=>{
 it('copies only the owner registry credential through stdin and preserves existing pull secrets',()=>{
   const secret={type:'kubernetes.io/dockerconfigjson',data:{'.dockerconfigjson':'TEST_ONLY_REGISTRY_CREDENTIAL'}};
   const run=vi.fn(args=>args.includes('secret')?JSON.stringify(secret):'');
   syncRegistryCredentials(source,target,prefix,run);
   const apply=run.mock.calls.find(([args])=>args.includes('apply'));
   expect(apply[0]).toEqual([...prefix,'-n','ghost-browser','apply','-f','-']);
   expect(JSON.parse(apply[1])).toMatchObject({metadata:{name:'regcred',namespace:'ghost-browser'},type:secret.type,data:secret.data});
   expect(JSON.stringify(run.mock.calls.map(([args])=>args))).not.toContain('TEST_ONLY_REGISTRY_CREDENTIAL');
   const patch=run.mock.calls.find(([args])=>args.includes('patch'))[0];
   expect(JSON.parse(patch.at(-1)).spec.template.spec.imagePullSecrets).toEqual([{name:'other'},{name:'regcred'}]);
 });
 it('never copies arbitrary application secrets and hides credential-bearing errors',()=>{
   const run=vi.fn(()=>JSON.stringify({type:'Opaque',data:{api:'private-value'}}));
   expect(()=>syncRegistryCredentials(source,target,prefix,run)).toThrow('registry credential synchronization failed');
   expect(run).toHaveBeenCalledTimes(1);
   const failing=vi.fn(()=>{throw Error('private-value');});
   expect(()=>syncRegistryCredentials(source,target,prefix,failing)).toThrow('no credential data logged');
   try{syncRegistryCredentials(source,target,prefix,failing);}catch(e){expect(e.message).not.toContain('private-value');}
 });
 it('leaves clusters without configured source pull credentials alone',()=>{
   const run=vi.fn();syncRegistryCredentials({spec:{template:{spec:{}}}},target,prefix,run);expect(run).not.toHaveBeenCalled();
 });
 it('refreshes a configured pull credential without changing the pod template unnecessarily',()=>{
   const run=vi.fn(()=>JSON.stringify({type:'kubernetes.io/dockerconfigjson',data:{'.dockerconfigjson':'test'}}));
   syncRegistryCredentials(source,{...target,spec:{template:{spec:{imagePullSecrets:[{name:'regcred'}]}}}},prefix,run);
   expect(run.mock.calls.some(([args])=>args.includes('patch'))).toBe(false);
 });
});

describe('owner boundary and recovery integration',()=>{
 it('repairs an already-current image blocked on pulling, using only the matching owner source',()=>{
  const image='wvdstoep/ghost-browser:v676';
  const sourceBrowser=(ns)=>({metadata:{namespace:ns,name:'ghost-browser'},spec:{replicas:1,template:{spec:{containers:[{name:'ghost-browser',image}],imagePullSecrets:[{name:'regcred'}]}}},status:{availableReplicas:1}});
  const host={metadata:{namespace:'byon-cp-ann',name:'byon-ann'},spec:{template:{spec:{containers:[{name:'k3s'}]}}}};
  const nested={metadata:{namespace:'ghost-browser',name:'ghost-browser'},spec:{replicas:1,selector:{matchLabels:{app:'ghost-browser'}},template:{spec:{containers:[{name:'ghost-browser',image}]}}},status:{availableReplicas:0}};
  const run=vi.fn((args)=>{
   if(args.includes('secret'))return JSON.stringify({type:'kubernetes.io/dockerconfigjson',data:{'.dockerconfigjson':'fixture'}});
   if(args.includes('pods'))return JSON.stringify({items:[{status:{containerStatuses:[{state:{waiting:{reason:'ImagePullBackOff'}}}]}}]});
   if(args.includes('get'))return JSON.stringify({items:args.includes('--')?[nested]:[sourceBrowser('pod-ann'),sourceBrowser('pod-bob'),host]});
   return '';
  });
  expect(syncAll(image,run,()=>{})).toBe(true);
  const reads=run.mock.calls.filter(([args])=>args.includes('secret')).map(([args])=>args);
  expect(reads).toEqual([['-n','pod-ann','get','secret','regcred','-o','json']]);
  expect(run.mock.calls.some(([args])=>args.includes('apply'))).toBe(true);
  expect(run.mock.calls.some(([args])=>args.includes('rollout'))).toBe(true);
 });
});

it('captures child stderr so a credential-bearing apply failure cannot bypass the redacted error handler',()=>{
 const fs=require('node:fs');const source=fs.readFileSync(require.resolve('../scripts/gb-sync-all'),'utf8');
 expect(source).toContain("stdio: ['pipe', 'pipe', 'pipe']");
});
