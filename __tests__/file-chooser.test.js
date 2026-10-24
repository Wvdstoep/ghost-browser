import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
const { captureFileChoosers, takeFileChooser } = require('../src/fileChooser');

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
afterAll(async () => { await browser?.close(); });

describe('native upload controls without a DOM file input', () => {
  it.each([true, false])('captures a chooser on an existing=%s page, consumes it, and uploads bytes', async (existing) => {
    const context = await browser.newContext();
    try {
      let page = existing ? await context.newPage() : null;
      captureFileChoosers(context);
      captureFileChoosers(context);
      page ||= await context.newPage();
      await page.setContent(`<button onclick="
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async () => { window.uploaded = await input.files[0].text(); };
        input.click();
      ">Upload</button>`);
      await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Upload' }).click()]);
      expect(await page.locator('input[type=file]').count()).toBe(0);
      expect(page.listenerCount('filechooser')).toBe(1);
      const chooser = takeFileChooser(page);
      expect(chooser).toBeDefined();
      await chooser.setFiles({ name: 'reference.txt', mimeType: 'text/plain', buffer: Buffer.from('original reference') });
      await page.waitForFunction(() => window.uploaded === 'original reference');
      expect(takeFileChooser(page)).toBeUndefined();
      await page.getByRole('button', { name: 'Upload' }).click();
      await page.close();
      expect(takeFileChooser(page)).toBeUndefined();
    } finally { await context.close(); }
  });
});
