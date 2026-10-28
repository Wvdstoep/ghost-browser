import {describe,it,expect,afterAll} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'job-list-execution-'));process.env.PROFILE_DIR=dir;
const jobs=createRequire(import.meta.url)('../src/jobs');afterAll(()=>{jobs.jobs.clear();fs.rmSync(dir,{recursive:true,force:true})});
it('preserves execution and capture in compact job lists, without exposing unrelated job data',()=>{
 const j=jobs.create({owner:'one',sessionId:'fixture',goal:'Maps'});
 jobs.storeData(j,'execution',{mode:'Saved routine reused',verified:true});jobs.storeData(j,'capture',{saved:true,recording:'maps'});jobs.storeData(j,'privateFixture','do-not-list');
 for(const rows of [jobs.listAll(),jobs.listFor('one')]){
  const row=rows.find(x=>x.id===j.id);expect(row.data.execution.mode).toBe('Saved routine reused');expect(row.data.capture.saved).toBe(true);expect(JSON.stringify(row)).not.toContain('do-not-list');
 }
 expect(jobs.listFor('other')).toEqual([]);
});
