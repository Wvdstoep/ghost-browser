'use strict';
/*
 * WHAT THE SERVER ASKS THE PAGE ON THE OWNER'S DEVICE.
 *
 * A session on a device acts through the phone app's own commands (/v1/click taps for real, /v1/type types
 * key by key). What those commands never did was LOOK before acting, so on 2026-11-19 (Product Hunt on the
 * SM-F926B, through the my-app-full connector) a tap on a disabled "Get started" answered "clicked", a click
 * by text hit a hidden copy of the button, a screenshot of a scrolled page was white and the tools could not
 * see a field's value, upload a picture, list the page's pictures or click at a spot.
 *
 * Every phone app runs any expression in the page (/v1/eval, with gb.js already there), so these scripts
 * fill the gaps without a new app: they check an element before the tap, pick the visible copy of a text,
 * report a field's value and state, list pictures, put a kept file into a file field, and type at the
 * cursor. A tap stays the app's own trusted tap: a script only CHOOSES what the app taps, by putting it in
 * a numbered slot of window.__gb._els that /v1/click then taps (gb.js coords() reads the slot).
 *
 * Each builder returns one JavaScript EXPRESSION (the app wraps it in JSON.stringify((…))). Pure strings, so
 * __tests__/ring-page.test.js runs them in a DOM.
 */

/* The slots a script fills for the app to tap: far past any real number, so they never meet one. */
const PICK = 99999;   // the element a script chose (click by text)
const SPOT = 99998;   // a point on the screen (click at)

const slotRef = (n) => `(window.__gb&&window.__gb._els&&window.__gb._els[${n}]&&window.__gb._els[${n}].el)`;
/** The element the caller numbered: gb.js's list, or the page list used when the browser was never drawn. */
const elementRef = (mode, i) => (mode === 'dom'
  ? `(window.__ringEls&&window.__ringEls[${Number(i)}])`
  : slotRef(Number(i)));

/* A short name for an element, as a caller can recognise it: tag#id.class. */
const NAME_FN = `function(t){if(!t||!t.tagName)return 'something';var c=(typeof t.className==='string'&&t.className.trim())?'.'+t.className.trim().split(/\\s+/).slice(0,2).join('.'):'';return t.tagName.toLowerCase()+(t.id?'#'+t.id:'')+c}`;

/*
 * BEFORE A TAP: IS IT THERE, CAN IT BE PRESSED, IS IT ON TOP. A disabled button is pressed in vain; a form
 * that checks its field when the field is LEFT keeps its button disabled while the cursor is still in the
 * field (Product Hunt's "Link to the product"). With `release`, the focused field is left (blur), which is
 * what a person does by tapping elsewhere, so the form can check itself and enable the button.
 * Answers { unknown } (not in the top page: a frame's element, or an app without gb.js), { gone },
 * { disabled, released }, { inert } or { ok, cover: '' | 'what is on top' }.
 */
