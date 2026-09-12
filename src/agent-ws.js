/**
 * agent-ws.js — the agent's work, as it happens.
 *
 * Polling would have been fewer lines, and wrong. The two moments that matter are the agent asking
 * permission and the agent getting stuck, and both are moments where a person is sitting there
 * waiting. A four-second poll turns "it asked" into "it seems to have stopped".
 *
 * The socket carries the same events the job record already emits, so it is a live view of the
 * record rather than a second version of the story that can drift from it. Anything missed while
 * disconnected is still in the record: the client is sent the whole job on connect and can
 * reconnect at any point without losing a step.
 */

const WebSocket = require('ws');
const jobs = require('./jobs');

function attach({ server, authorize, path = '/v1/agent', logger = console }) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
    if (url.pathname !== path) return;   // the live view owns its own path

    // Checked before the socket is accepted, for the same reason as the live view: a socket opened
    // first and authorised later has already been opened.
    const wanted = url.searchParams.get('job');
    const who = authorize(req, url);
    if (!who) {
      /* SAY WHICH DOOR SAID NO. A refusal here is a black rectangle on somebody's screen, and it
         used to leave nothing behind on either end to tell them which of three reasons it was. */
      logger.warn?.(`[agent-ws] refused: not signed in (job ${wanted})`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy();
    }

    const job = jobs.get(wanted);
    /* A key follows only its own jobs. The owner's console follows any job in this browser — the
       walks her organs dispatch are owned by their key, and Watch on one of those returned 404. */
    if (!job || (job.owner !== who.owner && !who.console)) {
      logger.warn?.(`[agent-ws] refused: ${job ? `job ${wanted} belongs to ${job.owner}, not ${who.owner}` : `no job ${wanted}`}`);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy();
    }
    logger.info?.(`[agent-ws] ${who.owner} is watching job ${job.id} (${job.status}${job.sessionId ? '' : ', no browser yet'})`);

    wss.handleUpgrade(req, socket, head, (ws) => follow(ws, job));
  });

  function follow(ws, job) {
    const send = (o) => { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); } catch { /* gone */ } };

    // The whole job first, so a reconnect mid-run is indistinguishable from having been there.
    send({ type: 'snapshot', job: jobs.view(job) });

    const onEvent = (e) => send(e);
    jobs.bus.on(job.id, onEvent);

    /* A job can run for a long time between steps — reading a slow page, or waiting on a person to
       approve something. Idle proxies close silent sockets, and a dropped socket in the middle of a
       decision looks exactly like a crash. */
    const ping = setInterval(() => { try { ws.ping(); } catch { /* closing */ } }, 25000);

    const bye = () => {
      clearInterval(ping);
      jobs.bus.off(job.id, onEvent);
    };
    ws.on('close', bye);
    ws.on('error', (e) => { logger.warn?.(`[agent-ws] ${job.id}: ${e.message}`); bye(); });
  }

  return wss;
}

module.exports = { attach };
