#!/usr/bin/env node
'use strict';
/*
 * stdin → stdout at most N MB/s (2026-11-21).
 *
 * gb-sync-all.js streams the 2.7 GB browser image into an owned cluster (docker save | kubectl exec … ctr import).
 * At full speed that saturated the node's one disk, which etcd shares: "slow fdatasync" for half an hour, then
 * k3s lost its leader election and restarted (2026-11-21 10:31). A limit on the copy's own process does not help
 * (dockerd reads and the owned cluster's containerd writes, in their own cgroups); pacing the stream between them
 * paces both. Usage: … | node throttle-stream.js 40 | …   (MB/s, default 40)
 */
const mbps = Math.max(1, Number(process.argv[2]) || 40);
const perTick = Math.floor((mbps * 1024 * 1024) / 10);   // budget per 100 ms
let budget = perTick;
const queue = [];
let ended = false;

setInterval(() => { budget = perTick; pump(); }, 100);

function pump() {
  while (queue.length && budget > 0) {
    let chunk = queue[0];
    if (chunk.length > budget) { queue[0] = chunk.subarray(budget); chunk = chunk.subarray(0, budget); } else queue.shift();
    budget -= chunk.length;
    if (!process.stdout.write(chunk)) { process.stdin.pause(); process.stdout.once('drain', () => { process.stdin.resume(); pump(); }); return; }
  }
  if (queue.length > 64) process.stdin.pause(); else if (!ended) process.stdin.resume();
  if (ended && !queue.length) { process.stdout.end(); process.exitCode = 0; setImmediate(() => process.exit(0)); }
}

process.stdin.on('data', (c) => { queue.push(c); pump(); });
process.stdin.on('end', () => { ended = true; pump(); });
process.stdout.on('error', () => process.exit(1));
