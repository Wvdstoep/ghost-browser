import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { makeRecorder } from '../src/recorder';
import { makeCardStore } from '../src/cardstore';
import { learnFrom, planFor } from '../src/routecards';
import { attemptReplay, IN_PAGE_FETCH, IN_PAGE_VERIFY, classifyResponse } from '../src/replay';
import { searchPlaces } from '../src/sites/maps';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-replay-e2e-'));
process.env.PROFILE_DIR = dir;
process.env.CARD_DIR = dir;
// CommonJS dependencies are loaded only after the temporary directories are set.
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
delete require.cache[require.resolve('../src/cardstore')];
const agent = require('../src/agent');
const jobs = require('../src/jobs');
let server, browser, base, token = 'initial-token', mode = 'success';
const posts = [];
const businesses = {
  rotterdam: [
    { name: 'Rotterdam Hair', category: 'Kapper', address: 'Teststraat 1, Rotterdam' },
    { name: 'Wrong City', category: 'Kapper', address: 'Amsterdam' },
  ],
  amsterdam: [
    { name: 'Amsterdam Animal Clinic', category: 'Dierenarts', address: 'Teststraat 2, Amsterdam' },
    { name: 'Wrong Category', category: 'Kapper', address: 'Amsterdam' },
    { name: 'Wrong Town Vet', category: 'Dierenarts', address: 'Rotterdam' },
  ],
};
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, base || 'http://localhost');
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/') return res.end('<input name="x-csrf-token" value="' + token + '"><input name="csrf" value="' + token + '"><input id="msg"><button id="send">Send</button><script>document.querySelector("#send").onclick=()=>fetch("/api/post",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":document.querySelector("[name=x-csrf-token]").value},body:JSON.stringify({message:document.querySelector("#msg").value,csrf:document.querySelector("[name=csrf]").value})});</script>');
    if (url.pathname === '/login') return res.end('<form id="login_form">Sign in</form>');
    if (url.pathname === '/api/posts') { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({ posts })); }
    if (url.pathname === '/api/post') {
      let body=''; req.on('data', c => body+=c);
      return req.on('end', () => {
        const data=JSON.parse(body);
        res.setHeader('content-type','application/json');
        if (req.headers['x-csrf-token'] !== token || data.csrf !== token) { res.statusCode=403; return res.end('{"error":"csrf refused"}'); }
        if(mode==='error') return res.end('{"errors":[{"message":"mutation refused"}]}');
        if(mode==='login') { res.statusCode=302;res.setHeader('location','/login');return res.end(); }
        if(mode==='ambiguous') return res.end('{"ok":true}');
        posts.push(data.message);return res.end('{"ok":true}');
      });
    }
    if (url.pathname === '/maps/search/') {
      const q=url.searchParams.get('query');
      const city=/Amsterdam/.test(q)?'amsterdam':'rotterdam';
      const links=businesses[city].map((r,i)=>'<a href="/maps/place/'+city+'/'+i+'" aria-label="'+r.name+'">'+r.name+'</a>').join('');
      return res.end('<input id="searchboxinput" value="'+q+'"><div role="feed">'+links+'</div>');
    }
    if (url.pathname.startsWith('/maps/place/')) {
      const [, , , city, index]=url.pathname.split('/');
      const row=businesses[city]?.[index];
      if(!row){res.statusCode=404;return res.end();}
      return res.end('<main role="main"><h1>'+row.name+'</h1><button data-category>'+row.category+'</button><button data-item-id="address">'+row.address+'</button><button data-item-id="phone:tel:123">+31 123</button></main>');
    }
    res.statusCode=404;res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  base='http://127.0.0.1:'+server.address().port;
  try { browser=await chromium.launch({headless:true,args:['--no-sandbox']}); }
  catch(e) {
    if(process.platform!=='win32') throw e;
    browser=await chromium.launch({channel:'chrome',headless:true});
  }
},60000);
afterAll(async()=>{
  if(browser)await browser.close();
  if(server)await new Promise(r=>server.close(r));
  fs.rmSync(dir,{recursive:true,force:true});
});

