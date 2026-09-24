/**
 * llm.js — talking to Ollama, hosted or self-hosted.
 *
 * Ollama's own chat API rather than the OpenAI-compatible shim, because the native one is where
 * tool calling is documented and where the hosted models advertise it. The URL is a setting, so the
 * same code reaches ollama.com with a key or a box on the owner's own network without one — which
 * is the point of this whole image: the browser is theirs and so is the model.
 *
 * WHAT THIS FILE REFUSES TO DO is paper over failure. An agent that silently gets an empty response
 * looks like an agent that decided to stop, and the person watching has no way to tell those apart.
 * Every failure here comes back as a message a human can act on: no key, wrong model, out of quota.
 */

const NET_TIMEOUT_MS = 120000;   // a large hosted model thinking about a full page is not fast

/**
 * One turn. `messages` is the running transcript, `tools` the JSON-schema tool list; the reply comes
 * back as { content, toolCalls } with toolCalls already normalised to { name, args }.
 */
async function chat({ host, model, key, messages, tools, signal, timeoutMs = NET_TIMEOUT_MS, fetchImpl = fetch, options: extra = null, keepAlive = null }) {
  if (!model) throw Object.assign(new Error('No model is configured — set one in the agent settings.'), { status: 400 });
  const base = String(host || 'https://ollama.com').replace(/\/+$/, '');
  // A hosted endpoint without a key produces a 401 whose body is not always readable; saying it up
  // front is clearer than relaying somebody else's error page.
  if (/ollama\.com/.test(base) && !key) {
    throw Object.assign(new Error('Ollama Cloud needs an API key — add one in the agent settings.'), { status: 400 });
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  // Stopping a job must stop the request it is waiting on, not wait out the timeout first.
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });

  let r;
  try {
    r = await fetchImpl(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools && tools.length ? { tools } : {}),
        stream: false,
        options: {
          // Low, because this agent decides between listed options rather than writing prose. The
          // creative part — what a comment says — is reviewed by a person before it is sent.
          temperature: 0.3,
          /* A caller that knows better - the student wants a context its prompt fits in and a
             deterministic, short answer - says so here. */
          ...(extra && typeof extra === 'object' ? extra : {}),
        },
        ...(keepAlive ? { keep_alive: keepAlive } : {}),
      }),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw Object.assign(new Error(signal?.aborted ? 'stopped' : `the model did not answer within ${Math.round(timeoutMs / 1000)}s`), { status: 504 });
    }
    // DNS, TLS, refused — all of which mean the host setting, not the model.
    throw Object.assign(new Error(`could not reach ${base}: ${e.message}`), { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  const text = await r.text();
  if (!r.ok) {
    let detail = text.slice(0, 400);
    try { detail = JSON.parse(text).error || detail; } catch { /* not JSON, keep the raw body */ }
    // 401 and 404 are the two everybody hits, and neither error text explains itself.
    if (r.status === 401 || r.status === 403) {
      throw Object.assign(new Error(`the API key was rejected (${r.status}): ${detail}`), { status: 401 });
    }
    if (r.status === 404) {
      throw Object.assign(new Error(`"${model}" is not available on ${base}: ${detail}`), { status: 404 });
    }
    /*
     * PRESERVE THE REAL STATUS — a 429 must stay a 429. Flattening every non-401/404 to 502 hid the
     * one status the keyring rolls on (isSpent needs status===429): a weekly-limit 429 read as a 502,
     * so the ring never moved to the backup key and a walk died on the exhausted primary while a good
     * key sat unused. Seen live: a Facebook setup walk stopped at step one, "weekly usage limit", with
     * the backup account still working. Keep the upstream status; 502 stays only for a truly unknown one.
     */
    throw Object.assign(new Error(`the model returned ${r.status}: ${detail}`), { status: r.status || 502 });
  }

  let body;
  try { body = JSON.parse(text); }
  catch { throw Object.assign(new Error(`${base} did not return JSON — is that an Ollama endpoint?`), { status: 502 }); }

  const msg = body.message || {};
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    /*
     * Ollama returns { function: { name, arguments } } and `arguments` is usually already an object
     * — but not always. A model that emits it as a JSON string is not misbehaving badly enough to
     * fail the turn over, so both are accepted.
     */
    toolCalls: (msg.tool_calls || []).map((c) => {
      const fn = c.function || {};
      let args = fn.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { _raw: args }; } }
      return { name: fn.name, args: args && typeof args === 'object' ? args : {} };
    }),
    raw: body,
  };
}

/**
 * A one-line proof that the key, host and model actually work together — before someone starts a
 * job and watches it fail forty seconds in.
 */
async function testConnection({ host, model, key }) {
  const started = Date.now();
  const r = await chat({
    host, model, key,
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    timeoutMs: 45000,
  });
  return { ok: true, model, reply: (r.content || '').trim().slice(0, 80), ms: Date.now() - started };
}


/**
 * What this host actually has.
 *
 * A free-text model box is a box you must already know the answer to, and picking a name that is
 * not there fails forty seconds into a job with a 404. Ollama answers /api/tags with what it can
 * serve, so ask it.
 *
 * NEVER THROWS. A host that will not list its models is still a host you can type a name into, so
 * an unanswered list falls back to the well-known cloud ones — and SAYS it fell back, because a
 * guessed list presented as fetched is the version of this that wastes an afternoon.
 */
const KNOWN_CLOUD = ['gpt-oss:120b', 'gpt-oss:20b', 'qwen3-coder:480b', 'deepseek-v3.1:671b',
                     'kimi-k2:1t', 'glm-4.6', 'minimax-m2'];

async function listModels({ host, key, timeoutMs = 20000 } = {}) {
  const base = String(host || 'https://ollama.com').replace(/\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/api/tags`, {
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: ctl.signal,
    });
    if (!r.ok) return { models: KNOWN_CLOUD, fetched: false, host: base, reason: `${base} answered ${r.status}` };
    const body = await r.json();
    const names = (body.models || []).map((m) => m.name || m.model).filter(Boolean);
    if (!names.length) return { models: KNOWN_CLOUD, fetched: false, host: base, reason: 'the host listed nothing' };
    return { models: names.sort(), fetched: true, host: base };
  } catch (e) {
    return { models: KNOWN_CLOUD, fetched: false, host: base, reason: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(timer); }
}

module.exports = { chat, testConnection, listModels, KNOWN_CLOUD };
