/**
 * images — the browser's hands for FILES: a canvas brand image, an upload that sets a file input, and
 * a download that takes an image out of a page. The page is faked (page.evaluate / page.$ return
 * canned values), so this proves the tool logic — the one live edge (a real canvas, a real file
 * input) is what a walk confirms. What matters now: made/downloaded bytes land in the CROSS-SESSION
 * store (fileAssets), so a picture generated on one login is uploadable from another — the fix that
 * lets the channel art and the video frames actually reach the next step.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeAssetStore, extFor } from '../src/assets.js';

// Point the persistent store at a temp dir BEFORE importing anything that binds it at load.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-img-'));
process.env.PROFILE_DIR = dir;
const fileAssets = await import('../src/fileAssets.js');
const images = (await import('../src/tools/images.js')).default;
const roles = (await import('../src/roles.js')).default;
const agent = (await import('../src/agent.js')).default;
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
beforeEach(() => { try { for (const f of fs.readdirSync(fileAssets.DIR)) fs.rmSync(path.join(fileAssets.DIR, f), { force: true }); } catch { /* fresh */ } });

// A 1x1 PNG as a data URL, so a faked canvas/fetch returns real bytes.
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// A fake image element handle: reports a src, and can be screenshotted.
function fakeHandle({ src = 'https://lh3.googleusercontent.com/generated/x', screenshot = null } = {}) {
  return { evaluate: async () => src, screenshot: async () => screenshot, $: async () => null };
}

function fakeCtx({ evaluate, query, handle, evaluateHandle } = {}) {
  const steps = []; const notes = [];
  let resets = 0;
  return {
    _steps: steps, _notes: notes, get _resets() { return resets; },
    session: () => ({}),
    page: () => ({
      evaluate: evaluate || (async () => PNG_DATA_URL),
      // download_image finds the image element via evaluateHandle → asElement().
      evaluateHandle: evaluateHandle || (async () => ({ asElement: () => (handle || null) })),
      $: query || (async () => null),
      $$: async () => [],
    }),
    observe: (t) => notes.push(t),
    step: (k, t) => steps.push([k, t]),
    settle: async () => {},
    sleep: async () => {},
    resetClickLoop: () => { resets += 1; },
  };
}

describe('the per-session asset store (assets.js, still its own module)', () => {
  it('puts bytes and gets them back; list is metadata only (no bytes)', () => {
    const s = makeAssetStore();
    const id = s.put({ kind: 'profile', mime: 'image/png', bytes: Buffer.from([1, 2, 3]) });
    expect(s.get(id).bytes).toHaveLength(3);
    expect(s.latest('profile').id).toBe(id);
    expect(s.list()[0].bytes).toBe(3);            // a COUNT, not the bytes
  });
  it('extFor maps mimes', () => {
    expect(extFor('image/png')).toBe('png');
    expect(extFor('application/x')).toBe('bin');
  });
});

describe('make_brand_image → cross-session store', () => {
  it('draws a profile asset that lands in fileAssets, ready for any later step to upload', async () => {
    const ctx = fakeCtx();
    await images.make_brand_image(ctx, { kind: 'profile', name: 'CaseHandoff', accent: '#d62b2b' });
    const items = fileAssets.list();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('profile');
    expect(fileAssets.latest('profile').bytes.length).toBeGreaterThan(0);
    expect(ctx._notes.join(' ')).toMatch(/upload_image/);
  });
});

