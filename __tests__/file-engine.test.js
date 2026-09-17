/** The file engine's rules: kinds from mimes, names from headers/urls with a fitting extension, what an inline tab response is worth capturing. */
import { describe, it, expect } from 'vitest';
import { kindOf, extFor, mimeFor, shouldCapture, nameFrom, describe as line } from '../src/fileEngine.js';

describe('file engine', () => {
  it('knows kinds and extensions', () => {
    expect(kindOf('image/png')).toBe('image'); expect(kindOf('video/mp4')).toBe('video'); expect(kindOf('application/pdf')).toBe('document'); expect(kindOf('application/zip')).toBe('archive'); expect(kindOf('application/octet-stream')).toBe('file');
    expect(extFor('image/jpeg')).toBe('jpg'); expect(extFor('video/mp4; codecs=avc1')).toBe('mp4'); expect(extFor('x/unknown')).toBe('bin');
    expect(mimeFor('clip.MP4')).toBe('video/mp4'); expect(mimeFor('a.jpeg')).toBe('image/jpeg'); expect(mimeFor('noext')).toBe('application/octet-stream');
  });
  it('captures files a tab shows inline, never pages or scripts, never absurd sizes', () => {
    expect(shouldCapture('image/png')).toBe(true); expect(shouldCapture('video/mp4; codecs=x', 5000000)).toBe(true); expect(shouldCapture('application/pdf')).toBe(true); expect(shouldCapture('application/octet-stream')).toBe(true);
    expect(shouldCapture('text/html; charset=utf-8')).toBe(false); expect(shouldCapture('application/javascript')).toBe(false); expect(shouldCapture('')).toBe(false); expect(shouldCapture('application/x-unknown')).toBe(false);
    expect(shouldCapture('video/mp4', 500 * 1024 * 1024)).toBe(false);
  });
  it('names a file from the header, the url or a stamp, with the mime\'s extension', () => {
    expect(nameFrom({ contentDisposition: 'attachment; filename="rabbit final.png"', mime: 'image/png' })).toBe('rabbit final.png');
    expect(nameFrom({ contentDisposition: "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", mime: 'application/pdf' })).toBe('résumé.pdf');
    expect(nameFrom({ url: 'https://x.com/exports/capcut-0917.mp4?sig=1', mime: 'video/mp4' })).toBe('capcut-0917.mp4');
    expect(nameFrom({ url: 'https://lh3.googleusercontent.com/abc', mime: 'image/jpeg' })).toMatch(/^file-\d+\.jpg$/);
    expect(nameFrom({ url: 'https://x.com/a/photo.jpeg', mime: 'image/jpeg' })).toBe('photo.jpeg');
    expect(nameFrom({ contentDisposition: 'attachment; filename="bad/name:x.png"', mime: 'image/webp' })).toBe('bad_name_x.webp');
  });
  it('describes a file in one line', () => {
    expect(line({ name: 'a.mp4', mime: 'video/mp4', size: 2048, source: 'capcut.com' })).toBe('a.mp4 (video, 2 KB, from capcut.com)');
  });
});
