"""The adapter must find the linear layer wherever the model keeps it.

Run: python3 training/test_resolve_targets.py

Three shapes. A PLAIN model exposes `q_proj` as a Linear and nothing may change - that is every
model trained here so far, and a change would silently alter their adapters. Gemma 4 WRAPS each
projection in a custom module with the Linear one level down, which PEFT refuses to adapt, so the
name of the inner Linear is the answer. And a MULTIMODAL model carries the same names inside its
vision and audio towers, which must be left alone: an adapter spent there is capacity given to
parts of the network that never see a browser page.

No torch needed. The function asks torch exactly one question - is this a Linear - and a stand-in
answers it truthfully for a fake tree.
"""
import sys
import types


# ── the stand-in for the one thing resolve_targets wants from torch ─────────────────────────────
class Linear:
    def __init__(self, name=""):
        self.name = name


class Module:
    """Enough of nn.Module to be walked: children by name, and every descendant by dotted name."""

    def __init__(self, **children):
        self._children = dict(children)

    def named_children(self):
        return list(self._children.items())

    def named_modules(self, prefix=""):
        out = [(prefix, self)] if prefix else [("", self)]
        for name, child in self._children.items():
            full = f"{prefix}.{name}" if prefix else name
            if isinstance(child, Module):
                out.extend(child.named_modules(full))
            else:
                out.append((full, child))
        return out


fake_nn = types.ModuleType("torch.nn")
fake_nn.Linear = Linear
fake_torch = types.ModuleType("torch")
fake_torch.nn = fake_nn
sys.modules.setdefault("torch", fake_torch)
sys.modules.setdefault("torch.nn", fake_nn)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) if False else __import__("os").path.dirname(__import__("os").path.abspath(__file__)))


def load_resolve_targets():
    """Lift the function out of the trainer without importing the whole trainer (it wants torch)."""
    import re
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "train_round.py"), encoding="utf-8").read()
    at = src.index("def resolve_targets(")
    end = src.index("\nANSWER_TOKENS", at)
    ns = {}
    exec(compile(src[at:end], "resolve_targets", "exec"), ns)
    return ns["resolve_targets"]


import os  # noqa: E402  (after the stubs, deliberately)

resolve_targets = load_resolve_targets()
WANTED = {"q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"}


def main():
    plain = Module(q_proj=Linear("q"), v_proj=Linear("v"), norm=Linear("n"))
    got = resolve_targets(plain, WANTED)
    assert got == ["q_proj", "v_proj"], got
    print("plain model unchanged:", got)

    clipped = Module(q_proj=Module(linear=Linear("q")), v_proj=Module(linear=Linear("v")))
    got = resolve_targets(clipped, WANTED)
    assert got == ["q_proj.linear", "v_proj.linear"], got
    print("wrapped model resolved:", got)

    multimodal = Module(
        language_model=Module(q_proj=Module(linear=Linear("q")), v_proj=Module(linear=Linear("v"))),
        vision_tower=Module(q_proj=Linear("vq")),
        audio_tower=Module(q_proj=Linear("aq")),
    )
    got = resolve_targets(multimodal, WANTED)
    assert got == ["q_proj.linear", "v_proj.linear"], got
    print("towers left alone:", got)

    # a wrapper with two linears inside is ambiguous and is skipped rather than guessed
    odd = Module(q_proj=Module(a=Linear("a"), b=Linear("b")))
    got = resolve_targets(odd, WANTED)
    assert got == [], got
    print("ambiguous wrapper skipped:", got)

    print("ALL GOOD")


if __name__ == "__main__":
    main()