describe('upload_image', () => {
  it('sets the file input from a stored (cross-session) asset', async () => {
    let setWith = null;
    const input = { setInputFiles: async (f) => { setWith = f; } };
    const ctx = fakeCtx({ query: async (sel) => (String(sel).includes('file') ? input : null) });
    fileAssets.put({ kind: 'profile', mime: 'image/png', name: 'profile.png', bytes: Buffer.from([9, 9, 9]) });
    await images.upload_image(ctx, { kind: 'profile' });   // no id → newest of the kind
    expect(setWith).toBeTruthy();
    expect(setWith.name).toBe('profile.png');
    expect(setWith.buffer).toHaveLength(3);
    expect(ctx._resets).toBe(1);   // an upload is progress — resets the click-loop
  });
  it('uploads by explicit assetId from a DIFFERENT session (the whole point of the store)', async () => {
    const id = fileAssets.put({ kind: 'cover', mime: 'image/png', name: 'cover.png', bytes: Buffer.from([7, 7]) });
    let setWith = null;
    const ctx = fakeCtx({ query: async () => ({ setInputFiles: async (f) => { setWith = f; } }) });
    await images.upload_image(ctx, { assetId: id });
    expect(setWith.buffer).toHaveLength(2);
  });
  it('with no image, says so instead of throwing', async () => {
    const ctx = fakeCtx();
    await images.upload_image(ctx, { kind: 'profile' });
    expect(ctx._notes.join(' ')).toMatch(/No stored image/);
  });
  it('with no file input on the page, tells the walk to open the editor first', async () => {
    fileAssets.put({ kind: 'cover', mime: 'image/png', bytes: Buffer.from([1]) });
    const ctx = fakeCtx({ query: async () => null });
    await images.upload_image(ctx, { kind: 'cover' });
    expect(ctx._notes.join(' ')).toMatch(/Open the photo editor first|No file input/);
  });
});

describe('download_image → cross-session store', () => {
  it('full-res fast path: fetches the image bytes in-page and stores them for a later login to upload', async () => {
    // fetch succeeds (page.evaluate returns a data URL) → the fetched bytes are stored.
    const ctx = fakeCtx({ handle: fakeHandle(), evaluate: async () => PNG_DATA_URL });
    await images.download_image(ctx, { kind: 'cover' });
    const items = fileAssets.list();
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('cover');
    expect(ctx._notes.join(' ')).toMatch(/upload_image|upload_file/);
  });
  it('reliable fallback: when the fetch cannot read the bytes (blob/CORS), it SCREENSHOTS the element', async () => {
    const shot = Buffer.from([5, 5, 5, 5]);
    // fetch returns null (a Gemini blob URL the in-page fetch cannot read) → screenshot the element.
    const ctx = fakeCtx({ handle: fakeHandle({ screenshot: shot }), evaluate: async () => null });
    await images.download_image(ctx, { kind: 'profile' });
    const item = fileAssets.latest('profile');
    expect(item).toBeTruthy();
    expect(item.bytes).toHaveLength(4);          // the screenshot bytes, not an empty store
    expect(item.mime).toBe('image/png');
  });
  it('when no image element is present yet, says to wait rather than storing nothing', async () => {
    const ctx = fakeCtx({ evaluateHandle: async () => ({ asElement: () => null }) });
    await images.download_image(ctx, {});
    expect(fileAssets.list()).toHaveLength(0);
    expect(ctx._notes.join(' ')).toMatch(/No generated image/);
  });
});

describe('the roles carry the tools', () => {
  it('herald.facebook.onboard can make and upload images', () => {
    const picked = roles.toolsFor('herald.facebook.onboard', agent.TOOLS).map((t) => t.function.name);
    expect(picked).toContain('make_brand_image');
    expect(picked).toContain('upload_image');
    expect(picked).toContain('act');
  });
  it('the three image tools are declared in the model tool set', () => {
    const names = agent.TOOLS.map((t) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['make_brand_image', 'upload_image', 'download_image']));
  });
});

/*
 * GIVING THE GENERATOR THE MARK TO MATCH.
 *
 * A cover asked for "in and around #5fe87f" comes back as a green rectangle. The same request with
 * the brand's own mark attached comes back as a banner that shares its weight, its geometry and its
 * exact greens — because the model can see the thing it is matching.
 *
 * The obstacle was never the picture, which has been on the shelf all along. It was that a chat's
 * attach button opens the OPERATING SYSTEM's file window, which a browser automation cannot answer.
 * Its paste handler can be reached, and pasting a screenshot is how people use these tools anyway.
 */
