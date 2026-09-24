/*
 * gpu.js — A GPU FOR AN HOUR, RENTED WHEN A ROUND IS DUE AND DESTROYED WHEN IT IS DONE.
 *
 * A CPU round reaches a few hundred turns in twelve hours. The same round on one rented card is
 * twenty minutes and about a euro, billed by the second. So when the owner has chosen the GPU flow
 * (a switch beside the laptop flow - never both, never guessed), a round is a machine that does not
 * exist until the planner says train and stops existing the moment the round has reported.
 *
 * The machine boots into one script: install the few packages the trainer needs, fetch the same
 * scripts the laptops fetch from the hub, train with the hub reporting progress exactly as a laptop
 * would, export the adapter as a model file the sidecar can serve, hand the adapter back to the hub
 * so the next round can chain from it, and ask the hub to destroy it. The hub also destroys it on
 * its own when the round has ended, when it has been silent too long, or when it has run past the
 * hours the owner allowed - a rented machine nobody is watching is the expensive mistake here.
 *
 * Provider: RunPod (REST, per-second billing). Hetzner's GPU line is dedicated and monthly, which
 * is the wrong shape for a machine that should live twenty minutes. The provider is one object here
 * so a second one is a second object.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = () => path.join(process.env.PROFILE_DIR || '/profiles', 'training');
const FILE = () => path.join(DIR(), 'gpu.json');

const PROVIDERS = {
  runpod: { base: 'https://rest.runpod.io/v1', name: 'RunPod' },
};
/** A CUDA image with torch already in it; the rest is a pip install of a minute. */
const IMAGE = 'runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04';
/** Sensible cards for a 0.5B-1.7B LoRA round, cheapest first. RunPod names them like this. */
const GPU_TYPES = ['NVIDIA GeForce RTX 4090', 'NVIDIA RTX A5000', 'NVIDIA GeForce RTX 3090', 'NVIDIA RTX A6000', 'NVIDIA L4'];
const DEFAULT_TYPE = GPU_TYPES[0];
/** A round that has not reported for this long on a rented machine is a machine to destroy. */
const SILENT_MS = 30 * 60 * 1000;

/**
 * The one script the machine runs. Everything it needs comes from the hub with the same token the
 * laptops use, so nothing here knows a path on this machine except /workspace.
 */
function bootstrap({ hub, token, deviceName = 'gpu-runpod', hours = 2, epochs = 3, slice = 10000, evalTurns = 500, base = '', adapter = '', tag = '' } = {}) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const lines = [
    '#!/bin/bash',
    'set -o pipefail',
    'export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8',
    `export GB_HUB=${q(hub)} GB_TOKEN=${q(token)} GB_DEVICE=${q(deviceName)}`,
    'mkdir -p /workspace/gb && cd /workspace/gb',
    'say() { echo "[gpu] $*"; curl -fsS -m 20 -X POST "$GB_HUB/v1/training/gpu/note" -H "Authorization: Bearer $GB_TOKEN" -H "Content-Type: application/json" -d "{\\"line\\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$*")}" >/dev/null 2>&1 || true; }',
    'say "booted on $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"',
    'pip install -q transformers peft accelerate psutil gguf sentencepiece protobuf 2>&1 | tail -1',
    'mkdir -p tools && (test -f tools/llama.cpp/convert_hf_to_gguf.py || git clone -q --depth 1 https://github.com/ggml-org/llama.cpp.git tools/llama.cpp)',
    'for f in train_round.py evaluate.py export_model.py; do curl -fsS -H "Authorization: Bearer $GB_TOKEN" "$GB_HUB/v1/training/script/$f" -o "$f" || { say "could not fetch $f"; }; done',
    'say "training"',
    [
      'python3 train_round.py --data /workspace/gb/data --out /workspace/gb/rounds',
      `--hours ${Number(hours) || 2} --epochs ${Number(epochs) || 3} --slice ${Number(slice) || 10000} --eval-turns ${Number(evalTurns) || 500}`,
      '--bf16 --threads 8 --hub "$GB_HUB" --token "$GB_TOKEN" --device-name "$GB_DEVICE"',
      base ? `--model ${q(base)}` : '',
      adapter ? `--adapter ${q(adapter)}` : '',
      '2>&1 | tee round.log | tail -40',
    ].filter(Boolean).join(' '),
    'A=$(ls -td /workspace/gb/rounds/round-*/adapter 2>/dev/null | head -1)',
    'if [ -n "$A" ]; then',
    '  say "handing the adapter back"',
    '  tar czf adapter.tgz -C "$A" . && curl -fsS -m 600 -X PUT --data-binary @adapter.tgz "$GB_HUB/v1/training/gpu/adapter" -H "Authorization: Bearer $GB_TOKEN" -H "Content-Type: application/octet-stream" >/dev/null || say "the adapter did not upload"',
    tag ? `  say "exporting ${tag}" && python3 export_model.py --adapter "$A" --tag ${q(tag)} ${base ? `--base ${q(base)}` : ''} --hub "$GB_HUB" --token "$GB_TOKEN" 2>&1 | tail -5` : '  say "no tag asked for; not exporting"',
    'else',
    '  say "no adapter was produced"',
    'fi',
    'say "done — asking to be destroyed"',
    'curl -fsS -m 20 -X POST "$GB_HUB/v1/training/gpu/release" -H "Authorization: Bearer $GB_TOKEN" >/dev/null 2>&1 || true',
    'sleep 300',
  ];
  return lines.join('\n');
}

