import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

/*
 * float32 is right for the half-billion incumbent and fatal for anything much larger: a Gemma in
 * float32 is more than the rented card holds, and the round dies at load in a paid hour. Two
 * things have to be true for that not to happen, and neither is visible from a screen.
 */
describe('a bigger student trains in half precision', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const node = fs.readFileSync(path.join(__dirname, '..', 'training', 'gb_node.py'), 'utf8');
  const trainer = fs.readFileSync(path.join(__dirname, '..', 'training', 'train_round.py'), 'utf8');

  it('the hub can ask for it, and asks for nothing when it does not', () => {
    expect(server).toMatch(/dispatchRound\(\{[^)]*bf16 = false/);
    /* Sent only when asked: every round measured so far keeps the precision it had. */
    expect(server).toMatch(/\.\.\.\(bf16 \? \{ bf16: true \} : \{\}\)/);
    expect(server).toMatch(/bf16: !!b\.bf16/);
  });

  it('the node passes it to the trainer', () => {
    expect(node).toMatch(/if body\.get\("bf16"\):/);
    expect(node).toMatch(/cmd \+= \["--bf16"\]/);
  });

  it('and the exam uses the precision the training used', () => {
    /* Measuring a half-precision round in float32 loads the model twice in two formats and
       reports a number about neither. */
    expect(trainer).toMatch(/exam_dtype = "bfloat16" if \(args\.bf16 and use_cuda\) else "float32"/);
    const calls = trainer.match(/measure\(args\.model, [^)]*\)/g) || [];
    const ordinary = calls.filter((c) => !c.includes('args.adapter, eval_path, args.eval_turns, hub.note, dtype=trial_dtype'));
    /* Every measurement in an ordinary round names a dtype; none is left to the default. */
    for (const c of ordinary) expect(c).toMatch(/dtype=/);
    expect(ordinary.length).toBeGreaterThanOrEqual(2);
  });

  it('the recipe still records what it actually trained in', () => {
    expect(trainer).toMatch(/"dtype": str\(dtype\)\.replace\("torch\.", ""\)/);
  });
});
