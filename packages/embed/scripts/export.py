"""Exports a ModernBERT-style embedding model (Hugging Face format: config.json, model.safetensors, tokenizer.json)
into the embedder's three model files, as src/model-files.ts reads them and rust/ runs them:

  tokenizer.bin       the tokenizer: vocabulary pieces, merges as (left length, rank) lists per result, byte
                      fallback ids, added tokens, <bos> and <eos>
  encoder-int8.bin    the encoder with int8 weights (production), or encoder-float.bin (--float, verification)
  tokens-int8.bin     the token table, one int8 row and its float32 scale per token (production), or
                      tokens-float.bin (--float, verification)

The int8 encoder is made safe for 8 bits with calibration texts (--calibration, a JSON list of strings): per-channel
rescaling folded exactly into the weights, and the 16 feed-forward channels of the last layer with the largest
activations kept in float. Every int8 linear layer keeps each group of 4 weights that feeds one 16-bit lane at
sum |w| <= 258, so the embedder's 16-bit kernels give the same bits as its 32-bit ones. Without calibration texts
the int8 encoder is quantised plainly.

The encoder reads at most --max-tokens tokens (default 512, as the reference truncates); its buffers and rotary
tables are sized to that, not to the config's max_position_embeddings, which the module's memory may not hold.

Usage: python -I export.py <model dir> <out dir> [--float] [--calibration texts.json] [--max-tokens 512]
Needs numpy, torch, transformers, safetensors and tokenizers."""
import argparse
import json
import struct
from pathlib import Path

import numpy as np
import torch
from safetensors.torch import load_file
from tokenizers import Tokenizer
from transformers import AutoConfig, AutoModel

HD = 64  # the head width the runtime is written for
SMOOTH = {"qkv": 0.6, "o": 0.0, "ff1": 0.6, "ff2": 0.8}  # per-channel rescaling strength at each linear input
FLOAT_CHANNELS = 16  # feed-forward channels of the last layer kept in float
PAIR_LIMIT = 258  # largest sum |w| over the 4 weights feeding one 16-bit lane
MAX_TOKENS = 512  # the most tokens the embedder reads by default: the reference truncation


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


def calibrate(src: Path, texts: list[str], max_tokens: int) -> dict[str, np.ndarray]:
    """Per-input-channel abs max at every linear layer's input, over the calibration texts."""
    tok = Tokenizer.from_file(str(src / "tokenizer.json"))
    tok.enable_truncation(max_tokens)
    model = AutoModel.from_pretrained(src, attn_implementation="eager", dtype=torch.float32).eval()
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
            model(input_ids=torch.tensor([tok.encode(t).ids]))
    return acc


def encoder(src: Path, cfg, int8: bool, cal: dict[str, np.ndarray] | None, maxn: int) -> bytes:
    T = {k: v.float().numpy() for k, v in load_file(src / "model.safetensors").items()}
    T = {k.removeprefix("model."): v for k, v in T.items()}
    h, nh, ff, nl = cfg.hidden_size, cfg.num_attention_heads, cfg.intermediate_size, cfg.num_hidden_layers
    assert h == nh * HD, f"head width {h // nh}, the runtime runs {HD}"
    assert not cfg.norm_bias and not cfg.attention_bias and not cfg.mlp_bias and cfg.hidden_activation == "gelu"
    thetas = sorted({cfg.rope_parameters[t]["rope_theta"] for t in cfg.layer_types})
    assert all(cfg.rope_parameters[t]["rope_type"] == "default" for t in cfg.layer_types)
    kinds = [(t == "sliding_attention") | (thetas.index(cfg.rope_parameters[t]["rope_theta"]) << 8) for t in cfg.layer_types]
    header = struct.pack(f"<4s{9 + nl}I", b"GENC", 1, int(int8), h, nh, ff, nl, maxn, cfg.sliding_window, len(thetas), *kinds)
    parts: list[bytes] = [pad16(header), pad16(le(T["embeddings.norm.weight"])), pad16(le(T["final_norm.weight"]))]
    for theta in thetas:
        parts += [pad16(le(a)) for a in rope_table(theta, maxn)]
    for l in range(nl):
        g = lambda n: T[f"layers.{l}.{n}"]  # noqa: E731
        gn = g("attn_norm.weight") if l > 0 else np.ones(h, np.float32)
        mlp_norm = g("mlp_norm.weight")
        wqkv = g("attn.Wqkv.weight").copy()
        wqkv[:h] *= HD**-0.5  # the attention's scale, folded into Wq
        wqkv = wqkv * gn[None, :]
        wo = g("attn.Wo.weight").copy()
        wi = g("mlp.Wi.weight") * mlp_norm[None, :]
        wo2 = g("mlp.Wo.weight").copy()
        gq, gf = np.ones(h, np.float32), np.ones(h, np.float32)
        nod = 0
        if int8 and cal is not None:
            act = lambda k: cal[f"L{l}.{k}"].astype(np.float64)  # noqa: E731
            # Exact: each rescaling is undone in the gain or the weights before it.
            sq = smoothing(act("qkv") / (np.maximum(np.abs(gn), 1e-6) if l > 0 else 1), wqkv, SMOOTH["qkv"])
            wqkv, gq = wqkv * sq[None, :], 1 / sq
            if SMOOTH["o"]:
                so = smoothing(act("o"), wo, SMOOTH["o"])
                wo, wqkv[2 * h :] = wo * so[None, :], wqkv[2 * h :] / so[:, None]
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
        for w in (wqkv, wo, wi, None, wo2[:, : ff - nod]):
            if w is None:
                parts.append(pad16(le(np.array([nod, 0, 0, 0], "<i4"))))
            elif int8:
                wq, s = quantize(w.astype(np.float32))
                parts += [pad16(le(dot4(wq))), pad16(le(s)), pad16(le(wq.astype(np.int32).sum(axis=1).astype("<i4")))]
            else:
                parts.append(pad16(le(panel8(w))))
        parts += [pad16(le(gq.astype(np.float32))), pad16(le(gf.astype(np.float32)))]
        if nod:
            parts.append(pad16(le(panel8(wo2[:, ff - nod :]))))
    return b"".join(parts)