/** The request RunPod wants. Pure, so the shape is tested without a card. */
function requestFor({ name = 'gb-round', gpuType = DEFAULT_TYPE, cloud = 'COMMUNITY', script = '', diskGb = 40 } = {}) {
  return {
    name: String(name).slice(0, 60),
    imageName: IMAGE,
    gpuTypeIds: [String(gpuType || DEFAULT_TYPE)],
    gpuCount: 1,
    cloudType: cloud === 'SECURE' ? 'SECURE' : 'COMMUNITY',
    containerDiskInGb: Number(diskGb) || 40,
    volumeInGb: 0,
    ports: [],
    env: {},
    dockerStartCmd: ['bash', '-c', String(script)],
  };
}

async function call({ key, method = 'GET', pathname = '/pods', body = null, fetchImpl = fetch, timeoutMs = 60000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${PROVIDERS.runpod.base}${pathname}`, {
      method, signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { json = null; }
    if (!r.ok) throw Object.assign(new Error(`RunPod answered ${r.status}: ${(json && (json.error || json.message)) || text.slice(0, 200)}`), { status: r.status });
    return json;
  } finally { clearTimeout(timer); }
}

async function rent({ key, request, fetchImpl }) { return call({ key, method: 'POST', pathname: '/pods', body: request, fetchImpl }); }
async function status({ key, id, fetchImpl }) { return call({ key, pathname: `/pods/${encodeURIComponent(id)}`, fetchImpl }); }
async function destroy({ key, id, fetchImpl }) { return call({ key, method: 'DELETE', pathname: `/pods/${encodeURIComponent(id)}`, fetchImpl, timeoutMs: 30000 }); }

/* ── the record ─────────────────────────────────────────────────────────────────────────────── */
const EMPTY = () => ({ pod: null, last: null, history: [] });
function load() { try { return { ...EMPTY(), ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) }; } catch { return EMPTY(); } }
function save(st) { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(st, null, 1)); return st; }

/** Why a live rental should end now, or null. */
function shouldEnd({ pod, round = null, maxHours = 2, now = Date.now(), silentMs = SILENT_MS } = {}) {
  if (!pod) return null;
  const since = Date.parse(pod.since || '') || now;
  if (now - since > (Number(maxHours) || 2) * 3600000) return `it has run ${Math.round((now - since) / 60000)} min, past the ${maxHours} h allowed`;
  if (pod.released) return 'the machine asked to be destroyed';
  if (round && round.status && round.status !== 'running') return `the round is ${round.status}`;
  const heard = Date.parse(pod.lastNoteAt || (round && round.lastAt) || pod.since || '') || since;
  if (now - heard > silentMs && now - since > 15 * 60000) return `nothing heard from it for ${Math.round((now - heard) / 60000)} min`;
  return null;
}

/** For the screen and for the planner's virtual machine. */
function state() {
  const st = load();
  const est = (p) => (p && p.costPerHr && p.since) ? Math.round(((Date.now() - Date.parse(p.since)) / 3600000) * Number(p.costPerHr) * 100) / 100 : null;
  return {
    pod: st.pod ? { ...st.pod, costSoFar: est(st.pod) } : null,
    last: st.last,
    history: (st.history || []).slice(-10),
  };
}

module.exports = { PROVIDERS, IMAGE, GPU_TYPES, DEFAULT_TYPE, SILENT_MS, bootstrap, requestFor, rent, status, destroy, load, save, shouldEnd, state, FILE };
