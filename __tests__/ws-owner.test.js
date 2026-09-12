/**
 * THE OWNER OF THE BROWSER COULD NOT WATCH HER OWN BROWSER.
 *
 * Carla pressed Watch on a running job and got a black square and, in the console, a refused
 * WebSocket — while Herald, polling the REST API, showed the same job progressing. Two socket doors,
 * one cause: both authorisers answered the cookie sign-in with { owner: username } and nothing else,
 * and both handlers then insisted the job or the session be owned by that exact name. Every walk an
 * organ dispatches is owned by the KEY's owner ("gb_42c3f"), so the job socket returned 404 (Watch
 * failed) and the live-frames socket returned 404 (the viewport stayed black).
 *
 * The REST list was fixed for this in v194 — `req.client.console` sees listAll() — and the sockets
 * never got it. Same door, same rule.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const server = read('../src/server.js');
const agentWs = read('../src/agent-ws.js');
const live = read('../src/live.js');

describe('the socket doors say who is at them', () => {
  it('the cookie sign-in is the console, on the job socket', () => {
    expect(server).toMatch(/const wsAuth = \(req, url\) => \{\s*\n\s*const who = accounts\.verifyToken\(accounts\.readCookie\(req\)\);\s*\n\s*if \(who\) return \{ owner: who\.username, console: true \};/);
  });

  it('and on the live-frames socket', () => {
    const liveAuth = server.slice(server.indexOf("require('./live').attach("));
    expect(liveAuth).toMatch(/if \(who\) return \{ owner: who\.username, console: true \};/);
  });

  /* A program is a program: a key still identifies only as its owner. */
  it('a key is never mistaken for the console', () => {
    expect(server).toMatch(/return found \? \{ owner: found\.owner \} : null;/);
    expect(server).not.toMatch(/owner: found\.owner, console/);
  });
});

