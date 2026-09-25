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
import re
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


# ── MAKE THE PROMPT FIT, NEVER DROP THE TURN ─────────────────────────────────────────────────────
#
# A sighted turn carries the page it decided on - six thousand characters - and the catalogue, and
# the first round on sighted data dropped 152 of its 200 turns as "too long for 2048 tokens". The
# window is wider now (4096 fits 91% of them), and the rest are FITTED rather than dropped: the
# oldest observations are cut from the user message first - they are what the prompt itself
# demotes to one line - and only then is the latest page shortened from its end. The goal, the
# newest observation and the answer always survive, which is the same priority the live prompt has.
SEEN = "\n\nSEEN SO FAR:\n"


def render(tok, messages):
    """The prompt as this model's own template writes it.

    NOT EVERY TEMPLATE TAKES A SYSTEM MESSAGE. Gemma's refuses one. The words matter, the envelope
    does not, so a refused system message is folded into the first user message - the same prompt,
    one turn - rather than the candidate being marked as unable to answer.
    """
    try:
        return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    except Exception:
        folded, carry = [], ""
        for m in messages:
            if m.get("role") == "system":
                carry = (carry + "\n\n" + m.get("content", "")).strip()
                continue
            if carry and m.get("role") == "user":
                folded.append({"role": "user", "content": carry + "\n\n" + m.get("content", "")})
                carry = ""
            else:
                folded.append(m)
        if carry:
            folded.append({"role": "user", "content": carry})
        return tok.apply_chat_template(folded, tokenize=False, add_generation_prompt=True, enable_thinking=False)


def _tokens(tok, messages):
    return len(tok(render(tok, messages), add_special_tokens=False)["input_ids"])


def fit_messages(tok, messages, max_len, answer_tokens=64):
    """The first two messages, shortened until prompt + answer fit in max_len. Returns (messages, cut)."""
    budget = max_len - answer_tokens
    sys_m, user_m = messages[0], messages[1]
    if _tokens(tok, [sys_m, user_m]) <= budget:
        return [sys_m, user_m], False
    content = user_m["content"]
    if SEEN in content:
        head, seen = content.split(SEEN, 1)
        blocks = seen.split("\n- ")
        blocks = [blocks[0]] + ["- " + b for b in blocks[1:]] if blocks else []
        while len(blocks) > 1:
            blocks = blocks[1:]
            trial = {"role": "user", "content": head + SEEN + "\n".join(blocks)}
            if _tokens(tok, [sys_m, trial]) <= budget:
                return [sys_m, trial], True
        user_m = {"role": "user", "content": head + SEEN + "\n".join(blocks)}
    # One block left and still too long: shorten it from the end, by characters, until it fits.
    text = user_m["content"]
    lo, hi = 0, len(text)
    best = None
    while lo < hi:
        mid = (lo + hi + 1) // 2
        trial = {"role": "user", "content": text[:mid]}
        if _tokens(tok, [sys_m, trial]) <= budget:
            best, lo = trial, mid
        else:
            hi = mid - 1
    if best is None:
        best = {"role": "user", "content": text[:200]}
    return [sys_m, best], True


def expected_call(row):
    try:
        obj = json.loads(row["messages"][2]["content"])
        return obj.get("tool"), (obj.get("args") if isinstance(obj.get("args"), dict) else {})
    except Exception:
        return None, {}


def role_of(row):
    try:
        return str((row.get("meta") or {}).get("role") or "general")
    except Exception:
        return "general"


# ── DO THE ARGUMENTS AGREE? ─────────────────────────────────────────────────────────────────────
#
# The tool name was the whole score, and a model that answers `open` with https://www.google.com
# to every open looked identical to one that read the page and chose the listing. So each argument
# is compared the way a person would: an address by its host and path (never the query string or
# a trailing slash), an index exactly, a piece of text by similarity, anything else by equality.
# A missing optional argument on both sides is agreement; an argument the gold call has and the
# model left out is not.
def _norm_text(s):
    return " ".join(str(s or "").lower().split())


def _norm_url(u):
    u = str(u or "").strip().lower()
    u = u.split("#")[0].split("?")[0]
    u = u.replace("https://", "").replace("http://", "")
    if u.startswith("www."):
        u = u[4:]
    return u.rstrip("/")


URLISH = ("url", "href", "link", "address", "postUrl")
INDEXISH = ("index", "n", "i")


def _arg_agrees(key, want, got):
    if key in URLISH:
        return _norm_url(want) == _norm_url(got)
    if key in INDEXISH:
        try:
            return int(want) == int(got)
        except Exception:
            return False
    if isinstance(want, (int, float, bool)) or isinstance(got, (int, float, bool)):
        return want == got
    if isinstance(want, (list, dict)) or isinstance(got, (list, dict)):
        return json.dumps(want, sort_keys=True) == json.dumps(got, sort_keys=True)
    a, b = _norm_text(want), _norm_text(got)
    if not a and not b:
        return True
    if not a or not b:
        return False
    import difflib
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.8


def args_agree(want, got):
    """Every argument the gold call made agrees; extra arguments the model added do not count against it."""
    want = want if isinstance(want, dict) else {}
    got = got if isinstance(got, dict) else {}
    for k, v in want.items():
        if v in (None, "", [], {}):
            continue
        if k not in got:
            return False
        if not _arg_agrees(k, v, got.get(k)):
            return False
    return True


