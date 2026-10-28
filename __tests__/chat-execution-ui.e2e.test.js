import {describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {chromium} from 'playwright';
const require=createRequire(import.meta.url),express=require('express'),{makeAssistant}=require('../src/operator/assistant');
const suite=process.env.GB_CONSOLE_DIR?describe:describe.skip;
suite('existing compiled Compose chat receives recording and replay status',()=>{
 it('renders live capture, saved capture, replay and verified completion without a client schema change',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-ui-'));let finish;let polls=0;
  let job={id:'j-ui-proof',data:{execution:{mode:'Recording browser routine',input:'hairdressers in Rotterdam',reason:'Reading fresh Maps results'}}};
  const run={id:'operator-ui-proof',status:'running',startedAt:Date.now(),iterations:1,tasks:[],report:{answer:'Two verified places found.'},done:new Promise(r=>finish=r),events:[
   {kind:'tool',name:'gb_walk',args:'{}'},{kind:'result',name:'gb_walk',text:'{"jobId":"j-ui-proof"}'},{kind:'tool',name:'gb_walk_wait',args:'{"jobId":"j-ui-proof"}'}]};
  const assistant=makeAssistant({dir,startTurn:()=>run,jobEvidence:id=>id===job.id?job:null});const chat=assistant.create();assistant.send(chat.id,'Find hairdressers in Rotterdam, then animal doctors in Amsterdam.');
  const app=express();
  app.get('/',(_,res)=>res.type('html').send('<body style="margin:0"><canvas id="ComposeTarget" style="width:100vw;height:100vh"></canvas><script src="/console/gbweb.js"></script>'));
  app.use('/console',express.static(process.env.GB_CONSOLE_DIR));app.use(express.static(process.env.GB_CONSOLE_DIR));
  app.get('/api/auth/state',(_,res)=>res.json({signedIn:true}));
  app.get('/v1/agent/settings',(_,res)=>res.json({llmModel:'test-intent-model'}));
  app.get('/v1/assistant/chats',(_,res)=>res.json({chats:assistant.list()}));
  app.get('/v1/assistant/chats/:id',(_,res)=>{polls++;res.json(assistant.view(chat.id))});
  app.use((_,res)=>res.json({}));
  const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const browser=await chromium.launch({args:['--enable-unsafe-swiftshader']});
  try{
   const page=await browser.newPage({viewport:{width:1200,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForTimeout(5000);await page.mouse.click(300,950);await page.waitForTimeout(3000);
   expect(polls).toBeGreaterThan(0);expect(assistant.view(chat.id).live.steps.at(-1).label).toBe('Recording browser routine…');
   await page.screenshot({path:'/work/chat-recording.png'});
   job.data={execution:{mode:'Routine captured',verified:true,input:'hairdressers in Rotterdam'},capture:{saved:true,ready:true,recording:'Maps routine',reason:'Built-in routine saved'}};
   await page.waitForTimeout(3000);await page.screenshot({path:'/work/chat-recording-saved.png'});
   job.data.execution={mode:'Replaying saved routine',input:'animal doctors in Amsterdam',reason:'Using the saved Maps routine with new inputs'};
   await page.waitForTimeout(3000);await page.screenshot({path:'/work/chat-replaying.png'});
   job.data.execution={mode:'Saved routine reused',verified:true,input:'animal doctors in Amsterdam',reason:'Fresh category and city independently checked'};
   await page.waitForTimeout(3000);await page.screenshot({path:'/work/chat-replay-verified.png'});
   run.status='done';finish();await page.waitForTimeout(3000);await page.screenshot({path:'/work/chat-complete.png'});
   const saved=assistant.view(chat.id).turns.at(-1);expect(saved.steps.some(s=>s.label==='Replay succeeded · saved routine')).toBe(true);expect(saved.steps.some(s=>s.name==='execution_capture')).toBe(true);
   expect(polls).toBeGreaterThanOrEqual(4);expect(errors).toEqual([]);
  }finally{await browser.close();await new Promise(r=>server.close(r));finish();await new Promise(r=>setTimeout(r,0));fs.rmSync(dir,{recursive:true,force:true})}
 },60000);
});
