// slim-image.test.js — the browser image carries Chromium only (2026-11-21).
//
// Microsoft's Playwright image ships Chromium, Firefox and WebKit: 2.0 of the image's 2.7 GB, unpacked on the node's
// one disk at every release (k3s restarted during such a rollout). This service only launches Chromium. Tested on a
// build VM before it shipped: 1.79 GB, health 200, Chromium 1217 headful under Xvfb, pwuser 1001, Node 24.14.1.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const df = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('the browser image', () => {
  it('is not built on the three-browser Playwright image', () => {
    expect(df).not.toMatch(/^FROM mcr\.microsoft\.com\/playwright/m);
    expect(df).toMatch(/^FROM ubuntu:24\.04$/m);
  });
  it('installs Chromium (and its headless shell and ffmpeg) at exactly the version package.json pins, nothing else', () => {
    const m = df.match(/npx -y playwright@([\d.]+) install --with-deps ([^;]+);/);
    expect(m).toBeTruthy();
    expect(m[1]).toBe(pkg.dependencies.playwright);
    expect(m[2].trim().split(/\s+/).sort()).toEqual(['chromium', 'chromium-headless-shell', 'ffmpeg']);
  });
  it('keeps what the old base gave: pwuser 1001 (the profile volumes are owned by it), Node 24, /ms-playwright, Xvfb, curl', () => {
    expect(df).toMatch(/groupadd -g 1001 pwuser; useradd -u 1001 -g 1001 -G users/);
    expect(df).toMatch(/FROM node:24\.14\.1-bookworm-slim AS node-bin/);
    expect(df).toMatch(/PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
    expect(df).toMatch(/--no-install-recommends ca-certificates curl xz-utils xvfb xauth/);
  });
});
