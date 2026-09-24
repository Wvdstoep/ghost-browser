"""
export_model.py — FROM AN ADAPTER ON THIS LAPTOP TO A MODEL THE CLUSTER CAN SERVE.

A round leaves an 8 MB LoRA adapter beside a base model on this machine. The cluster's model
server (an Ollama sidecar in the browser's pod) cannot use that: it wants one file it can load.
So this merges the adapter into the base, converts the result to GGUF (llama.cpp's own converter,
quantised to q8_0 - a 0.5B model becomes about 550 MB, a 1.5B about 1.6 GB), uploads that one
file to the cluster, and asks the cluster to register it under a tag. From then on the tag is a
model the serving switch can name.

Run by the desktop app on a promotion, or by hand:
  python export_model.py --adapter D:\gb-train\rounds\round-x\adapter --tag gb-general-v3 --hub https://gb... --token XXX

Every step is idempotent and says what it is doing; the merged model and the GGUF are kept next
to the adapter so a second run is an upload, not a merge.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
CONVERTER = os.path.join(HERE, "tools", "llama.cpp", "convert_hf_to_gguf.py")


def say(s):
    print(f"  {s}", flush=True)


def merge(base, adapter, out):
    """Base + adapter -> one fp16 model on disk. Skipped when it is already there."""
    if os.path.isfile(os.path.join(out, "config.json")) and any(f.endswith(".safetensors") for f in os.listdir(out)):
        say(f"merged model already at {out}")
        return out
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel
    say(f"loading {base}")
    model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.float32)
    say(f"merging {adapter}")
    model = PeftModel.from_pretrained(model, adapter)
    model = model.merge_and_unload()
    model = model.to(torch.float16)
    os.makedirs(out, exist_ok=True)
    model.save_pretrained(out, safe_serialization=True)
    AutoTokenizer.from_pretrained(base).save_pretrained(out)
    say(f"merged model written to {out}")
    return out


def convert(merged, gguf_path, outtype="q8_0"):
    """The merged model -> one GGUF file, quantised. Skipped when it is already there."""
    if os.path.isfile(gguf_path) and os.path.getsize(gguf_path) > 1_000_000:
        say(f"gguf already at {gguf_path}")
        return gguf_path
    if not os.path.isfile(CONVERTER):
        raise SystemExit(f"the converter is missing: {CONVERTER} (tools/convert_hf_to_gguf.py from llama.cpp)")
    cmd = [sys.executable, CONVERTER, merged, "--outfile", gguf_path, "--outtype", outtype]
    say("converting to gguf (" + outtype + ")")
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or not os.path.isfile(gguf_path):
        raise SystemExit("conversion failed:\n" + r.stdout[-2000:])
    say(f"gguf written: {os.path.getsize(gguf_path) / 1e6:.0f} MB")
    return gguf_path


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Hub:
    def __init__(self, base, token):
        self.base = base.rstrip("/")
        self.token = token

    def _req(self, method, path, body=None, headers=None, timeout=60):
        h = {"Authorization": f"Bearer {self.token}", **(headers or {})}
        req = urllib.request.Request(f"{self.base}{path}", data=body, headers=h, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")

    PART = 64 * 1024 * 1024

    def upload(self, tag, path, digest):
        """In parts of 64 MB, then joined and checked on the cluster.

        The edge in front of the cluster closes any single request past about a hundred megabytes
        (the first two attempts died with an SSL EOF at exactly that point), and a model is five to
        sixteen times that. Each part is retried on its own, so a dropped connection costs one part."""
        size = os.path.getsize(path)
        parts = (size + self.PART - 1) // self.PART
        say(f"uploading {size / 1e6:.0f} MB to the cluster as {tag}, in {parts} part(s)")
        with open(path, "rb") as fh:
            for i in range(parts):
                fh.seek(i * self.PART)
                chunk = fh.read(self.PART)
                for attempt in range(4):
                    try:
                        req = urllib.request.Request(
                            f"{self.base}/v1/training/models/{tag}/part/{i}", data=chunk, method="PUT",
                            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/octet-stream",
                                     "Content-Length": str(len(chunk))},
                        )
                        with urllib.request.urlopen(req, timeout=600) as r:
                            r.read()
                        break
                    except (urllib.error.URLError, OSError) as e:
                        if attempt == 3:
                            raise
                        say(f"part {i} failed ({str(e)[:80]}) — trying again")
                        time.sleep(5)
                say(f"  part {i + 1}/{parts} landed")
        say("asking the cluster to join the parts")
        body = json.dumps({"parts": parts, "digest": digest}).encode("utf-8")
        return self._req("POST", f"/v1/training/models/{tag}/assemble", body, {"Content-Type": "application/json"}, timeout=1800)

    def create(self, tag, digest, base, round_id):
        say(f"asking the cluster to register {tag}")
        body = json.dumps({"digest": digest, "base": base, "roundId": round_id}).encode("utf-8")
        return self._req("POST", f"/v1/training/models/{tag}/create", body, {"Content-Type": "application/json"}, timeout=1800)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True, help="the round's adapter directory")
    ap.add_argument("--tag", required=True, help="the model tag the cluster will serve, e.g. gb-general-v3")
    ap.add_argument("--base", default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--outtype", default="q8_0")
    ap.add_argument("--hub", default=os.environ.get("GB_HUB", ""))
    ap.add_argument("--token", default=os.environ.get("GB_TOKEN", ""))
    ap.add_argument("--round", default="", help="the round id, for the record")
    ap.add_argument("--no-upload", action="store_true")
    args = ap.parse_args()

    tag = "".join(c for c in args.tag if c.isalnum() or c in "-_.:").strip(".:")
    if not tag:
        raise SystemExit("a tag is needed")
    adapter = os.path.abspath(args.adapter)
    root = os.path.dirname(adapter)
    merged = os.path.join(root, "merged")
    gguf_path = os.path.join(root, f"{tag.replace(':', '-')}.gguf")

    started = time.time()
    merge(args.base, adapter, merged)
    convert(merged, gguf_path, args.outtype)
    digest = sha256_of(gguf_path)
    say(f"sha256 {digest[:12]}… in {time.time() - started:.0f}s")
    if args.no_upload or not args.hub:
        say("not uploading (no hub or --no-upload)")
        print(json.dumps({"tag": tag, "gguf": gguf_path, "digest": digest}))
        return 0
    hub = Hub(args.hub, args.token)
    up = hub.upload(tag, gguf_path, digest)
    say(f"uploaded: {json.dumps(up)[:200]}")
    made = hub.create(tag, digest, args.base, args.round)
    say(f"registered: {json.dumps(made)[:300]}")
    print(json.dumps({"tag": tag, "gguf": gguf_path, "digest": digest, "created": made}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
