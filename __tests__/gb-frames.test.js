// gb-frames.test.js — the phone's page script reaches into frames (2026-11-10).
//
// A Claude session could not edit a Google Business Profile on the owner's phone: Google's edit form is a
// frame from another domain, and the phone's tools only ran in the top page. Now gb.js + a frame agent run in
// every frame (FrameBridge.kt); the top page tells each frame where it sits, a frame numbers its elements
// after the top page's and answers only the app's own channel. These run that code in jsdom.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const GB = read('../mobile/app/src/main/assets/gb.js');
const KT = read('../mobile/app/src/main/java/engineer/myapp/gbmobile/FrameBridge.kt');
const FRAME_JS = KT.match(/const val FRAME_JS = """([\s\S]*?)"""/)[1];

const tick = () => new Promise((r) => setTimeout(r, 20));
function rect(el, x, y, w, h) {
  el.getBoundingClientRect = () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y });
}

let dom, top, frame, sent, onMsg;
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><body><button id="b">Top</button><iframe id="f"></iframe></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  top = dom.window;
  const ifr = top.document.getElementById('f');
  rect(ifr, 10, 100, 300, 400);
  rect(top.document.getElementById('b'), 0, 0, 80, 30);
  frame = ifr.contentWindow;
  // jsdom leaves event.source empty ("TODO: requires the incumbent window"); deliver it with its sender.
  const deliver = (data, source) => setTimeout(() => frame.dispatchEvent(new frame.MessageEvent('message', { data, source })), 0);
  frame.postMessage = (data) => deliver(data, top);
  frame.__fromStranger = (data) => deliver(data, frame);
  for (const w of [top, frame]) Object.defineProperty(w.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
  frame.document.body.innerHTML = '<input id="name" placeholder="Bedrijfsnaam"><button id="save">Opslaan</button><p>Profiel bewerken</p>';
  rect(frame.document.getElementById('name'), 5, 20, 200, 30);
  rect(frame.document.getElementById('save'), 5, 60, 90, 30);
  sent = []; onMsg = null;
  frame.GBFrame = { postMessage: (s) => sent.push(JSON.parse(s)), addEventListener: (t, fn) => { if (t === 'message') onMsg = fn; } };
  frame.eval(GB); frame.eval(FRAME_JS);
  top.eval(GB);
});
const ask = (m) => { onMsg({ data: JSON.stringify({ rid: 'r1', ...m }) }); return sent[sent.length - 1]; };

describe('a frame on the phone', () => {
  it('says hello to the app over its own channel, never the top page', () => {
    expect(sent[0]).toMatchObject({ hello: 1 });
    expect(sent[0].fid).toMatch(/^[a-z0-9]{8,}$/);
    expect(top.GBFrame).toBeUndefined();
  });

  it('does not know where it is until the page above tells it', async () => {
    expect(ask({ op: 'where' }).result.off).toBeNull();
    expect(ask({ op: 'mark' }).result).toMatchObject({ hidden: true });
    expect(top.__gb.geo()).toMatchObject({ frames: 1 });
    await tick();
    expect(ask({ op: 'where' }).result.off).toEqual({ x: 10, y: 100 });
  });

  it('ignores a position from anyone but its own parent', async () => {
    frame.__fromStranger({ __gbgeo: 1, x: 999, y: 999 });
    await tick();
    expect(ask({ op: 'where' }).result.off).toBeNull();
  });

  it('numbers its elements after the top page and reads its own form', async () => {
    const topEls = top.__gb.mark();
    expect(topEls.map((e) => e.text)).toContain('Top');
    top.__gb.geo(); await tick();
    const r = ask({ op: 'mark', base: topEls.length }).result;
    expect(r.off).toEqual({ x: 10, y: 100 });
    expect(r.els.map((e) => e.text)).toEqual(['Bedrijfsnaam', 'Opslaan']);
    const badges = [...frame.document.querySelectorAll('#__gbmarks > div')].map((d) => d.textContent).filter(Boolean);
    expect(badges).toEqual([String(topEls.length), String(topEls.length + 1)]);
  });

  it('types into the frame’s field and reads the frame’s text', async () => {
    top.__gb.geo(); await tick(); ask({ op: 'mark' });
    expect(ask({ op: 'type', i: 0, text: 'my-app.engineer' }).result).toBe('ok');
    expect(frame.document.getElementById('name').value).toBe('my-app.engineer');
    expect(ask({ op: 'text' }).result.text).toContain('Profiel bewerken');
  });

  it('does not number what is hidden under the frame (the page behind a dialog)', () => {
    const d = top.document;
    const under = d.createElement('a'); under.href = '/zoeken'; under.textContent = 'Zoekresultaat'; d.body.appendChild(under);
    rect(under, 50, 200, 120, 30);
    top.innerWidth = 400; top.innerHeight = 800;
    const ifr = d.getElementById('f'), btn = d.getElementById('b');
    d.elementFromPoint = (x, y) => (x >= 10 && x < 310 && y >= 100 && y < 500 ? ifr : x < 80 && y < 30 ? btn : d.body);
    const texts = top.__gb.mark().map((e) => e.text);
    expect(texts).toContain('Top');
    expect(texts).not.toContain('Zoekresultaat');
  });

  it('selects a field before real keys and reports what it holds', async () => {
    top.__gb.geo(); await tick(); ask({ op: 'mark' });
    frame.document.getElementById('name').value = 'Oude naam';
    expect(ask({ op: 'select', i: 0 }).result).toBe(9);
    expect(frame.document.activeElement.id).toBe('name');
    expect(ask({ op: 'value', i: 0 }).result).toBe('Oude naam');
    expect(ask({ op: 'select', i: 99 }).result).toBe(-1);
  });

  it('answers only a command addressed to it', () => {
    const before = sent.length;
    onMsg({ data: JSON.stringify({ rid: 'r2', fid: 'someone-else', op: 'where' }) });
    expect(sent.length).toBe(before);
  });
});
