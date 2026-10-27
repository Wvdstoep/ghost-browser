import { describe,it,expect } from 'vitest';
import { distill,learnFrom,sameShape,buildReplay,isLearnable,shapeOf } from '../src/routecards';
import { makeRecorder } from '../src/recorder';
import { attemptReplay, classifyResponse } from '../src/replay';
import { inputs, contains } from '../src/sites/maps';
const request = (name='CometJoinGroupMutation') => ({ method:'POST',url:'https://www.facebook.com/api/graphql/',
 headers:{'x-fb-lsd':'secret'},postData:new URLSearchParams({fb_api_req_friendly_name:name,doc_id:'12345',variables:'{"groupID":"private-value"}',fb_dtsg:'secret'}).toString() });
describe('Facebook route identity and capture correctness',()=>{
 it('excludes telemetry, navigation and read-only GraphQL queries',()=>{
   for(const endpoint of ['/ajax/bnzai','/ajax/bulk-route-definitions/','/ajax/bootload','/collect']) expect(isLearnable({...request(),url:'https://www.facebook.com'+endpoint})).toBe(false);
   expect(isLearnable(request('CometSearchQuery'))).toBe(false);
 });
 it('distinguishes different mutations on the same GraphQL endpoint without retaining private variables',()=>{
   const a=shapeOf(request()),b=shapeOf(request('CometPostMutation'));
   expect(sameShape(a,b)).toBe(false);
   expect(JSON.stringify(a)).not.toMatch(/secret|private-value/);
   expect(a.operation).toEqual({name:'CometJoinGroupMutation',id:'12345'});
 });
 it('does not promote repeated requests when the intended effect was never confirmed',()=>{
   const fresh=distill({intent:'join',requests:[request()],now:1}).card;
   expect(learnFrom(fresh,fresh,2).promoted).toBe(false);
 });
 it('seals BEFORE the write and confirms only after an observed effect',()=>{
   const recorder=makeRecorder({log:{info(){}}});recorder.arm({intent:'join'});recorder.seal();recorder.observe(request());
   const unconfirmed=recorder.finish({now:1}).card;
   expect(unconfirmed.verifiedEffect).toBe(false);
   recorder.arm({intent:'join'});recorder.seal();recorder.observe(request());recorder.confirm();
   const confirmed=recorder.finish({now:2}).card;
   expect(confirmed.verifiedEffect).toBe(true);
   expect(learnFrom(confirmed,confirmed,3).promoted).toBe(true);
 });
 it('uses protocol operation constants but requires NEW action variables',()=>{
   const card=distill({intent:'join',requests:[request()],now:1}).card;
   const replay=buildReplay(card,{variables:{groupID:'new-group'}});
   expect(replay.constants.doc_id).toBe('12345');expect(replay.values.variables.groupID).toBe('new-group');
   expect(buildReplay(card,{variables:'{}',doc_id:'99999'})).toBeNull();
 });
 it('refuses cards pointed off their origin and unknown GraphQL operations',()=>{
   const card=distill({intent:'join',requests:[request()],now:1}).card;
   expect(buildReplay({...card,origin:'https://other.example'},{variables:'{}',doc_id:'12345',fb_api_req_friendly_name:'CometJoinGroupMutation'})).toBeNull();
   expect(buildReplay({...card,operation:null},{variables:'{}'})).toBeNull();
 });
});
describe('replay outcomes',()=>{
 const card={origin:'https://example.test',url:'https://example.test/api/post',method:'POST',slots:[],authAt:[],bodyKind:'json'};
 it('never considers an unverified 2xx successful, even with ok:true',async()=>{
   const out=await attemptReplay({card,runInPage:()=>({status:200,text:'{"ok":true}'}),now:5});
   expect(out).toMatchObject({done:false,kind:'unconfirmed',inspectBeforeRetry:true});
 });
 it('does not invoke a verifier to override an application failure',async()=>{
   let called=false;
   const out=await attemptReplay({card,runInPage:()=>({status:200,text:'{"errors":[{"message":"no"}]}'}),verify:()=>{called=true;return true;}});
   expect(called).toBe(false);expect(out.kind).toBe('application_error');
 });
 it('does not quarantine an expired login as a broken card',async()=>{
   const out=await attemptReplay({card,runInPage:()=>({status:200,url:'https://example.test/login'})});
   expect(out).toMatchObject({stop:true,done:false,healed:false,kind:'login_required'});
   expect(out.card).toBe(card);
 });
 it('handles thrown verification and missing responses without a false success',async()=>{
   expect((await attemptReplay({card,runInPage:()=>null})).done).toBe(false);
   expect((await attemptReplay({card,runInPage:()=>({status:200}),verify:()=>{throw Error('gone');}})).kind).toBe('unconfirmed');
 });
});
describe('Maps input and location checks',()=>{
 it('requires fresh business and city, and bounds the search',()=>{
   expect(()=>inputs({business:'',city:'Amsterdam'})).toThrow();
   expect(inputs({business:'vets',city:'Amsterdam',limit:500}).limit).toBe(25);
   expect(contains('Amsterdamseweg 1 Rotterdam','Amsterdam')).toBe(false);
   expect(contains('Teststraat 2, Amsterdam','Amsterdam')).toBe(true);
 });
});
