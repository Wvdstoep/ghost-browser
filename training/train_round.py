"""
train_round.py — ONE NIGHT'S TRAINING ROUND, ON WHICHEVER MACHINE IS AWAKE.

This is the half of the nightly loop that does not run on the cluster. The controller builds the set
and holds the history; a device with a CPU to spare trains, measures, and reports back. Which device
does not matter, and that is the point: it is registered as work, it says what it is doing while it
works, and it hands back a number that can be compared with the number before it.

THREE DECISIONS THAT ARE NOT OBVIOUS, AND WHY THEY ARE MADE THIS WAY.

1. THE ROUND IS BUDGETED IN HOURS, NOT EPOCHS.
   The devices are not alike. On the laptop this was written for, one epoch over the full set is a
   measured 155 hours; on a machine with a GPU it is minutes. "One epoch" therefore means nothing
   that can be scheduled. "Train until morning, then measure and stop" means the same thing on
   every device, and it is what actually has to be true for a ring of mixed hardware. The script
   measures its own speed on the first examples and takes as many as fit.

2. IT MEASURES BEFORE AND AFTER, ON THE SAME TURNS.
   The number that matters is not what the new adapter scores, it is whether it beats what was there
   before. Both measurements use the same seed over the same evaluation split, which was cut BY JOB
   so no job contributes to both training and scoring. A round that cannot show a win is a round
   that gets recorded and not promoted.

3. IT NEVER PROMOTES ITSELF.
   Finishing is not winning. The device reports the two numbers and stops; putting the adapter into
   service is a separate, explicit act on the controller, which refuses anything that did not beat
   its own baseline. A script that promoted its own output would eventually serve a worse model on
   the strength of being the most recent thing to finish.

Usage:
  python train_round.py --data D:\\gb-train\\data --hours 8
  python train_round.py --data ... --hours 8 --hub https://gb.example --token XXX --device laptop-carla
"""
import argparse
import io
import json
import os
import sys as _sys
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

# ── MAKE torch LOADABLE WHEN THE BROWSER IS WHAT STARTED US ─────────────────────────────────────
#
# Measured, not guessed. A round dispatched by the engine died instantly at `import torch`:
#
#   OSError: [WinError 1114] A dynamic link library (DLL) initialization routine failed.
#   Error loading "...	orch\lib\c10.dll" or one of its dependencies.
#
# The same import from a shell takes 176 seconds and succeeds. The environment the browser hands
# down is byte-identical to a working shell's apart from the four variables it sets itself; the child
# is in no job object and under no process mitigation; and a plain JVM spawning it the same way works.
# So the difference is not torch, not the venv, not the environment and not the spawn.
#
# Loading each of torch's own libraries by hand, from inside the process the browser started, under
# three different search rules, found it exactly:
#
#                      browser-started child      shell
#   c10.dll  0x1100          WinError 1114        loaded     <- the flags torch itself uses
#   c10.dll  0x0800          loaded               loaded
#   c10.dll  0x0000          loaded               loaded
#   every other lib          loaded               loaded
#
# One file, and only under LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS —
# which is the one rule set that searches neither PATH nor the current directory. So c10.dll is
# reachable and its dependencies are resolvable; they are simply not all resolvable under those
# flags in this process.
#
# LoadLibrary is reference-counted and idempotent: a module already resident is handed straight back.
# So loading c10.dll here, under rules that DO work, means torch's own attempt a moment later finds
# it loaded and carries on. torch is not patched, nothing is copied, and on a machine where the
# import already works this is a no-op that costs a millisecond.
def _preload_torch_libs():
    if os.name != "nt":
        return "not windows"
    try:
        import ctypes
        from ctypes import wintypes
        lib = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(_sys.executable)),
                                            "..", "Lib", "site-packages", "torch", "lib"))
        if not os.path.isdir(lib):
            return "no torch/lib at %s" % lib
        # Puts torch/lib into the DEFAULT_DIRS search set, which is what torch's own flags consult.
        try:
            os.add_dll_directory(lib)
        except Exception:
            pass
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.LoadLibraryExW.restype = wintypes.HMODULE
        k32.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
        done = []
        for name in ("c10.dll",):
            p = os.path.join(lib, name)
            if not os.path.isfile(p):
                done.append("%s missing" % name)
                continue
            # System32 first, then default dirs, then the old PATH-searching rules. The first that
            # works wins; the point is only that the module ends up resident.
            for flags in (0x00000800, 0x00001000, 0x00000000):
                ctypes.set_last_error(0)
                if k32.LoadLibraryExW(p, None, flags):
                    done.append("%s loaded with %s" % (name, hex(flags)))
                    break
            else:
                done.append("%s could not be loaded under any rules" % name)
        return done
    except Exception as e:
        return repr(e)


# The browser sits in a Windows JOB OBJECT and a child it starts inherits that job. A job can cap
# the memory a process may commit, and torch commits several hundred megabytes of DLL while it
# initialises — which fails as WinError 1114, the same error a genuinely broken DLL gives. Asked
# from inside the child, because that is the only process that is actually in the job.
def _job_limits():
    try:
        import ctypes
        from ctypes import wintypes
        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                        ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD),
                        ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t),
                        ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t),
                        ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]
        class IOC(ctypes.Structure):
            _fields_ = [("ReadOperationCount", ctypes.c_uint64), ("WriteOperationCount", ctypes.c_uint64),
                        ("OtherOperationCount", ctypes.c_uint64), ("ReadTransferCount", ctypes.c_uint64),
                        ("WriteTransferCount", ctypes.c_uint64), ("OtherTransferCount", ctypes.c_uint64)]
        class EXT(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", IOC),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        in_job = wintypes.BOOL()
        k32.IsProcessInJob(k32.GetCurrentProcess(), None, ctypes.byref(in_job))
        info = EXT()
        ok = k32.QueryInformationJobObject(None, 9, ctypes.byref(info), ctypes.sizeof(info), None)
        flags = info.BasicLimitInformation.LimitFlags
        return {"in_job": bool(in_job), "queried": bool(ok),
                "limit_flags": hex(flags),
                "process_memory_limit": info.ProcessMemoryLimit,
                "job_memory_limit": info.JobMemoryLimit,
                "peak_process_memory": info.PeakProcessMemoryUsed,
                "active_process_limit": info.BasicLimitInformation.ActiveProcessLimit,
                "breakaway_ok": bool(flags & 0x00000800),
                "silent_breakaway_ok": bool(flags & 0x00001000),
                "caps_process_memory": bool(flags & 0x00000100),
                "caps_job_memory": bool(flags & 0x00000200)}
    except Exception as e:
        return {"error": repr(e)}


# ── WHAT THIS PROCESS WAS HANDED, WRITTEN DOWN BEFORE THE FIRST HEAVY IMPORT ────────────────────
#
# A round dispatched by the engine died at `import torch` with WinError 1114 — the DLL loaded, its
# initialisation routine did not. The same import run from a shell takes 176 seconds and succeeds,
# and a Java process spawning it exactly the way the desktop node does also succeeds. So the
# difference is not torch, not the venv, and not the spawn: it is something in the environment the
# browser hands down, and the only way to see that environment is from inside a child it started.
#
# The preload is the FIX and stands on its own line: it must not be a side effect of writing a
# diagnostic file. An earlier version called it from inside the json.dump argument list, which meant
# a full disk or a locked file would have quietly skipped the one thing that makes the import work.
_PRELOADED = _preload_torch_libs()

# The record of what this process was handed. Cheap, always on, overwritten each round, and never
# fatal: a round must not die because it could not write a note about itself.
try:
    _env = {k: v for k, v in os.environ.items() if "TOKEN" not in k.upper() and "KEY" not in k.upper()}
    with io.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "round-env.json"),
                 "w", encoding="utf-8") as _fh:
        json.dump({"executable": _sys.executable, "cwd": os.getcwd(),
                   "path": _env.get("PATH", ""), "env": _env, "syspath": _sys.path,
                   "job_limits": _job_limits(), "preload": _PRELOADED}, _fh, indent=1)