THINK = re.compile(r'<think>.*?</think>\s*', re.S)


def _unthink(text):
    """A hybrid student's reasoning, removed before anything is read out of the answer.

    Qwen3 opens a reasoning block unless its template is told not to. The flag is passed wherever
    a prompt is rendered; this is the second lock, because what is measured is the tool the model
    chose, not whether a flag reached it. An unclosed block - the answer cut off mid-thought -
    leaves nothing to read, which is the honest outcome rather than a guess.
    """
    if not text or "<think>" not in text:
        return text
    return THINK.sub("", text)


def predicted_call(text):
    """The tool name and its arguments out of whatever the model said, however untidily it said it."""
    obj = _first_object(_unthink(text))
    if not obj:
        return None, {}
    t = obj.get("tool") or obj.get("name")
    a = obj.get("args") if isinstance(obj.get("args"), dict) else (obj.get("arguments") if isinstance(obj.get("arguments"), dict) else {})
    return (t if isinstance(t, str) else None), a


def predicted_tool(text):
    return predicted_call(text)[0]


def _first_object(text):
    """The first complete JSON object in the text, or None."""
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
                return obj if isinstance(obj, dict) else None
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
          model_obj=None, tok=None, trainable=False, note=print, max_len=4096, dtype="float32"):
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
        import transformers
        from transformers import AutoModelForCausalLM, AutoTokenizer, AutoConfig
        tok = tok or AutoTokenizer.from_pretrained(model_id)
        want = torch.bfloat16 if str(dtype) == "bfloat16" else torch.float32
        # THE MODEL'S OWN CONFIG SAYS WHAT CLASS IT IS. A multimodal wrapper such as Gemma 4's
        # Gemma4ForConditionalGeneration is not a causal LM and AutoModelForCausalLM refuses it;
        # loading the class the config names works for both and needs no list of exceptions.
        model_obj = None
        try:
            arch = (getattr(AutoConfig.from_pretrained(model_id), "architectures", None) or [None])[0]
            if arch and arch != "AutoModelForCausalLM" and hasattr(transformers, arch):
                model_obj = getattr(transformers, arch).from_pretrained(model_id, dtype=want)
                note(f"loaded as {arch} in {want}".replace("torch.", ""))
        except Exception as e:
            note(f"the named architecture did not load ({str(e)[:120]}) - trying the causal loader")
        if model_obj is None:
            model_obj = AutoModelForCausalLM.from_pretrained(model_id, dtype=want)
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
    # Arguments, and the role: a right tool with the wrong address is a wrong answer live, and an
    # average over roles hides the role that is hopeless.
    args_hits = 0
    per_role = defaultdict(lambda: [0, 0])   # role -> [right, seen]
    started = time.time()
    # THE GPU, WHEN THERE IS ONE. Same float32 maths as on a laptop - the numbers stay comparable -
    # but a node's CPU is a sliver, and a 500-turn exam took hours there before this line.
    if torch.cuda.is_available():
        model_obj = model_obj.to("cuda")
    device = next(model_obj.parameters()).device

    for i, row in enumerate(rows):
        want, want_args = expected_call(row)
        if not want:
            continue
        role = role_of(row)
        fitted, _cut = fit_messages(tok, row["messages"], max_len)
        prompt = render(tok, fitted)
        ids = tok(prompt, return_tensors="pt", truncation=True, max_length=max_len).to(device)
        with torch.no_grad():
            out = model_obj.generate(**ids, max_new_tokens=max_new, do_sample=False,
                                     pad_token_id=tok.eos_token_id)
        text = tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)
        got, got_args = predicted_call(text)
        if got is None:
            unusable += 1
        said[got or "(nothing usable)"] += 1
        per_tool[want][1] += 1
        per_role[role][1] += 1
        if got == want:
            hits += 1
            per_tool[want][0] += 1
            per_role[role][0] += 1
            if args_agree(want_args, got_args):
                args_hits += 1
        else:
            confusion[f"{want} -> {got}"] += 1
        if (i + 1) % 10 == 0:
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
        # The tool AND its arguments, over every turn - the number that says whether it would have
        # done the right thing live, not only named it. And the same over the turns it named right.
        "args_agreement_pct": round(100 * args_hits / total, 2) if total else 0,
        "args_of_hits_pct": round(100 * args_hits / hits, 2) if hits else 0,
        "per_role": {k: {"right": v[0], "seen": v[1], "pct": round(100 * v[0] / v[1], 1)}
                     for k, v in sorted(per_role.items(), key=lambda kv: -kv[1][1])},
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
    # 320 IS WHAT SERVING GIVES IT (student.js OPTIONS.num_predict). At 48 a `finish` was cut off
    # mid-JSON and scored as garbage, which is why that tool read 0% in every round ever measured.
    ap.add_argument("--max-new", type=int, default=320,
                    help="the answer budget; matches what the served student is given")
    ap.add_argument("--out", default=None)
    ap.add_argument("--dtype", choices=["float32", "bfloat16"], default="float32",
                    help="float32 is the rounds' own precision; a trial of a bigger candidate is measured in bfloat16")
    args = ap.parse_args()

    result = score(args.model, adapter=args.adapter, data=args.data,
                   limit=args.limit, max_new=args.max_new, dtype=args.dtype)
    print(json.dumps(result, indent=1))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=1)
        print(f"written to {args.out}")


if __name__ == "__main__":
    main()
