import {describe,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import {inputs, readSearch, readPlace, rejectOptionalConsent, searchPlaces} from '../src/sites/maps';
import {IN_PAGE_VERIFY} from '../src/replay';
const require=createRequire(import.meta.url);
const tools=require('../src/tools');
const roles=require('../src/roles');
describe('Maps contracts and blockers',()=>{
 it('requires a valid display language and preserves the selected language independently of the browser locale',()=>{
   expect(inputs({business:'kappers',city:'Rotterdam',language:'nl'}).language).toBe('nl');
   expect(()=>inputs({business:'kappers',city:'Rotterdam',language:'nl&unsafe=true'})).toThrow(/display language/);
 });
 it('reads the current query in Maps limited view without a search box',()=>{
   const dom=new JSDOM('<div role="feed"><a href="/maps/place/Test">Test</a></div>',{url:'https://www.google.com/maps/search/?api=1&query=dierenartsen+Amsterdam'});
   global.document=dom.window.document;global.location=dom.window.location;
   // jsdom does not implement innerText.
   Object.defineProperty(document.body,'innerText',{value:'Results'});
   expect(readSearch().query).toBe('dierenartsen Amsterdam');
   dom.window.close();
 });
 it('only dismisses the real Google consent domain and an unambiguous reject button',async()=>{
   expect(await rejectOptionalConsent({url:()=> 'https://attacker.example/consent'})).toBe(false);
   expect(await rejectOptionalConsent({url:()=> 'https://consent.google.com/m',getByRole:()=>({count:async()=>2})})).toBe(false);
   let clicked=false;
   const page={url:()=>clicked?'https://www.google.com/maps':'https://consent.google.com/m',
     getByRole:()=>({count:async()=>1,click:async()=>{clicked=true;}}),waitForURL:async()=>{}};
   expect(await rejectOptionalConsent(page)).toBe(true);expect(clicked).toBe(true);
 });
 it('returns stale-query and challenge blockers without recording or saving leads',async()=>{
   for(const state of [{kind:'results',query:'hairdressers Rotterdam',links:[]},{kind:'challenge_required'}]){
     let saved=false;
     const page={goto:async()=>{},waitForFunction:async()=>{},evaluate:async()=>state};
     const result=await searchPlaces(page,{business:'vets',city:'Amsterdam'},{store:{get:()=>null,put:()=>{saved=true;}}});
     expect(result.leads).toEqual([]);expect(saved).toBe(false);
   }
 });
 it('is available to the Maps role and registers its executable handler',()=>{
   expect(tools.has('maps_search')).toBe(true);
   expect(roles.get('google.maps').tools).toContain('maps_search');
 });
 it('only reports reuse for the same supported verified routine',async()=>{
   const good={kind:'browser-routine',routine:'google.maps.search',routineVersion:1,lastVerified:1};
   for(const [previous,mode] of [[good,'replay'],[{...good,_persisted:false},'record'],[{...good,quarantined:true},'record'],[{...good,routineVersion:2},'record'],[{...good,kind:'request'},'record'],[{...good,lastVerified:null},'record']]){
     const page={goto:async()=>{},waitForFunction:async()=>{},waitForTimeout:async()=>{},evaluate:async()=>({kind:'results',query:'vets Amsterdam',links:[]})};
     const result=await searchPlaces(page,{business:'vets',city:'Amsterdam'},{store:{get:()=>previous,put:()=>{throw Error('No leads must not save')}}});
     expect(result.mode).toBe(mode);
   }
 });
});