except Exception:
    pass

import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig, get_peft_model

import subprocess
import sys
import tempfile


# The exam subprocess while one runs, so a stop can end it with its parent.
EXAM_CHILD = None


def measure(model_id, adapter, data, limit, note=print):
    """Score a model in a SEPARATE PROCESS, and read the answer back as JSON.

    Not an optimisation — a correctness fix. Doing the measurement in this process and then training
    in the same one segfaults reproducibly on CPU: a hundred-odd generate() calls leave the
    allocator in a state the first backward pass does not survive. Both attempts at this round died
    at exactly that transition, one silently with status zero, one with SIGSEGV, in each case after
    the baseline had been computed and printed.

    A fresh process cannot inherit that state. It also means a crash while measuring costs only the
    measurement: by the time the second one runs, the adapter is already saved to disk.
    """
    out = os.path.join(tempfile.gettempdir(), f"gb-eval-{os.getpid()}-{int(time.time())}.json")
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    cmd = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "evaluate.py"),
           "--model", model_id, "--data", data, "--limit", str(limit), "--out", out]
    if adapter:
        cmd += ["--adapter", adapter]
    note(f"measuring in a separate process ({limit} turns)")
    # Streamed, not captured. Capturing means the parent learns nothing until the child exits, and a
    # measurement takes twenty-five minutes on this hardware — so the status page would sit on one
    # line for half an hour, which is the silence this whole surface exists to remove. Only the
    # progress lines are forwarded; the child also prints the full JSON, which belongs in the file.
    # UTF-8 explicitly, and never fatal on a stray byte. Windows defaults a child pipe to cp1252,
    # which died on the first non-ASCII byte the scorer printed — inside subprocess's reader THREAD,
    # so the parent carried on none the wiser and simply had no stderr to show. A measurement that
    # fails would then report nothing about why, which is the one moment the text is worth having.
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace", bufsize=1, env=env)
    global EXAM_CHILD
    EXAM_CHILD = proc
    tail = []
    for line in proc.stdout:
        line = line.rstrip()
        tail = (tail + [line])[-12:]
        if "/" in line and "agreement" in line:
            note(line.strip())
    proc.wait()
    EXAM_CHILD = None
    if proc.returncode != 0:
        note(f"measurement failed ({proc.returncode}): {' | '.join(tail)[-200:]}")
        return None
    try:
        with open(out, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except OSError:
        note("measurement produced no result file")
        return None
    finally:
        try:
            os.remove(out)
        except OSError:
            pass


# ── talking to the controller ────────────────────────────────────────────────────────────────────

class Hub:
    """The controller, or nothing at all.

    A round must run when the hub is unreachable — the training is the valuable part and a status
    page being down is not a reason to waste a night. So every call here is best-effort and failure
    is printed, never raised."""

    def __init__(self, base, token, device):
        self.base = (base or "").rstrip("/")
        self.token = token or ""
        self.device = device or os.environ.get("COMPUTERNAME") or "unknown"
        self.round_id = None

    def _post(self, path, body):
        if not self.base:
            return None
        req = urllib.request.Request(
            f"{self.base}{path}",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            print(f"  [hub unreachable: {e}]", flush=True)
            return None

    def start(self, base_model, turns, recipe=None):
        # The recipe travels with the round. Two rounds are comparable only if the recipe is, and
        # a number on a screen with no recipe beside it is a number nobody can reproduce.
        got = self._post("/v1/training/rounds", {"device": self.device, "base": base_model, "turns": turns,
                                                 "recipe": recipe or {}})
        self.round_id = (got or {}).get("id")
        print(f"round {self.round_id or '(local only)'} on {self.device}", flush=True)
        return self.round_id

    def check(self, point):
        """One validation point: {step, turns, valLoss, trainLoss, best, lr}. The curve the screen draws."""
        if self.round_id:
            self._heed(self._post(f"/v1/training/rounds/{self.round_id}/check", point))

    def note(self, line):
        """One line of progress. Printed always, sent when there is somewhere to send it."""
        print(f"  {line}", flush=True)
        if self.round_id:
            self._heed(self._post(f"/v1/training/rounds/{self.round_id}/note", {"line": line}))

    def _heed(self, got):
        """The hub answers every note; `stop` means the owner ended this round. Leave now: the exam
        child first, then this process, with status 0 so the machine reports no crash."""
        if isinstance(got, dict) and got.get("stop"):
            print("  stopped by the owner — leaving the round", flush=True)
            global EXAM_CHILD
            child = EXAM_CHILD
            if child is not None:
                try:
                    child.kill()
                except Exception:
                    pass
            raise SystemExit(0)

    def fetch(self, path, into):
        """Pull a file from the controller. Returns the number of lines written, or -1.

        THE DEVICE NEVER RECEIVES THE WHOLE SET. It is 141 MB, a round reaches about seven hundred
        turns of it, and a laptop with four gigabytes free has to be able to take a round too. The
        controller draws the slice and hands over only that — which also makes two machines' slices
        disjoint, where two machines sampling independently would overlap and the second one would
        add almost nothing, silently.
        """
        if not self.base:
            return -1
        req = urllib.request.Request(f"{self.base}{path}", headers={"Authorization": f"Bearer {self.token}"})
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = r.read().decode("utf-8", "replace")
                # The answer's headers say which paper this is (X-Exam-Paper) - kept for the baseline.
                self._headers = {k.lower(): v for k, v in r.headers.items()}
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            print(f"  [could not fetch {path}: {e}]", flush=True)
            return -1
        rows = [l for l in data.split(chr(10)) if l.strip()]
        os.makedirs(os.path.dirname(into), exist_ok=True)
        with open(into, "w", encoding="utf-8") as fh:
            fh.write(chr(10).join(rows))
        return len(rows)

    def last_header(self, name):
        return str((getattr(self, "_headers", {}) or {}).get(name.lower(), "") or "")

    def baseline_known(self, scope, start, paper, turns):
        # GET /v1/training/baseline: the number the hub already has for this start on this paper.
        return self.baseline_ask(scope, start, paper, turns)[0]

    def baseline_ask(self, scope, start, paper, turns):
        """(baseline or None, measure: whether THIS machine is the one to measure it, by: who is).
        The first machine asking for an unknown number claims it; the others train at once and take
        the number at their end. Without a hub, or without a paper, this machine measures."""
        if not paper or not self.base:
            return None, True, ""
        try:
            q = urllib.parse.urlencode({"scope": scope, "base": start, "paper": paper, "turns": turns, "device": self.device})
            req = urllib.request.Request(f"{self.base}/v1/training/baseline?{q}", headers={"Authorization": f"Bearer {self.token}"})
            with urllib.request.urlopen(req, timeout=30) as r:
                out = json.loads(r.read().decode("utf-8"))
            b = out.get("baseline") if out.get("known") else None
            b = b if b and "agreement_pct" in b else None
            return b, (True if b is None and out.get("measure", True) else False), str(out.get("by") or "")
        except Exception:
            return None, True, ""

    def baseline_tell(self, scope, start, paper, turns, baseline):
        if not paper:
            return
        try:
            self._post("/v1/training/baseline", {"scope": scope, "base": start, "paper": paper, "turns": turns, "baseline": baseline})
        except Exception:
            pass

    def upload_adapter(self, adapter_dir):
        # The best adapter, as one tgz, to PUT /v1/training/rounds/<id>/adapter - tens of MB.
        if not (self.base and self.round_id and os.path.isdir(adapter_dir)):
            return
        try:
            import tarfile, io as _io
            buf = _io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tf:
                for f in os.listdir(adapter_dir):
                    tf.add(os.path.join(adapter_dir, f), arcname=f)
            data = buf.getvalue()
            req = urllib.request.Request(f"{self.base}/v1/training/rounds/{self.round_id}/adapter", data=data, method="PUT",
                                         headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/gzip", "Content-Length": str(len(data))})
            with urllib.request.urlopen(req, timeout=1800) as r:
                r.read()
            print(f"adapter handed to the hub as hub:{self.round_id} ({len(data) / 1e6:.0f} MB)", flush=True)
        except Exception as e:
            print(f"[the adapter stays here only: {e}]", flush=True)

    def end(self, status, baseline, result, adapter, why="", trained=0, drawSeed=None, paper=""):
        if self.round_id:
            self._post(f"/v1/training/rounds/{self.round_id}/end", {
                "status": status, "baseline": baseline, "result": result, "adapter": adapter,
                # The paper it sat, so the hub can hold it to what serves on the same paper.
                "paper": paper or "",
                "why": why,
                # What it TRAINED, not what was available to it. Coverage is summed from this, and
                # summing the other number would report the corpus finished after one night.
                "trained": trained, "drawSeed": drawSeed,
            })


# ── choosing what to train on ────────────────────────────────────────────────────────────────────

# A turn's tool and tier, read off the raw line without building the whole object. The training
# file is 141 MB; parsing all of it into Python dicts to decide which two thousand rows to keep
# costs gigabytes, and paying that beside an fp32 model is what killed the first attempt at this
# round — silently, with an exit code of zero.
_TOOL = re.compile(r'\{\\"tool\\":\\"([a-z_]+)\\"')
_GOLD = '"tier":"gold"'


def label_of(line):
    m = _TOOL.search(line)
    return (m.group(1) if m else None), (_GOLD in line or '"tier": "gold"' in line)


# A rare tool still has to appear often enough to be learnable at all, and a common one must not
# be allowed to become the answer to everything. Same two numbers the hub's slice builder uses —
# they are here rather than imported because the two live on different machines, and the one thing
# worse than one sampler is two that quietly disagree.
FLOOR = 4          # every tool present in the corpus gets at least this many
CAP_SHARE = 0.15   # and none may take more than this fraction of the round


def stratified(lines, budget, seed=None):
    """Take `budget` turns, keeping the shape of the real distribution but trimming its extremes.

    WHAT THIS REPLACED, AND WHY IT HAD TO GO.

    The first version dealt round-robin: every tool got its first example before any tool got its
    second. That does not trim the distribution, it ERASES it — forty tools come out with roughly
    equal weight, so a model is taught that `save_keywords` and `open` are equally likely next
    moves when the truth is 9.5% against 18.7%. Round one ran that sampler and scored 20% against a
    5% baseline, which reads as a win until the per-tool numbers are read: save_keywords 8/8 and
    sweep 2/2 carried almost the whole gain, while `read` went 1/15 -> 0/15 and `look` 1/11 -> 0/11.
    It had not learnt to browse. It had learnt the rare tools, because the sampler made them common.

    So: PROPORTIONAL, with a floor under the rare tools and a cap over the loud ones. A tool that is
    a fifth of real work stays roughly a fifth of the round, `finish` is guaranteed to show up
    enough times to be learnable, and nothing may take more than CAP_SHARE of the draw.

    Gold is preferred over silver inside each tool, because gold means something outside the agent's
    own report agreed the work happened.

    THE SEED MOVES BETWEEN ROUNDS, AND THAT IS NOT A DETAIL.

    It used to be fixed at 7, which meant every round drew the SAME turns. Chaining ten rounds
    would then show the model one identical slice ten times — overfitting to three percent of the
    corpus while the round counter went up and the loss obligingly fell. Nothing would have looked
    wrong. The evaluation seed stays fixed, deliberately and separately, because that is what makes
    two rounds comparable at all; it is only the TRAINING draw that has to move.

    Works on INDICES into the raw lines, and parses only what it keeps."""
    if seed is None:
        seed = int(time.time())
    by_tool = defaultdict(list)
    for i, line in enumerate(lines):
        tool, gold = label_of(line)
        if tool:
            by_tool[tool].append((0 if gold else 1, i))
    if not by_tool:
        return []

    rnd = random.Random(seed)
    for tool in by_tool:
        rnd.shuffle(by_tool[tool])
        by_tool[tool].sort(key=lambda p: p[0])   # gold first, shuffled within tier

    total = sum(len(v) for v in by_tool.values())
    cap = max(FLOOR, int(budget * CAP_SHARE))

    # The share each tool has earned, then clamped. A tool with fewer examples than its share simply
    # gives the remainder back — it cannot invent turns it does not have.
    want = {}
    for tool, rows in by_tool.items():
        share = int(round(budget * len(rows) / total))
        want[tool] = min(len(rows), max(FLOOR, min(cap, share)))

    # Clamping moves the total off `budget` in either direction, so settle the difference against
    # the tools that still have rows left, largest first — which is where the extra turns belong.
    order = sorted(by_tool, key=lambda t: -len(by_tool[t]))
    while sum(want.values()) > budget:
        for tool in reversed(order):
            if sum(want.values()) <= budget:
                break
            if want[tool] > 1:
                want[tool] -= 1
    while sum(want.values()) < budget:
        moved = False
        for tool in order:
            if sum(want.values()) >= budget:
                break
            if want[tool] < min(len(by_tool[tool]), cap):
                want[tool] += 1
                moved = True
        if not moved:
            break

    picked = []
    for tool, n in want.items():
        picked.extend(i for _, i in by_tool[tool][:n])
    rnd.shuffle(picked)
    return [json.loads(lines[j]) for j in picked]


class Turns(Dataset):
    """Prompt tokens are masked out of the loss.

    The model is scored on its answer, not on reciting the tool catalogue back. That is standard for
    instruction tuning and it matters more than usual here: the prompt is roughly twenty times the
    length of the answer, so without masking almost all of the gradient would be spent teaching the
    model to reproduce a block of text that is handed to it anyway."""

    def __init__(self, rows, tok, max_len, note=print):
        """
        TURNS WHOSE ANSWER WOULD BE TRUNCATED AWAY ARE DROPPED, NOT TRAINED ON.

        Truncation cuts the END, and the end is the answer. A turn whose prompt already fills
        max_len therefore arrives with every label masked — nothing to predict — and the loss comes
        back NaN. backward() on NaN writes NaN into the adapter, and from that moment the round is
        producing a model made of NaN while still reporting turns and minutes as though it were
        working. Two rounds scored 0.0% after training for exactly this reason.

        It is not hypothetical arithmetic: at max_len 1792 it was 4.9% of this set. And it is about
        to get worse rather than better, because look now records the numbered list and prompts are
        growing. So the length is chosen to lose nothing AND the ones that would be lost are
        removed, because the next thing to make prompts longer should not silently poison a round.
        """
        """
        ...AND NOW THEY ARE FITTED INSTEAD. The first round on sighted data dropped 152 of its 200
        turns at 2048 tokens - three quarters of the slice, and the sighted ones at that. The window
        is 4096 and a prompt that still does not fit loses its oldest observations first and the
        end of its latest page last (evaluate.fit_messages), so the answer always has a prompt in
        front of it and no turn is thrown away for being the kind of turn a round exists to learn.
        """
        from evaluate import fit_messages
        keep, cut = [], 0
        for r in rows:
            m = r["messages"]
            fitted, was_cut = fit_messages(tok, m, max_len, answer_tokens=96)
            if was_cut:
                cut += 1
            keep.append({**r, "messages": [fitted[0], fitted[1], m[2]]})
        if cut:
            note(f"shortened {cut} turn(s) to fit {max_len} tokens (oldest observations first) — none dropped")
        self.rows, self.tok, self.max_len = keep, tok, max_len

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        m = self.rows[i]["messages"]
        prompt = self.tok.apply_chat_template(m[:2], tokenize=False, add_generation_prompt=True)
        full = prompt + m[2]["content"] + self.tok.eos_token
        p_ids = self.tok(prompt, add_special_tokens=False)["input_ids"]
        f_ids = self.tok(full, add_special_tokens=False)["input_ids"][: self.max_len]
        labels = list(f_ids)
        for j in range(min(len(p_ids), len(labels))):
            labels[j] = -100
        return {"input_ids": f_ids, "labels": labels}


def collate(batch, pad):
    n = max(len(b["input_ids"]) for b in batch)
    ids, labels, mask = [], [], []
    for b in batch:
        k = n - len(b["input_ids"])
        ids.append(b["input_ids"] + [pad] * k)
        labels.append(b["labels"] + [-100] * k)
        mask.append([1] * len(b["input_ids"]) + [0] * k)
    return torch.tensor(ids), torch.tensor(labels), torch.tensor(mask)


def load_jsonl(path, limit=None):
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
            if limit and len(rows) >= limit:
                break
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=r"D:\gb-train\data", help="folder holding train.jsonl and eval.jsonl")
    ap.add_argument("--out", default=r"D:\gb-train\rounds")
    ap.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    ap.add_argument("--adapter", default=None, help="carry on from this adapter instead of the bare base")
    ap.add_argument("--hours", type=float, default=8.0, help="how long this device may spend training")
    ap.add_argument("--eval-turns", type=int, default=None,
                    help="exam size; 150 on a CPU (an exam costs 25 minutes there), 500 on a GPU")
    ap.add_argument("--max-len", type=int, default=4096, help="a sighted turn is ~2,700 tokens; 4096 fits nine in ten, the rest are fitted (see Turns)")
    ap.add_argument("--batch", type=int, default=1)
    # ── THE RECIPE ───────────────────────────────────────────────────────────────────────────────
    # Two rounds ran with a flat 1e-4, batch 1, no warm-up, no schedule, no shuffle, and never saw
    # an example twice. Both collapsed. Each of these is the ordinary fix for one of those.
    ap.add_argument("--lr", type=float, default=2e-4, help="peak; 5%% linear warm-up then cosine to a tenth")
    ap.add_argument("--epochs", type=float, default=3.0, help="passes over the slice; --hours is the ceiling, not the plan")
    ap.add_argument("--accum", type=int, default=16, help="gradient accumulation: effective batch = batch x accum")
    ap.add_argument("--warmup", type=float, default=0.05, help="share of the planned steps spent warming up")
    ap.add_argument("--lora-r", type=int, default=32)
    ap.add_argument("--lora-alpha", type=int, default=64)
    ap.add_argument("--lora-scope", choices=["attn", "all"], default="all",
                    help="attn = q/k/v/o only; all = attention and the MLP, where a page-to-tool mapping lives")
    ap.add_argument("--bf16", action="store_true", help="bfloat16 on a GPU; ignored on CPU")
    ap.add_argument("--cpu", action="store_true", help="stay on the CPU even when a GPU is present")
    ap.add_argument("--slice", type=int, default=None, help="turns to ask the controller for; default fits the hours")
    ap.add_argument("--validate-every", type=float, default=60.0,
                    help="minutes between validation checks on CPU; on a GPU every 200 optimiser steps")
    ap.add_argument("--validate-turns", type=int, default=64, help="held-out turns the validation loss is taken on")
    ap.add_argument("--patience", type=int, default=3, help="validation checks without improvement before stopping")
    ap.add_argument("--no-fetch", action="store_true",
                    help="use the local set instead of asking the controller for a slice")
    ap.add_argument("--seed", type=int, default=None,
                    help="fix the TRAINING draw for a reproducible round; omit so each round sees new turns")
    ap.add_argument("--threads", type=int, default=6, help="measured best on the first trainer; 8 was slower")
    ap.add_argument("--hub", default=os.environ.get("GB_HUB", ""))
    ap.add_argument("--token", default=os.environ.get("GB_TOKEN", ""))
    ap.add_argument("--device-name", default=os.environ.get("GB_DEVICE", ""))
    ap.add_argument("--skip-baseline", action="store_true",
                    help="only when the baseline for this exact base and eval split is already known")
    args = ap.parse_args()

    torch.set_num_threads(args.threads)
    hub = Hub(args.hub, args.token, args.device_name)

    # Where and in what. A GPU makes the same round a few minutes; bf16 only means anything there.
    use_cuda = torch.cuda.is_available() and not args.cpu
    device = torch.device("cuda" if use_cuda else "cpu")
    if args.eval_turns is None:
        args.eval_turns = 500 if use_cuda else 150
    dtype = torch.bfloat16 if (args.bf16 and use_cuda) else torch.float32
    targets = (["q_proj", "k_proj", "v_proj", "o_proj"] if args.lora_scope == "attn"
               else ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    recipe = {
        "base": args.model, "device": "cuda" if use_cuda else "cpu", "dtype": str(dtype).replace("torch.", ""),
        "loraR": args.lora_r, "loraAlpha": args.lora_alpha, "loraScope": args.lora_scope,
        "lr": args.lr, "warmup": args.warmup, "schedule": "cosine",
        "epochs": args.epochs, "batch": args.batch, "accum": args.accum, "maxLen": args.max_len,
        "hoursCeiling": args.hours, "validateTurns": args.validate_turns, "patience": args.patience,
    }

    train_path = os.path.join(args.data, "train.jsonl")
    eval_path = os.path.join(args.data, "eval.jsonl")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = os.path.join(args.out, f"round-{stamp}")
    os.makedirs(out_dir, exist_ok=True)

    tok = AutoTokenizer.from_pretrained(args.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    # ── how much fits in the night ───────────────────────────────────────────────────────────────
    # ── GET THIS ROUND'S WORK FROM THE CONTROLLER ────────────────────────────────────────────────
    #
    # The controller owns the draw: it knows what every other round has already taken, so slices do
    # not overlap and coverage of the corpus is counted rather than estimated. Falling back to a
    # local file keeps a round possible on a machine that has the set already, which is how this was
    # developed — but the hub path is the one that works on a laptop that has never seen the data.
    if not args.no_fetch and hub.base:
        # A CPU round reaches about a hundred turns an hour (measured: 641 turns in six hours, and
        # 34 seconds a turn on the smoke run) and wants its epochs over what it draws, so the slice
        # is sized to be seen `epochs` times inside the hours. A GPU round is not bound by the clock
        # and takes a full slice.
        # A sighted turn is ~2,700 tokens and takes about 100 s a pass on this CPU - forty an hour, not
        # a hundred. The controller's gate uses the same figure.
        want = args.slice or (10000 if use_cuda else max(120, int(args.hours * 40 / args.epochs)))
        who = urllib.parse.quote(hub.device or "")
        got = hub.fetch(f"/v1/training/slice?turns={want}&device={who}", train_path)
        if got > 0:
            print(f"the controller handed over {got} turns", flush=True)
        ev = hub.fetch(f"/v1/training/evalslice?turns={args.eval_turns}&device={who}", eval_path)
        if ev > 0:
            print(f"and {ev} turns to score on", flush=True)
        paper_id = hub.last_header("x-exam-paper")
        paper_scope = hub.last_header("x-exam-scope") or "base"

    if not os.path.isfile(train_path):
        print(f"no turns to train on at {train_path}")
        return 2

    # ── AN ADAPTER THAT LIVES ON THE HUB ─────────────────────────────────────────────────────────
    # A rented machine hands its adapter back to the hub as its last act, and the next round - on
    # any machine - chains from it by name. `hub:<name>` is fetched into ./adapters/<name> here.
    def fetch_hub_adapter(name):
        # `hub:<name>` fetched into ./adapters/<name>; the directory, or None when the hub has none.
        into = os.path.join(args.out, "adapters", name)
        if os.path.isfile(os.path.join(into, "adapter_config.json")):
            return into
        import tarfile
        os.makedirs(into, exist_ok=True)
        tgz = into + ".tgz"
        req = urllib.request.Request(f"{hub.base}/v1/training/adapters/{name}", headers={"Authorization": f"Bearer {hub.token}"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r, open(tgz, "wb") as fh:
                for chunk in iter(lambda: r.read(1 << 20), b""):
                    fh.write(chunk)
            with tarfile.open(tgz, "r:gz") as tf:
                tf.extractall(into)
            print(f"fetched adapter {name} from the hub", flush=True)
            return into
        except Exception as e:
            print(f"could not fetch adapter {name} from the hub ({e})", flush=True)
            return None

    # ── TWO HALVES INTO ONE ──────────────────────────────────────────────────────────────────────
    # `merge:hub:a,hub:b`: two machines trained the two halves of one slice from the same start;
    # this round averages their adapters weight for weight, trains nothing, and takes the exam
    # once. Averaging two LoRA adapters trained from one starting point on disjoint data is the
    # plain federated average, and on a CPU it is the one way two laptops make one model faster
    # without touching what a turn carries.
    merge_names = []
    if args.adapter and str(args.adapter).startswith("merge:") and hub.base:
        merge_names = [x.strip()[4:] if x.strip().startswith("hub:") else x.strip() for x in str(args.adapter)[6:].split(",") if x.strip()]
        dirs = [fetch_hub_adapter(n) for n in merge_names]
        if len(dirs) < 2 or any(d is None for d in dirs):
            print("merge: not every half is on the hub — nothing to merge", flush=True)
            return 2
        import shutil
        from safetensors.torch import load_file, save_file
        merged = os.path.join(args.out, "adapters", "merged-" + "-".join(n[-4:] for n in merge_names) + "-" + str(int(time.time())))
        os.makedirs(merged, exist_ok=True)
        shutil.copy(os.path.join(dirs[0], "adapter_config.json"), os.path.join(merged, "adapter_config.json"))
        tensors = [load_file(os.path.join(d, "adapter_model.safetensors")) for d in dirs]
        keys = set(tensors[0].keys())
        for tt in tensors[1:]:
            if set(tt.keys()) != keys:
                print("merge: the halves have different shapes — they were not trained from one start", flush=True)
                return 2
        avg = {k: (sum(tt[k].float() for tt in tensors) / len(tensors)).to(tensors[0][k].dtype) for k in keys}
        save_file(avg, os.path.join(merged, "adapter_model.safetensors"))
        print(f"merged {len(dirs)} adapters into {merged}", flush=True)
        args.adapter = merged
        args.epochs = 0.0
        recipe["merged"] = merge_names
    elif args.adapter and str(args.adapter).startswith("hub:") and hub.base:
        got = fetch_hub_adapter(str(args.adapter)[4:].strip())
        if got is None:
            print("starting from the base", flush=True)
        args.adapter = got

    # Raw lines only. 141 MB of text is fine to hold; 141 MB parsed into dicts, beside a model, is
    # not — and the failure mode is the process simply disappearing.
    with open(train_path, "r", encoding="utf-8") as fh:
        all_rows = [ln for ln in (l.strip() for l in fh) if ln]
    print(f"{len(all_rows)} turns available", flush=True)
    if not all_rows:
        print("nothing to train on")
        return 2

    # The round is registered once there is something to report about — before the model is loaded,
    # because the baseline runs elsewhere and this process should hold nothing while it does.
    hub.start(args.model, len(all_rows), recipe)

    # ── what the model scores before we touch it ─────────────────────────────────────────────────
    #
    # Measured FIRST, and in another process, with nothing loaded here. A freshly wrapped LoRA is
    # mathematically the base model (its B matrices start at zero), so measuring the base is exactly
    # measuring this round's starting point — no model needs to exist in this process yet.
    baseline = None
    baseline_deferred = False
    if merge_names:
        # The halves measured their common start on this paper already; the merged adapter is
        # measured AGAINST that, never against itself.
        try:
            req = urllib.request.Request(f"{hub.base}/v1/training/state", headers={"Authorization": f"Bearer {hub.token}"})
            with urllib.request.urlopen(req, timeout=60) as r:
                rows = json.loads(r.read().decode("utf-8")).get("rounds", [])
            for row in rows:
                if row.get("id") in merge_names and row.get("baseline") is not None:
                    baseline = {"agreement_pct": float(row["baseline"]), "turns": args.eval_turns, "from": row.get("id")}
                    hub.note(f"merge: the shares scored their start at {baseline['agreement_pct']}% — measuring the average against that")
                    break
            if baseline is None:
                # The shares' own rows carry no number (a share ended unmeasured): the hub's cache
                # keyed by the shares' start does - the members' start is the same for all of them.
                start_of = ""
                for row in rows:
                    if row.get("id") in merge_names:
                        start_of = str(row.get("base") or "")
                        break
                known = hub.baseline_known(paper_scope, start_of, paper_id, args.eval_turns)
                if known:
                    baseline = dict(known, **{"from": "hub"})
                    hub.note(f"merge: the hub knows the start at {baseline['agreement_pct']}% on this paper — measuring the average against that")
        except Exception as e:
            hub.note(f"merge: could not read the shares' baseline ({e})")
    elif not args.skip_baseline:
        # ONCE PER START, NOT ONCE PER ROUND - AND ONCE PER BATCH, NOT ONCE PER SHARE. The same
        # start on the same paper scores the same; the hub keeps the number and a round asks before
        # it spends forty minutes measuring. Of the shares of one batch, the first to ask measures;
        # the others are told who has it, train at once, and take the number at their end.
        start_name = str(args.adapter or "")
        known, measure_me, by = hub.baseline_ask(paper_scope, start_name, paper_id, args.eval_turns)
        if known:
            baseline = known
            hub.note(f"before: {baseline['agreement_pct']}% agreement over {baseline.get('turns', args.eval_turns)} turns — known from an earlier round on this paper, not measured again")
        elif measure_me:
            baseline = measure(args.model, args.adapter, eval_path, args.eval_turns, hub.note)
            if baseline and hub.base:
                hub.baseline_tell(paper_scope, start_name, paper_id, args.eval_turns, baseline)
            if baseline:
                hub.note(f"before: {baseline['agreement_pct']}% agreement over {baseline['turns']} turns")
        else:
            baseline_deferred = True
            hub.note(f"before: {by} is measuring this start on this paper — training now, the number is taken at the end")

    # sdpa asks for memory-efficient attention rather than the maths path that materialises the
    # whole attention matrix. On CPU it is not guaranteed, which is why checkpointing below is the
    # load-bearing fix and this is only the cheap half.
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=dtype,
                                                 attn_implementation="sdpa").to(device)
    if args.adapter:
        # Carrying on from the serving adapter rather than starting over: each night is a small
        # step from where the model already is, which is what makes this a loop and not a series of
        # unrelated experiments. The adapter's own shape wins over the flags here.
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, args.adapter, is_trainable=True)
        print(f"continuing from {args.adapter}", flush=True)
    else:
        model = get_peft_model(model, LoraConfig(
            r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=0.05, task_type="CAUSAL_LM",
            target_modules=targets,
        ))
    model.print_trainable_parameters()

    # ── THE REASON THREE ROUNDS DIED WITH A SEGFAULT ────────────────────────────────────────────
    #
    # Backward needs the activations forward produced, and for this model at the prompt lengths in
    # this set that is enormous: 24 layers x 14 heads x ~1800^2 x 4 bytes is about 4.3 GB of
    # attention probabilities alone, before the MLP intermediates. One long example was exhausting a
    # machine with 10 GB free, and the process did not raise MemoryError — it died with SIGSEGV, at a
    # different step each time depending on where the long examples happened to fall in the shuffle.
    # That is why it looked like the eval-to-training transition twice and was never that at all.
    #
    # Checkpointing stores the layer boundaries and recomputes the rest during backward. Memory
    # stops scaling with depth, at the cost of one extra forward pass (~30% slower). On a round
    # budgeted in hours rather than epochs, 30% slower is simply 30% fewer turns — and a round that
    # finishes beats a round that is 30% faster and segfaults.
    model.gradient_checkpointing_enable()
    # LoRA freezes the base, so nothing upstream of the adapters would otherwise require grad and
    # the recomputed graph would come back empty.
    model.enable_input_require_grads()

    # ── train ────────────────────────────────────────────────────────────────────────────────────
    budget_s = args.hours * 3600
    # The slice is what the controller handed over (or the local file); the draw below only
    # re-balances it. The plan is EPOCHS over that slice, and the hours are the ceiling.
    want = len(all_rows)
    draw_seed = args.seed if args.seed is not None else int(time.time())
    torch.manual_seed(draw_seed)
    rows = stratified(all_rows, budget=min(len(all_rows), want), seed=draw_seed)
    hub.note(f"drew {min(len(all_rows), want)} turns with seed {draw_seed}")
    del all_rows
    print(f"round will draw on {len(rows)} turns", flush=True)
    ds = Turns(rows, tok, args.max_len, note=hub.note)
    # SHUFFLED. The slice arrives grouped by tool, and a loader that walks it in order feeds the
    # optimiser forty `open` turns, then forty `read` turns: each group drags the adapter toward
    # its own tool and the last group wins. That is one of the ways the first rounds collapsed.
    gen = torch.Generator()
    gen.manual_seed(draw_seed)
    dl = DataLoader(ds, batch_size=args.batch, shuffle=True, generator=gen,
                    collate_fn=lambda b: collate(b, tok.pad_token_id))
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr, weight_decay=0.0)

    # ── THE SCHEDULE ─────────────────────────────────────────────────────────────────────────────
    # Warm up over the first few percent of the planned steps, then cosine down to a tenth of the
    # peak. `total` is a one-element list because the plan is revised once the machine's real
    # speed is known: on a CPU the hours usually cut the epochs short, and a cosine that expected
    # 600 steps and got 120 never left its warm-up. The lambda reads the list, so revising it is
    # one assignment and the curve re-shapes itself around the steps that will actually happen.
    import math
    per_epoch = max(1, math.ceil(len(ds) / (args.batch * args.accum)))
    total = [max(1, int(round(args.epochs * per_epoch)))]

    def lr_at(step):
        warm = max(1, int(total[0] * args.warmup))
        if step < warm:
            return (step + 1) / warm
        prog = min(1.0, (step - warm) / max(1, total[0] - warm))
        return 0.1 + 0.9 * 0.5 * (1.0 + math.cos(math.pi * prog))

    sched = torch.optim.lr_scheduler.LambdaLR(opt, lr_at)
    hub.note(f"plan: {args.epochs:g} epoch(s) over {len(ds)} turns = {total[0]} steps of {args.batch * args.accum}, "
             f"peak lr {args.lr:g}, r={args.lora_r} on {args.lora_scope}, {recipe['device']} {recipe['dtype']}")

    # ── VALIDATION, AND WHY IT IS A LOSS AND NOT AN EXAM ────────────────────────────────────────
    # The exam (generate, compare the tool) takes twenty-five minutes on this CPU, so it can only
    # be taken twice a round. A teacher-forced loss over a few dozen held-out turns takes two
    # minutes, runs in this process (forward only, no generate, so none of the allocator trouble
    # that killed the in-process exams), and moves in step with the exam score. It is what says
    # WHEN to stop and WHICH checkpoint to keep; the exam at the end still says how good it is.
    val_ds = None
    if os.path.isfile(eval_path) and args.validate_turns > 0:
        val_rows = load_jsonl(eval_path, limit=args.validate_turns)
        if val_rows:
            val_ds = Turns(val_rows, tok, args.max_len, note=lambda _s: None)

    def val_loss():
        if val_ds is None or len(val_ds) == 0:
            return None
        model.eval()
        tot, n = 0.0, 0
        with torch.no_grad():
            for i in range(len(val_ds)):
                ids, labels, mask = collate([val_ds[i]], tok.pad_token_id)
                out = model(input_ids=ids.to(device), attention_mask=mask.to(device), labels=labels.to(device))
                if torch.isfinite(out.loss):
                    tot += float(out.loss.item())
                    n += 1
        model.train()
        return (tot / n) if n else None

    adapter_dir = os.path.join(out_dir, "adapter")          # the BEST checkpoint — what gets measured
    last_dir = os.path.join(out_dir, "adapter-last")        # the most recent one, for a crash
    model.train()
    started = time.time()
    seen, skipped, losses = 0, 0, []
    step, micro = 0, 0
    last_note = started
    last_save = started
    last_val = started
    best, best_at, checks, bad = None, 0, 0, 0
    replanned = False
    max_turns = int(args.epochs * len(ds))
    stopped_because = "the time budget ran out"

    def save_best():
        model.save_pretrained(adapter_dir)

    def check_now(final=False):
        nonlocal best, best_at, checks, bad
        v = val_loss()
        if v is None:
            return False
        checks += 1
        improved = best is None or v < best - 1e-4
        if improved:
            best, best_at, bad = v, seen, 0
            save_best()
        else:
            bad += 1
        recent = (sum(losses[-40:]) / len(losses[-40:])) if losses else None
        hub.check({"step": step, "turns": seen, "valLoss": round(v, 4),
                   "trainLoss": (round(recent, 4) if recent is not None else None),
                   "best": bool(improved), "lr": round(sched.get_last_lr()[0], 7)})
        hub.note(f"check {checks}: validation loss {v:.3f}"
                 + (" — best so far, kept" if improved else f" (best {best:.3f} at {best_at} turns, {bad} without gain)")
                 + (" — final" if final else ""))
        return improved

    done = False
    for epoch in range(max(1, math.ceil(args.epochs))):
        if done:
            break
        for ids, labels, mask in dl:
            if time.time() - started > budget_s:
                done = True
                break
            if seen >= max_turns:
                stopped_because = f"{args.epochs:g} epoch(s) done"
                done = True
                break
            ids, labels, mask = ids.to(device), labels.to(device), mask.to(device)
            out = model(input_ids=ids, attention_mask=mask, labels=labels)
            # Even with the filter above, one NaN reaching backward() destroys every LoRA weight
            # for the rest of the night, and nothing downstream would say so. Cheap to check.
            if not torch.isfinite(out.loss):
                skipped += 1
                continue
            (out.loss / args.accum).backward()
            micro += 1
            seen += ids.shape[0]
            losses.append(float(out.loss.item()))

            if micro % args.accum == 0:
                torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
                opt.step()
                sched.step()
                opt.zero_grad()
                step += 1

                # Re-plan once the real speed is known: how many steps fit in the hours left.
                if not replanned and step >= 2:
                    per_turn = (time.time() - started) / max(1, seen)
                    reach = step + int((budget_s - (time.time() - started)) / per_turn / (args.batch * args.accum))
                    if reach < total[0]:
                        hub.note(f"at {per_turn:.1f}s a turn the hours allow {reach} of {total[0]} planned steps — schedule shortened")
                        total[0] = max(step + 1, reach)
                    replanned = True

                due = (step % 200 == 0) if use_cuda else (time.time() - last_val > args.validate_every * 60)
                if due:
                    check_now()
                    last_val = time.time()
                    if bad >= args.patience:
                        stopped_because = f"validation stopped improving ({args.patience} checks)"
                        done = True
                        break

            # ── SAVE AS IT GOES ─────────────────────────────────────────────────────────────────
            # An unknown crash in hour five should cost the remaining hours, not all of them. The
            # last state goes to its own directory so it can never overwrite the best one.
            if time.time() - last_save > 1800:
                try:
                    model.save_pretrained(last_dir)
                    hub.note(f"saved the latest adapter at {seen} turns")
                except Exception as e:
                    hub.note(f"could not save mid-round: {e}")
                last_save = time.time()

            if seen == 3 or time.time() - last_note > 300:
                el = time.time() - started
                recent = sum(losses[-40:]) / len(losses[-40:])
                left = max(0, budget_s - el)
                rss = ""
                try:
                    import psutil
                    rss = f", {psutil.Process().memory_info().rss / 1e9:.1f} GB"
                except Exception:
                    rss = ""
                # "step 0/24" at thirteen turns read as a stall on the screen. A step is one optimizer
                # update every batch*accum turns, so say how far into the next one this is, and how
                # many turn-passes of the whole plan are done.
                per_step = max(1, args.batch * args.accum)
                into = max(0, min(per_step, seen - step * per_step))
                hub.note(f"{seen}/{len(ds) * int(math.ceil(args.epochs))} turn-passes · epoch {epoch + 1}/{args.epochs:g} · "
                         f"step {step}/{total[0]} ({into}/{per_step} turns into the next) · loss {recent:.3f} · "
                         f"lr {sched.get_last_lr()[0]:.2e} · {el/60:.0f} min in, about {left/60:.0f} min left{rss}")
                last_note = time.time()
        else:
            if epoch + 1 >= math.ceil(args.epochs) and not done:
                stopped_because = f"{args.epochs:g} epoch(s) done"

    # Whatever is left in the accumulator is a real gradient; apply it rather than throw it away.
    if micro % args.accum != 0:
        torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
        opt.step()
        opt.zero_grad()
        step += 1

    elapsed = time.time() - started
    hub.note(f"trained on {seen} turns in {elapsed/60:.0f} min over {step} step(s) — {stopped_because}"
             + (f" ({skipped} skipped as unusable)" if skipped else ""))

    # The last state is checked too: a round that stopped on the clock may have ended on its best
    # weights, and if it did not, the best checkpoint on disk is the one that gets measured.
    if val_ds is not None and not merge_names:
        hub.note(f"final check: validation loss over {len(val_ds)} held-out turn(s) — a few minutes, then the exam")
        check_now(final=True)
    if best is None:
        save_best()
    else:
        hub.note(f"keeping the checkpoint with validation loss {best:.3f} (at {best_at} turns) for the exam")

    # ── and what it scores now ───────────────────────────────────────────────────────────────────
    # The adapter is on disk by now, so the round's product survives even if this measurement does
    # not. Same seed, same split, same count as the baseline — the comparison is the whole point.
    hub.note("measuring the trained model on the same turns")
    del model, opt, dl, ds
    if baseline_deferred:
        # The other share measured the start while this one trained; its number is on the hub by
        # now. If it never arrived (that machine died), this one measures the start itself: the
        # comparison is the whole point and it is not skipped.
        start_name = str(args.adapter or "")
        baseline = hub.baseline_known(paper_scope, start_name, paper_id, args.eval_turns)
        if baseline:
            hub.note(f"before: {baseline['agreement_pct']}% agreement over {baseline.get('turns', args.eval_turns)} turns — measured by the other share")
        else:
            hub.note("the other share's number never arrived — measuring the start now")
            baseline = measure(args.model, args.adapter, eval_path, args.eval_turns, hub.note)
            if baseline and hub.base:
                hub.baseline_tell(paper_scope, start_name, paper_id, args.eval_turns, baseline)
            if baseline:
                hub.note(f"before: {baseline['agreement_pct']}% agreement over {baseline['turns']} turns")
    result = measure(args.model, adapter_dir, eval_path, args.eval_turns, hub.note)
    if not result:
        hub.note("the after-measurement did not complete — the adapter is saved and unmeasured")
        hub.end("done", baseline, None, adapter_dir, "trained, but not measured", trained=seen, drawSeed=draw_seed, paper=paper_id)
        return 0

    won = baseline is not None and result["agreement_pct"] > baseline["agreement_pct"]
    why = (f"{result['agreement_pct']}% against {baseline['agreement_pct']}%"
           if baseline else f"{result['agreement_pct']}% (no baseline taken)")
    hub.note(f"after: {why} — {'better' if won else 'NOT better'}")

    summary = {
        "round": stamp, "device": hub.device, "base": args.model, "carriedFrom": args.adapter,
        "drawSeed": draw_seed, "recipe": recipe, "steps": step,
        "bestValLoss": (round(best, 4) if best is not None else None), "bestAtTurns": best_at,
        "turnsTrained": seen, "minutes": round(elapsed / 60, 1), "stoppedBecause": stopped_because,
        "meanLoss": round(sum(losses) / len(losses), 4) if losses else None,
        "baseline": baseline, "result": result, "adapter": adapter_dir, "beat": bool(won),
    }
    with open(os.path.join(out_dir, "round.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=1)

    hub.end("done", baseline, result, adapter_dir, why, trained=seen, drawSeed=draw_seed, paper=paper_id)
    hub.upload_adapter(adapter_dir)
    print(json.dumps({k: v for k, v in summary.items() if k not in ("baseline", "result")}, indent=1))
    print(f"\nadapter: {adapter_dir}")
    print("Promotion is a separate step on the controller, and it refuses a round that did not win.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
