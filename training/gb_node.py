#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GHOST BROWSER TRAINING NODE - a machine made of any Python session with a GPU.

This file is served by the hub with the hub's address, a device token, a device id and a name
filled in (the placeholders below), for one join code the owner minted on the Machines page. Run
it and the session becomes a machine on the hub exactly like a laptop running the desktop app:
it registers with what it can do, polls for commands, takes rounds, reports progress, uploads
the adapter, and ends its round on Stop. It runs the same trainer with the same recipe - the same
pages, the same window, three epochs - only faster.

It leaves by itself when nothing has been asked of it for a while (IDLE_EXIT seconds), because a
rented session costs while it is alive. It uploads its checkpoint to the hub every half hour of
training so a session that is cut short is continued, not restarted, on the next node.

Colab: paste the one line from the Machines page into a cell and run it. Kaggle and Modal: the
hub starts it for you.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

HUB = "__HUB__"
TOKEN = "__TOKEN__"
DEVICE = "__DEVICE__"
NAME = "__NAME__"
KIND = "__KIND__"
IDLE_EXIT = int(os.environ.get("GB_IDLE_EXIT", "900") or 900)      # seconds without a round before leaving
HOME = os.path.abspath(os.environ.get("GB_NODE_HOME") or os.path.join(os.getcwd(), "gb-train"))
SCRIPTS = ("train_round.py", "evaluate.py", "export_model.py")


