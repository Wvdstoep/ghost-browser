import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

/*
 * Exporting has only ever been the tail of a promotion, on the machine that trained the round,
 * from a directory on that machine's disk. So every adapter we hold but did not promote was a
 * file nobody could run. These pin the three things that had to change for one to be served.
 */
describe('serving an adapter without promoting it', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const node = fs.readFileSync(path.join(__dirname, '..', 'training', 'gb_node.py'), 'utf8');
  const route = server.slice(server.indexOf("app.post('/v1/training/rounds/:id/export'"),
    server.indexOf("app.post('/v1/training/rounds/:id/export'") + 2600);

  it('exports without touching the promotion or the serving map', () => {
    expect(route).toBeTruthy();
    expect(route).not.toMatch(/promote\(/);
    expect(route).not.toMatch(/setAdapter|current\.json|studentModels/);
  });

  it('merges into the MODEL from the recipe, never round.base', () => {
    /* `round.base` is the adapter a continuation started from - handing that to the merger as a
       base model is how this would have failed on the first round that used it. */
    expect(route).toMatch(/const model = String\(\(r\.recipe && r\.recipe\.base\) \|\| ''\)/);
    expect(route).toMatch(/base: model/);
    expect(route).not.toMatch(/base: r\.base/);
  });

  it('takes the adapter by hub name, so any machine can do it', () => {
    expect(route).toMatch(/r\.adapterHub/);
    expect(route).toMatch(/no machine is online that can export|is not online/);
    /* Not restricted to the machine that trained it, which is what the old path required. */
    expect(route).not.toMatch(/round\.device/);
  });

  it('and refuses clearly when there is nothing on the hub to serve', () => {
    expect(route).toMatch(/only the machine that trained it ever had one/);
    expect(route).toMatch(/did not record which model it trained/);
  });

  it('the node fetches a hub adapter before handing it to the exporter', () => {
    /* The exporter merges a DIRECTORY; it has no idea what `hub:<round>` means. */
    expect(node).toMatch(/def fetch_adapter\(name\):/);
    expect(node).toMatch(/adapter_dir = fetch_adapter\(body\.get\("adapter", ""\)\)/);
    expect(node).toMatch(/"--adapter", adapter_dir/);
  });
});
