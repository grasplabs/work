"""Makes the test fixtures (../test/fixtures): two tiny, random models of the same family as the real one, exported
into the embedder's model files, with the reference outputs the tests compare against. Run once; its output is
committed.

Both share a Gemma-style BPE tokenizer trained on texts.json (a few hundred pieces, every byte as a fallback token,
added tokens with and without lstrip), a width of 128, a window of +-8 tokens and at most 128 tokens, so the texts
are longer than the window and the longest is cut.
- fixtures/: 2 layers (global, then local, each with its own rotary base), two heads, a feed-forward width of 64.
- fixtures/deep/: 5 layers, local, global, local, local, global (so the first layer, which has no attention norm, is
  local), pruned layer by layer: one head in layer 2, a feed-forward width of 32 in layer 3.
- fixtures/trimmed/: the first model with a trimmed token table: a few pieces removed (TRIMMED), each written as the
  kept pieces that spell it (longest first, as training builds its maps), so one becomes two pieces, one three, and
  one is an added token. Its encoder-float.bin is the first model's, byte for byte, so it isn't stored twice. Its
  texts add, to texts.json, a removed piece first and last in a text, a text with none, and one that passes the
  length limit only once the map is applied.
The references come from Hugging Face tokenizers and transformers, in float32 with eager attention: token IDs for
texts.json and tricky-strings.json (strings from the tokenizer fuzz sets), and each text's mean-pooled,
L2-normalised embedding. For the trimmed model the reference tokenizer's IDs go through the map as training applies
it (export.py `mapped`), the model reads them, and the IDs recorded are the token table's rows.

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
from export import IDMAP, export, kept_pieces, load_model, mapped  # noqa: E402

FIXTURES = Path(__file__).parent.parent / "test" / "fixtures"
MAX_TOKENS = 128
SPECIAL = ["<pad>", "<eos>", "<bos>", "<unk>"]
# (content, lstrip): what Gemma's tokenizer adds, in small.
ADDED = [("<mask>", True), ("<b>", False), ("</b>", False), ("<unused3>", False), ("\t\t", False), ("\t\t\t\t", False), ("\n\n", False)]
# The pieces the trimmed fixture removes: "terdam" becomes "ter dam", "▁Rotterdam" (with "terdam" gone) "▁Rot ter dam",
# "▁contract" "▁contr act", and the added token "\t\t\t\t" two "\t\t".
TRIMMED = ["terdam", "▁Rotterdam", "▁contract", "\t\t\t\t"]
# Its texts beyond texts.json: a removed piece first, one last, none at all, a removed added token, and 70 x
# "▁Rotterdam" (72 pieces with <bos> and <eos>, 212 once mapped), cut at the limit only after the map.
TRIMMED_TEXTS = ["Rotterdam is where the warehouse is.", "We signed the contract", "Hallo", "tabs\t\t\t\tand tabs", "Rotterdam " * 70]


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

    def config(layer_types: list[str], std: float) -> ModernBertConfig:
        return ModernBertConfig(
            vocab_size=len(vocab),
            hidden_size=128,
            intermediate_size=64,
            num_hidden_layers=len(layer_types),
            num_attention_heads=2,
            max_position_embeddings=MAX_TOKENS,
            layer_types=layer_types,
            local_attention=16,
            rope_parameters={"full_attention": {"rope_type": "default", "rope_theta": 160000.0}, "sliding_attention": {"rope_type": "default", "rope_theta": 10000.0}},
            pad_token_id=vocab["<pad>"],
            bos_token_id=vocab["<bos>"],
            eos_token_id=vocab["<eos>"],
            cls_token_id=vocab["<bos>"],
            sep_token_id=vocab["<eos>"],
            # Larger than the usual 0.02, so the layers change what goes through them as much as a trained model's do.
            initializer_range=std,
        )

    def gains(model: ModernBertModel) -> None:
        with torch.no_grad():
            # Norm gains away from one, so folding them into the weights is tested.
            for name, p in model.named_parameters():
                if name.endswith("norm.weight"):
                    p.copy_(1 + 0.3 * torch.randn_like(p))

    model = ModernBertModel(config(["full_attention", "sliding_attention"], 0.2)).eval()
    gains(model)
    write(model, tk, FIXTURES, texts, tricky)

    # 0.15, not 0.2: through five random layers at 0.2, 8 bits lose more than through a trained model (cosine 0.96).
    std = 0.15
    deep = ModernBertModel(config(["sliding_attention", "full_attention", "sliding_attention", "sliding_attention", "full_attention"], std)).eval()
    linear = lambda i, o: torch.nn.init.normal_(torch.nn.Linear(i, o, bias=False).weight, std=std)  # noqa: E731
    with torch.no_grad():
        deep.layers[2].attn.Wqkv.weight = torch.nn.Parameter(linear(128, 3 * 64))
        deep.layers[2].attn.Wo.weight = torch.nn.Parameter(linear(64, 128))
        deep.layers[3].mlp.Wi.weight = torch.nn.Parameter(linear(128, 2 * 32))
        deep.layers[3].mlp.Wo.weight = torch.nn.Parameter(linear(32, 128))
    gains(deep)
    write(deep, tk, FIXTURES / "deep", texts, [])

    vocab = tk.get_vocab()
    removed = {vocab[p] for p in TRIMMED}
    kept = {p: i for p, i in vocab.items() if i not in removed}
    write(model, tk, FIXTURES / "trimmed", texts + TRIMMED_TEXTS, [], {vocab[p]: spelled(p, kept) for p in TRIMMED})
    # The encoder doesn't depend on the token table: the first model's float encoder, not a second copy.
    assert (FIXTURES / "trimmed" / "encoder-float.bin").read_bytes() == (FIXTURES / "encoder-float.bin").read_bytes()
    (FIXTURES / "trimmed" / "encoder-float.bin").unlink()


def spelled(piece: str, kept: dict[str, int]) -> list[int]:
    """`piece` as the kept pieces that spell it, longest first from the left, as training writes a removed piece."""
    out, at = [], 0
    while at < len(piece):
        size = next(n for n in range(len(piece) - at, 0, -1) if piece[at : at + n] in kept)
        out.append(kept[piece[at : at + size]])
        at += size
    return out


def write(
    model: ModernBertModel, tk: Tokenizer, out: Path, texts: list[str], tricky: list[str], decomp: dict[int, list[int]] | None = None
) -> None:
    """Exports `model` into `out` in both forms, with its references and the files' hashes; with `decomp`, with its
    token table trimmed by that map (idmap.json beside the checkpoint, as training writes it)."""
    tk = Tokenizer.from_str(tk.to_str())
    n = tk.get_vocab_size()
    # What the embedder reports: a row per piece, or a trimmed table's rows.
    row = {i: i for i in range(n)} if decomp is None else {p: r for r, p in enumerate(kept_pieces(n, decomp))}
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp)
        model.save_pretrained(src)
        tk.save(str(src / "tokenizer.json"))
        if decomp is not None:
            idmap = {"decomp": {str(k): v for k, v in decomp.items()}, "merges": [], "base": n, "n_keep": n - len(decomp)}
            (src / IDMAP).write_text(json.dumps(idmap))
        sizes = export(src, out, float_files=True, calibration=None, max_tokens=MAX_TOKENS) | export(src, out, float_files=False, calibration=texts, max_tokens=MAX_TOKENS)
        tk.enable_truncation(MAX_TOKENS)
        ref = load_model(src)
        embeddings = []
        model_ids = lambda t: mapped(tk.encode(t).ids, decomp or {}, MAX_TOKENS)  # noqa: E731
        for t in texts:
            ids = model_ids(t)
            with torch.no_grad():
                v = ref(input_ids=torch.tensor([ids])).last_hidden_state[0].mean(0).double().numpy()
            rows = [row[i] for i in ids]
            embeddings.append({"text": t, "ids": rows, "vector": [round(float(x), 9) for x in v / np.linalg.norm(v)]})
        tokens = [{"text": t, "ids": [row[i] for i in model_ids(t)]} for t in tricky]
    (out / "reference.json").write_text(json.dumps({"embeddings": embeddings, "tokens": tokens}, ensure_ascii=False))
    # What the tests' model descriptions name each file by.
    files = {name: {"sha256": hashlib.sha256((out / name).read_bytes()).hexdigest(), "size": size} for name, size in sizes.items()}
    (out / "files.json").write_text(json.dumps(files, indent=2) + "\n")
    print(out.name, sizes, "longest text", max(len(e["ids"]) for e in embeddings), "tokens")


if __name__ == "__main__":
    main()
