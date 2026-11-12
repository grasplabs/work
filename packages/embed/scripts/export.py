"""Exports a ModernBERT-style embedding model (Hugging Face format: config.json, model.safetensors, tokenizer.json)
into the embedder's three model files, as src/model-files.ts reads them and rust/ runs them:

  tokenizer.bin       the tokenizer: vocabulary pieces, merges as (left length, rank) lists per result, byte
                      fallback ids, added tokens, <bos> and <eos>
  encoder-int8.bin    the encoder with int8 weights (production), or encoder-float.bin (--float, verification)
  tokens-int8.bin     the token table, one int8 row and its float32 scale per token (production), or
                      tokens-float.bin (--float, verification)

A model with a trimmed token table (idmap.json beside the checkpoint, as training writes it: `decomp`, each removed
piece's fixed sequence of kept pieces) is exported with rows for its kept pieces only, in the order of their IDs, and
its tokenizer file (version 2) maps every piece to its rows: a kept piece to its own, a removed one to its kept
pieces' rows. The embedder applies the map as the model was trained (`mapped`). A model without idmap.json exports as
before, a row per piece, its files byte for byte the same.

The int8 encoder is made safe for 8 bits with calibration texts (--calibration, a JSON list of strings): per-channel
rescaling folded exactly into the weights, and the 16 feed-forward channels of the last layer with the largest
activations kept in float. Every int8 linear layer keeps each group of 4 weights that feeds one 16-bit lane at
sum |w| <= 258, so the embedder's 16-bit kernels give the same bits as its 32-bit ones. Without calibration texts
the int8 encoder is quantised plainly.

The encoder file's header says the model's shape: its width, its layers, and for each layer whether it is local,
whether it has an attention norm, its heads and its feed-forward width (read from the weights, so a model pruned
layer by layer exports as it is). The embedder runs any shape the header says, within its bounds.

The encoder reads at most --max-tokens tokens (default 512, as the reference truncates); its buffers and rotary
tables are sized to that, not to the config's max_position_embeddings, which the module's memory may not hold.

Which layers are local comes from config.json's layer_types, one per layer. A model whose layers were cut must list
them, each kept layer's kind from its original position: transformers would otherwise derive kinds from each layer's
new index, which is wrong after a cut. A config without the list (any ModernBERT saved before transformers 5, such as
the published bekko-a8m) is refused unless --uncut asserts that the checkpoint is an unmodified published model, whose
kinds transformers derives from its config (global every n layers); then its layer count and its attention norms
(none on the first layer, one on every other) are checked against its weights.

Usage: python -I export.py <model dir> <out dir> [--float] [--calibration texts.json] [--max-tokens 512] [--uncut]
Needs numpy, torch, transformers, safetensors and tokenizers."""
import argparse
import json
import struct
from pathlib import Path

import numpy as np
import torch
from safetensors import safe_open
from safetensors.torch import load_file
from tokenizers import Tokenizer
from transformers import AutoConfig, ModernBertModel

HD = 64  # the head width the runtime is written for
EPS = 1e-5  # the runtime's norm epsilon (rust/src/encoder.rs)
MLM_HEAD = ("head.", "decoder.")  # a masked-LM checkpoint's head, not part of the encoder
LOCAL, NORM = 1, 2  # a layer's kind: local attention, an attention norm; bits 8 to 15 its rotary table
SMOOTH = {"qkv": 0.6, "o": 0.0, "ff1": 0.6, "ff2": 0.8}  # per-channel rescaling strength at each linear input
FLOAT_CHANNELS = 16  # feed-forward channels of the last layer kept in float
PAIR_LIMIT = 258  # largest sum |w| over the 4 weights feeding one 16-bit lane
MAX_TOKENS = 512  # the most tokens the embedder reads by default: the reference truncation
IDMAP = "idmap.json"  # a trimmed token table's map, beside the checkpoint


def pad16(b: bytes) -> bytes:
    return b + b"\0" * (-len(b) % 16)


