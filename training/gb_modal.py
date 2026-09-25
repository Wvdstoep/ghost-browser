# -*- coding: utf-8 -*-
"""
A GHOST BROWSER TRAINING NODE ON MODAL.

The hub runs `modal run --detach training/gb_modal.py --join-url <url>` with the owner's Modal
token in the environment. Modal builds the image once (torch with CUDA, transformers, peft) and
caches it; every later start is seconds. The function fetches the node script from the hub by its
join code and runs it: the session registers as a machine, takes rounds, uploads, and leaves by
itself when idle - a detached function stops costing the moment it returns. The GPU comes from
GB_MODAL_GPU (T4 by default: about $0.60 an hour, fifty hours on the free credits).
"""
import os
import subprocess
import sys
import urllib.request

import modal

GPU = os.environ.get("GB_MODAL_GPU", "T4") or "T4"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "curl")
    .pip_install("torch", "transformers", "peft", "safetensors", "accelerate", "gguf", "sentencepiece", "numpy")
)

app = modal.App("ghost-browser-training")


@app.function(image=image, gpu=GPU, timeout=24 * 3600, retries=0)
def node(join_url: str, idle_exit: int = 900):
    src = urllib.request.urlopen(join_url, timeout=60).read()
    path = "/root/gb_node.py"
    with open(path, "wb") as fh:
        fh.write(src)
    env = dict(os.environ, GB_IDLE_EXIT=str(idle_exit), GB_NODE_HOME="/root/gb-train", PYTHONUNBUFFERED="1")
    subprocess.run([sys.executable, path], env=env, check=False)


@app.local_entrypoint()
def main(join_url: str, idle_exit: int = 900):
    # spawn, not call: the hub's process returns at once and the node keeps running detached.
    call = node.spawn(join_url, idle_exit)
    print(f"node spawned: {call.object_id}")