def req(method, path, body=None, raw=False, timeout=60):
    data = None
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(HUB + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        b = resp.read()
        if raw:
            return b
        return json.loads(b.decode("utf-8")) if b.strip() else None


def say(line):
    print(line, flush=True)
    try:
        req("POST", "/v1/device/log", {"deviceId": DEVICE, "line": ("train: " + line)[:400]}, timeout=20)
    except Exception:
        pass


def gpu_name():
    try:
        import torch
        return torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""
    except Exception:
        return ""


def free_gb():
    try:
        return int(shutil.disk_usage(HOME).free // (1024 ** 3))
    except Exception:
        return 0


def pip_missing():
    import importlib.util
    need = [("torch", "torch"), ("transformers", "transformers"), ("peft", "peft"), ("safetensors", "safetensors"),
            ("accelerate", "accelerate"), ("gguf", "gguf"), ("sentencepiece", "sentencepiece")]
    return [pkg for mod, pkg in need if importlib.util.find_spec(mod) is None]


def fetch_scripts():
    for name in SCRIPTS:
        src = req("GET", f"/v1/training/script/{name}", raw=True, timeout=120)
        with open(os.path.join(HOME, name), "wb") as fh:
            fh.write(src)


def setup():
    os.makedirs(HOME, exist_ok=True)
    for d in ("data", "rounds", os.path.join("tools", "llama.cpp")):
        os.makedirs(os.path.join(HOME, d), exist_ok=True)
    missing = pip_missing()
    if missing:
        say(f"installing {', '.join(missing)}")
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", *missing], check=False)
    fetch_scripts()
    # THE CONVERTER COMES WITH ITS OWN LIBRARY. `convert_hf_to_gguf.py` reads the gguf package that
    # sits beside it in llama.cpp's tree (gguf-py); the single file against a pip release of another
    # version fails on a symbol nobody expects. So: the tree, shallow, like a laptop's set-up. The
    # single file stays as the fallback for a session without git.
    tools = os.path.join(HOME, "tools")
    conv = os.path.join(tools, "llama.cpp", "convert_hf_to_gguf.py")
    if not os.path.isfile(conv):
        os.makedirs(tools, exist_ok=True)
        try:
            import shutil as _sh
            _sh.rmtree(os.path.join(tools, "llama.cpp"), ignore_errors=True)
            r = subprocess.run(["git", "clone", "--depth", "1", "https://github.com/ggml-org/llama.cpp", os.path.join(tools, "llama.cpp")],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if r.returncode != 0:
                print(f"llama.cpp not cloned: {r.stdout[-300:]}", flush=True)
        except Exception as e:
            print(f"llama.cpp not cloned: {e}", flush=True)
    if not os.path.isfile(conv):
        os.makedirs(os.path.dirname(conv), exist_ok=True)
        try:
            urllib.request.urlretrieve("https://raw.githubusercontent.com/ggml-org/llama.cpp/master/convert_hf_to_gguf.py", conv)
        except Exception as e:
            print(f"converter not fetched: {e}", flush=True)
    say("ready to export" if os.path.isfile(conv) else "no gguf converter — this node can train but not export")


def caps():
    g = gpu_name()
    return {
        "platform": "cluster",
        "trainer": bool(g),
        "trainerFreeGb": free_gb(),
        "trainerHome": HOME,
        "trainerMissing": [] if g else ["no GPU in this session"],
        "trainerCanSetUp": False,
        "features": ["train_round", "train_stop", "train_status", "train_export", "train_log"],
        "gpu": g,
        "node": KIND,
    }


def register():
    for _ in range(60):
        try:
            out = req("POST", "/v1/device/register", {"deviceId": DEVICE, "name": NAME, "caps": caps()})
            if out and out.get("ok"):
                return True
        except Exception as e:
            print(f"register: {e}", flush=True)
        time.sleep(5)
    return False


ROUND = {"proc": None, "started": 0.0, "log": None}
EXPORT = {"proc": None}
LAST_WORK = {"at": time.time()}


def status():
    p = ROUND["proc"]
    return {"ready": bool(gpu_name()), "freeGb": free_gb(), "home": HOME, "gpu": gpu_name(),
            "missing": caps()["trainerMissing"], "running": bool(p and p.poll() is None), "node": KIND}


def log_tail(lines=80):
    try:
        with open(os.path.join(HOME, "last-round.log"), "r", encoding="utf-8", errors="replace") as fh:
            data = fh.read()
        return "\n".join(data.splitlines()[-int(lines):])
    except Exception as e:
        return f"(no round log: {e})"


def round_id_from_log():
    try:
        with open(os.path.join(HOME, "last-round.log"), "r", encoding="utf-8", errors="replace") as fh:
            import re
            m = None
            for line in fh:
                mm = re.search(r"round (r-[a-z0-9-]+) on", line)
                if mm:
                    m = mm.group(1)
            return m or ""
    except Exception:
        return ""


def watch(p):
    code = p.wait()
    LAST_WORK["at"] = time.time()
    if code == 0:
        return
    rid = round_id_from_log()
    if not rid:
        return
    try:
        st = req("GET", "/v1/training/state")
        r = next((x for x in st.get("rounds", []) if x.get("id") == rid), None)
        if not r or r.get("status") != "running":
            return
        # The last checkpoint is on the hub when one was uploaded as it went; then the retry continues from it.
        tail = log_tail(30)
        uploaded = "checkpoint handed to the hub" in tail
        last = [ln for ln in tail.splitlines() if ln.strip()][-6:]
        req("POST", f"/v1/training/rounds/{rid}/end", {"status": "failed",
            "why": (f"the trainer process died on this node with exit code {code}: " + " | ".join(last))[:400],
            **({"adapter": f"hub:{rid}-last"} if uploaded else {})})
        say(f"round {rid} died with exit code {code} — reported to the hub")
    except Exception as e:
        print(f"watch: {e}", flush=True)


def run_round(body):
    p = ROUND["proc"]
    if p and p.poll() is None:
        return {"started": False, "error": "a round is still running on this node"}
    try:
        fetch_scripts()
    except Exception as e:
        return {"started": False, "error": f"could not fetch the round scripts: {e}"}
    cmd = [sys.executable, os.path.join(HOME, "train_round.py"),
           "--data", os.path.join(HOME, "data"), "--out", os.path.join(HOME, "rounds"),
           "--hours", str(body.get("hours", 6))]
    base = str(body.get("base") or "")
    if base:
        cmd += ["--adapter", base]
    # A round that continues from an adapter is given a smaller step by the hub; the trainer's own
    # default stands when nothing is sent.
    lr = body.get("lr")
    if lr:
        cmd += ["--lr", str(lr)]
    # A STUDENT TRIAL. The hub names a candidate and asks for a measurement only; the trainer then
    # claims no turns and writes no adapter. Both are ignored by an ordinary round.
    model = str(body.get("model") or "")
    if model:
        cmd += ["--model", model]
    if body.get("measureOnly"):
        cmd += ["--measure-only"]
    # BIGGER STUDENTS TRAIN IN BFLOAT16. float32 is right for the half-billion incumbent and about
    # thirty gigabytes for a Gemma; the card holds twenty-four. Off unless the hub asks.
    if body.get("bf16"):
        cmd += ["--bf16"]
    env = dict(os.environ, GB_HUB=HUB, GB_TOKEN=TOKEN, GB_DEVICE=NAME, GB_CKPT_HUB="1",
               PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
    # The trainer's lines go to the round log AND to this process's stdout, so a session's own
    # log view (Modal's Logs tab) shows the training as it goes and the traceback when it dies.
    logf = open(os.path.join(HOME, "last-round.log"), "wb")
    # A first line the moment the round starts, so an empty log means the tee never ran rather than
    # leaving nobody able to tell that from a trainer that printed nothing.
    logf.write(("starting: " + " ".join(cmd) + os.linesep).encode("utf-8", "replace"))
    logf.flush()
    ROUND["proc"] = subprocess.Popen(cmd, cwd=HOME, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, start_new_session=True)
    ROUND["started"] = time.time()
    ROUND["log"] = logf

    def tee(proc, fh):
        # Two destinations, two guards. A detached session's stdout is a pipe nobody reads and it
        # can break at any line; when it did, the one exception took the FILE down with it and the
        # round log stayed empty for the whole run. Neither destination may end the other.
        try:
            for line in iter(proc.stdout.readline, b""):
                try:
                    fh.write(line)
                    fh.flush()
                except Exception:
                    pass
                try:
                    sys.stdout.write(line.decode("utf-8", "replace"))
                    sys.stdout.flush()
                except Exception:
                    pass
        except Exception:
            pass
        finally:
            try:
                fh.close()
            except Exception:
                pass
    threading.Thread(target=tee, args=(ROUND["proc"], logf), daemon=True).start()
    LAST_WORK["at"] = time.time()
    threading.Thread(target=watch, args=(ROUND["proc"],), daemon=True).start()
    say(f"started a training round ({body.get('hours', 6)}h) on {gpu_name() or 'no GPU'}")
    return {"started": True}


def stop_round(body):
    p = ROUND["proc"]
    n = 0
    if p and p.poll() is None:
        try:
            import signal
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            n += 1
        except Exception:
            try:
                p.kill()
                n += 1
            except Exception:
                pass
        try:
            p.wait(timeout=10)
        except Exception:
            pass
    say(f"round {body.get('round', '')} stopped by the owner — {n} trainer process(es) ended")
    return {"stopped": n > 0, "processes": n}


def export_model(body):
    script = os.path.join(HOME, "export_model.py")
    if not os.path.isfile(script):
        return {"started": False, "error": "the export script is not here"}
    conv = os.path.join(HOME, "tools", "llama.cpp", "convert_hf_to_gguf.py")
    if not os.path.isfile(conv):
        setup()
    if not os.path.isfile(conv):
        return {"started": False, "error": "no gguf converter on this node"}
    cmd = [sys.executable, script, "--adapter", str(body.get("adapter", "")), "--tag", str(body.get("tag", "")),
           "--round", str(body.get("roundId", "")), "--hub", HUB, "--token", TOKEN]
    if body.get("base"):
        cmd += ["--base", str(body["base"])]
    logf = open(os.path.join(HOME, "last-export.log"), "wb")
    p = subprocess.Popen(cmd, cwd=HOME, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=dict(os.environ, PYTHONUNBUFFERED="1"))
    EXPORT["proc"] = p

    def watch_export(proc, fh):
        # An export that ran detached and said nothing left a promoted round with no model and no
        # reason. Its lines go to this session's log and its end is reported like a round's.
        tail = []
        try:
            for line in iter(proc.stdout.readline, b""):
                fh.write(line)
                fh.flush()
                s = line.decode("utf-8", "replace").rstrip()
                tail = (tail + [s])[-8:]
                sys.stdout.write(s + "\n")
                sys.stdout.flush()
        except Exception:
            pass
        code = proc.wait()
        LAST_WORK["at"] = time.time()
        try:
            fh.close()
        except Exception:
            pass
        say(f"export of {body.get('tag', '')} {'done' if code == 0 else f'FAILED ({code}): ' + ' | '.join(tail)[-300:]}")
    threading.Thread(target=watch_export, args=(p, logf), daemon=True).start()
    LAST_WORK["at"] = time.time()
    return {"started": True}


def exec_path(path, body):
    if path == "/v1/train_status":
        return status()
    if path == "/v1/train_round":
        return run_round(body)
    if path == "/v1/train_stop":
        return stop_round(body)
    if path == "/v1/train_export":
        return export_model(body)
    if path == "/v1/train_log":
        return {"lines": log_tail(int(body.get("lines", 80) or 80))}
    if path == "/v1/info_device":
        return {"platform": "cluster", "name": NAME, "node": KIND, "gpu": gpu_name()}
    if path == "/v1/train_setup":
        setup()
        return {"started": False, "status": status()}
    return {"error": f"a training node does not do {path}"}


def main():
    print(f"Ghost Browser training node '{NAME}' ({KIND}) → {HUB}", flush=True)
    setup()
    if not register():
        print("could not register with the hub — giving up", flush=True)
        return 2
    say(f"online — {gpu_name() or 'no GPU'}, {free_gb()} GB free")
    last_register = time.time()
    while True:
        # LEAVE WHEN IDLE, WHATEVER THE HUB SAYS. A rented session costs while it lives; a node
        # that could not reach the hub for a quarter of an hour with nothing running leaves too.
        busy = (ROUND["proc"] is not None and ROUND["proc"].poll() is None) or (EXPORT["proc"] is not None and EXPORT["proc"].poll() is None)
        if not busy and IDLE_EXIT > 0 and time.time() - LAST_WORK["at"] > IDLE_EXIT:
            say(f"nothing asked for {IDLE_EXIT // 60} min — leaving to save the session")
            return 0
        # The hub forgets every device when its pod rolls: register again every five minutes
        # whatever the poll says, and at once when the poll answers with an HTTP error.
        if time.time() - last_register > 300:
            try:
                req("POST", "/v1/device/register", {"deviceId": DEVICE, "name": NAME, "caps": caps()})
            except Exception:
                pass
            last_register = time.time()
        try:
            raw = req("GET", f"/v1/device/poll?deviceId={urllib.parse.quote(DEVICE)}", raw=True, timeout=90)
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404, 410):
                print(f"poll: {e.code} — registering again", flush=True)
                register()
                last_register = time.time()
            time.sleep(3)
            continue
        except Exception:
            time.sleep(3)
            continue
        text = raw.decode("utf-8", "replace").strip() if raw else ""
        if not text or text == "null":
            continue
        try:
            o = json.loads(text)
        except Exception:
            time.sleep(1.5)
            continue
        if "id" not in o:
            if "register first" in text or "not connected" in text:
                register()
            else:
                time.sleep(1.5)
            continue
        cid = o.get("id")
        path = o.get("path", "/v1/info")
        body = o.get("body") or {}
        try:
            out = exec_path(path, body)
        except Exception as e:
            out = {"error": str(e)}
        try:
            req("POST", "/v1/device/result", {"deviceId": DEVICE, "id": cid, "status": 200, "body": json.dumps(out)})
        except Exception as e:
            print(f"result: {e}", flush=True)
        if path != "/v1/train_status":
            LAST_WORK["at"] = time.time()


if __name__ == "__main__":
    sys.exit(main() or 0)