function stateJs(ref, { release = false } = {}) {
  return `(function(){var e=${ref};var name=${NAME_FN};
  if(!e||e.nodeType!==1)return {unknown:1};
  if(e.isConnected===false)return {gone:1};
  var dis=!!(e.disabled||(e.matches&&e.matches(':disabled'))||e.getAttribute('aria-disabled')==='true'||(e.closest&&e.closest('[aria-disabled="true"]')));
  if(dis){var a=document.activeElement,rel=false;
    if(${release ? 'true' : 'false'}&&a&&a!==e&&a!==document.body&&a!==document.documentElement&&a.blur){a.blur();rel=true}
    return {disabled:true,released:rel}}
  var inert=getComputedStyle(e).pointerEvents==='none';
  try{e.scrollIntoView({block:'center',inline:'center'})}catch(x){}
  var r=e.getBoundingClientRect(),cover='',root=e.getRootNode?e.getRootNode():document;
  var at=function(x,y){return (root&&root.elementFromPoint?root:document).elementFromPoint(x,y)};
  var hit=function(x,y){var t=at(x,y);
    return !t||t===e||e.contains(t)||t.contains(e)||(t.tagName==='LABEL'&&t.control===e)||(root!==document&&t===root.host)?'':name(t)};
  var CLICK='a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=switch],[onclick]';
  /* Another control INSIDE it at that point (a row's "..." button over its centre): not this one. */
  var nested=function(x,y){var t=at(x,y);if(!t||t===e||!e.contains(t))return null;var c=t.closest&&t.closest(CLICK);return c&&c!==e&&e.contains(c)?c:null};
  if(r.width>0&&r.height>0&&innerWidth>0){var cx=r.left+r.width/2,cy=r.top+r.height/2;
    var shown=cx>=0&&cy>=0&&cx<innerWidth&&cy<innerHeight;
    /* pointer-events: none on the label a person sees (Facebook's "Beantwoorden", 2026-11-20): it takes no
       events itself, and a finger on it reaches what listens there, a parent or an overlay. Give that spot. */
    if(inert){var u=shown?at(cx,cy):null;
      return u&&u!==document.body&&u!==document.documentElement?{inert:true,reach:name(u),point:{x:Math.round(cx),y:Math.round(cy)}}:{inert:true}}
    if(shown){cover=hit(cx,cy);var n=!cover&&nested(cx,cy);
      if(n){var fx=[.15,.3,.7,.85,.5],fy=[.5,.3,.7];
        for(var i=0;i<fy.length;i++)for(var j=0;j<fx.length;j++){var x=r.left+r.width*fx[j],y=r.top+r.height*fy[i];
          if(x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&!hit(x,y)&&!nested(x,y))return {ok:true,cover:'',part:{x:Math.round(x),y:Math.round(y)},nested:name(n)}}
        return {ok:true,cover:'',nested:name(n)}}}
    else{
      /* A menu that opens below the screen is a pinned layer: scrolling does not bring it up, and a tap
         at its centre lands outside the browser (Facebook's post menu, 2026-11-20). Tap the part of it
         that is on screen; with nothing on screen it can only be clicked by script. */
      var L=Math.max(r.left,0),T=Math.max(r.top,0),R=Math.min(r.right,innerWidth),B=Math.min(r.bottom,innerHeight);
      if(R-L>=2&&B-T>=2){var px=(L+R)/2,py=(T+B)/2;if(!hit(px,py))return {ok:true,cover:'',part:{x:Math.round(px),y:Math.round(py)}}}
      return {ok:true,cover:'',offscreen:true}}}
  if(inert)return {inert:true};
  return {ok:true,cover:cover}})()`;
}

/* A point of the page (CSS pixels) into slot SPOT, for the app's own tap there. */
function pointJs(x, y) {
  const X = Number(x) || 0; const Y = Number(y) || 0;
  return `(function(){if(!window.__gb||!window.__gb._els)return {error:'no page script'};
  window.__gb._els[${SPOT}]={el:{scrollIntoView:function(){},getBoundingClientRect:function(){return {left:${X},top:${Y},width:0,height:0}}}};return {x:${X},y:${Y}}})()`;
}

/* A click by script, as the page's own handlers hear a tap: pointer and mouse down and up, then click. */
function scriptClickJs(ref) {
  return `(function(){var e=${ref};if(!e||e.nodeType!==1)return {error:'gone'};var name=${NAME_FN};
  var o={bubbles:true,cancelable:true,composed:true,view:window,button:0,buttons:1};
  try{e.dispatchEvent(new PointerEvent('pointerdown',o))}catch(x){}e.dispatchEvent(new MouseEvent('mousedown',o));
  o.buttons=0;try{e.dispatchEvent(new PointerEvent('pointerup',o))}catch(x){}e.dispatchEvent(new MouseEvent('mouseup',o));
  e.click();return {clicked:name(e)}})()`;
}

/*
 * LONG TEXT AND LETTERS WITHOUT A KEY (2026-11-20). Typing key by key into Facebook's post box stopped after
 * about 2,000 characters (each key costs ~60 ms there, so the 120 s call ran out) and at "ę" (the virtual
 * keymap has no key for it, and the fallback key event is dropped). Such text goes in through the browser's
 * own insert command, which the editor hears as typing; a line break is inserted as a line break (what
 * Shift+Enter does), never Enter, so a comment box does not send half a text.
 */