describe('the console may watch anything in this browser; a key only its own', () => {
  it('following a job', () => {
    expect(agentWs).toMatch(/if \(!job \|\| \(job\.owner !== who\.owner && !who\.console\)\) \{/);
  });

  it('streaming a session', () => {
    expect(live).toMatch(/if \(!session \|\| \(session\.owner !== who\.owner && !who\.console\)\) \{/);
  });

  /* Still authorised BEFORE the socket is accepted — nothing here moved the check after handleUpgrade. */
  it('and both are still refused before the socket is opened', () => {
    for (const src of [agentWs, live]) {
      const check = src.indexOf('&& !who.console');
      const accept = src.indexOf('wss.handleUpgrade(');
      expect(check).toBeGreaterThan(0);
      expect(check).toBeLessThan(accept);
    }
  });
});

/*
 * WATCHING A JOB SHOWED THE WRONG ROLE.
 *
 * Carla watched two of Herald's replies and read 'Lead scout' on the LinkedIn one and 'Reddit demand'
 * on the Reddit one, with those roles' descriptions above the trace, and concluded — entirely
 * reasonably — that the desk was dispatching replies with research roles. It was not: both ran on
 * herald-reply-linkedin and herald-reply-reddit. renderJob never touched the picker, so it kept the
 * OWNER's own last choice out of localStorage and described that instead.
 */
describe('the role on screen belongs to the job being watched', () => {
  const ui = read('../public/js/console.js');

  it('rendering a job sets the picker from the job', () => {
    expect(ui).toMatch(/function renderJob\(j\) \{[\s\S]{0,40}?showJobRole\(j\);/);
    expect(ui).toMatch(/sel\.value = j\.role;/);
  });

  /* An organ's role is not in the owner's picker; naming it beats showing somebody else's. */
  it('a role the picker does not list is still named, not swapped for another', () => {
    expect(ui).toMatch(/if \(!has\) \{ const o = document\.createElement\('option'\); o\.value = j\.role;/);
  });

  it('and it is locked while the job runs, because changing it then changes nothing', () => {
    expect(ui).toMatch(/sel\.disabled = !!live;/);
    expect(ui).toMatch(/it cannot be changed mid-run/);
  });

  /* The owner's own choice must survive watching somebody else's work. */
  it('a job’s role never overwrites what the owner chose', () => {
    expect(ui).toMatch(/if \(!\$\('roleSel'\)\.disabled\) localStorage\.setItem\('gb_role'/);
  });
});

/*
 * AND IT WENT BLACK AGAIN, for a different reason each half of which was invisible.
 *
 * The reconnect: adoptAgentSession returned early whenever the session id had not changed. Right
 * while the picture is live, wrong the moment it is not — leaving the console for Accounts and
 * pressing Watch again on the same job re-enters with `session` already set, so nothing was adopted,
 * nothing reconnected, and the dead canvas from the last visit stayed on screen until a reload.
 *
 * The silence: every refusal on both sockets was a bare status written to a socket that was then
 * destroyed. Nothing was logged and nothing was shown, so a wrong owner, an expired session and a
 * job that has no browser yet all looked identical — a black rectangle. Watching a job is the one
 * feature whose whole purpose is to show what is happening; it must never fail without saying so.
 */
describe('and when it cannot show you, it says so', () => {
  const console_ = read('../public/js/console.js');

  it('watching the same job twice reconnects rather than trusting the id', () => {
    const at = console_.indexOf('function adoptAgentSession');
    const body = console_.slice(at, at + 900);
    expect(body).toMatch(/const connected = ws && \(ws\.readyState === WebSocket\.OPEN \|\| ws\.readyState === WebSocket\.CONNECTING\)/);
    expect(body).toMatch(/if \(sessionId === session && connected\) return;/);
    /* The old guard is gone: an unchanged id must no longer be enough to skip connecting. */
    expect(body).not.toMatch(/if \(!sessionId \|\| sessionId === session\) return;/);
  });

  it('a socket that closes without ever answering is reported', () => {
    const at = console_.indexOf('function followJob');
    /* The whole function, not a window: it grew when the snapshot handler was made safe. */
    const body = console_.slice(at, console_.indexOf('\nfunction ', at + 10));
    expect(body).toMatch(/let heard = false;/);
    expect(body).toMatch(/heard = true;/);
    expect(body).toMatch(/if \(heard\) return;/);
    /*
     * AND ONLY THE CURRENT SOCKET MAY SPEAK. This reported a refusal whenever a socket closed
     * without a snapshot — including one this function had just replaced on purpose. Measured: two
     * accepts in the browser's own log, and "it refused the connection" on screen. A wrong
     * explanation is worse than none, because it sends somebody to fix the wrong thing.
     */
    expect(body).toMatch(/ajws\.__replaced = true;/);
    expect(body).toMatch(/if \(mine\.__replaced\) return;/);
    /* And it carries the close code, which separates a dead connection from a clean close. */
    expect(body).toMatch(/code \$\{ev && ev\.code\}/);
  });

  /* A running job with no browser is a real state — queued, waiting — not a broken viewer. */
  it('and a job that has no browser yet is explained, not shown as black', () => {
    expect(console_).toMatch(/this job has no browser yet/);
  });

  it('the job socket writes down which refusal it was', () => {
    expect(agentWs).toMatch(/\[agent-ws\] refused: not signed in/);
    expect(agentWs).toMatch(/belongs to \$\{job\.owner\}, not \$\{who\.owner\}/);
    expect(agentWs).toMatch(/\[agent-ws\] \$\{who\.owner\} is watching job/);
  });

  it('and so does the live one, including a session that has expired', () => {
    expect(live).toMatch(/\[live\] refused: not signed in/);
    expect(live).toMatch(/it may have expired/);
    expect(live).toMatch(/\[live\] \$\{who\.owner\} is watching/);
  });
});

/*
 * A LINK STRAIGHT INTO ONE WALK.
 *
 * Creating a Facebook page fills a real form and clicks through a real flow for several minutes.
 * Herald showed a progress bar while that happened, which tells somebody nothing at exactly the
 * moment they most want to see what is going on — both to trust it and to step in.
 *
 * So an organ can send them here with #job=<id>, and the console opens on that walk already watching
 * it. Landing them on the account board and asking them to find the right row would be the same as
 * not linking at all.
 */
describe('an organ can link straight to the walk it started', () => {
  const dash = read('../public/js/dashboard.js');

  it('a job in the hash opens the live view on it', () => {
    expect(dash).toMatch(/const m = \(location\.hash \|\| ''\)\.match\(\/\[#&\]job=\(\[\^&\]\+\)\/\);/);
    expect(dash).toMatch(/if \(typeof followJob === 'function'\) followJob\(id\);/);
    /* The app view, not the board — the board is what the link exists to skip. */
    expect(dash).toMatch(/deepLinked = true;\s*\n\s*const id = decodeURIComponent\(m\[1\]\);\s*\n\s*showApp\(\);/);
  });

  /* Once. Otherwise going back to the board and forward again yanks the person into it again. */
  it('and it is consumed once, not on every return to the board', () => {
    expect(dash).toMatch(/let deepLinked = false;/);
    expect(dash).toMatch(/if \(deepLinked\) return;/);
  });

  it('and it runs after the board is drawn, since it takes you off it', () => {
    const at = dash.indexOf('new MutationObserver');
    const body = dash.slice(at, at + 700);
    expect(body).toMatch(/refresh\(\);\s*\n[^\n]*\n\s*followDeepLink\(\);/);
  });
});

/*
 * THE BLACK VIEW BEHIND A LINK THAT CONNECTED FINE.
 *
 * Carla followed the watch link into a running page set-up. The server logged the job socket
 * accepted — "is watching job … (running)" — and the frames socket was never attempted at all,
 * neither accepted nor refused. So the failure was not in either door; it was between them.
 *
 * The snapshot handler drew the steps and THEN connected the live view, in one sequence. A browser
 * swallows an exception thrown inside a socket handler, so anything that went wrong while drawing
 * killed the handler before it ever reached the connect — and produced a black rectangle with
 * nothing wrong anywhere on the server to explain it.
 *
 * The frames are what the link exists for. Drawing the steps is the part that can fail.
 */
describe('the live view does not depend on the transcript drawing', () => {
  const console_ = read('../public/js/console.js');
  const at = console_.indexOf("if (m.type === 'snapshot')");
  const body = console_.slice(at, at + 1800);

  it('the session is adopted BEFORE the steps are drawn', () => {
    const adopt = body.indexOf('adoptAgentSession(m.job.sessionId');
    const render = body.indexOf('renderJob(m.job)');
    expect(adopt).toBeGreaterThan(0);
    expect(render).toBeGreaterThan(adopt);
  });

  it('and a failure while drawing cannot take the picture down with it', () => {
    expect(body).toMatch(/try \{ renderJob\(m\.job\); \}/);
    expect(body).toMatch(/catch \(e\) \{ agentSay\('the transcript could not be drawn: '/);
    expect(body).toMatch(/the live view above is unaffected/);
  });

  /* And it says so, rather than failing silently the way the browser does with a thrown handler. */
  it('and it is reported instead of swallowed', () => {
    expect(body).toMatch(/agentSay\('the transcript could not be drawn/);
  });
});