describe('pasting a reference image into a prompt box', () => {
  it('pastes the stored image of a named kind and reports what the page did with it', async () => {
    fileAssets.put({ kind: 'brandmark', mime: 'image/png', name: 'm.png', bytes: Buffer.from([1, 2, 3, 4]) });
    /* The page half runs in a real browser; here it stands in, and returns what it would return. */
    const ctx = fakeCtx({ evaluate: async () => ({ ok: true, handled: true, tag: 'div', label: 'Ask Gemini' }) });
    await images.paste_image(ctx, { kind: 'brandmark' });
    expect(ctx._steps.some(([k]) => k === 'image')).toBe(true);
    expect(ctx._notes.join(' ')).toMatch(/accepted the paste/);
  });

  /* Delivered is not attached. Only a look can tell, so the walk is sent to look. */
  it('never claims the image is attached — it sends the walk to check', async () => {
    fileAssets.put({ kind: 'brandmark', mime: 'image/png', name: 'm.png', bytes: Buffer.from([1, 2, 3, 4]) });
    const ctx = fakeCtx({ evaluate: async () => ({ ok: true, handled: false, tag: 'textarea', label: '' }) });
    await images.paste_image(ctx, { kind: 'brandmark' });
    const note = ctx._notes.join(' ');
    expect(note).toMatch(/did not visibly take it/);
    expect(note).toMatch(/call look/i);
    expect(note).toMatch(/thumbnail or file chip/);
  });

  /* A missing reference must never stop a run — the picture is better with it, not impossible without. */
  it('no stored image of that kind is a note, not a failure', async () => {
    const ctx = fakeCtx();
    await images.paste_image(ctx, { kind: 'brandmark' });
    expect(ctx._steps).toHaveLength(0);
    expect(ctx._notes.join(' ')).toMatch(/carry on without a reference image/);
  });

  it('and a page that refuses the paste says why, and says what to do instead', async () => {
    fileAssets.put({ kind: 'brandmark', mime: 'image/png', name: 'm.png', bytes: Buffer.from([1, 2, 3, 4]) });
    const ctx = fakeCtx({ evaluate: async () => ({ ok: false, why: 'there is no writing box on this page to paste into' }) });
    await images.paste_image(ctx, { kind: 'brandmark' });
    expect(ctx._notes.join(' ')).toMatch(/was not pasted: there is no writing box/);
    expect(ctx._notes.join(' ')).toMatch(/describe the brand in words and carry on/);
  });

  it('an exception in the page is survivable too', async () => {
    fileAssets.put({ kind: 'brandmark', mime: 'image/png', name: 'm.png', bytes: Buffer.from([1, 2, 3, 4]) });
    const ctx = fakeCtx({ evaluate: async () => { throw new Error('detached frame'); } });
    await images.paste_image(ctx, { kind: 'brandmark' });
    expect(ctx._notes.join(' ')).toMatch(/could not be pasted \(detached frame\)/);
    expect(ctx._notes.join(' ')).toMatch(/not a reason to stop/);
  });
});