const LINE_BREAK_JS = `(function(){var a=document.activeElement;if(!a||a===document.body)return {error:'nothing is focused'};
  var ok=false;if('value' in a){try{ok=document.execCommand('insertText',false,'\\n')}catch(e){}}
  else{try{ok=document.execCommand('insertLineBreak')}catch(e){}if(!ok){try{ok=document.execCommand('insertParagraph')}catch(e){}}}
  return {ok:ok}})()`;

/* Focus is in this element (a tap on a box can focus a child); else focus it. */
function focusInJs(ref) {
  return `(function(){var e=${ref};if(!e||e.nodeType!==1)return {error:'gone'};var a=document.activeElement;
  var inside=function(){a=document.activeElement;return !!a&&a!==document.body&&(a===e||e.contains(a)||a.contains(e))};
  if(!inside()){try{e.focus()}catch(x){}}
  if(!inside()){var c=e.querySelector&&e.querySelector('[contenteditable=true],textarea,input');if(c){try{c.focus()}catch(x){}}}
  return {focused:inside()}})()`;
}

/* The phone's Back button: the keyboard goes away (the field is left), then one step back in the history. */
const BACK_JS = `(function(){var a=document.activeElement;if(a&&a!==document.body&&a.blur)a.blur();
  var n=history.length;history.back();return n>1?'went back':'nothing to go back to'})()`;

/* A navigation the page itself makes (location.replace), for a browser whose own load does not take. */
function goJs(url) {
  return `(function(){try{location.replace(${JSON.stringify(String(url))});return 'going'}catch(e){return 'refused'}})()`;
}

/*
 * WAIT FOR A TEXT, AND SAY WHERE IT IS (2026-11-20). After "Plaatsen" there was no link to the new post,
 * so checking it went up meant searching the feed while the post slid away. This finds the text on the
 * page and the link nearest to it: the element's own link, else a permalink in the block around it
 * (a post, comment or story address before any other link).
 */
function waitTextJs(text) {
  const want = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return `(function(){var want=${JSON.stringify(want)};if(!want||!document.body)return {found:false};
  var hay=(document.body.innerText||'').replace(/\\s+/g,' ').toLowerCase();if(hay.indexOf(want)<0)return {found:false,url:location.href};
  var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),n,el=null,probe=want.slice(0,40);
  while((n=w.nextNode())){var t=(n.nodeValue||'').replace(/\\s+/g,' ').toLowerCase();if(t&&(t.indexOf(probe)>-1||probe.indexOf(t.trim())===0&&t.trim().length>8)){el=n.parentElement;break}}
  var PERMA=/\\/posts\\/|\\/permalink|story_fbid|comment_id|\\/status\\/|\\/p\\/|\\/reel\\/|\\/videos\\//;
  var link='',up=el,hops=0;
  if(el&&el.closest){var own=el.closest('a[href]');if(own)link=own.href}
  while(!link&&up&&hops<8){var as=up.querySelectorAll?up.querySelectorAll('a[href]'):[];
    for(var i=0;i<as.length;i++){if(PERMA.test(as[i].href)){link=as[i].href;break}}up=up.parentElement;hops++}
  var near=el?String(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,200):'';
  return {found:true,url:location.href,link:link,near:near}})()`;
}

/* What the focused field holds now, as text. */
const FIELD_TEXT_JS = `(function(){var a=document.activeElement;if(!a||a===document.body)return {text:null};
  return {text:'value' in a?String(a.value||''):String(a.innerText||a.textContent||'')}})()`;

/*
 * CLICK BY TEXT, THE COPY A PERSON SEES. Product Hunt renders hidden copies of its buttons (other layouts,
 * closed panels); the first match in the page was a hidden one, so "Done" and "Add pricing" answered
 * "clicked" and nothing happened. Only a copy that is shown and on top counts; one in an open dialog, an
 * exact match, one on screen and an enabled one go first. The choice goes into slot PICK for the app to tap.
 */
