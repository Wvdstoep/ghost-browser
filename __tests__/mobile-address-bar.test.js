// mobile-address-bar.test.js — the phone app's address bar works like Chrome on Android (2026-11-10).
//
// Carla: "when I press the URL bar in Chrome I can share, copy or edit the URL; this part is missing in the
// mobile app, and on the left side the home icon to go to the start page." These pin the Compose source
// (the app compiles and its unit tests run in the Android build; this suite runs without an SDK).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../mobile/app/src/main/java/engineer/myapp/gbmobile/ui/AppShell.kt', import.meta.url)), 'utf8');
const between = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
const topBar = between('private fun TopBar(', 'private fun TabCountButton(');
const omnibox = between('private fun Omnibox(', 'HorizontalDivider(color = cs.outline)\n                }\n                if (q.isNotBlank())');

describe('the phone address bar', () => {
  it('has a Home button left of the address that opens the start page', () => {
    expect(topBar).toContain('IconButton(onClick = act.onHome');
    expect(topBar.indexOf('act.onHome')).toBeLessThan(topBar.indexOf('act.onFocusUrl'));
  });

  it('opens with the whole address selected, so typing replaces it', () => {
    expect(omnibox).toContain('TextFieldValue(pageUrl, androidx.compose.ui.text.TextRange(0, pageUrl.length))');
  });

  it('shows the current page with Share, Copy link and Edit while the address is unchanged', () => {
    expect(omnibox).toContain('if (pageUrl.isNotBlank() && q == pageUrl)');
    expect(omnibox).toContain('act.onShare()');
    expect(omnibox).toContain('clipboard.setText(androidx.compose.ui.text.AnnotatedString(pageUrl))');
    expect(omnibox).toContain('"Copy link"');
    // Edit keeps the address and puts the cursor at its end
    expect(omnibox).toContain('TextFieldValue(pageUrl, androidx.compose.ui.text.TextRange(pageUrl.length))');
  });
});
