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
                   profiles: [], features: ['click_xy', 'drag', 'drag_xy', 'run_steps', 'upload_file', 'download_url', 'run_flow'] };
// The Kotlin/JCEF node, read off DesktopNode.kt's own dispatch: it clicks at a coordinate, drags a
// canvas (press then move then release) and sets a page file input. cdp stays false, honestly — it
// has no Input.setInterceptDrags, and that flag is what separates a canvas drag from an HTML5 drop.
const KOTLIN   = { platform: 'desktop', cdp: false, realIp: true, model: false, mobileApp: false,
                   profiles: [], features: ['navigate', 'info', 'analyze', 'content', 'click_text',
                     'click', 'type', 'scroll', 'screenshot', 'eval', 'click_xy', 'drag', 'upload_file'] };
const PHONE    = { platform: 'android', cdp: false, realIp: true, model: true, mobileApp: true,
                   profiles: ['p_capcut'], features: ['native_tap'] };
const CLUSTER  = { platform: 'cluster', cdp: false, realIp: false, model: false, mobileApp: false,
                   profiles: [], features: [] };

/*
 * WHAT A CAPCUT EDIT ACTUALLY NEEDS — three actions, not a flag name.
 *
 * My first version was {cdp:true, features:['drag_xy']}, and it refused the node the owner actually
 * runs. The Kotlin/JCEF desktop reports cdp:false (it has no drag-interception) and its drag path is
 * /v1/drag. I had looked for its command handling in AgentD.kt — the on-device agent's tool list —
 * instead of DesktopNode.kt, which is the node dispatch, and concluded it could do none of this.
 *
 * So: click at a coordinate, really drag, put a local file into a page input. Both desktop nodes can
 * do all three. The cluster can do none, which is the whole point.
 */
const CAPCUT_NEEDS = { features: ['click_xy', 'drag', 'upload_file'] };

describe('who may be given a CapCut edit', () => {
  it('the Electron node qualifies — it is the one that can drag', () => {
    expect(missesFor(ELECTRON, CAPCUT_NEEDS)).toEqual([]);
  });

  it('the Kotlin desktop node qualifies too — it is the one the owner actually runs', () => {
    expect(missesFor(KOTLIN, CAPCUT_NEEDS)).toEqual([]);
  });

  it('and a role needing a true HTML5 drop can still single out the CDP node', () => {
    // A library card with draggable="true" needs Input.setInterceptDrags, which only Electron has.
    // Keeping cdp as a separate flag is what makes that distinction sayable.
    expect(missesFor(KOTLIN, { cdp: true })).toEqual(['cdp']);
    expect(missesFor(ELECTRON, { cdp: true })).toEqual([]);
  });

  it('the phone does not — it has none of the three', () => {
    expect(missesFor(PHONE, CAPCUT_NEEDS)).toEqual(['feature:click_xy', 'feature:drag', 'feature:upload_file']);
  });

  it('the cluster does not, which is the whole point', () => {
    expect(missesFor(CLUSTER, CAPCUT_NEEDS)).toEqual(['feature:click_xy', 'feature:drag', 'feature:upload_file']);
  });

  it('a device that claims a flag but lacks the actions is still refused', () => {
    // A word in a capability record is not a capability. This is what routing on cdp alone would do.
    const liar = { platform: 'desktop', cdp: true, features: [] };
    expect(missesFor(liar, CAPCUT_NEEDS)).toEqual(['feature:click_xy', 'feature:drag', 'feature:upload_file']);
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
    'capcut-video-editor': { require: { features: ['click_xy', 'drag', 'upload_file'] } },
    'facebook.scout': {},
  })[name] || {};

  it('the CapCut automation asks for a drag-capable device', () => {
    const wf = { nodes: [{ type: 'trigger' }, { type: 'agent', role: 'capcut-video-editor', goal: 'edit {{input.path}}' }] };
    expect(needOf(wf.nodes, roleFor)).toEqual({ features: ['click_xy', 'drag', 'upload_file'] });
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
    expect(needOf(wf.nodes, roleFor)).toEqual({ features: ['click_xy', 'drag', 'upload_file'] });
  });
});