function findTextJs(text, nth = 0) {
  const want = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `(function(){var want=${JSON.stringify(want)},nth=${Number(nth) || 0};var name=${NAME_FN};
  if(!want)return {notfound:1,hidden:0};
  var CLICK='a[href],button,[role=button],[role=link],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],input[type=submit],input[type=button],input[type=reset],label,summary';
  var norm=function(t){return String(t||'').toLowerCase().replace(/\\s+/g,' ').trim()};
  var words=function(e){return norm(e.innerText||e.value||'')+' '+norm(e.getAttribute('aria-label'))+' '+norm(e.getAttribute('title'))};
  var shown=function(e){var r=e.getBoundingClientRect();if(r.width<2||r.height<2)return false;
    if(e.checkVisibility&&!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;
    for(var p=e;p&&p.nodeType===1;p=p.parentElement){var cs=getComputedStyle(p);if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity||'1')<=0.05)return false}
    return true};
  var pool=[].slice.call(document.querySelectorAll(CLICK)).concat([].slice.call(document.querySelectorAll('div,span,li,p,td,h1,h2,h3,h4')));
  var seen=[],hits=[],hidden=0;
  for(var i=0;i<pool.length&&hits.length<40;i++){var e=pool[i];if(words(e).indexOf(want)<0)continue;
    if(!e.matches(CLICK)&&(norm(e.innerText).length>want.length*3+20||e.querySelector(CLICK)))continue;   // a container, not the thing
    for(var k=e,j=0;j<5&&k;j++,k=k.parentElement){if(k.matches&&k.matches(CLICK)){e=k;break}}
    if(seen.indexOf(e)>=0)continue;seen.push(e);
    if(!shown(e)){hidden++;continue}
    var r=e.getBoundingClientRect();
    var exact=norm(e.innerText||e.value||'')===want||norm(e.getAttribute('aria-label'))===want;
    var dlg=!!e.closest('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]');
    var view=r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;
    var dis=!!(e.disabled||e.getAttribute('aria-disabled')==='true');
    hits.push({e:e,s:(dlg?8:0)+(exact?4:0)+(view?2:0)+(e.matches(CLICK)?1:0)-(dis?16:0),n:hits.length,len:norm(e.innerText).length})}
  hits.sort(function(a,b){return b.s-a.s||a.len-b.len||a.n-b.n});
  var onTop=[],covered='';
  for(var h=0;h<hits.length&&h<8&&onTop.length<=nth;h++){var c=hits[h].e;try{c.scrollIntoView({block:'center',inline:'center'})}catch(x){}
    var b=c.getBoundingClientRect(),cx=b.left+b.width/2,cy=b.top+b.height/2,t=null;
    if(innerWidth>0&&cx>=0&&cy>=0&&cx<innerWidth&&cy<innerHeight){var root=c.getRootNode?c.getRootNode():document;t=(root&&root.elementFromPoint?root:document).elementFromPoint(cx,cy)}
    if(!t||t===c||c.contains(t)||t.contains(c)||(t.tagName==='LABEL'&&t.control===c))onTop.push(c);else if(!covered)covered=name(t)}
  var pick=onTop[nth];
  if(!pick)return hits.length?{covered:covered||'something',count:hits.length}:{notfound:1,hidden:hidden};
  if(window.__gb&&window.__gb._els)window.__gb._els[${PICK}]={el:pick};else window.__ringPick=pick;
  return {found:1,tag:pick.tagName.toLowerCase(),text:norm(pick.innerText||pick.value||pick.getAttribute('aria-label')).slice(0,80),hiddenCopies:hidden}})()`;
}

/*
 * A SPOT ON THE SCREENSHOT. The app taps an element's centre ({x,y} from gb.js coords()); a stand-in
 * "element" whose box is the point makes that tap land exactly there, still the app's own trusted tap.
 * The screenshot is in its own pixels (the service browser sends it scaled to 720 px wide), so the point
 * is scaled to the page: shotWidth when the session knows it, else the screen's pixel ratio.
 */
