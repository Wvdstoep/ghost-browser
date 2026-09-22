/*
 * THE RING PICKS THE DEVICE THAT CAN ACTUALLY DO IT.
 *
 * On 22/09 a CapCut edit was asked for and ran on the cluster browser, which can load the editor and
 * cannot drop a clip on a timeline. It spent 84 steps looking at the page and reported on the editor.
 * The ring could have known: normCaps already carries `cdp` ("drag-interception"), and
 * /v1/device/route already scores on requirements. Three things defeated it, and all three are here:
 *
 *   NOBODY STATED THE REQUIREMENT. The role now declares require:{cdp,features:[drag_xy]}, and
 *   deviceNeedOf reads it off a flow's agent steps.
 *
 *   THE RULES EXISTED TWICE AND HAD DRIFTED. /v1/device/route checked need.features; capableDevice —
 *   the in-process path the scheduler uses, whose comment claimed it mirrored the route — did not. So
 *   a scheduled run could be handed to a device missing the one primitive it needed. One predicate now.
 *
 *   EVERY DEVICE LIED. The Kotlin desktop node advertised cdp:true plus click_xy/drag/upload_file and
 *   implements none of them; the phone advertised click_xy/drag_xy with no handler; and the Electron
 *   node — the only one that has ever completed a CapCut edit — registered no caps at all, so it was
 *   invisible. A capability record the ring believes is worse than silence.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { missesFor } = require('../src/device-hub.js');

const ELECTRON = { platform: 'desktop', cdp: true, realIp: true, model: false, mobileApp: false,
                   profiles: [], features: ['click_xy', 'drag_xy', 'run_steps', 'upload_file', 'download_url', 'run_flow'] };
const KOTLIN   = { platform: 'desktop', cdp: false, realIp: true, model: false, mobileApp: false,
                   profiles: [], features: ['browser_read', 'browser_click', 'browser_type'] };
const PHONE    = { platform: 'android', cdp: false, realIp: true, model: true, mobileApp: true,
                   profiles: ['p_capcut'], features: ['native_tap'] };
const CLUSTER  = { platform: 'cluster', cdp: false, realIp: false, model: false, mobileApp: false,
                   profiles: [], features: [] };

const CAPCUT_NEEDS = { cdp: true, features: ['drag_xy'] };

describe('who may be given a CapCut edit', () => {
  it('the Electron node qualifies — it is the one that can drag', () => {
    expect(missesFor(ELECTRON, CAPCUT_NEEDS)).toEqual([]);
  });

  it('the Kotlin desktop node does not, now that it stops claiming cdp', () => {
    expect(missesFor(KOTLIN, CAPCUT_NEEDS)).toEqual(['cdp', 'feature:drag_xy']);
  });

  it('the phone does not — a WebView cannot complete an HTML5 drop', () => {
    expect(missesFor(PHONE, CAPCUT_NEEDS)).toEqual(['cdp', 'feature:drag_xy']);
  });

  it('the cluster does not, which is the whole point', () => {
    expect(missesFor(CLUSTER, CAPCUT_NEEDS)).toEqual(['cdp', 'feature:drag_xy']);
  });

  it('a device that claims cdp but lacks the primitive is still refused', () => {
    // This is exactly the Kotlin node's old advertisement: cdp:true with no drag behind it. Checking
    // the boolean alone would have routed the edit there, over the node that can really do it.
    const liar = { ...KOTLIN, cdp: true };
    expect(missesFor(liar, CAPCUT_NEEDS)).toEqual(['feature:drag_xy']);
  });
});

describe('the phone stays the operator', () => {
  it('it still qualifies for the work it really can do', () => {
    // Dropping click_xy/drag_xy from its advert must not cost it the runs it was always right for:
    // a real touch device, on a real mobile IP, able to run the agent itself.
    expect(missesFor(PHONE, { mobileApp: true, realIp: true, model: true })).toEqual([]);
    expect(missesFor(PHONE, { profile: 'p_capcut' })).toEqual([]);
  });

  it('and it is refused only for what it cannot do', () => {
    expect(missesFor(PHONE, { features: ['native_tap'] })).toEqual([]);
    expect(missesFor(PHONE, { features: ['upload_file'] })).toEqual(['feature:upload_file']);
  });
});

describe('reading the requirement off a flow', () => {
  // deviceNeedOf lives in server.js, which boots a whole browser on import, so the rule it applies is
  // restated here against the same role shape: the union over the flow's agent steps.
  const needOf = (nodes, roleFor) => {
    const need = {};
    for (const n of nodes) {
      if (n.type !== 'agent' || !n.role) continue;
      const req = (roleFor(n.role) || {}).require;
      if (!req || typeof req !== 'object') continue;
      for (const k of ['cdp', 'mobileApp', 'model', 'realIp']) if (req[k]) need[k] = true;
      if (req.platform) need.platform = req.platform;
      if (Array.isArray(req.features) && req.features.length) need.features = [...new Set([...(need.features || []), ...req.features])];
    }
    return Object.keys(need).length ? need : null;
  };
  const roleFor = (name) => ({
    'capcut-video-editor': { require: { cdp: true, features: ['drag_xy'] } },
    'facebook.scout': {},
  })[name] || {};

  it('the CapCut automation asks for a drag-capable device', () => {
    const wf = { nodes: [{ type: 'trigger' }, { type: 'agent', role: 'capcut-video-editor', goal: 'edit {{input.path}}' }] };
    expect(needOf(wf.nodes, roleFor)).toEqual({ cdp: true, features: ['drag_xy'] });
  });

  it('an ordinary flow asks for nothing, so it runs where it always did', () => {
    const wf = { nodes: [{ type: 'trigger' }, { type: 'agent', role: 'facebook.scout', goal: 'find groups' }] };
    expect(needOf(wf.nodes, roleFor)).toBeNull();
  });

  it('one demanding step makes the whole flow a device flow', () => {
    // Splitting it would put half the run in a different browser from the edit it is performing.
    const wf = { nodes: [
      { type: 'agent', role: 'facebook.scout', goal: 'a' },
      { type: 'agent', role: 'capcut-video-editor', goal: 'b' },
    ] };
    expect(needOf(wf.nodes, roleFor)).toEqual({ cdp: true, features: ['drag_xy'] });
  });
});
