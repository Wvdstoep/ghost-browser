import { describe,it,expect,afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gb-verification-spec-'));
process.env.PROFILE_DIR=dir;
delete require.cache[require.resolve('../src/workflows')];
const workflows=require('../src/workflows');
afterAll(()=>fs.rmSync(dir,{recursive:true,force:true}));
describe('workflow replay verification contract',()=>{
 const flow=spec=>({name:'Verified action',nodes:[{id:'t',type:'trigger',trigger:{type:'manual'}},{id:'a',type:'agent',role:'general',goal:'Send {{input.message}}',values:{message:'{{input.message}}'},replayVerification:spec}],edges:[{from:'t',to:'a'}]});
 it('persists the readback contract beside parameterized values',()=>{
   const spec={url:'/api/messages',path:['messages'],match:{slot:'message',field:'text'},completesTask:true};
   const stored=workflows.save(flow(spec),['general']);
   expect(stored.nodes[1].replayVerification).toEqual(spec);
   expect(workflows.resolveNode(stored.nodes[1],{input:{message:'the NEW message'}}).values.message).toBe('the NEW message');
 });
 it.each([{url:'/api',path:['__proto__'],match:{slot:'message'}},{url:'/api',path:'messages',match:{slot:'message'}},{url:'/api',path:[],match:null}])('drops malformed readback specifications',spec=>{
   expect(workflows.save(flow(spec),['general']).nodes[1].replayVerification).toBeUndefined();
 });
});
