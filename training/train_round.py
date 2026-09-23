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
import json
import os
import random
import re
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict

import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig, get_peft_model

import subprocess
import sys
import tempfile


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
    tail = []
    for line in proc.stdout:
        line = line.rstrip()
        tail = (tail + [line])[-12:]
        if "/" in line and "agreement" in line:
            note(line.strip())
    proc.wait()
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

    def start(self, base_model, turns):
        got = self._post("/v1/training/rounds", {"device": self.device, "base": base_model, "turns": turns})
        self.round_id = (got or {}).get("id")
        print(f"round {self.round_id or '(local only)'} on {self.device}", flush=True)
        return self.round_id

    def note(self, line):
        """One line of progress. Printed always, sent when there is somewhere to send it."""
        print(f"  {line}", flush=True)
        if self.round_id:
            self._post(f"/v1/training/rounds/{self.round_id}/note", {"line": line})

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
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            print(f"  [could not fetch {path}: {e}]", flush=True)
            return -1
        rows = [l for l in data.split(chr(10)) if l.strip()]
        os.makedirs(os.path.dirname(into), exist_ok=True)
        with open(into, "w", encoding="utf-8") as fh:
            fh.write(chr(10).join(rows))
        return len(rows)

    def end(self, status, baseline, result, adapter, why="", trained=0, drawSeed=None):
        if self.round_id:
            self._post(f"/v1/training/rounds/{self.round_id}/end", {
                "status": status, "baseline": baseline, "result": result, "adapter": adapter,
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


def stratified(lines, budget, seed=None):
    """Take `budget` turns without letting the loud tools take all of them.

    The raw distribution is dominated by a handful of tools — `open` and `read` alone are a third of
    every call ever made. Sampling that distribution straight into a small round produces a model
    that is excellent at opening pages and has seen `finish` four times, which is the failure that
    hides inside a good average: it never stops working.

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

    rnd = random.Random(seed)
    for tool in by_tool:
        rnd.shuffle(by_tool[tool])
        by_tool[tool].sort(key=lambda p: p[0])   # gold first, shuffled within tier

    picked, tools = [], sorted(by_tool, key=lambda t: len(by_tool[t]))
    i = 0
    # Round-robin: every tool gets its first example before any tool gets its second.
    while len(picked) < budget:
        took = False
        for t in tools:
            if i < len(by_tool[t]):
                picked.append(by_tool[t][i][1])
                took = True
                if len(picked) >= budget:
                    break
        if not took:
            break
        i += 1
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
        keep, dropped = [], 0
        for r in rows:
            m = r["messages"]
            prompt = tok.apply_chat_template(m[:2], tokenize=False, add_generation_prompt=True)
            if len(tok(prompt, add_special_tokens=False)["input_ids"]) >= max_len - 4:
                dropped += 1
                continue
            keep.append(r)
        if dropped:
            note(f"dropped {dropped} turn(s) too long to keep their answer at {max_len} tokens")
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
    ap.add_argument("--eval-turns", type=int, default=150)
    ap.add_argument("--max-len", type=int, default=2048, help="every answer must survive truncation; see Turns")
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--lr", type=float, default=1e-4)
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
        want = max(200, int(args.hours * 3600 / 12))
        got = hub.fetch(f"/v1/training/slice?turns={want}", train_path)
        if got > 0:
            print(f"the controller handed over {got} turns", flush=True)
        ev = hub.fetch(f"/v1/training/evalslice?turns={args.eval_turns}", eval_path)
        if ev > 0:
            print(f"and {ev} turns to score on", flush=True)

    if not os.path.isfile(train_path):
        print(f"no turns to train on at {train_path}")
        return 2

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
    hub.start(args.model, len(all_rows))

    # ── what the model scores before we touch it ─────────────────────────────────────────────────
    #
    # Measured FIRST, and in another process, with nothing loaded here. A freshly wrapped LoRA is
    # mathematically the base model (its B matrices start at zero), so measuring the base is exactly
    # measuring this round's starting point — no model needs to exist in this process yet.
    baseline = None
    if not args.skip_baseline:
        baseline = measure(args.model, args.adapter, eval_path, args.eval_turns, hub.note)
        if baseline:
            hub.note(f"before: {baseline['agreement_pct']}% agreement over {baseline['turns']} turns")

    # sdpa asks for memory-efficient attention rather than the maths path that materialises the
    # whole attention matrix. On CPU it is not guaranteed, which is why checkpointing below is the
    # load-bearing fix and this is only the cheap half.
    model = AutoModelForCausalLM.from_pretrained(args.model, dtype=torch.float32,
                                                 attn_implementation="sdpa")
    if args.adapter:
        # Carrying on from the serving adapter rather than starting over: each night is a small
        # step from where the model already is, which is what makes this a loop and not a series of
        # unrelated experiments.
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, args.adapter, is_trainable=True)
        print(f"continuing from {args.adapter}", flush=True)
    else:
        model = get_peft_model(model, LoraConfig(
            r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
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
    # Deliberately generous: the sampler is cheap and the time budget is what actually stops the
    # round. Taking too few turns wastes the night; taking too many costs nothing but a list.
    # Sized to the night with headroom, not to the corpus. The time budget is what actually stops
    # the round; taking far more than can be reached only costs memory.
    want = max(200, int(budget_s / 12))
    draw_seed = args.seed if args.seed is not None else int(time.time())
    rows = stratified(all_rows, budget=min(len(all_rows), want), seed=draw_seed)
    hub.note(f"drew {min(len(all_rows), want)} turns with seed {draw_seed}")
    del all_rows
    print(f"round will draw on {len(rows)} turns", flush=True)
    ds = Turns(rows, tok, args.max_len, note=hub.note)
    dl = DataLoader(ds, batch_size=args.batch, shuffle=False,
                    collate_fn=lambda b: collate(b, tok.pad_token_id))
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)

    adapter_dir = os.path.join(out_dir, "adapter")
    model.train()
    started = time.time()
    seen, skipped, losses, tool_seen = 0, 0, [], Counter()
    last_note = started
    last_save = started
    stopped_because = "the time budget ran out"

    for ids, labels, mask in dl:
        if time.time() - started > budget_s:
            break
        out = model(input_ids=ids, attention_mask=mask, labels=labels)
        # Even with the filter above, one NaN reaching backward() destroys every LoRA weight for the
        # rest of the night, and nothing downstream would say so — the round would report turns,
        # minutes and a loss, and hand back an adapter of NaN. Cheap to check, catastrophic to miss.
        if not torch.isfinite(out.loss):
            skipped += 1
            opt.zero_grad()
            continue
        out.loss.backward()
        opt.step()
        opt.zero_grad()
        seen += ids.shape[0]
        losses.append(float(out.loss.item()))

        # A line every few minutes: often enough that a status page is never silent, rare enough
        # that a night does not become forty thousand rows of history.
        # ── SAVE AS IT GOES ─────────────────────────────────────────────────────────────────────
        #
        # Three rounds have died with SIGSEGV and the cause is still not known. An unknown crash in
        # hour five of a seven-hour round should cost the remaining two hours, not all seven — and
        # an adapter trained on four hundred turns is a real result, while an empty directory is
        # not. Saving is seconds: the adapter is 8.6 MB, not the model.
        if time.time() - last_save > 1800:
            try:
                model.save_pretrained(adapter_dir)
                hub.note(f"saved the adapter at {seen} turns")
            except Exception as e:
                hub.note(f"could not save mid-round: {e}")
            last_save = time.time()

        if seen == 3 or time.time() - last_note > 300:
            el = time.time() - started
            recent = sum(losses[-40:]) / len(losses[-40:])
            left = max(0, budget_s - el)
            # Memory is reported because it is what kills this process, and a number that is
            # climbing is the only warning there will be — a segfault leaves no traceback.
            rss = ""
            try:
                import psutil
                rss = f", {psutil.Process().memory_info().rss / 1e9:.1f} GB"
            except Exception:
                rss = ""
            hub.note(f"{seen} turns, loss {recent:.3f}, {el/60:.0f} min in, about {left/60:.0f} min left{rss}")
            last_note = time.time()
    else:
        stopped_because = "every turn in the round was used"

    elapsed = time.time() - started
    hub.note(f"trained on {seen} turns in {elapsed/60:.0f} min — {stopped_because}"
             + (f" ({skipped} skipped as unusable)" if skipped else ""))

    model.save_pretrained(adapter_dir)

    # ── and what it scores now ───────────────────────────────────────────────────────────────────
    # The adapter is on disk by now, so the round's product survives even if this measurement does
    # not. Same seed, same split, same count as the baseline — the comparison is the whole point.
    hub.note("measuring the trained model on the same turns")
    del model, opt, dl, ds
    result = measure(args.model, adapter_dir, eval_path, args.eval_turns, hub.note)
    if not result:
        hub.note("the after-measurement did not complete — the adapter is saved and unmeasured")
        hub.end("done", baseline, None, adapter_dir, "trained, but not measured", trained=seen, drawSeed=draw_seed)
        return 0

    won = baseline is not None and result["agreement_pct"] > baseline["agreement_pct"]
    why = (f"{result['agreement_pct']}% against {baseline['agreement_pct']}%"
           if baseline else f"{result['agreement_pct']}% (no baseline taken)")
    hub.note(f"after: {why} — {'better' if won else 'NOT better'}")

    summary = {
        "round": stamp, "device": hub.device, "base": args.model, "carriedFrom": args.adapter,
        "drawSeed": draw_seed,
        "turnsTrained": seen, "minutes": round(elapsed / 60, 1), "stoppedBecause": stopped_because,
        "meanLoss": round(sum(losses) / len(losses), 4) if losses else None,
        "baseline": baseline, "result": result, "adapter": adapter_dir, "beat": bool(won),
    }
    with open(os.path.join(out_dir, "round.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=1)

    hub.end("done", baseline, result, adapter_dir, why, trained=seen, drawSeed=draw_seed)
    print(json.dumps({k: v for k, v in summary.items() if k not in ("baseline", "result")}, indent=1))
    print(f"\nadapter: {adapter_dir}")
    print("Promotion is a separate step on the controller, and it refuses a round that did not win.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
