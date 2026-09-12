'use strict';
/**
 * tools/craft.js — making the things a browser is asked for, rather than only finding them.
 *
 * WHY THESE FOUR.
 *
 * A freelance brief wants a CV. A marketplace wants a portfolio PDF. A signup wants a code from an
 * authenticator app. A menu only opens when the pointer is over it. None of those are a website's
 * quirk to be worked around — they are ordinary parts of earning money online, and every one of them
 * stopped the work dead because the browser could find and read and click, but could not MAKE
 * anything, could not answer a second factor, and could not hover.
 *
 *   make_document   compose a document as HTML and print it to a real PDF, stored as an asset the
 *                   existing upload_file then attaches. The page IS the document: the same engine
 *                   that renders a site renders this, so what the agent saw is what the PDF holds.
 *   save_totp_secret / totp_code
 *                   an authenticator app, in the browser. A platform that shows a setup secret can
 *                   be answered on every later sign-in without a phone. The secret is a credential:
 *                   it is written to the profiles volume beside the cookies, mode 600, and is NEVER
 *                   read back out — only the six digits of the moment are, and those expire.
 *   hover           the menus that exist only under the pointer.
 *
 * PRINTING IN A HEADED BROWSER. page.pdf() is headless-only in Playwright, and this browser runs
 * headed (on Xvfb, deliberately — a headless fingerprint is the cheapest automation tell there is).
 * So the print goes through CDP's Page.printToPDF, which a headed Chromium answers perfectly well.
 */
const fileAssets = require('../fileAssets');
const { totp, secretFrom, documentHtml, safeName, readSecrets, writeSecrets, accountKey } = require('./craft-parts');

module.exports = {
  /*
   * COMPOSE A DOCUMENT AND KEEP IT. The HTML is rendered in its own throwaway page in this same
   * browser, printed through CDP (headed Chromium cannot use page.pdf()), and stored as an asset —
   * so the very next step attaches it with upload_file, exactly as it would a downloaded file.
   */
  async make_document(ctx, a) {
    const html = String(a.html || '').trim();
    if (html.length < 40) { ctx.observe('make_document needs the document itself as HTML — headings, paragraphs, lists. Write the content; a print stylesheet is added for you unless you send your own <style>.'); return; }
    const title = String(a.title || a.filename || 'Document').slice(0, 120);
    const name = safeName(a.filename, 'document');
    const page = await ctx.page().context().newPage();
    let bytes = null, why = '';
    try {
      await page.setContent(documentHtml(html, title), { waitUntil: 'load' });
      await page.emulateMedia({ media: 'print' }).catch(() => {});
      const cdp = await page.context().newCDPSession(page);
      const out = await cdp.send('Page.printToPDF', {
        printBackground: true, preferCSSPageSize: true, paperWidth: 8.27, paperHeight: 11.69,
        marginTop: 0.7, marginBottom: 0.7, marginLeft: 0.63, marginRight: 0.63,
      });
      bytes = Buffer.from(out.data, 'base64');
      try { await cdp.detach(); } catch { /* the page is closing anyway */ }
    } catch (e) { why = String((e && e.message) || e).slice(0, 200); }
    finally { try { await page.close(); } catch { /* already gone */ } }
    if (!bytes || !bytes.length) { ctx.observe(`The document could not be printed${why ? ': ' + why : ''}. Check the HTML is valid and try again.`); return; }
    const id = fileAssets.put({ mime: 'application/pdf', kind: a.kind || 'document', name, bytes, source: 'make_document' });
    if (!id) { ctx.observe('The document printed but could not be stored — try again.'); return; }
    ctx.step('download', `made ${name} (${bytes.length} bytes) as asset ${id}`);
    ctx.observe(`Made "${name}" — ${Math.round(bytes.length / 1024)} KB, asset "${id}". To attach it: open the page's upload / "Add file" control so its file field is on screen, then call upload_file with assetId "${id}". To check it first, open the asset from the Files tab.`);
  },

  /*
   * REMEMBER AN AUTHENTICATOR. Called once, at the moment a platform shows its setup secret (read it
   * off the page with read or run_script). The secret is written to the profiles volume, mode 600,
   * beside the cookies it belongs with — and never read back out to anyone.
   */
  async save_totp_secret(ctx, a) {
    const account = accountKey(a.account);
    const secret = secretFrom(a.secret);
    if (!account) { ctx.observe('save_totp_secret needs an account name — the platform, e.g. "upwork".'); return; }
    if (!secret) { ctx.observe('That does not look like an authenticator secret. Take the base32 key the page shows (or its otpauth:// link) — 16 characters or more, letters A-Z and digits 2-7.'); return; }
    const probe = totp(secret);
    if (!probe) { ctx.observe('That secret could not be decoded — copy it again exactly as the page shows it.'); return; }
    const all = readSecrets();
    const replacing = !!all[account];
    all[account] = { secret, at: new Date().toISOString() };
    try { writeSecrets(all); } catch (e) { ctx.observe(`The secret could not be stored: ${String(e.message).slice(0, 160)}`); return; }
    ctx.step('note', `stored an authenticator secret for ${account}${replacing ? ' (replacing the old one)' : ''}`);
    ctx.observe(`Saved the authenticator for "${account}". From now on call totp_code with account "${account}" whenever a sign-in asks for a code. The secret itself is stored with the logins and is never shown again. Finish the platform's setup by entering the code it is asking for now: ${probe.code}`);
  },

  /** The six digits of the moment, for an account whose authenticator was saved. */
  async totp_code(ctx, a) {
    const account = accountKey(a.account);
    const all = readSecrets();
    const known = Object.keys(all);
    const row = account ? all[account] : null;
    if (!row) {
      ctx.observe(known.length
        ? `No authenticator is saved for "${a.account || '(none given)'}". Saved: ${known.join(', ')}.`
        : 'No authenticator is saved yet. When a platform shows its setup secret, read it off the page and call save_totp_secret first.');
      return;
    }
    const t = totp(row.secret);
    if (!t) { ctx.observe(`The stored secret for "${account}" cannot be decoded — save it again from the platform's security page.`); return; }
    ctx.step('note', `read the authenticator code for ${account}`);
    ctx.observe(`${account} code: ${t.code} — valid for ${t.secondsLeft} more second(s). Type it into the code field now; if it expires, call totp_code again for the next one.`);
  },

  /** Put the pointer on something — for a menu that only opens under it. */
  async hover(ctx, a) {
    const { clickByIndex } = require('../inspector');
    // The numbers come from the last look; if this one is not in it, look again rather than guess.
    let el = ctx.elementAt(a.index);
    if (!el) { await ctx.freshAnalysis(); el = ctx.elementAt(a.index); }
    if (!el) { ctx.observe(`There is no [${a.index}] on this page. Call look and use a number it shows.`); return; }
    let target;
    try { target = await clickByIndex(ctx.page(), Number(a.index), [el]); }
    catch (e) { ctx.observe(`[${a.index}] could not be reached: ${String((e && e.message) || e).slice(0, 140)}. Call look again.`); return; }
    try { await ctx.page().mouse.move(target.x, target.y); } catch (e) { ctx.observe(`The pointer could not be moved there: ${String(e.message).slice(0, 140)}`); return; }
    await ctx.settle(900);
    ctx.step('click', `hovered [${a.index}] ${target.text || ''}`);
    ctx.observe(`The pointer is on [${a.index}] "${target.text || ''}". Whatever it opens is on the page now — call look to see it (its numbers will have changed).`);
  },

};