function spotJs(x, y, shotWidth) {
  const sx = Number(x) || 0; const sy = Number(y) || 0; const w = Number(shotWidth) || 0;
  return `(function(){if(!window.__gb||!window.__gb._els)return {error:'no page script'};if(!(innerWidth>0))return {error:'not drawn'};
  var k=${w > 0 ? `innerWidth/${w}` : '1/(window.devicePixelRatio||1)'};var X=${sx}*k,Y=${sy}*k;
  if(X>=innerWidth||Y>=innerHeight)return {error:'outside',iw:innerWidth,ih:innerHeight,x:Math.round(X),y:Math.round(Y)};
  var t=document.elementFromPoint(X,Y),name=${NAME_FN};
  window.__gb._els[${SPOT}]={el:{scrollIntoView:function(){},getBoundingClientRect:function(){return {left:X,top:Y,width:0,height:0}}}};
  return {x:Math.round(X),y:Math.round(Y),at:t?name(t):''}})()`;
}

/*
 * WHAT ANALYZE NEVER SAID: whether a button is disabled, what a field holds (apart from its placeholder),
 * whether a box is ticked. Read per numbered element of the top page. A password is never read back:
 * only whether it is filled.
 */
function fieldsJs(mode) {
  const list = mode === 'dom' ? '(window.__ringEls||[])' : '((window.__gb&&window.__gb._els)||[]).map(function(o){return o&&o.el})';
  return `(function(){var els=${list};
  return {ih:innerHeight,fileInputs:document.querySelectorAll('input[type=file]').length,fields:els.map(function(e){if(!e||e.nodeType!==1)return null;
    var tg=e.tagName,ty=String(e.getAttribute('type')||'').toLowerCase(),f={disabled:!!(e.disabled||e.getAttribute('aria-disabled')==='true')};
    if(tg==='INPUT'||tg==='TEXTAREA'||tg==='SELECT'){f.placeholder=e.getAttribute('placeholder')||'';
      if(ty==='password'){f.password=true;f.filled=!!e.value}else if(ty!=='file')f.value=String(e.value==null?'':e.value).slice(0,300);
      if(ty==='checkbox'||ty==='radio')f.checked=!!e.checked;if(e.required)f.required=true;
      if(e.validity&&!e.validity.valid&&e.value!=='')f.invalid=true}
    else if(e.isContentEditable)f.value=String(e.innerText||'').slice(0,300);
    else if(e.getAttribute('aria-checked'))f.checked=e.getAttribute('aria-checked')==='true';
    return f})}})()`;
}

/*
 * LEAVE THE FIELD, FOR THE FORM'S SAKE — WITHOUT LEAVING IT. Forms check a field when it loses focus
 * (onBlur); after typing the cursor stays in it, so the check never ran and the submit button stayed
 * disabled. The blur is announced (blur + focusout, then change) while focus stays where it is, so a
 * following Enter still goes into the field. A field that suggests as you type (a combobox) is left
 * alone: telling it the field was left would close the suggestions the caller is about to pick from.
 */
const COMMIT_JS = `(function(){var a=document.activeElement;
  if(!a||a===document.body||a===document.documentElement)return 'nothing focused';
  if(a.tagName==='IFRAME'||a.tagName==='FRAME')return 'in a frame';
  if(a.getAttribute('role')==='combobox'||a.getAttribute('aria-autocomplete')||a.getAttribute('list')||a.getAttribute('aria-expanded')==='true')return 'kept for its suggestions';
  try{a.dispatchEvent(new FocusEvent('blur',{bubbles:false}));a.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));a.dispatchEvent(new Event('change',{bubbles:true}))}catch(e){return 'failed'}
  return 'committed'})()`;

/*
 * TEXT AT THE CURSOR. press_key { text } types into whatever has focus; insertText is what the browser does
 * for typed text (the page sees a trusted beforeinput/input), at the cursor, without touching the rest.
 */