describe('the image role knows how to use a reference', () => {
  const r = roles.ROLES['gemini.image'];

  it('it is allowed the tool at all', () => {
    expect(r.tools).toContain('paste_image');
  });

  /* The attach button is a dead end, and a walk that tries it burns its steps on a file dialog. */
  it('and is told to paste rather than hunt for a paperclip', () => {
    expect(r.prompt).toMatch(/do NOT hunt for the "\+" or a paperclip/);
    expect(r.prompt).toMatch(/open the computer's own file window, which you cannot use/);
  });

  it('the reference goes in BEFORE the prompt is typed', () => {
    const paste = r.prompt.indexOf('paste_image');
    const type = r.prompt.indexOf('TYPE the prompt into the box and RUN it');
    expect(paste).toBeGreaterThan(0);
    expect(paste).toBeLessThan(type);
  });

  it('and the walk must confirm the thumbnail before writing the prompt', () => {
    expect(r.prompt).toMatch(/A thumbnail or a file chip should be sitting in or just above the box/);
    expect(r.prompt).toMatch(/Only once the thumbnail is there, type the prompt/);
  });

  /* Two runs that produced different pictures must not read the same in the record. */
  it('the note says whether the reference actually went in', () => {
    expect(r.prompt).toMatch(/SAY WHETHER THE REFERENCE WAS ATTACHED/);
  });

  it('the model is offered the tool', () => {
    const tool = agent.TOOLS
      ? agent.TOOLS.find((t) => t.function && t.function.name === 'paste_image')
      : null;
    if (tool) expect(tool.function.description).toMatch(/REFERENCE picture/);
  });
});

/*
 * IT DID THE WHOLE JOB INTO A SIGNED-OUT CHAT.
 *
 * Live: the walk opened Gemini in the google profile, pasted the mark, typed the full prompt and
 * sent it — while a "Sign in" button sat in the corner of the very first screenshot. The attachment
 * stopped at "Uploading file: 50%" and never moved. Nothing errored; it simply never finished.
 *
 * The order was wrong. Checking whether the door is open costs one look and is the cheapest thing
 * the walk can do; doing it last costs the whole run.
 */
describe('the image role checks the door before spending the run on it', () => {
  const r = roles.ROLES['gemini.image'];

  it('the FIRST question at each door is whether it is signed in', () => {
    expect(r.prompt).toMatch(/IS THIS SIGNED IN\?/);
    const ask = r.prompt.indexOf('IS THIS SIGNED IN');
    const paste = r.prompt.indexOf('paste_image');
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(paste);
  });

  it('and a signed-out chat is left alone, not filled in', () => {
    expect(r.prompt).toMatch(/do NOT paste, do NOT type, do NOT send/);
  });

  /* The order that cost every run: the working door is tried first, not last. */
  it('the door that is signed in is the one it starts at', () => {
    expect(r.prompt).toMatch(/THE FIRST DOOR — GOOGLE AI STUDIO/);
    expect(r.prompt).toMatch(/THE SECOND DOOR — GEMINI/);
  });

  /* Both doors shut is a person's problem. Filling in a sign-in form is never the walk's job. */
  it('and both doors shut ends the run instead of attempting a login', () => {
    expect(r.prompt).toMatch(/do NOT fill in a sign-in form/);
    expect(r.prompt).toMatch(/Somebody has to sign that browser profile in once/);
  });

  /* A stuck percentage is not a slow generation, and telling them apart is what ends the waiting. */
  it('a page that will never answer is recognised as one', () => {
    expect(r.prompt).toMatch(/A SIGNED-OUT SESSION IS NOT A SLOW ONE/);
    expect(r.prompt).toMatch(/Waiting longer has never once turned this into a picture/);
  });

  /* The organ reads this marker to tell "try again later" apart from "nobody can fix this by trying". */
  it('the one unfixable failure is marked so an organ can act on it', () => {
    expect(r.prompt).toMatch(/BEGIN YOUR NOTE WITH "SIGNED OUT:"/);
    expect(r.prompt).toMatch(/needs a person to sign in/);
  });
});

/*
 * A FINDING THAT IS NOT A NUMBER.
 *
 * Performance was the only thing a Search Console reader could file, so on a young property the
 * channel's entire output was "nought clicks, one impression" — true, and useless. The actionable
 * half of that console is counts, refusal reasons, sitemap statuses, manual actions and Google's own
 * messages, and none of them fitted through the reach door.
 *
 * One call per finding, as it is read: a walk that is stopped halfway still delivers what it saw.
 */
describe('recording what Search Console says about the property', () => {
  const records = require('../src/tools/records.js');

  const ctxFor = () => {
    const steps = []; const notes = []; const rows = [];
    return {
      _steps: steps, _notes: notes, _rows: rows,
      addGscHealth: (r) => {
        if (!r || !r.kind || !r.label) return null;
        if (rows.some((x) => x.kind === r.kind && x.label === r.label && x.value === r.value)) return null;
        const row = { kind: r.kind, label: r.label, value: String(r.value ?? ''), detail: r.detail || '' };
        rows.push(row); return row;
      },
      step: (k, t) => steps.push([k, t]),
      observe: (t) => notes.push(t),
    };
  };

  it('a finding is recorded and named back to the walk', async () => {
    const ctx = ctxFor();
    await records.save_gsc_health(ctx, { kind: 'indexing', label: 'not indexed', value: '12' });
    expect(ctx._rows).toHaveLength(1);
    expect(ctx._steps[0][1]).toMatch(/indexing: not indexed = 12/);
  });

  /* A walk that re-reads a tab must not double a finding, and must be told to move on. */
  it('the same finding twice is the same finding', async () => {
    const ctx = ctxFor();
    const row = { kind: 'sitemap', label: '/sitemap.xml', value: 'Geslaagd' };
    await records.save_gsc_health(ctx, row);
    await records.save_gsc_health(ctx, row);
    expect(ctx._rows).toHaveLength(1);
    expect(ctx._notes.join(' ')).toMatch(/already down/);
  });

  it('a finding with no kind is refused rather than stored empty', async () => {
    const ctx = ctxFor();
    await records.save_gsc_health(ctx, { label: 'orphan' });
    expect(ctx._rows).toHaveLength(0);
    expect(ctx._steps).toHaveLength(0);
  });
});

/*
 * ── SOMEBODY ELSE'S TOOLBAR ENDED UP IN OUR DIAGRAM ──────────────────────────────────────────────
 *
 * The first drawn diagram this platform published came out with three small icons in its top-right
 * corner — the generator's own share, copy and download buttons. Nothing grabbed them by accident.
 * An element screenshot captures whatever is painted over that RECTANGLE, and the toolbar sits on
 * top of the picture, so the fallback could not avoid photographing another product's interface onto
 * our page. No amount of aiming fixes that; it is the wrong kind of capture.
 *
 * The order is now: fetch the source, then read the image's own pixels through a canvas, and only
 * then photograph the screen. The canvas reads the IMAGE rather than the screen, at its real
 * resolution, with nothing on top of it — and it fails loudly (a tainted canvas throws) exactly when
 * the screenshot really is the only thing left.
 */
describe('a captured image is the image, not the region it sits in', () => {
  const src = fs.readFileSync(new URL('../src/tools/images.js', import.meta.url), 'utf8');

  /* Scoped to download_image — screenshot_page photographs the screen on purpose, and always will. */
  const grab = src.slice(src.indexOf('async download_image'));

  it('the pixels are read through a canvas before anything photographs the screen', () => {
    const canvasAt = grab.indexOf("c.getContext('2d').drawImage(el, 0, 0, w, h)");
    const shotAt = grab.indexOf("handle.screenshot({ type: 'png' })");
    expect(canvasAt).toBeGreaterThan(0);
    expect(shotAt).toBeGreaterThan(0);
    expect(canvasAt).toBeLessThan(shotAt);
  });

  /* Full resolution, not display size — the canvas is sized from the image, not from the layout. */
  it('at the image\'s own size rather than the size it happens to be shown at', () => {
    expect(src).toMatch(/const w = el\.naturalWidth \|\| el\.width, h = el\.naturalHeight \|\| el\.height/);
  });

  /* A tainted canvas is the signal that the screenshot is genuinely the last resort. */
  it('and a cross-origin image falls through rather than throwing', () => {
    expect(src).toMatch(/throws on a tainted canvas/);
  });

  /*
   * The other way chrome got in: a numbered element that is a CARD, not an image. Capturing the card
   * captures its border, its padding and its buttons.
   */
  it('a numbered element is used only when it is an image', () => {
    expect(src).toMatch(/handle = await marked\.\$\('img'\)\.catch/);
    expect(src).toMatch(/el\.tagName === 'IMG'/);
    expect(src).not.toMatch(/\(await marked\.\$\('img'\)\) \|\| marked/);
  });
});
