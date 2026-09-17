/**
 * The file engine reads what bytes ARE: a gated "download" (a paywall, a captcha, an encrypted stream)
 * answers with a page or noise under the file's content-type, and stored as a song it crashes the
 * owner's player. sniff() names the real type from the header; looksLike() says whether it matches the claim.
 */
import { describe, it, expect } from 'vitest';
import { sniff, looksLike } from '../src/fileEngine.js';

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const noise = (n) => { const b = Buffer.alloc(n); let x = 12345; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = (x >> 8) & 0xff; } return b; };

describe('what the bytes are', () => {
  it('names real files by their headers', () => {
    expect(sniff(bytes([0x89], 'PNG\r\n\x1a\n', noise(20)))).toBe('image/png');
    expect(sniff(bytes([0xff, 0xd8, 0xff, 0xe0], noise(20)))).toBe('image/jpeg');
    expect(sniff(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toBe('image/webp');
    expect(sniff(bytes('RIFF', [1, 2, 3, 4], 'WAVEfmt '))).toBe('audio/wav');
    expect(sniff(bytes([0, 0, 0, 0x20], 'ftypM4A ', noise(20)))).toBe('audio/mp4');
    expect(sniff(bytes([0, 0, 0, 0x20], 'ftypisom', noise(20)))).toBe('video/mp4');
    expect(sniff(bytes('ID3', [3, 0], noise(20)))).toBe('audio/mpeg');
    expect(sniff(bytes([0xff, 0xfb, 0x90, 0x64], noise(20)))).toBe('audio/mpeg');
    expect(sniff(bytes('%PDF-1.7\n', noise(20)))).toBe('application/pdf');
    expect(sniff(bytes('PK\x03\x04', noise(20)))).toBe('application/zip');
    expect(sniff(bytes([0x1a, 0x45, 0xdf, 0xa3], noise(20)))).toBe('video/webm');
    expect(sniff(bytes('OggS', noise(20)))).toBe('audio/ogg');
  });
  it('names a web page, json and text — the shapes a gated download answers with', () => {
    expect(sniff(Buffer.from('<!DOCTYPE html><html><head><title>Sign in</title>'))).toBe('text/html');
    expect(sniff(Buffer.from('{"error":"captcha required"}'))).toBe('application/json');
    expect(sniff(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(sniff(Buffer.from('just some words\n'))).toBe('text/plain');
  });
  it('has no name for noise (an encrypted stream) or nothing', () => {
    expect(sniff(noise(4000))).toBe(''); expect(sniff(Buffer.alloc(0))).toBe(''); expect(sniff(null)).toBe('');
  });
  it('matches the bytes against the claim: same kind, an mp4 box for any audio/video claim, nothing for noise', () => {
    expect(looksLike('audio/mpeg', 'audio/mpeg')).toBe(true); expect(looksLike('audio/wav', 'audio/mp4')).toBe(true);
    expect(looksLike('video/mp4', 'audio/mp4')).toBe(true); expect(looksLike('audio/mp4', 'video/mp4')).toBe(true);
    expect(looksLike('image/jpeg', 'image/png')).toBe(true);
    expect(looksLike('', 'audio/mp4')).toBe(false); expect(looksLike('text/html', 'application/pdf')).toBe(false); expect(looksLike('application/json', 'audio/mp4')).toBe(false);
    expect(looksLike('image/png', 'video/mp4')).toBe(false);
  });
});