function insertTextJs(text) {
  return `(function(){var a=document.activeElement,t=${JSON.stringify(String(text))};
  if(!a||a===document.body||a===document.documentElement)return {error:'nothing is focused - click the field first'};
  if(a.tagName==='IFRAME'||a.tagName==='FRAME')return {error:'the focused field is inside a frame - type into it by its number with browser_type'};
  var before='value' in a?String(a.value||''):String(a.textContent||'');
  var ok=false;try{ok=document.execCommand('insertText',false,t)}catch(e){}
  if(!ok&&'value' in a){var p=a.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(p,'value');
    var s=typeof a.selectionStart==='number'?a.selectionStart:before.length,e2=typeof a.selectionEnd==='number'?a.selectionEnd:before.length;
    var v=before.slice(0,s)+t+before.slice(e2);if(d&&d.set)d.set.call(a,v);else a.value=v;a.dispatchEvent(new Event('input',{bubbles:true}))}
  var after='value' in a?String(a.value||''):String(a.textContent||'');
  return {into:a.getAttribute('name')||a.getAttribute('aria-label')||a.getAttribute('placeholder')||a.tagName.toLowerCase(),changed:after!==before,length:after.length}})()`;
}

/* Control+A: select everything in the focused field (or the page), as the key would. */
const SELECT_ALL_JS = `(function(){var a=document.activeElement;
  if(a&&typeof a.select==='function'&&'value' in a){a.select();return 'selected field'}
  try{document.execCommand('selectAll');return 'selected'}catch(e){return 'failed'}})()`;

/* Shift+Tab: the previous field, as the key moves focus (tab order of what can take focus and is shown). */
const FOCUS_PREVIOUS_JS = `(function(){var sel='a[href],button,input:not([type=hidden]),select,textarea,[tabindex],[contenteditable=true]';
  var all=[].slice.call(document.querySelectorAll(sel)).filter(function(e){var r=e.getBoundingClientRect();return !e.disabled&&e.tabIndex>=0&&r.width>0&&r.height>0});
  var i=all.indexOf(document.activeElement);var p=all[i>0?i-1:all.length-1];if(!p)return 'nothing to move to';
  if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();p.focus();return 'moved'})()`;

/*
 * THE PAGE'S PICTURES, as browser_images lists them on the server: the picture actually shown (currentSrc,
 * so srcset and <picture> give the one the screen chose), biggest first. data: pictures are named, not sent.
 */
const IMAGES_JS = `(function(){var seen={},out=[];
  [].slice.call(document.images).forEach(function(img,dom){var src=img.currentSrc||img.src,w=img.naturalWidth,h=img.naturalHeight;
    if(!src||seen[src]||w<64||h<64)return;seen[src]=1;var r=img.getBoundingClientRect();
    out.push({src:/^data:/i.test(src)?src.slice(0,40):src.slice(0,1500),inline:/^data:/i.test(src),alt:String(img.alt||'').slice(0,160),width:w,height:h,visible:r.width>0&&r.height>0,dom:dom})});
  out.sort(function(a,b){return (b.width*b.height)-(a.width*a.height)||a.dom-b.dom});
  return out.slice(0,60).map(function(i,n){return {image:n+1,src:i.src,inline:i.inline,alt:i.alt,width:i.width,height:i.height,visible:i.visible}})})()`;

/* One inline (data:) picture in full, by its number in IMAGES_JS's order: it is only in the page. */
function imageDataJs(n) {
  return `(function(){var seen={},out=[];[].slice.call(document.images).forEach(function(img,dom){var src=img.currentSrc||img.src;if(!src||seen[src]||img.naturalWidth<64||img.naturalHeight<64)return;seen[src]=1;out.push({src:src,a:img.naturalWidth*img.naturalHeight,dom:dom})});
  out.sort(function(a,b){return b.a-a.a||a.dom-b.dom});var p=out[${Number(n) - 1}];return p?p.src:null})()`;
}

/*
 * A KEPT FILE INTO A FILE FIELD. A file field is often hidden behind its button (Product Hunt's gallery), so
 * the numbered element is the button and the field is found from it: the field itself, the one a label
 * points to, one inside it, the only one in a nearby container, or the only one on the page.
 */
