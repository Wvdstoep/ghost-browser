// Runs against the real compiled Compose bundle: GB_CONSOLE_DIR=/work/console npm test -- ...
import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url),express=require('express');
const suite=process.env.GB_CONSOLE_DIR?describe:describe.skip;
suite('compiled action recordings console',()=>{
 it('renders the library and current execution evidence',async()=>{
  const app=express();let polls=0;
  const {recordingView}=require('../src/recording-status');
  const card=recordingView({origin:'https://www.google.com',intent:'routine.google.maps.search.v1',kind:'browser-routine',routine:'google.maps.search',routineVersion:1,lastVerified:Date.now(),uses:1});
  app.get('/',(_,res)=>res.type('html').send('<html><body style="margin:0"><canvas id="ComposeTarget" style="width:100vw;height:100vh"></canvas><script src="/console/gbweb.js"></script></body></html>'));
  app.use('/console',express.static(process.env.GB_CONSOLE_DIR));
  app.use(express.static(process.env.GB_CONSOLE_DIR));
  app.get('/api/auth/state',(_,res)=>res.json({signedIn:true}));
  app.get('/v1/route-cards',(_,res)=>{polls++;res.json({cards:[card]})});
  app.get('/v1/agent/jobs',(_,res)=>res.json({jobs:[{id:'maps-proof',role:'google.maps',status:'idle',data:{execution:{mode:'Saved routine reused',verified:true,input:'animal doctors in Amsterdam',reason:'Fresh category and city verified',recording:card.id}},steps:[],proposals:[]}]}));
  app.use((_,res)=>res.json({}));
  const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});
  const browser=await chromium.launch({args:['--enable-unsafe-swiftshader']});
  try{
   const page=await browser.newPage({viewport:{width:1200,height:1000}});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:'+server.address().port);
   await page.waitForTimeout(6000);
   await page.screenshot({path:'/work/recordings-ui-initial.png'});
   await page.mouse.click(500,950); // Flows in the observed 1200x1000 console layout
   await page.waitForTimeout(500);
   await page.mouse.click(990,28); // Recordings sub-tab
   await page.waitForTimeout(4000);
   await page.screenshot({path:'/work/recordings-ui-library.png'});
   expect(polls).toBeGreaterThanOrEqual(2);
   await page.setViewportSize({width:390,height:844});
   await page.waitForTimeout(1000);
   await page.screenshot({path:'/work/recordings-ui-mobile.png'});
   expect(errors).toEqual([]);
  }finally{await browser.close();await new Promise(r=>server.close(r))}
 },30000);
});
