import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

describe('the model is served the way it was trained', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  it('the create call carries the chat template and its stop tokens', () => {
    const call = src.slice(src.indexOf('async function createServedModel'), src.indexOf('async function createServedModel') + 4000);
    expect(call).toContain('<|im_start|>system');
    expect(call).toContain('{{ .Prompt }}<|im_end|>');
    expect(call).toContain('<|im_start|>assistant');
    expect(call).toMatch(/template:\s*TEMPLATE/);
    expect(call).toMatch(/stop:\s*\['<\|im_end\|>', '<\|im_start\|>'\]/);
  });
  it('and the server is asked whether it really holds one', () => {
    expect(src).toContain('without its chat template');
    expect(src).toContain('/api/show');
  });
  it('the student is given room to finish a summary', () => {
    const student = fs.readFileSync(path.join(__dirname, '..', 'src', 'student.js'), 'utf8');
    const m = /num_predict:\s*(\d+)/.exec(student);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(300);
  });
});
