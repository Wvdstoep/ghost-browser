import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

/*
 * A GGUF handed over without its template is served with a passthrough one, and the model answers
 * prose while the exam reads a fine number. That fault cost every export ever made, so the rule is
 * simple: the template travels with the model, and it is the template of THAT model's family.
 */
describe('the model is served the way it was trained', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

  /* templateFor is a plain function in server.js; lift it out rather than boot the whole app. */
  const templateFor = (() => {
    const at = src.indexOf('function templateFor(');
    const end = src.indexOf('\n}', at) + 2;
    // eslint-disable-next-line no-new-func
    return new Function(`${src.slice(at, end)}; return templateFor;`)();
  })();

  it('a Qwen model is served the ChatML turns it was trained on', () => {
    const t = templateFor('Qwen/Qwen2.5-0.5B-Instruct');
    expect(t.family).toBe('chatml');
    expect(t.template).toContain('<|im_start|>system');
    expect(t.template).toContain('{{ .Prompt }}<|im_end|>');
    expect(t.template).toContain('<|im_start|>assistant');
    expect(t.stop).toEqual(['<|im_end|>', '<|im_start|>']);
    expect(t.marker).toBe('<|im_start|>');
  });

  /*
   * THIS TEST USED TO SAY "nothing about serving changes" FOR QWEN3, AND IT WAS WRONG.
   *
   * Qwen3 uses ChatML markers, so the family looked settled. What it also does is reason before
   * it answers, unless the template pre-fills an empty reasoning block - which is the only thing
   * `enable_thinking=False` does, and the exam passes that flag on every prompt it renders. The
   * first Qwen3 adapter exported on plain ChatML answered the opening move of a real job with
   * 1,406 characters of reasoning, ran out of the 320-token budget mid-thought, and parsed to
   * nothing, while its exam read 35.31%. With the block: 86 characters of correct JSON, six
   * times faster.
   */
  it('Qwen3 is served with the empty reasoning block, so it answers instead of reasoning', () => {
    const t = templateFor('Qwen/Qwen3-0.6B');
    expect(t.family).toBe('qwen3');
    expect(t.marker).toBe('<|im_start|>');
    expect(t.stop).toEqual(['<|im_end|>', '<|im_start|>']);
    const after = t.template.slice(t.template.indexOf('<|im_start|>assistant'));
    expect(after).toContain('<think>');
    expect(after.indexOf('</think>')).toBeGreaterThan(after.indexOf('<think>'));
    expect(after.indexOf('{{ .Response }}')).toBeGreaterThan(after.indexOf('</think>'));
    /* Nothing between the markers: an EMPTY block, not a prompt to reason inside. */
    const open = t.template.indexOf('<think>');
    const close = t.template.indexOf('</think>');
    expect(t.template.slice(open + 7, close).trim()).toBe('');
  });

  it('every Qwen3 size gets it, and Qwen2.5 gets none of it', () => {
    expect(templateFor('Qwen/Qwen3-1.7B').family).toBe('qwen3');
    expect(templateFor('Qwen/Qwen2.5-0.5B-Instruct').family).toBe('chatml');
    expect(templateFor('Qwen/Qwen2.5-0.5B-Instruct').template).not.toContain('<think>');
  });

  it('a Gemma model is served Gemma turns, never ChatML', () => {
    const t = templateFor('google/gemma-4-E4B-it');
    expect(t.family).toBe('gemma');
    expect(t.template).toContain('<start_of_turn>user');
    expect(t.template).toContain('<end_of_turn>');
    expect(t.template).toContain('<start_of_turn>model');
    /* No system turn: Gemma has none, and the system text rides the first user turn. */
    expect(t.template).not.toContain('<|im_start|>');
    expect(t.stop).toEqual(['<end_of_turn>', '<start_of_turn>']);
  });

  it('an unknown model falls back to the family every export so far has been', () => {
    expect(templateFor('').family).toBe('chatml');
    expect(templateFor('someone/unheard-of-7B').family).toBe('chatml');
  });

  it('the create call sends whichever template that chose, with its own stop tokens', () => {
    const call = src.slice(src.indexOf('async function createServedModel'), src.indexOf('async function createServedModel') + 4000);
    expect(call).toMatch(/const shape = templateFor\(/);
    expect(call).toMatch(/template:\s*shape\.template/);
    expect(call).toMatch(/stop:\s*shape\.stop/);
  });

  it('and the server is asked whether it really holds that family s template', () => {
    expect(src).toContain('without its ${shape.family} chat template');
    expect(src).toContain('/api/show');
    expect(src).toMatch(/includes\(shape\.marker\)/);
  });

  it('the student is given room to finish a summary', () => {
    const student = fs.readFileSync(path.join(__dirname, '..', 'src', 'student.js'), 'utf8');
    const m = /num_predict:\s*(\d+)/.exec(student);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(300);
  });
});
