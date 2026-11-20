// ring-page.test.js — what the server asks the page on the owner's device (2026-11-19).
//
// A Claude session on the SM-F926B (Product Hunt, then a test page that logged every event) found the phone's
// tools acting blind: a tap on a disabled "Get started" answered "clicked", a form that checks its field on
// blur kept the button disabled after typing, a click by text hit a hidden copy, analyze showed no value and
// no disabled state, and pictures, uploads, a click at a spot and Control+A were refused. ringPage.js fills
// those gaps with page scripts the app already runs (/v1/eval). These run them in jsdom, with gb.js, as the
// phone does.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const P = require('../src/ringPage');
const GB = readFileSync(fileURLToPath(new URL('../mobile/app/src/main/assets/gb.js', import.meta.url)), 'utf8');

function rect(el, x, y, w, h) {
  el.getBoundingClientRect = () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y });
}
let dom, win, doc, run, onTop;
function page(html) {
  dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  win = dom.window; doc = win.document;
  Object.defineProperty(win.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
  // jsdom draws nothing: what is "on top" at a point is what the test says.
  onTop = null;
  doc.elementFromPoint = () => onTop;
  win.eval(GB);
  run = (code) => win.eval(code);
}
/** Number these elements the way gb.js mark() does (its own scan needs real geometry). */
const number = (...els) => { win.__gb._els = els.map((el) => ({ el })); };

describe('before a tap', () => {
  beforeEach(() => {
    page('<form><input id="url" placeholder="Link"><button id="go" disabled>Get started</button></form><div id="veil"></div>');
    rect(doc.getElementById('go'), 10, 100, 120, 40);
    number(doc.getElementById('url'), doc.getElementById('go'));
  });
  it('says a disabled button is disabled, and leaves the field the cursor is in so the form can check it', () => {
    const field = doc.getElementById('url'); field.focus();
    let blurred = 0; field.addEventListener('blur', () => { blurred += 1; });
    expect(run(P.stateJs(P.elementRef('screen', 1), { release: true }))).toEqual({ disabled: true, released: true });
    expect(blurred).toBe(1);
    expect(run(P.stateJs(P.elementRef('screen', 1)))).toEqual({ disabled: true, released: false });
  });
  it('lets an enabled button through, and names what covers one', () => {
    const go = doc.getElementById('go'); go.disabled = false;
    onTop = go;
    expect(run(P.stateJs(P.elementRef('screen', 1)))).toEqual({ ok: true, cover: '' });
    const veil = doc.getElementById('veil'); veil.className = 'modal backdrop open'; onTop = veil;
    expect(run(P.stateJs(P.elementRef('screen', 1))).cover).toBe('div#veil.modal.backdrop');
  });
  it('tells an element that left the page from one it cannot see (a frame\'s)', () => {
    doc.getElementById('go').remove();
    expect(run(P.stateJs(P.elementRef('screen', 1)))).toEqual({ gone: 1 });
    expect(run(P.stateJs(P.elementRef('screen', 7)))).toEqual({ unknown: 1 });
  });
  it('treats aria-disabled and a disabled fieldset as disabled', () => {
    page('<fieldset disabled><button id="a">A</button></fieldset><div role="button" id="b" aria-disabled="true">B</div>');
    number(doc.getElementById('a'), doc.getElementById('b'));
    expect(run(P.stateJs(P.elementRef('screen', 0))).disabled).toBe(true);
    expect(run(P.stateJs(P.elementRef('screen', 1))).disabled).toBe(true);
  });
});

describe('click by text picks the copy a person sees', () => {
  it('skips the hidden copy and puts the shown one in the slot the app taps', () => {
    page('<div style="display:none"><button id="h">Done</button></div><button id="v">Done</button><p>Done is a word in this long paragraph about other things entirely, too long to be the button</p>');
    rect(doc.getElementById('h'), 0, 0, 80, 30); rect(doc.getElementById('v'), 0, 50, 80, 30);
    onTop = doc.getElementById('v');
    const r = run(P.findTextJs('Done'));
    expect(r).toMatchObject({ found: 1, tag: 'button', text: 'done', hiddenCopies: 1 });
    expect(win.__gb._els[P.PICK].el.id).toBe('v');
  });
  it('says so when every copy is hidden, instead of tapping one', () => {
    page('<div style="visibility:hidden"><button id="h">Add pricing</button></div>');
    rect(doc.getElementById('h'), 0, 0, 80, 30);
    expect(run(P.findTextJs('add pricing'))).toEqual({ notfound: 1, hidden: 1 });
  });
  it('prefers the copy in an open dialog, and reports a covered one', () => {
    page('<button id="a">Save</button><div role="dialog"><button id="b">Save</button></div><div id="o"></div>');
    rect(doc.getElementById('a'), 0, 0, 80, 30); rect(doc.getElementById('b'), 0, 300, 80, 30);
    onTop = doc.getElementById('b');
    run(P.findTextJs('Save'));
    expect(win.__gb._els[P.PICK].el.id).toBe('b');
    page('<button id="a">Save</button><div id="o" class="cookie"></div>');
    rect(doc.getElementById('a'), 0, 0, 80, 30);
    onTop = doc.getElementById('o');
    expect(run(P.findTextJs('Save'))).toMatchObject({ covered: 'div#o.cookie' });
  });
});

describe('a spot on the screenshot', () => {
  it('becomes the point the app taps, scaled from the screenshot to the page', () => {
    page('<canvas id="c"></canvas>');
    onTop = doc.getElementById('c');
    // The service browser's screenshot is 720 px wide; jsdom's page is 1024 CSS px.
    const r = run(P.spotJs(360, 100, 720));
    expect(r).toMatchObject({ x: 512, y: 142, at: 'canvas#c' });
    // gb.js coords() is what the app reads before its native tap.
    expect(win.__gb.coords(P.SPOT)).toMatchObject({ x: 512, y: 142 });
    expect(run(P.spotJs(5000, 10, 720)).error).toBe('outside');
  });
});

describe('what analyze now says about each element', () => {
  it('splits value from placeholder, reports disabled and ticked, and never reads a password', () => {
    page('<input id="n" placeholder="Name" value="Ghost"><input id="p" type="password" value="hunter2"><input id="c" type="checkbox" checked><button id="b" disabled>Go</button><input type="file" style="display:none">');
    number(...['n', 'p', 'c', 'b'].map((i) => doc.getElementById(i)));
    const r = run(P.fieldsJs('screen'));
    expect(r.fileInputs).toBe(1);
    expect(r.fields[0]).toMatchObject({ value: 'Ghost', placeholder: 'Name', disabled: false });
    expect(r.fields[1]).toEqual({ disabled: false, placeholder: '', password: true, filled: true });
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(r.fields[2].checked).toBe(true);
    expect(r.fields[3].disabled).toBe(true);
  });
});

describe('typing then leaving the field, without leaving it', () => {
  it('lets a form that checks on blur run its check, and keeps the cursor in the field', () => {
    page('<input id="u">');
    const u = doc.getElementById('u'); u.focus();
    let checked = 0; doc.addEventListener('focusout', () => { checked += 1; });   // where React listens for onBlur
    expect(run(P.COMMIT_JS)).toBe('committed');
    expect(checked).toBe(1);
    expect(doc.activeElement).toBe(u);
  });
  it('leaves a field with suggestions alone, so they stay open', () => {
    page('<input id="q" role="combobox">');
    doc.getElementById('q').focus();
    expect(run(P.COMMIT_JS)).toBe('kept for its suggestions');
  });
});

describe('keys the phone has no key for', () => {
  it('types text at the cursor of the focused field', () => {
    page('<input id="t" value="ab">');
    const t = doc.getElementById('t'); t.focus(); t.setSelectionRange(1, 1);
    let inputs = 0; t.addEventListener('input', () => { inputs += 1; });
    expect(run(P.insertTextJs('X'))).toMatchObject({ changed: true, length: 3 });
    expect(t.value).toBe('aXb');
    expect(inputs).toBe(1);
  });
  it('asks for a click first when nothing is focused', () => {
    page('<p>x</p>');
    expect(run(P.insertTextJs('X')).error).toMatch(/nothing is focused/);
  });
  it('selects all in the field for Control+A, and moves back a field for Shift+Tab', () => {
    page('<input id="a" value="one"><input id="b" value="two">');
    rect(doc.getElementById('a'), 0, 0, 100, 20); rect(doc.getElementById('b'), 0, 30, 100, 20);
    const b = doc.getElementById('b'); b.focus();
    expect(run(P.SELECT_ALL_JS)).toBe('selected field');
    expect([b.selectionStart, b.selectionEnd]).toEqual([0, 3]);
    expect(run(P.FOCUS_PREVIOUS_JS)).toBe('moved');
    expect(doc.activeElement.id).toBe('a');
  });
});

describe('pictures and files on the device', () => {
  it('lists the pictures biggest first, naming inline ones without sending them', () => {
    page('<img id="s" src="https://cdn.example/s.jpg" alt="small"><img id="l" src="https://cdn.example/l.jpg" alt="large"><img id="d" src="data:image/png;base64,AAAA"><img id="t" src="https://cdn.example/icon.png">');
    const dims = { s: [200, 200], l: [1200, 800], d: [300, 300], t: [16, 16] };
    for (const [id, [w, h]] of Object.entries(dims)) {
      Object.defineProperty(doc.getElementById(id), 'naturalWidth', { value: w });
      Object.defineProperty(doc.getElementById(id), 'naturalHeight', { value: h });
    }
    const list = run(P.IMAGES_JS);
    expect(list.map((i) => i.alt || (i.inline ? 'inline' : '?'))).toEqual(['large', 'inline', 'small']);
    expect(list[1].src.length).toBeLessThanOrEqual(40);
    expect(run(P.imageDataJs(2))).toBe('data:image/png;base64,AAAA');
  });
  it('finds the file field behind its upload button and hands it the file as a picker would', () => {
    page('<div class="gallery"><button id="up">Upload images</button><input id="f" type="file" accept="image/*" style="display:none"></div>');
    number(doc.getElementById('up'));
    const f = doc.getElementById('f');
    let changed = 0; f.addEventListener('change', () => { changed += 1; });
    // jsdom has no DataTransfer, and its file list cannot be set: the browser's own pieces, stood in for.
    win.DataTransfer = class { constructor() { const list = []; this.items = { add: (x) => list.push(x) }; this.files = list; } };
    let got = null; Object.defineProperty(f, 'files', { configurable: true, get: () => got || [], set: (v) => { got = v; } });
    expect(run(P.uploadTargetJs(P.elementRef('screen', 0)))).toEqual({ ok: true, accept: 'image/*', multiple: false });
    const b64 = Buffer.from('PNGDATA').toString('base64');
    run(P.uploadChunkJs(b64.slice(0, 4))); run(P.uploadChunkJs(b64.slice(4)));
    expect(run(P.uploadFinishJs('photo.png', 'image/png'))).toEqual({ ok: true, files: 1, bytes: 7 });
    expect(got[0].name).toBe('photo.png');
    expect(changed).toBe(1);
  });
  it('says when no file field belongs to the element', () => {
    page('<input type="file"><input type="file"><button id="x">x</button>');
    number(doc.getElementById('x'));
    expect(run(P.uploadTargetJs(P.elementRef('screen', 0))).error).toMatch(/several file fields/);
  });
});

describe('the console on an older app', () => {
  it('catches uncaught errors from the first call on, without replacing anything in the page', () => {
    page('<p>x</p>');
    const before = win.console.log;
    run(P.CONSOLE_JS);
    win.dispatchEvent(new win.ErrorEvent('error', { message: 'TypeError: x is undefined', filename: 'https://app.example/main.js', lineno: 12 }));
    const r = run(P.CONSOLE_JS);
    expect(r.entries[0]).toMatchObject({ kind: 'console', level: 'error', text: 'TypeError: x is undefined', line: 12 });
    expect(win.console.log).toBe(before);
  });
});

// 2026-11-20: Facebook's post menu opened below the screen; a tap at its centre landed outside the browser.
describe('an element sticking out of the screen', () => {
  beforeEach(() => {
    page('<div id="menu" role="menu"><div id="edit" role="menuitem">Bericht bewerken</div></div><div id="veil"></div>');
    win.innerWidth = 400; win.innerHeight = 800;
    number(doc.getElementById('edit'));
  });
  it('gives the centre of its shown part when that part is really it', () => {
    rect(doc.getElementById('edit'), 0, 780, 400, 60);   // 20 px on screen, the rest below
    onTop = doc.getElementById('edit');
    expect(run(P.stateJs(P.elementRef('screen', 0)))).toEqual({ ok: true, cover: '', part: { x: 200, y: 790 } });
  });
  it('says offscreen when nothing of it is shown, or its shown part is under something else', () => {
    rect(doc.getElementById('edit'), 0, 900, 400, 60);
    expect(run(P.stateJs(P.elementRef('screen', 0)))).toEqual({ ok: true, cover: '', offscreen: true });
    rect(doc.getElementById('edit'), 0, 780, 400, 60);
    onTop = doc.getElementById('veil');
    expect(run(P.stateJs(P.elementRef('screen', 0))).offscreen).toBe(true);
  });
  it('the script click is heard as a tap, and a point goes into the spot slot', () => {
    const got = [];
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) doc.getElementById('edit').addEventListener(t, () => got.push(t));
    if (!win.PointerEvent) win.PointerEvent = win.MouseEvent;
    expect(run(P.scriptClickJs(P.elementRef('screen', 0))).clicked).toMatch(/div/);
    expect(got).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    expect(run(P.pointJs(200, 790))).toEqual({ x: 200, y: 790 });
    expect(win.__gb._els[P.SPOT].el.getBoundingClientRect()).toMatchObject({ left: 200, top: 790 });
  });
  it('a line break is a line break in a box and a newline in a text area, never Enter', () => {
    page('<textarea id="t"></textarea><div id="ce" contenteditable="true"></div>');
    const cmds = []; doc.execCommand = (c, u, v) => { cmds.push([c, v]); return true; };
    doc.getElementById('t').focus();
    expect(run(P.LINE_BREAK_JS)).toEqual({ ok: true });
    doc.getElementById('ce').focus();
    run(P.LINE_BREAK_JS);
    expect(cmds).toEqual([['insertText', '\n'], ['insertLineBreak', undefined]]);
    doc.getElementById('t').value = 'tak poproszę';
    doc.getElementById('t').focus();
    expect(run(P.FIELD_TEXT_JS)).toEqual({ text: 'tak poproszę' });
  });
});
