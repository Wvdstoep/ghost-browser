import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {maps_search}=require('../src/tools/maps');
function ctx(page){return {page:()=>page,storeData:vi.fn(),step:vi.fn(),observe:vi.fn(),stopForLogin:vi.fn(),addLead:vi.fn()};}
describe('Maps execution evidence',()=>{
 it('reports failures rather than leaving a routine running',async()=>{
   const c=ctx({goto:async()=>{throw Error('navigation timeout')}});
   await expect(maps_search(c,{business:'vets',city:'Amsterdam'})).rejects.toThrow('navigation timeout');
   expect(c.storeData).toHaveBeenLastCalledWith('execution',expect.objectContaining({mode:'Routine failed',verified:false}));
 });
 it('stops on login and retains explicit execution evidence',async()=>{
   const c=ctx({goto:async()=>{},waitForFunction:async()=>{},evaluate:async()=>({kind:'login_required'})});
   await maps_search(c,{business:'vets',city:'Amsterdam'});
   expect(c.stopForLogin).toHaveBeenCalledOnce();
   expect(c.addLead).not.toHaveBeenCalled();
   expect(c.storeData).toHaveBeenCalledWith('execution',expect.objectContaining({mode:'Login required',verified:false}));
 });
 it('names a challenge blocker rather than presenting it as partial results',async()=>{
   const c=ctx({goto:async()=>{},waitForFunction:async()=>{},evaluate:async()=>({kind:'challenge_required'})});
   await maps_search(c,{business:'vets',city:'Amsterdam'});
   expect(c.storeData).toHaveBeenCalledWith('execution',expect.objectContaining({mode:'Routine blocked',reason:expect.stringContaining('challenge_required'),verified:false}));
   expect(c.addLead).not.toHaveBeenCalled();
 });
});