def le(a: np.ndarray) -> bytes:
    a = np.ascontiguousarray(a)
    if a.dtype.kind == "f":
        return a.astype("<f4").tobytes()
    return a.astype(a.dtype.newbyteorder("<")).tobytes() if a.dtype.itemsize > 1 else a.tobytes()


def panel8(w: np.ndarray) -> np.ndarray:
    """[out, in] -> [out/8][in][8]"""
    o, i = w.shape
    return w.reshape(o // 8, 8, i).transpose(0, 2, 1)


def dot4(wq: np.ndarray) -> np.ndarray:
    """[out, in] -> [out/8][in/4][2 halves][4 outs][4 ks]"""
    o, i = wq.shape
    return wq.reshape(o // 8, 2, 4, i // 4, 4).transpose(0, 3, 1, 2, 4)


def quantize(w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """int8 per output channel, each channel's scale raised until its 16-bit lane groups stay within PAIR_LIMIT."""
    s = (np.maximum(np.abs(w).max(axis=1), 1e-12) / 127.0).astype(np.float32)
    o, k = w.shape
    # The ks one 16-bit lane sums over two steps of the pair kernel: {4t+2p, 4t+2p+1, 4t+4+2p, 4t+5+2p}, t even.
    lanes = np.array([[4 * t + 2 * p, 4 * t + 2 * p + 1, 4 * t + 4 + 2 * p, 4 * t + 5 + 2 * p] for t in range(0, k // 4, 2) for p in range(2)])
    while True:
        q = np.minimum(127, np.abs(np.rint(w / s[:, None])))
        over = q[:, lanes].sum(axis=2).max(axis=1) > PAIR_LIMIT
        if not over.any():
            break
        s[over] = (s[over] * 1.01).astype(np.float32)
    return np.clip(np.rint(w / s[:, None]), -127, 127).astype(np.int8), s


def smoothing(act: np.ndarray, w: np.ndarray, alpha: float) -> np.ndarray:
    s = (np.maximum(act, 1e-5) ** alpha) / (np.maximum(np.abs(w).max(0), 1e-5) ** (1 - alpha))
    return s / np.exp(np.log(s).mean())


def rope_table(theta: float, max_tokens: int) -> tuple[np.ndarray, np.ndarray]:
    """cos and sin as transformers computes them for the default rotary type, in float32."""
    inv = 1.0 / (theta ** (torch.arange(0, HD, 2, dtype=torch.float) / HD))
    freqs = torch.arange(max_tokens).float()[:, None] * inv[None, :]
    return freqs.cos().numpy(), freqs.sin().numpy()


def load_model(src: Path) -> ModernBertModel:
    """The float32 model with eager attention, built as the checkpoint is: each layer's linear layers sized as its
    weights are, and an attention norm on exactly the layers whose weights have one. A model pruned layer by layer
    (fewer heads or a narrower feed-forward in some layers, or layers cut so that the first kept one has a norm)
    loads as it is and runs as the exported encoder does, where from_pretrained would size every layer by the config
    and give only layer 0 no norm."""
    cfg = AutoConfig.from_pretrained(src, attn_implementation="eager")
    model = ModernBertModel(cfg)
    state = {k.removeprefix("model."): v.float() for k, v in load_file(src / "model.safetensors").items()}
    # A masked-LM checkpoint's head is not the encoder's; any other key the encoder lacks fails the strict load.
    state = {k: v for k, v in state.items() if not k.startswith(MLM_HEAD)}
    for l, layer in enumerate(model.layers):
        if f"layers.{l}.attn_norm.weight" in state:
            layer.attn_norm = torch.nn.LayerNorm(cfg.hidden_size, eps=cfg.norm_eps, bias=False)
        else:
            layer.attn_norm = torch.nn.Identity()
    for name, module in model.named_modules():
        if isinstance(module, torch.nn.Linear) and f"{name}.weight" in state:
            out, inp = state[f"{name}.weight"].shape
            if (out, inp) != (module.out_features, module.in_features):
                parent, _, child = name.rpartition(".")
                setattr(model.get_submodule(parent), child, torch.nn.Linear(inp, out, bias=False))
    model.load_state_dict(state, strict=True)
    return model.eval()


def read_idmap(src: Path) -> dict[int, list[int]] | None:
    """A trimmed token table's map, from the checkpoint's idmap.json: each removed piece and the kept pieces it is
    written as, all as tokenizer IDs. None for a model with a row per piece. Refuses a map the embedder can't run
    exactly as the model was trained: one with merged pieces (new rows for runs of pieces), or for another vocabulary,
    or a removed piece written as nothing or as another removed piece, or <bos> or <eos> removed."""
    path = src / IDMAP
    if not path.exists():
        return None
    raw = json.loads(path.read_text())
    n = vocab_size(src)
    assert not raw.get("merges"), "merged pieces: the embedder has no rows for runs of pieces"
    assert raw.get("base", n) == n, f"a map for {raw['base']} pieces, the tokenizer has {n}"
    decomp = {int(k): [int(t) for t in v] for k, v in raw["decomp"].items()}
    assert all(0 <= k < n for k in decomp), "a removed piece past the vocabulary"
    assert all(seq for seq in decomp.values()), "a removed piece written as nothing"
    assert all(0 <= t < n and t not in decomp for seq in decomp.values() for t in seq), "a removed piece written as a removed one"
    assert raw.get("n_keep", n - len(decomp)) == n - len(decomp), "n_keep doesn't match the map"
    assert not set(specials(src)) & decomp.keys(), "<bos> or <eos> removed: the length cut keeps <eos> as one row"
    return decomp


def vocab_size(src: Path) -> int:
    return len(json.loads((src / "tokenizer.json").read_text())["model"]["vocab"])


def specials(src: Path) -> tuple[int, int]:
    """<bos> and <eos>, as the tokenizer's template adds them."""
    post = json.loads((src / "tokenizer.json").read_text())["post_processor"]
    special = lambda at: post["special_tokens"][post["single"][at]["SpecialToken"]["id"]]["ids"][0]  # noqa: E731
    return special(0), special(2)


def mapped(ids: list[int], decomp: dict[int, list[int]], max_tokens: int) -> list[int]:
    """Tokenizer IDs as a model with a trimmed table reads them, in the order it was trained with: `ids` come from the
    reference tokenizer, already cut at `max_tokens` (<bos> and <eos> included); each removed piece becomes its
    sequence of kept pieces; then what passes `max_tokens` is cut again, keeping the first max_tokens - 1 and the last
    (<eos>). The embedder gets the same by applying the map piece by piece and counting what it maps to."""
    out = [t for i in ids for t in decomp.get(i, [i])]
    return out if len(out) <= max_tokens else out[: max_tokens - 1] + out[-1:]


def calibrate(src: Path, texts: list[str], max_tokens: int) -> dict[str, np.ndarray]:
    """Per-input-channel abs max at every linear layer's input, over the calibration texts, as the model reads them
    (a trimmed table's map applied)."""
    tok = Tokenizer.from_file(str(src / "tokenizer.json"))
    tok.enable_truncation(max_tokens)
    decomp = read_idmap(src) or {}
    model = load_model(src)
    acc: dict[str, np.ndarray] = {}

    def hook(name: str):
        def record(_mod, inp, _out):
            a = inp[0][0].detach().float().abs().amax(0).numpy()
            acc[name] = np.maximum(acc[name], a) if name in acc else a

        return record

    for l, layer in enumerate(model.layers):
        layer.attn.Wqkv.register_forward_hook(hook(f"L{l}.qkv"))
        layer.attn.Wo.register_forward_hook(hook(f"L{l}.o"))
        layer.mlp.Wi.register_forward_hook(hook(f"L{l}.ff1"))
        layer.mlp.Wo.register_forward_hook(hook(f"L{l}.ff2"))
    with torch.no_grad():
        for t in texts:
            model(input_ids=torch.tensor([mapped(tok.encode(t).ids, decomp, max_tokens)]))
    return acc


def check_model(src: Path, cfg, uncut: bool = False) -> None:
    """Refuses a model the runtime would run wrongly without noticing: everything the encoder file doesn't say and
    the runtime assumes (rust/src/encoder.rs). Each layer's widths and norms are read from its weights."""
    assert cfg.model_type == "modernbert", cfg.model_type  # pre-norm layers, rotate-half rotary, GeGLU (value, gate)
    # Which layers are local, and their rotary bases, come from the config's layer_types, one per kept layer in
    # order. Without it transformers derives them from each layer's new index (global every n layers), which is
    # wrong for a model whose layers were cut: so it must be written out, or the model asserted uncut (--uncut).
    raw = json.loads((src / "config.json").read_text())
    if "layer_types" in raw:
        assert len(raw["layer_types"]) == cfg.num_hidden_layers, "config.json lists layer_types for another layer count"
    else:
        assert uncut, (
            "config.json lists no layer_types, so which layers are local can't be known for a model whose layers were "
            "cut. If this is an unmodified published model, pass --uncut: it asserts that, and the kinds transformers "
            "derives from the config are used."
        )
        with safe_open(src / "model.safetensors", "pt") as f:
            keys = {k.removeprefix("model.") for k in f.keys()}
        layers = {int(k.split(".")[1]) for k in keys if k.startswith("layers.")}
        assert layers == set(range(cfg.num_hidden_layers)), f"weights for layers {sorted(layers)}, config says {cfg.num_hidden_layers}"
        norms = [f"layers.{l}.attn_norm.weight" in keys for l in range(cfg.num_hidden_layers)]
        assert norms == [l > 0 for l in range(cfg.num_hidden_layers)], f"attention norms {norms}: not an uncut ModernBERT"
    # The head width: 64, which the kernels, the attention scale and the rotary tables are written for. A pruned
    # model drops whole heads, so the config's head width stays the model's.
    head = getattr(cfg, "head_dim", None) or cfg.hidden_size // cfg.num_attention_heads
    assert head == HD and cfg.hidden_size % cfg.num_attention_heads == 0, f"head width {head}, the runtime runs {HD}"
    assert not cfg.norm_bias and not cfg.attention_bias and not cfg.mlp_bias, "biases"
    assert cfg.hidden_activation == "gelu", cfg.hidden_activation  # exact erf GELU in GeGLU
    assert cfg.norm_eps == EPS, cfg.norm_eps
    for t in cfg.layer_types:
        rope = cfg.rope_parameters[t]
        assert t in ("full_attention", "sliding_attention") and rope["rope_type"] == "default", (t, rope)
        assert rope.get("partial_rotary_factor", 1.0) == 1.0, rope  # the whole head rotates
    # Mean pooling, as the runtime pools. A sentence-transformers model says how it pools; a bare encoder is taken as
    # mean-pooled (the test fixtures).
    modules = src / "modules.json"
    if modules.exists():
        kinds = [m["type"].rsplit(".", 1)[-1] for m in json.loads(modules.read_text())]
        assert kinds in (["Transformer", "Pooling"], ["Transformer", "Pooling", "Normalize"]), kinds
        pool = next(m for m in json.loads(modules.read_text()) if m["type"].endswith("Pooling"))
        modes = json.loads((src / pool["path"] / "config.json").read_text())
        on = sorted(k for k, v in modes.items() if k.startswith("pooling_mode_") and v)
        assert on == ["pooling_mode_mean_tokens"] and modes.get("include_prompt", True), modes


def encoder(src: Path, cfg, int8: bool, cal: dict[str, np.ndarray] | None, maxn: int) -> bytes:
    T = {k: v.float().numpy() for k, v in load_file(src / "model.safetensors").items()}
    T = {k.removeprefix("model."): v for k, v in T.items()}
    h, nl = cfg.hidden_size, cfg.num_hidden_layers
    thetas = sorted({cfg.rope_parameters[t]["rope_theta"] for t in cfg.layer_types})
    shapes: list[int] = []
    parts: list[bytes] = [pad16(le(T["embeddings.norm.weight"])), pad16(le(T["final_norm.weight"]))]
    for theta in thetas:
        parts += [pad16(le(a)) for a in rope_table(theta, maxn)]
    for l in range(nl):
        g = lambda n: T[f"layers.{l}.{n}"]  # noqa: E731
        # Each layer's widths, from its weights: the attention's (heads x the head width) and the feed-forward's.
        a, ff = g("attn.Wo.weight").shape[1], g("mlp.Wo.weight").shape[1]
        assert a % HD == 0 and g("attn.Wqkv.weight").shape == (3 * a, h) and g("mlp.Wi.weight").shape == (2 * ff, h), l
        norm = f"layers.{l}.attn_norm.weight" in T
        gn = g("attn_norm.weight") if norm else np.ones(h, np.float32)
        mlp_norm = g("mlp_norm.weight")
        wqkv = g("attn.Wqkv.weight").copy()
        wqkv[:a] *= HD**-0.5  # the attention's scale, folded into Wq
        wqkv = wqkv * gn[None, :]
        wo = g("attn.Wo.weight").copy()
        wi = g("mlp.Wi.weight") * mlp_norm[None, :]
        wo2 = g("mlp.Wo.weight").copy()
        gq, gf = np.ones(h, np.float32), np.ones(h, np.float32)
        nod = 0
        if int8 and cal is not None:
            act = lambda k: cal[f"L{l}.{k}"].astype(np.float64)  # noqa: E731
            # Exact: each rescaling is undone in the gain or the weights before it.
            sq = smoothing(act("qkv") / (np.maximum(np.abs(gn), 1e-6) if norm else 1), wqkv, SMOOTH["qkv"])
            wqkv, gq = wqkv * sq[None, :], 1 / sq
            if SMOOTH["o"]:
                so = smoothing(act("o"), wo, SMOOTH["o"])
                wo, wqkv[2 * a :] = wo * so[None, :], wqkv[2 * a :] / so[:, None]
            sf = smoothing(act("ff1") / np.maximum(np.abs(mlp_norm), 1e-6), wi, SMOOTH["ff1"])
            wi, gf = wi * sf[None, :], 1 / sf
            s2 = smoothing(act("ff2"), wo2, SMOOTH["ff2"])
            wo2 = wo2 * s2[None, :]
            wi[ff:] /= s2[:, None]
            if l == nl - 1:
                nod = FLOAT_CHANNELS
                kept = np.argsort(-act("ff2"))[:nod]
                perm = np.concatenate([np.setdiff1d(np.arange(ff), kept), kept])
                wi = np.concatenate([wi[:ff][perm], wi[ff:][perm]])
                wo2 = wo2[:, perm]
        kind = (LOCAL if cfg.layer_types[l] == "sliding_attention" else 0) | (NORM if norm else 0)
        shapes += [kind | thetas.index(cfg.rope_parameters[cfg.layer_types[l]]["rope_theta"]) << 8, a // HD, ff, nod]
        for w in (wqkv, wo, wi, wo2[:, : ff - nod]):
            if int8:
                wq, s = quantize(w.astype(np.float32))
                parts += [pad16(le(dot4(wq))), pad16(le(s)), pad16(le(wq.astype(np.int32).sum(axis=1).astype("<i4")))]
            else:
                parts.append(pad16(le(panel8(w))))
        parts += [pad16(le(gq.astype(np.float32))), pad16(le(gf.astype(np.float32)))]
        if nod:
            parts.append(pad16(le(panel8(wo2[:, ff - nod :]))))
    header = struct.pack(f"<4s{7 + len(shapes)}I", b"GENC", 2, int(int8), h, nl, maxn, cfg.sliding_window, len(thetas), *shapes)
    return pad16(header) + b"".join(parts)


def tokens(src: Path, int8: bool, kept: list[int] | None) -> bytes:
    """The token table: a row per piece, or only the `kept` pieces' rows, in that order."""
    raw = load_file(src / "model.safetensors")
    key = next(k for k in raw if k.endswith("embeddings.tok_embeddings.weight"))
    e = raw[key].float().numpy()
    if kept is not None:
        assert e.shape[0] == vocab_size(src), "a trimmed checkpoint keeps a row per piece; the export drops the removed"
        e = e[kept]
    n, h = e.shape
    header = pad16(struct.pack("<4s4I", b"GTKN", 1, int(int8), h, n))
    if not int8:
        return header + le(e)
    sc = np.maximum(np.abs(e).max(axis=1), 1e-12) / 127.0
    q = np.clip(np.rint(e / sc[:, None]), -127, 127).astype(np.int8)
    rows = np.zeros((n, 4 + h), dtype=np.uint8)
    rows[:, :4] = sc.astype("<f4").view(np.uint8).reshape(-1, 4)
    rows[:, 4:] = q.view(np.uint8)
    return header + rows.tobytes()


def tokenizer(src: Path, decomp: dict[int, list[int]] | None) -> bytes:
    """The tokenizer file: version 1 for a row per piece, version 2 with the map from pieces to rows for a trimmed
    table (`decomp`). Only the kept pieces have rows, numbered in the order of their IDs."""
    tj = json.loads((src / "tokenizer.json").read_text())
    m = tj["model"]
    assert m["type"] == "BPE" and m["byte_fallback"] and not m.get("ignore_merges") and m.get("continuing_subword_prefix") is None
    assert tj["normalizer"] == {"type": "Replace", "pattern": {"String": " "}, "content": "▁"}
    pre = tj["pre_tokenizer"]
    assert pre["type"] == "Metaspace" and pre["replacement"] == "▁" and pre["prepend_scheme"] == "always" and pre["split"]
    post = tj["post_processor"]
    assert post["type"] == "TemplateProcessing" and [list(x)[0] for x in post["single"]] == ["SpecialToken", "Sequence", "SpecialToken"]
    bos, eos = specials(src)
    vocab = m["vocab"]
    n = len(vocab)
    pieces: list[bytes] = [b""] * n
    for p, i in vocab.items():
        pieces[i] = p.encode()
    assert sorted(vocab.values()) == list(range(n))
    merges: dict[tuple[int, int], tuple[int, int]] = {}
    for rank, mg in enumerate(m["merges"]):
        a, b = mg.split(" ", 1) if isinstance(mg, str) else mg
        merges[(vocab[a], vocab[b])] = (rank, vocab[a + b])  # a later duplicate wins, as the tokenizers' map does
    per: list[list[tuple[int, int]]] = [[] for _ in range(n)]
    for (a, _b), (rank, r) in merges.items():
        per[r].append((len(pieces[a]), rank))
    moffs = np.zeros(n + 1, dtype="<u4")
    moffs[1:] = np.cumsum([len(x) for x in per])
    mlen = np.array([x[0] for lst in per for x in lst], dtype=np.uint8)
    mrank = np.array([x[1] for lst in per for x in lst], dtype="<u4")
    # A byte without a <0xXX> token is only ever reached as a whole character in the vocabulary, so byte
    # fallback never needs it: it maps to <unk>.
    missing = [b for b in range(256) if f"<0x{b:02X}>" not in vocab]
    assert all(b < 0x80 and chr(b) in vocab for b in missing), missing
    byte_ids = np.array([vocab.get(f"<0x{b:02X}>", vocab["<unk>"]) for b in range(256)], dtype="<u4")
    offs = np.zeros(n + 1, dtype="<u4")
    offs[1:] = np.cumsum([len(p) for p in pieces])
    added = tj["added_tokens"]
    assert all(not a["normalized"] and not a["single_word"] and not a["rstrip"] for a in added)
    pad4 = lambda b: b + b"\0" * (-len(b) % 4)  # noqa: E731
    if decomp is None:
        blob = struct.pack("<4s6I", b"GTOK", 1, bos, eos, n, len(mlen), len(added))
        blob += offs.tobytes() + moffs.tobytes() + mrank.tobytes() + byte_ids.tobytes()
    else:
        row = {piece: r for r, piece in enumerate(kept_pieces(n, decomp))}
        seqs = [[row[t] for t in decomp.get(i, [i])] for i in range(n)]
        soffs = np.zeros(n + 1, dtype="<u4")
        soffs[1:] = np.cumsum([len(q) for q in seqs])
        rows = np.array([r for q in seqs for r in q], dtype="<u4")
        blob = struct.pack("<4s8I", b"GTOK", 2, bos, eos, n, len(mlen), len(added), len(row), len(rows))
        blob += offs.tobytes() + moffs.tobytes() + mrank.tobytes() + byte_ids.tobytes() + soffs.tobytes() + rows.tobytes()
    blob += pad4(mlen.tobytes())
    for a in added:
        c = a["content"].encode()
        blob += pad4(struct.pack("<III", a["id"], int(a["lstrip"]), len(c)) + c)
    return blob + b"".join(pieces)


def kept_pieces(n: int, decomp: dict[int, list[int]]) -> list[int]:
    """The pieces a trimmed table keeps a row for, in the order of their rows."""
    return [i for i in range(n) if i not in decomp]


def export(src: Path, out: Path, float_files: bool, calibration: list[str] | None, max_tokens: int = MAX_TOKENS, uncut: bool = False) -> dict[str, int]:
    """Writes the three model files into `out`; returns their sizes."""
    cfg = AutoConfig.from_pretrained(src)
    # At most 1,024: past it attention's integer sums could overflow, and the embedder refuses the file
    # (rust/src/encoder.rs, MAX_TOKENS).
    assert 2 <= max_tokens <= min(1024, cfg.max_position_embeddings) and max_tokens % 8 == 0, max_tokens
    check_model(src, cfg, uncut)
    out.mkdir(parents=True, exist_ok=True)
    int8 = not float_files
    cal = calibrate(src, calibration, max_tokens) if int8 and calibration else None
    kind = "float" if float_files else "int8"
    decomp = read_idmap(src)
    kept = None if decomp is None else kept_pieces(vocab_size(src), decomp)
    files = {
        "tokenizer.bin": tokenizer(src, decomp),
        f"encoder-{kind}.bin": encoder(src, cfg, int8, cal, max_tokens),
        f"tokens-{kind}.bin": tokens(src, int8, kept),
    }
    for name, data in files.items():
        (out / name).write_bytes(data)
    return {name: len(data) for name, data in files.items()}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("model", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--float", action="store_true", help="float32 encoder and token table, for verification")
    ap.add_argument(
        "--uncut",
        action="store_true",
        help="assert the checkpoint is an unmodified published model: needed when config.json lists no layer_types",
    )
    ap.add_argument("--calibration", type=Path, help="JSON list of calibration texts for the int8 encoder")
    ap.add_argument(
        "--max-tokens",
        type=int,
        default=MAX_TOKENS,
        help=f"the most tokens the embedder reads (default {MAX_TOKENS}, as the reference truncates), not the config's "
        "max_position_embeddings: the encoder's buffers and rotary tables are sized to it, and at 8,192 they don't fit "
        "the module's 64 MiB; at most 1,024, where attention's integer sums stay in range",
    )
    args = ap.parse_args()
    texts = json.loads(args.calibration.read_text()) if args.calibration else None
    print(export(args.model, args.out, args.float, texts, args.max_tokens, args.uncut))