function uploadTargetJs(ref) {
  return `(function(){var e=${ref};
  var only=function(root){var l=root.querySelectorAll('input[type=file]');return l.length===1?l[0]:null};
  var f=null;
  if(e&&e.nodeType===1){if(e.tagName==='INPUT'&&String(e.type).toLowerCase()==='file')f=e;
    else if(e.tagName==='LABEL'&&e.control&&String(e.control.type).toLowerCase()==='file')f=e.control;
    else f=e.querySelector('input[type=file]');
    for(var p=e.parentElement,k=0;!f&&p&&k<6;k++,p=p.parentElement){var l=p.querySelectorAll('input[type=file]');if(l.length===1)f=l[0];else if(l.length>1)break}}
  if(!f)f=only(document);
  if(!f)return {error:document.querySelectorAll('input[type=file]').length?'several file fields on this page and none belongs to that element':'no file field on this page'};
  if(f.disabled)return {error:'that file field is disabled'};
  window.__gbUpTarget=f;window.__gbUp='';
  return {ok:true,accept:f.getAttribute('accept')||'',multiple:!!f.multiple}})()`;
}
const uploadChunkJs = (b64) => `(function(){window.__gbUp=(window.__gbUp||'')+${JSON.stringify(b64)};return window.__gbUp.length})()`;
/* The file is built in the page and handed to the field the way a picker does: its files, then input + change. */
function uploadFinishJs(name, mime) {
  return `(function(){var f=window.__gbUpTarget,b=window.__gbUp||'';window.__gbUp='';
  if(!f||!f.isConnected)return {error:'the file field is gone from the page'};
  var bin=atob(b),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
  var file=new File([u],${JSON.stringify(String(name))},{type:${JSON.stringify(String(mime))}});
  var dt=new DataTransfer();if(f.multiple&&f.files)for(var j=0;j<f.files.length;j++)dt.items.add(f.files[j]);dt.items.add(file);
  f.files=dt.files;f.dispatchEvent(new Event('input',{bubbles:true}));f.dispatchEvent(new Event('change',{bubbles:true}));
  return {ok:true,files:f.files.length,bytes:u.length}})()`;
}

/*
 * THE PAGE'S CONSOLE ON AN OLDER APP. The 0.98 app keeps the console and failed requests natively
 * (/v1/console). An older one has no such command, so the page is asked: uncaught errors from now on
 * (listening only: nothing in the page is replaced, which a site could notice), and requests the page
 * itself recorded as failed (resource timing's responseStatus, which covers what loaded before).
 */
const CONSOLE_JS = `(function(){var c=window.__gbErr;
  if(!c){c=window.__gbErr={since:Date.now(),entries:[]};
    addEventListener('error',function(ev){var t=ev.target;if(t&&t!==window&&t.tagName){c.entries.push({t:Date.now(),kind:'network',status:0,url:String(t.src||t.href||'').slice(0,400),error:'did not load ('+t.tagName.toLowerCase()+')'})}
      else c.entries.push({t:Date.now(),kind:'console',level:'error',text:String(ev.message||'error').slice(0,800),source:String(ev.filename||'').slice(-160),line:ev.lineno||0});if(c.entries.length>300)c.entries.shift()},true);
    addEventListener('unhandledrejection',function(ev){var r=ev.reason;c.entries.push({t:Date.now(),kind:'console',level:'error',text:('Unhandled rejection: '+(r&&(r.stack||r.message)||String(r))).slice(0,800)});if(c.entries.length>300)c.entries.shift()})}
  var http=[];try{performance.getEntriesByType('resource').forEach(function(r){if(r.responseStatus>=400)http.push({t:Math.round(performance.timeOrigin+r.responseEnd),kind:'http',status:r.responseStatus,url:r.name.slice(0,400)})})}catch(e){}
  return {since:c.since,entries:c.entries.concat(http)}})()`;

/* When the page in the tab was loaded: a new navigation is a new document with a new timeOrigin. */
const LOADED_AT_JS = '(typeof performance!=="undefined"&&performance.timeOrigin?Math.round(performance.timeOrigin):null)';

module.exports = {
  PICK, SPOT, slotRef, elementRef, stateJs, findTextJs, spotJs, fieldsJs, COMMIT_JS, insertTextJs, SELECT_ALL_JS,
  pointJs, scriptClickJs, LINE_BREAK_JS, focusInJs, FIELD_TEXT_JS, BACK_JS, goJs, waitTextJs,
  FOCUS_PREVIOUS_JS, IMAGES_JS, imageDataJs, uploadTargetJs, uploadChunkJs, uploadFinishJs, CONSOLE_JS, LOADED_AT_JS,
};