def tokens(src: Path, int8: bool) -> bytes:
    raw = load_file(src / "model.safetensors")
    key = next(k for k in raw if k.endswith("embeddings.tok_embeddings.weight"))
    e = raw[key].float().numpy()
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


def tokenizer(src: Path) -> bytes:
    tj = json.loads((src / "tokenizer.json").read_text())
    m = tj["model"]
    assert m["type"] == "BPE" and m["byte_fallback"] and not m.get("ignore_merges") and m.get("continuing_subword_prefix") is None
    assert tj["normalizer"] == {"type": "Replace", "pattern": {"String": " "}, "content": "▁"}
    pre = tj["pre_tokenizer"]
    assert pre["type"] == "Metaspace" and pre["replacement"] == "▁" and pre["prepend_scheme"] == "always" and pre["split"]
    post = tj["post_processor"]
    assert post["type"] == "TemplateProcessing" and [list(x)[0] for x in post["single"]] == ["SpecialToken", "Sequence", "SpecialToken"]
    bos = post["special_tokens"][post["single"][0]["SpecialToken"]["id"]]["ids"][0]
    eos = post["special_tokens"][post["single"][2]["SpecialToken"]["id"]]["ids"][0]
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
    blob = struct.pack("<4s6I", b"GTOK", 1, bos, eos, n, len(mlen), len(added))
    blob += offs.tobytes() + moffs.tobytes() + mrank.tobytes() + byte_ids.tobytes() + pad4(mlen.tobytes())
    for a in added:
        c = a["content"].encode()
        blob += pad4(struct.pack("<III", a["id"], int(a["lstrip"]), len(c)) + c)
    return blob + b"".join(pieces)


def export(src: Path, out: Path, float_files: bool, calibration: list[str] | None, max_tokens: int = MAX_TOKENS) -> dict[str, int]:
    """Writes the three model files into `out`; returns their sizes."""
    cfg = AutoConfig.from_pretrained(src)
    # At most 1,024: past it attention's integer sums could overflow, and the embedder refuses the file
    # (rust/src/encoder.rs, MAX_TOKENS).
    assert 2 <= max_tokens <= min(1024, cfg.max_position_embeddings) and max_tokens % 8 == 0, max_tokens
    out.mkdir(parents=True, exist_ok=True)
    int8 = not float_files
    cal = calibrate(src, calibration, max_tokens) if int8 and calibration else None
    kind = "float" if float_files else "int8"
    files = {"tokenizer.bin": tokenizer(src), f"encoder-{kind}.bin": encoder(src, cfg, int8, cal, max_tokens), f"tokens-{kind}.bin": tokens(src, int8)}
    for name, data in files.items():
        (out / name).write_bytes(data)
    return {name: len(data) for name, data in files.items()}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("model", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--float", action="store_true", help="float32 encoder and token table, for verification")
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
    print(export(args.model, args.out, args.float, texts, args.max_tokens))
