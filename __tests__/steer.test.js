/*
 * STEERING THE TEACHER - and the two ways it could go wrong: naming a tool the role cannot use
 * (a wasted, confusing step), and leaking into the student's prompt (checked where the prompt is
 * built: localPrompt reads goal and role only, never the job's hint).
 */
import { describe, it, expect } from 'vitest';
import { steerFor, toolsOfAim } from '../src/steer.js';
import localPrompt from '../src/localPrompt.js';

describe('the steer', () => {
  it('names only tools the role has, at most four, once each', () => {
    const s = steerFor(['hover', 'hover', 'switch_tab', 'sweep', 'type', 'paste_text', 'choose_option'], new Set(['hover', 'switch_tab', 'type', 'paste_text', 'choose_option', 'look']));
    expect(s).toMatch(/^FOR THIS WALK/);
    expect(s).toMatch(/hover, switch_tab, type, paste_text\./);
    expect(s).not.toMatch(/sweep|choose_option/);
  });

  it('is nothing when there is nothing the role can practise', () => {
    expect(steerFor([], new Set(['look']))).toBe('');
    expect(steerFor(['sweep'], new Set(['look']))).toBe('');
    expect(steerFor(null)).toBe('');
  });

  it('reads the tool names off the collector aim lines', () => {
    expect(toolsOfAim(['hover (0)', 'switch_tab (0)', 'save_search (2)'])).toEqual(['hover', 'switch_tab', 'save_search']);
  });

  it('never reaches the student: the training prompt is built from the goal and the role alone', () => {
    const sys = localPrompt.systemFor({ role: 'general', tools: [{ function: { name: 'hover', description: 'Hover.' } }] });
    const user = localPrompt.userFor({ goal: 'Go to anwb.nl and hover over Verkeer', observed: [] });
    expect(sys + user).not.toMatch(/FOR THIS WALK|practise/);
  });
});
