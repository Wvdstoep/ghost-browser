import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {makeAssistant} from '../src/operator/assistant';
import {executionStatus,captureStatus} from '../src/operator/executionStatus';
const dirs=[];afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true})});
function setup(events){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-replay-'));dirs.push(dir);
 let end;const run={id:'op-proof',status:'running',events,done:new Promise(r=>end=r),report:{answer:'Done'},startedAt:1,iterations:1};
 let job={id:'j-proof',data:{execution:{mode:'Replaying saved routine',reason:'Fresh inputs',recording:'maps'}}};
 const lookup=vi.fn(id=>id===job?.id?job:null);
 const assistant=makeAssistant({dir,startTurn:()=>run,jobEvidence:lookup});const c=assistant.create();assistant.send(c.id,'Find vets in Amsterdam');
 return {assistant,c,lookup,run,setJob:j=>job=j,end:async()=>{run.status='done';end();await new Promise(r=>setTimeout(r,0))},dir};
}
const events=()=>[
 {kind:'tool',name:'gb_walk',args:'{}'},
 {kind:'result',name:'gb_walk',text:'{"jobId":"j-proof","status":"running"}'},
 {kind:'tool',name:'gb_walk_wait',args:'{"jobId":"j-proof","seconds":300}'}
];
describe('execution status in existing chat UI fields',()=>{
 it('updates the live browsing label BEFORE wait returns, then keeps verified replay in history',async()=>{
  const s=setup(events());
  expect(s.assistant.view(s.c.id).live.steps.at(-1).label).toBe('Replaying saved routine…');
  s.setJob({id:'j-proof',data:{execution:{mode:'Saved routine reused',verified:true,input:'vets in Amsterdam',recording:'maps'}}});
  expect(s.assistant.view(s.c.id).live.steps.at(-1)).toMatchObject({label:'Replay succeeded · saved routine',text:expect.stringContaining('vets in Amsterdam')});
  await s.end();
  const restarted=makeAssistant({dir:s.dir,startTurn:()=>s.run});
  expect(restarted.view(s.c.id).turns.at(-1).steps.at(-1).label).toBe('Replay succeeded · saved routine');
 });
 it('surfaces a capture that completes after the operator has already landed its answer',async()=>{
  const s=setup(events());s.setJob({id:'j-proof',data:{execution:{mode:'Browser walk'}}});await s.end();
  s.setJob({id:'j-proof',data:{execution:{mode:'Browser walk'},capture:{saved:true,ready:false,recording:'card',reason:'Needs verifier'}}});
  const steps=s.assistant.view(s.c.id).turns.at(-1).steps;
  expect(steps.at(-1).label).toBe('Recording saved · needs verification');
  expect(steps.filter(x=>x.label==='Recording saved · needs verification')).toHaveLength(1);
 });
 it('keeps saved capture evidence after a restart even if the browser job is gone',async()=>{
  const s=setup(events());s.setJob({id:'j-proof',data:{execution:{mode:'Routine captured'},capture:{saved:true,ready:true,recording:'maps'}}});await s.end();
  const restarted=makeAssistant({dir:s.dir,startTurn:()=>s.run});
  expect(restarted.view(s.c.id).turns.at(-1).steps.some(s=>s.label==='Recording saved · ready for reuse')).toBe(true);
 });
 it('does not resolve arbitrary job IDs from tool arguments or unrelated results',()=>{
  const s=setup([{kind:'tool',name:'gb_walk_wait',args:'{"jobId":"j-other"}'},{kind:'result',name:'gb_job',text:'{"jobId":"j-other"}'}]);
  s.assistant.view(s.c.id);expect(s.lookup).not.toHaveBeenCalled();
 });
 it('never treats unverified replay, failed storage, login or fallback as success',()=>{
  expect(executionStatus({execution:{mode:'Saved routine reused',verified:false}}).label).toBe('Replay not verified');
  expect(executionStatus({execution:{mode:'Replay fallback'}}).label).toContain('Replay fallback');
  expect(executionStatus({execution:{mode:'Login required'}}).label).toContain('Login required');
  expect(captureStatus({saved:false,state:'failed',reason:'Disk full'})).toMatchObject({label:'Recording not saved',text:'Disk full'});
  expect(captureStatus({saved:false,state:'recording'})).toBeNull();
 });
 it('keeps the live replay label current when a previous capture exists in the same job',()=>{
  const s=setup(events());s.setJob({id:'j-proof',data:{execution:{mode:'Replaying recorded request'},capture:{saved:true,ready:true,recording:'old'}}});
  expect(s.assistant.view(s.c.id).live.steps.at(-1).label).toBe('Replaying recorded request…');
 });
 it('does not steal a later same-name result for a still-pending earlier call',()=>{
  const ev=events();ev.push({kind:'tool',name:'gb_walk_wait',args:'{"jobId":"j-other"}'},{kind:'result',name:'gb_walk_wait',text:'{"execution":{"mode":"Saved routine reused","verified":true}}'});
  const s=setup(ev);const st=s.assistant.view(s.c.id).live.steps;
  expect(st.filter(x=>x.browserJobId==='j-proof').at(-1).label).toContain('Replaying');
  expect(st.at(-1).browserJobId).toBeUndefined();
 });
 it.each(['Recording browser routine','Recorded request replay','Routine captured','Browser walk','Routine blocked','Routine failed','Browser routine completed','unknown'])('has an honest label for %s',mode=>{
  expect(executionStatus({execution:{mode,verified:true},capture:{saved:true,ready:true}}).label).toBeTruthy();
 });
});
