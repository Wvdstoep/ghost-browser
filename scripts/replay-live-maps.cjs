'use strict';
// Diagnostic runner. Run in a resource-limited test container, never in the serving pod.
// argv[2] optionally carries a base64 module for testing uncommitted code in memory.
const { chromium } = require('playwright');
const Module = require('module');
const assert = require('assert/strict');
(async () => {
  let maps;
  if (process.argv[2]) {
    const source = Buffer.from(process.argv[2], 'base64').toString();
    assert(source.includes('async function searchPlaces('), 'Expected the Maps module, not the runner');
    const module = new Module('/tmp/maps-live-module.js');
    module._compile(source, '/tmp/maps-live-module.js');
    maps = module.exports;
  } else maps = require('../src/sites/maps');
  const browser = await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const records = new Map();
  const store = {get:(o,i)=>records.get(o+i),put:c=>records.set(c.origin+c.intent,c)};
  try {
    const page = await browser.newPage({locale:'nl-NL'});
    const cases = [
      {business:'kappers',city:'Rotterdam',categoryTerms:['kapper','kapsalon'],limit:2},
      {business:'dierenartsen',city:'Amsterdam',categoryTerms:['dierenarts','dierenkliniek'],limit:2},
    ];
    for (const input of cases) {
      const result = await maps.searchPlaces(page,input,{store});
      console.log(JSON.stringify({result,url:page.url(),pageText:(await page.locator('body').innerText()).slice(0,2000)}));
      if (result.kind !== 'success') process.exitCode = 2;
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
