import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const student = require('../src/student.js');

/*
 * A Qwen3 adapter scored 35.31% on the exam and zero in front of a real job. The exam renders
 * every prompt with enable_thinking=False and strips any reasoning block before reading the
 * answer; the serving path did neither, so the model reasoned through the whole 320-token answer
 * budget and emitted no JSON at all. Two locks now, one per side of that gap.
 */
describe('Qwen3 is not allowed to think its answer away', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  /* `templateFor` is module-private; the file is the surface the test has. */
  const qwen3 = server.slice(server.indexOf("if (m.includes('qwen3'))"),
    server.indexOf("family: 'chatml'"));

  it('serves Qwen3 with the empty reasoning block enable_thinking=False would have written', () => {
    expect(qwen3).toBeTruthy();
    expect(qwen3).toMatch(/family: 'qwen3'/);
    /* The block sits AFTER the assistant marker and BEFORE the response, which is the whole
       point - it is the pre-filled opening the model is made to continue from. */
    const after = qwen3.slice(qwen3.indexOf('im_start|>assistant'));
    expect(after.indexOf('<think>')).toBeGreaterThan(-1);
    expect(after.indexOf('</think>')).toBeGreaterThan(after.indexOf('<think>'));
    expect(after.indexOf('{{ .Response }}')).toBeGreaterThan(after.indexOf('</think>'));
  });

  it('and joins the template with a newline, not a line break in the source', () => {
    /* A real newline inside the join argument is a syntax error that only shows at require
       time, which on this path means after the image is built. */
    expect(qwen3).toMatch(/\]\.join\('\\n'\)/);
  });

  it('leaves Qwen2.5 and Gemma on their own templates', () => {
    expect(server).toMatch(/if \(m\.includes\('gemma'\)\)/);
    const chatml = server.slice(server.indexOf("family: 'chatml'"));
    expect(chatml.slice(0, 400)).not.toMatch(/<think>/);
  });
});

describe('the parser drops a reasoning block if one arrives anyway', () => {
  it('reads the call that follows the block, not a brace inside it', () => {
    const text = '<think>' + String.fromCharCode(10) +
      'I could say {"tool":"guess"} but no.' + String.fromCharCode(10) +
      '</think>' + String.fromCharCode(10) +
      '{"tool":"open","args":{"url":"https://example.com"}}';
    expect(student.parseCall(text)).toEqual({ name: 'open', args: { url: 'https://example.com' } });
  });

  it('leaves an unclosed block alone — an answer cut off mid-thought is no answer', () => {
    /* Removing the marker and reading on would turn "ran out of budget" into a guess. */
    const text = '<think>' + String.fromCharCode(10) + 'the page shows {"tool":"click"} maybe';
    expect(student.parseCall(text)).toBe(null);
  });

  it('does not touch an answer that never reasoned', () => {
    expect(student.unthink('{"tool":"read","args":{}}')).toBe('{"tool":"read","args":{}}');
  });
});
