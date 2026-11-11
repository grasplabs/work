"""Makes the test fixture (../test/fixtures): a tiny, random model of the same family as the real one, exported
into the embedder's model files, with the reference outputs the tests compare against. Run once; its output is
committed.

The model: a Gemma-style BPE tokenizer trained on texts.json (a few hundred pieces, every byte as a fallback token,
added tokens with and without lstrip), and a ModernBERT encoder of width 128, two heads, 2 layers (global, then
local, each with its own rotary base), a feed-forward width of 64, a window of +-8 tokens and at most 128 tokens,
so the texts are longer than the window and the longest is cut. The references come from Hugging Face tokenizers and transformers, in
float32 with eager attention: token IDs for texts.json and tricky-strings.json (strings from the tokenizer fuzz
sets), and each text's mean-pooled, L2-normalised embedding.

Usage: python -I make-fixture.py   (needs what export.py needs)"""
import hashlib
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch
from tokenizers import Tokenizer, decoders, models, normalizers, pre_tokenizers, processors, trainers
from transformers import ModernBertConfig, ModernBertModel

sys.dont_write_bytecode = True  # no __pycache__ beside the scripts
sys.path.insert(0, str(Path(__file__).parent))
from export import export  # noqa: E402

FIXTURES = Path(__file__).parent.parent / "test" / "fixtures"
MAX_TOKENS = 128
SPECIAL = ["<pad>", "<eos>", "<bos>", "<unk>"]
# (content, lstrip): what Gemma's tokenizer adds, in small.
ADDED = [("<mask>", True), ("<b>", False), ("</b>", False), ("<unused3>", False), ("\t\t", False), ("\t\t\t\t", False), ("\n\n", False)]
# Texts too large to commit, built the same way by the tests (embedder.test.ts): a whitespace run that an lstrip
# token takes, past the module's 256 KiB text buffer, and one of newlines that the newline-pair token takes, past the limit.
GENERATED = {"spaces-then-mask": " " * 262_144 + "<mask>", "newlines-then-mask": "Hallo" + "\n" * 300_000 + "<mask> Welt"}


def make_tokenizer(texts: list[str]) -> Tokenizer:
    tk = Tokenizer(models.BPE(unk_token="<unk>", byte_fallback=True, fuse_unk=True))
    tk.normalizer = normalizers.Replace(" ", "▁")
    tk.pre_tokenizer = pre_tokenizers.Metaspace(replacement="▁", prepend_scheme="always", split=True)
    tk.train_from_iterator(texts, trainers.BpeTrainer(vocab_size=260, special_tokens=SPECIAL, show_progress=False))
    tj = json.loads(tk.to_str())
    vocab = tj["model"]["vocab"]
    for piece in [f"<0x{b:02X}>" for b in range(256)] + [c for c, _ in ADDED]:
        vocab.setdefault(piece, len(vocab))
    tj["added_tokens"] = [
        {"id": vocab[c], "content": c, "single_word": False, "lstrip": ls, "rstrip": False, "normalized": False, "special": c in SPECIAL}
        for c, ls in [(s, False) for s in SPECIAL] + ADDED
    ]
    tk = Tokenizer.from_str(json.dumps(tj))
    tk.post_processor = processors.TemplateProcessing(single="<bos> $A <eos>", special_tokens=[("<bos>", vocab["<bos>"]), ("<eos>", vocab["<eos>"])])
    tk.decoder = decoders.Sequence([decoders.Replace("▁", " "), decoders.ByteFallback(), decoders.Fuse()])
    return tk


def main() -> None:
    texts = json.loads((FIXTURES / "texts.json").read_text())
    tricky = json.loads((FIXTURES / "tricky-strings.json").read_text())
    torch.manual_seed(1765)
    tk = make_tokenizer(texts)
    vocab = tk.get_vocab()
    cfg = ModernBertConfig(
        vocab_size=len(vocab),
        hidden_size=128,
        intermediate_size=64,
        num_hidden_layers=2,
        num_attention_heads=2,
        max_position_embeddings=MAX_TOKENS,
        layer_types=["full_attention", "sliding_attention"],
        local_attention=16,
        rope_parameters={"full_attention": {"rope_type": "default", "rope_theta": 160000.0}, "sliding_attention": {"rope_type": "default", "rope_theta": 10000.0}},
        pad_token_id=vocab["<pad>"],
        bos_token_id=vocab["<bos>"],
        eos_token_id=vocab["<eos>"],
        cls_token_id=vocab["<bos>"],
        sep_token_id=vocab["<eos>"],
        # Larger than the usual 0.02, so the layers change what goes through them as much as a trained model's do.
        initializer_range=0.2,
    )
    model = ModernBertModel(cfg).eval()
    with torch.no_grad():
        # Norm gains away from one, so folding them into the weights is tested.
        for name, p in model.named_parameters():
            if name.endswith("norm.weight"):
                p.copy_(1 + 0.3 * torch.randn_like(p))
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp)
        model.save_pretrained(src)
        tk.save(str(src / "tokenizer.json"))
        sizes = export(src, FIXTURES, float_files=True, calibration=None, max_tokens=MAX_TOKENS) | export(src, FIXTURES, float_files=False, calibration=texts, max_tokens=MAX_TOKENS)
        tk.enable_truncation(MAX_TOKENS)
        ref = ModernBertModel.from_pretrained(src, attn_implementation="eager", dtype=torch.float32).eval()
        embeddings = []
        for t in texts:
            ids = tk.encode(t).ids
            with torch.no_grad():
                v = ref(input_ids=torch.tensor([ids])).last_hidden_state[0].mean(0).double().numpy()
            embeddings.append({"text": t, "ids": ids, "vector": [round(float(x), 9) for x in v / np.linalg.norm(v)]})
        tokens = [{"text": t, "ids": tk.encode(t).ids} for t in tricky]
        generated = [{"name": name, "ids": tk.encode(text).ids} for name, text in GENERATED.items()]
    (FIXTURES / "reference.json").write_text(json.dumps({"embeddings": embeddings, "tokens": tokens, "generated": generated}, ensure_ascii=False))
    # What the tests' model descriptions name each file by.
    files = {name: {"sha256": hashlib.sha256((FIXTURES / name).read_bytes()).hexdigest(), "size": size} for name, size in sizes.items()}
    (FIXTURES / "files.json").write_text(json.dumps(files, indent=2) + "\n")
    print(sizes, "vocab", len(vocab), "longest text", max(len(e["ids"]) for e in embeddings), "tokens")


if __name__ == "__main__":
    main()