describe('production recording, replay and job outcomes in real Chromium',()=>{
  let card;
  it('records, confirms, persists and replays a NEW value using a rotated live token',async()=>{
    const context=await browser.newContext(),page=await context.newPage();
    const recorder=makeRecorder({log:{info(){}}}),store=makeCardStore({dir});
    context.on('request',r=>recorder.observe({method:r.method(),url:r.url(),headers:r.headers(),postData:r.postData()}));
    const verification={url:'/api/posts',path:['posts'],match:{slot:'message'},completesTask:true};
    for(let i=1;i<=2;i++){
      recorder.arm({intent:'fixture.send',origin:base,verification});
      await page.goto(base);await page.fill('#msg','ui-'+i);recorder.seal();
      await Promise.all([page.waitForResponse(r=>r.url()===base+'/api/post'),page.click('#send')]);
      expect(posts).toContain('ui-'+i);recorder.confirm();
      const fresh=recorder.finish({now:Date.now()}).card;
      store.put(learnFrom(store.get(base,'fixture.send'),fresh,Date.now()).card);
    }
    card=makeCardStore({dir}).get(base,'fixture.send');
    expect(planFor(card).mode).toBe('fast');
    token='rotated-token';await page.goto(base);
    const values={message:'new input on replay'};
    const outcome=await attemptReplay({card,values,runInPage:r=>page.evaluate(IN_PAGE_FETCH,r),
      prepare:()=>page.evaluate(IN_PAGE_VERIFY,{spec:verification,values}),
      verify:({baseline})=>page.evaluate(IN_PAGE_VERIFY,{spec:verification,values,baseline}),now:Date.now()});
    expect(outcome).toMatchObject({kind:'success',done:true});
    expect(posts).toEqual(['ui-1','ui-2','new input on replay']);
    await context.close();
  });
  it('does not accept an OLD matching record as a new success',async()=>{
    mode='ambiguous';const context=await browser.newContext(),page=await context.newPage();await page.goto(base);
    const values={message:'ui-1'};
    const out=await attemptReplay({card,values,runInPage:r=>page.evaluate(IN_PAGE_FETCH,r),prepare:()=>page.evaluate(IN_PAGE_VERIFY,{spec:card.verification,values}),verify:({baseline})=>page.evaluate(IN_PAGE_VERIFY,{spec:card.verification,values,baseline})});
    expect(out).toMatchObject({done:false,kind:'unconfirmed'});expect(posts.filter(p=>p==='ui-1')).toHaveLength(1);await context.close();
  });
  it.each(['error','login','ambiguous','success'])('actual agent job handles %s truthfully',async(testMode)=>{
    mode=testMode;
    const context=await browser.newContext(),page=await context.newPage();await page.goto(base);
    agent.cardStore.put({...card,intent:'flow:replay-diagnostic:send'});
    const job=jobs.create({owner:'fixture',goal:'Send one message',workflowId:'replay-diagnostic',nodeId:'send',sessionId:'fixture'});
    let modelCalls=0, observations=[];
    const values={message:'job-'+testMode};
    await agent.run({job,session:{page,recorder:makeRecorder({log:{info(){}}})},
      settings:{singleBrowser:true,autoAct:true,maxSteps:2,replayValues:values},pace:0,idleTimeoutMs:0,unattended:true,
      chat:async({messages})=>{modelCalls++;observations=messages;return {toolCalls:[{name:'finish',args:{summary:'Inspected replay outcome; stopping diagnostic.'}}],content:'',raw:{}};}});
    const completed=job.steps.some(s=>/completed by route-card replay/.test(s.text));
    expect(completed).toBe(testMode==='success');
    expect(posts.includes(values.message)).toBe(testMode==='success');
    if(testMode==='login'){
      expect(modelCalls).toBe(0);expect(job.status).toBe('stopped');
      expect(job.data.replay).toMatchObject({kind:'login_required',needsLogin:true});
      expect(job.report).toMatch(/Sign in/);
    }else if(testMode==='success')expect(modelCalls).toBe(0);
    else{
      expect(modelCalls).toBeGreaterThan(0);
      expect(observations.some(m=>/inspect the current state|choose the next step|inspect whether/i.test(m.content))).toBe(true);
    }
    await context.close();
  },20000);
});

