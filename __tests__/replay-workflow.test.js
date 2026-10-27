import {describe,it,expect} from 'vitest';
import {drive,save,read,outcomeOf} from '../src/workflows';
import {attemptReplay} from '../src/replay';
describe('login is an actionable workflow result',()=>{
 it('preserves the login result and stops dependent steps',async()=>{
   const flow={id:'login-test',name:'Login test',nodes:[{id:'a',type:'agent',goal:'Read'},{id:'b',type:'agent',goal:'Write'}],edges:[{from:'a',to:'b'}]};
   const called=[];
   const result=await drive(flow,{runAgent:async({node})=>{called.push(node.id);return {outcome:'login_required',report:'Sign in',data:{replay:{needsLogin:true}}};}});
   expect(called).toEqual(['a']);expect(result.status).toBe('needs_login');
   expect(result.steps[0].output.report).toBe('Sign in');
 });
 it('stops a for-each before touching the next account item',async()=>{
   const flow={id:'login-for-each',name:'Login for each',nodes:[{id:'a',type:'agent',goal:'Read {{item}}',forEach:'input.items'}],edges:[]};
   let called=0;
   const result=await drive(flow,{input:{items:['one','two']},runAgent:async()=>{called++;return {data:{replay:{needsLogin:true}}};}});
   expect(called).toBe(1);expect(result.status).toBe('needs_login');expect(result.steps[0].output.count).toBe(1);
 });
 it('reports sign-in instead of a previous successful action',()=>expect(outcomeOf([{kind:'acted'},{kind:'login-required'}])).toBe('login_required'));
});
describe('verification prerequisites',()=>{
 const card={origin:'https://example.test',url:'https://example.test/api',method:'POST',slots:[],authAt:[],bodyKind:'json'};
 it('detects the login redirect BEFORE sending a request',async()=>{
   let sent=false;
   const result=await attemptReplay({card,ensureOrigin:()=> 'https://example.test/login.php?next=home',runInPage:()=>{sent=true;}});
   expect(result.kind).toBe('login_required');expect(sent).toBe(false);
 });
 it('never sends when the before-state cannot be read',async()=>{
   let sent=false;
   const result=await attemptReplay({card,prepare:()=>false,runInPage:()=>{sent=true;}});
   expect(result.kind).toBe('not_applicable');expect(sent).toBe(false);
 });
 it('returns sign-in if the readback baseline discovers an expired session',async()=>{
   const result=await attemptReplay({card,prepare:()=>({kind:'login_required'}),runInPage:()=>{throw Error('must not send');}});
   expect(result).toMatchObject({kind:'login_required',stop:true});
 });
 it('keeps missing live session fields distinct from a broken request or expired login',async()=>{
   const result=await attemptReplay({card,runInPage:()=>({status:0,notSent:true})});
   expect(result).toMatchObject({kind:'not_applicable',healed:false});
 });
});
