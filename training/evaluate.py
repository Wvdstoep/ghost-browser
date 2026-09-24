"""
evaluate.py — DOES THE MODEL PICK THE TOOL THE GOOD RUN PICKED?

The one number that matters, and the reason it is this number rather than another:

  - Format is already solved. Across 72,673 recorded calls the current cloud model produced ONE
    unknown tool name and 28 calls missing a required argument. Measuring "is the JSON valid" would
    be spending an evening to learn nothing.
  - What actually fails is CHOICE and TIMING: 108 clicks on an index that went stale, 19 navigations
    to a URL the model truncated, and the constant question of when to stop.

So the score is agreement with the gold trajectory on the tool name, measured on turns the model has
never seen — the evaluation split was cut by JOB before any turn was made, so no job contributes to
both sides.

WHAT THIS SCORE IS NOT. A disagreement is not always a mistake: two tools can both be reasonable at
the same moment, and the gold run only shows one path that worked. So the number is a floor on
capability, not a ceiling, and it is only meaningful COMPARED — stock against fine-tuned, on exactly
the same turns. An absolute figure here means very little on its own.

Reported per tool as well as overall, because an average hides the thing worth knowing: a model that
is excellent at `look` and hopeless at `finish` averages out fine and never stops working.
"""
import argparse
import json
import os
import random
import sys as _sys
import time
from collections import Counter, defaultdict


# ── MAKE torch LOADABLE WHEN THE BROWSER IS WHAT STARTED US (see train_round.py) ────────────────
#
# The scorer runs in a process the round starts, which is a process the browser started, so it
# inherits whatever makes `import torch` fail there: c10.dll refuses to load under the search flags
# torch itself uses, and only under those. Loading it first, under rules that work, leaves it
# resident and torch's own attempt then succeeds. Measured, and a no-op where the import already
# works — but it has to be HERE too, or the round trains for six hours and then cannot score itself.
def _preload_torch_libs():
    if os.name != "nt":
        return
    try:
        import ctypes
        from ctypes import wintypes
        lib = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(_sys.executable)),
                                            "..", "Lib", "site-packages", "torch", "lib"))
        if not os.path.isdir(lib):
            return
        try:
            os.add_dll_directory(lib)
        except Exception:
            pass
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.LoadLibraryExW.restype = wintypes.HMODULE
        k32.LoadLibraryExW.argtypes = [wintypes.LPCWSTR, wintypes.HANDLE, wintypes.DWORD]
        p = os.path.join(lib, "c10.dll")
        if not os.path.isfile(p):
            return
        for flags in (0x00000800, 0x00001000, 0x00000000):
            ctypes.set_last_error(0)
            if k32.LoadLibraryExW(p, None, flags):
                return
    except Exception:
        pass


_preload_torch_libs()


def load(path, limit=None, seed=7):
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
    if limit and limit < len(rows):
        # Deterministic, so stock and fine-tuned are scored on the SAME turns. Comparing two models
        # on two different samples measures the sample.
        random.Random(seed).shuffle(rows)
        rows = rows[:limit]
    return rows


def expected_tool(row):
    try:
        return json.loads(row["messages"][2]["content"])["tool"]
    except Exception:
        return None


def predicted_tool(text):
    """The tool name out of whatever the model said, however untidily it said it."""
    if not text:
        return None
    start = text.find("{")
    if start < 0:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if esc:
            esc = False
            continue
        if c == "\\" and in_str:
            esc = True
            continue
        if c == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(text[start:i + 1])
                except Exception:
                    return None
                t = obj.get("tool") or obj.get("name")
                return t if isinstance(t, str) else None
    return None


def _collapse(said, per_tool, total):
    """How far the model's loudest answer is from how often that answer is correct.

    1.0 means it says each tool about as often as it should. Tonight's round came out near 3.6 on
    `look`, which is a model that has stopped reading the page and started guessing the cheapest
    token. Reported rather than judged here - what counts as too far is the controller's business,
    and it lives in the promotion gate where the reasoning can be read."""
    if not total or not said:
        return {}
    tool, n = said.most_common(1)[0]
    share = n / total
    seen = (per_tool.get(tool) or [0, 0])[1]
    should = (seen / total) if total else 0
    return {
        "tool": tool,
        "said_pct": round(100 * share, 1),
        "correct_pct": round(100 * should, 1),
        "ratio": round(share / should, 2) if should else None,
        "distinct": len(said),
    }