describe('parameterized Maps routine with fresh, independently read business cards',()=>{
  it('records hairdressers Rotterdam then replays veterinarians Amsterdam with no old leads',async()=>{
    mode='success';
    const context=await browser.newContext(),page=await context.newPage();
    const store=makeCardStore({dir:path.join(dir,'maps')});
    const first=await searchPlaces(page,{business:'hairdressers',city:'Rotterdam',categoryTerms:['kapper'],limit:1},{store,baseUrl:base});
    expect(first.mode).toBe('record');expect(first.leads.map(x=>x.name)).toEqual(['Rotterdam Hair']);
    const next=await searchPlaces(page,{business:'animal doctors',city:'Amsterdam',categoryTerms:['dierenarts'],limit:3},{store,baseUrl:base});
    expect(next.mode).toBe('replay');expect(next.leads.map(x=>x.name)).toEqual(['Amsterdam Animal Clinic']);
    expect(next.complete).toBe(false);
    expect(next.rejected).toHaveLength(2);
    expect(JSON.stringify(store.list())).not.toMatch(/Rotterdam Hair|hairdressers|Rotterdam|Amsterdam Animal Clinic/);
    expect(next.leads.every(x=>x.category==='Dierenarts'&&x.address.includes('Amsterdam'))).toBe(true);
    await context.close();
  },30000);
});

describe('Maps tool through the actual agent and real browser',()=>{
  it('saves only fresh leads from the substituted second query',async()=>{
    const context=await browser.newContext();
    await context.route('https://www.google.com/maps/**',async route=>{const url=new URL(route.request().url());const response=await fetch(base+url.pathname+url.search);await route.fulfill({contentType:'text/html',body:await response.text()});});
    const page=await context.newPage();
    for(const args of [{business:'hairdressers',city:'Rotterdam',categoryTerms:['kapper'],limit:1},{business:'animal doctors',city:'Amsterdam',categoryTerms:['dierenarts'],limit:1}]){
      const job=jobs.create({owner:'fixture',goal:args.business+' in '+args.city,sessionId:'maps-fixture'});let turn=0;
      await agent.run({job,session:{page},role:'google.maps',settings:{singleBrowser:true,maxSteps:3},pace:0,idleTimeoutMs:0,unattended:true,
        chat:async()=>({content:'',raw:{},toolCalls:++turn===1?[{name:'maps_search',args}]:[{name:'finish',args:{summary:'Verified places saved.'}}]})});
      expect(job.leads).toHaveLength(1);expect(job.leads[0].city).toBe(args.city);expect(job.data.mapsSearch.query).toBe(args.business+' '+args.city);
      if(args.city==='Amsterdam')expect(job.leads[0].name).toBe('Amsterdam Animal Clinic');
    }
    await context.close();
  },20000);
});

describe('response classification',()=>{
  it.each([
    [{status:200,text:'{"errors":[{"code":190}]}',url:base},'login_required'],
    [{status:200,text:'for (;;);{"error":1357001}'},'application_error'],
    [{status:429},'http_error'],
    [{status:200,text:'{"success":false}'},'application_error'],
    [{status:0},'uncertain'],
    [{status:204},'unconfirmed'],
  ])('does not confuse a response with a verified outcome', (response,kind)=>expect(classifyResponse(response).kind).toBe(kind));
});
