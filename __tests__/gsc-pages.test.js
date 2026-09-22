/*
 * THE ADDRESSES BEHIND A REASON — the half of the reading that was missing.
 *
 * Pulse showed "Geblokkeerd door robots.txt = 9" for days. True, and useless: nobody can fix a
 * number. The nine URLs exist, one click deeper in the console, and the walk never went there.
 *
 * Two of these tests exist because of traps that were sitting in the way:
 *
 *   THE DUPLICATE CHECK WOULD HAVE EATEN THEM. The walk records the reason row first, then opens it
 *   and records the URLs behind it — same kind, same label, same value. addGscHealth refuses a
 *   finding it already has, so that second call was thrown away, and with it the only actionable
 *   part. A repeat that carries addresses is not a repeat.
 *
 *   THE COLLECTOR IS LAST-WINS, WHICH WOULD HAVE DROPPED THEM TOO. The count moving from 9 to 8 must
 *   update the row, but it must not lose the addresses read on the earlier call, because the row and
 *   its addresses arrive separately.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// jobs.js resolves its directory at load time and persists every change to disk. Point it at a
// temp dir BEFORE requiring it, so a test never writes into a real /profiles/jobs.
process.env.PROFILE_DIR = join(tmpdir(), `gb-gsc-pages-test-${process.pid}`);
const gsc = require('../src/gscWatch');
const jobsMod = require('../src/jobs');

const PROPERTY = 'sc-domain:my-app.engineer';
const runWith = (...jobIds) => ({ steps: jobIds.map((id) => ({ output: { __jobId: id } })) });
const jobs = (map) => (id) => map[id] || null;

const REASON = 'Geblokkeerd door robots.txt';
const NINE = [
  'https://my-app.engineer/api/me/export',
  'https://my-app.engineer/api/showcase',
  'https://my-app.engineer/api/explore/screenshot?owner=carla&app=shop',
];

describe('a finding carries the addresses behind it', () => {
  it('the collector keeps pages, and merges the ones that came in a separate call', () => {
    const job = {
      gscHealth: [
        { kind: 'indexing', label: REASON, value: '9', detail: 'ours to fix' },
        { kind: 'indexing', label: REASON, value: '9', pages: NINE },
      ],
    };
    const [found] = gsc.findingsOf(runWith('j1'), jobs({ j1: job }));
    expect(found.label).toBe(REASON);
    expect(found.value).toBe('9');
    expect(found.detail).toBe('ours to fix');
    expect(found.pages).toEqual(NINE);
  });

  it('a later pass with a NEW count keeps the addresses the earlier one read', () => {
    // The row and its addresses arrive in two calls; last-wins on the value must not mean
    // last-wins on the pages, or a changed count silently empties the only useful part.
    const job = {
      gscHealth: [
        { kind: 'indexing', label: REASON, value: '9', pages: NINE },
        { kind: 'indexing', label: REASON, value: '8' },
      ],
    };
    const [found] = gsc.findingsOf(runWith('j1'), jobs({ j1: job }));
    expect(found.value).toBe('8');
    expect(found.pages).toEqual(NINE);
  });

  it('a finding with no pages still works and simply has none', () => {
    const job = { gscHealth: [{ kind: 'manual_action', label: 'manual actions', value: 'Geen problemen' }] };
    const [found] = gsc.findingsOf(runWith('j1'), jobs({ j1: job }));
    expect(found.pages).toEqual([]);
  });
});

describe('what Pulse is shown', () => {
  const rowFor = (pages) => gsc.feedRowsFor(
    [{ kind: 'indexing', label: REASON, value: String(pages.length), detail: '', pages }],
    { property: PROPERTY },
  )[0];

  it('the addresses are in the fields, numbered, with a count', () => {
    const row = rowFor(NINE);
    expect(row.fields.pages).toBe('3');
    expect(row.fields['page 1']).toBe(NINE[0]);
    expect(row.fields['page 3']).toBe(NINE[2]);
  });

  it('the title stays the reason alone — the key must not move when the addresses do', () => {
    // A title carrying the count or the URLs makes every pass a new row, and the page fills with
    // history instead of showing the current state. This is the same rule the counts already follow.
    const one = rowFor([NINE[0]]);
    const three = rowFor(NINE);
    expect(one.title).toBe(REASON);
    expect(three.title).toBe(REASON);
    expect(one.url).toBe(three.url);
  });

  it('a long list is capped and says how many it did not list', () => {
    const many = Array.from({ length: 40 }, (_, i) => `https://my-app.engineer/learn/page-${i}`);
    const row = rowFor(many);
    expect(row.fields.pages).toBe('40');
    expect(row.fields['page 25']).toBe(many[24]);
    expect(row.fields['page 26']).toBeUndefined();
    expect(row.fields['and more']).toMatch(/15 further/);
  });

  it('a finding without addresses gets no pages fields at all', () => {
    const row = rowFor([]);
    expect(row.fields.pages).toBeUndefined();
    expect(row.fields['page 1']).toBeUndefined();
  });
});

describe('storing them on the job', () => {
  const freshJob = () => ({ id: 'job-1', gscHealth: [], steps: [] });

  it('a repeat that carries addresses is NOT a duplicate — it fills them in', () => {
    const j = freshJob();
    const first = jobsMod.addGscHealth(j, { kind: 'indexing', label: REASON, value: '9' });
    expect(first).toBeTruthy();
    expect(first.pages).toEqual([]);

    const second = jobsMod.addGscHealth(j, { kind: 'indexing', label: REASON, value: '9', pages: NINE });
    expect(second, 'the addresses must not be refused as a duplicate').toBeTruthy();
    expect(second.pages).toEqual(NINE);
    expect(j.gscHealth).toHaveLength(1);        // one finding, now complete — not two
  });

  it('a true repeat, with nothing new, is still refused', () => {
    const j = freshJob();
    jobsMod.addGscHealth(j, { kind: 'indexing', label: REASON, value: '9', pages: NINE });
    expect(jobsMod.addGscHealth(j, { kind: 'indexing', label: REASON, value: '9', pages: NINE })).toBeNull();
    expect(j.gscHealth).toHaveLength(1);
  });

  it('only real addresses are kept — a count or a label is not a URL', () => {
    const j = freshJob();
    const r = jobsMod.addGscHealth(j, {
      kind: 'indexing', label: REASON, value: '9',
      pages: ['https://my-app.engineer/a', '9', 'Geblokkeerd door robots.txt', '', null,
              '/relative/path', 'https://my-app.engineer/a'],
    });
    expect(r.pages).toEqual(['https://my-app.engineer/a']);
  });
});