def score(model_id, adapter=None, data=r"D:\gb-train\data\eval.jsonl", limit=300, max_new=48,
          model_obj=None, tok=None, trainable=False, note=print):
    """Agreement with the gold trajectory, as a plain dict.

    `model_obj` lets a caller hand in a model it already has in memory — the training round scores
    the same object before and after, which is not merely faster: loading the base a second time to
    take the "before" measurement would silently use a DIFFERENT object than the one about to be
    trained, and any difference between them lands in the result as if it were progress.

    A freshly wrapped LoRA is mathematically the base model (its B matrices start at zero), so the
    before-measurement is honest without unwrapping anything.
    """
    import torch

    rows = load(data, limit)
    note(f"scoring {len(rows)} turns from {data}")

    if model_obj is None:
        from transformers import AutoModelForCausalLM, AutoTokenizer
        tok = tok or AutoTokenizer.from_pretrained(model_id)
        model_obj = AutoModelForCausalLM.from_pretrained(model_id, dtype=torch.float32)
        if adapter:
            from peft import PeftModel
            model_obj = PeftModel.from_pretrained(model_obj, adapter)
            note(f"adapter: {adapter}")

    was_training = model_obj.training
    model_obj.eval()

    hits = 0
    unusable = 0
    per_tool = defaultdict(lambda: [0, 0])   # expected -> [right, seen]
    confusion = Counter()
    # ── WHAT IT ACTUALLY SAID, which nothing recorded until now ─────────────────────────────────
    #
    # per_tool counts what was EXPECTED and whether the answer was right. That cannot see the one
    # failure that matters most. The first round to finish this path scored 15.33% against a 3.33%
    # baseline and reported beat: true, and the model was answering `look` to almost everything:
    # scroll -> look, open -> look, read -> look, run_script -> look, finish -> look. `look` is the
    # right answer on 10% of the paper and it gave it at least 36% of the time.
    #
    # Mode collapse is what a small adapter does when one answer is much cheaper to produce than
    # the others - {"tool":"look","args":{}} is the shortest string in the set, and with prompt
    # tokens masked the quickest way to cut loss is to always say it. It reads as progress in every
    # headline number: agreement rises because the cheap answer is also a common one, and unusable
    # FALLS because the model has learnt to emit valid JSON. Both improved tonight.
    #
    # So count the predictions themselves. A gate cannot refuse what nobody measured.
    said = Counter()
    started = time.time()

    for i, row in enumerate(rows):
        want = expected_tool(row)
        if not want:
            continue
        prompt = tok.apply_chat_template(row["messages"][:2], tokenize=False, add_generation_prompt=True)
        ids = tok(prompt, return_tensors="pt", truncation=True, max_length=4096)
        with torch.no_grad():
            out = model_obj.generate(**ids, max_new_tokens=max_new, do_sample=False,
                                     pad_token_id=tok.eos_token_id)
        text = tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)
        got = predicted_tool(text)
        if got is None:
            unusable += 1
        said[got or "(nothing usable)"] += 1
        per_tool[want][1] += 1
        if got == want:
            hits += 1
            per_tool[want][0] += 1
        else:
            confusion[f"{want} -> {got}"] += 1
        if (i + 1) % 25 == 0:
            rate = (i + 1) / (time.time() - started)
            note(f"  {i+1}/{len(rows)}  agreement {100*hits/(i+1):.1f}%  {rate:.2f} turns/s")

    # Left exactly as it was found: scoring a model mid-round must not quietly leave it in eval mode
    # and turn the rest of the night into a no-op.
    if was_training and trainable:
        model_obj.train()

    total = sum(n for _, n in per_tool.values())
    return {
        "model": model_id,
        "adapter": adapter,
        "turns": total,
        "agreement_pct": round(100 * hits / total, 2) if total else 0,
        "unusable_pct": round(100 * unusable / total, 2) if total else 0,
        "seconds": round(time.time() - started, 1),
        "per_tool": {k: {"right": v[0], "seen": v[1], "pct": round(100 * v[0] / v[1], 1)}
                     for k, v in sorted(per_tool.items(), key=lambda kv: -kv[1][1])},
        "top_confusions": confusion.most_common(12),
        # What it said, and how far the loudest answer is from how often it is actually right.
        # Scale-free on purpose: a paper with 32 tools and one with 8 are not comparable by share
        # alone, but "it says this 3.6 times more often than it should" is.
        "said": dict(said.most_common(12)),
        "collapse": _collapse(said, per_tool, total),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="a HF model id or a local path")
    ap.add_argument("--adapter", default=None, help="a LoRA adapter to apply on top")
    ap.add_argument("--data", default=r"D:\gb-train\data\eval.jsonl")
    ap.add_argument("--limit", type=int, default=300)
    ap.add_argument("--max-new", type=int, default=48)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    result = score(args.model, adapter=args.adapter, data=args.data,
                   limit=args.limit, max_new=args.max_new)
    print(json.dumps(result, indent=1))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=1)
        print(f"written to {args.out}")


if __name__ == "__main__":
    main()
