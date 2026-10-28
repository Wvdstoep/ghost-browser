import {describe,it,expect} from 'vitest';
import {recordingView} from '../src/recording-status';
describe('safe action recording library',()=>{
 const base={origin:'https://example.com',intent:'send',confidence:2};
 it('never advertises unverified or verifier-less requests as reusable',()=>{
   expect(recordingView(base).eligible).toBe(false);
   expect(recordingView({...base,lastVerified:123}).eligible).toBe(false);
   expect(recordingView({...base,lastVerified:123,verification:{}}).eligible).toBe(true);
 });
 it('quarantine takes precedence over previous success',()=>{
   expect(recordingView({...base,lastVerified:123,verification:{},quarantined:true}).status).toBe('Quarantined');
 });
 it('distinguishes built-in routines from captured requests and rejects incompatible versions',()=>{
   const r={...base,kind:'browser-routine',routine:'google.maps.search',routineVersion:1,lastVerified:123};
   expect(recordingView(r).eligible).toBe(true);
   expect(recordingView(r).kind).toBe('Built-in browser routine');
   expect(recordingView({...r,routineVersion:2}).eligible).toBe(false);
   expect(recordingView({...r,quarantined:true}).eligible).toBe(false);
 });
 it('does not expose tokens, recorded payloads or verifier bodies',()=>{
   const view=recordingView({...base,body:'secret',auth:'secret',verification:{token:'secret'},slots:{message:{}}});
   expect(JSON.stringify(view)).not.toContain('secret');
   expect(view.inputKeys).toEqual(['message']);
   expect(view.lastVerifiedLabel).toBe('Never');
 });
});

import {briefOf} from '../src/operator/assistant';
import {assistantPrompt} from '../src/operator/assistantPrompt';
it('surfaces execution evidence in the actual assistant chat step',()=>{
 expect(briefOf('gb_walk_wait',JSON.stringify({status:'idle',execution:{mode:'Saved routine reused',verified:true,reason:'Fresh city checked'}}))).toBe('Saved routine reused · verified · Fresh city checked');
 expect(briefOf('gb_walk_wait',JSON.stringify({execution:{mode:'Login required',verified:false}}))).toContain('not yet verified');
 expect(assistantPrompt()).toContain('role "google.maps"');
});
