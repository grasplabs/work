/**
 * The tiny test models in fixtures/ (scripts/make-fixture.py) as data:
 * each one's name and files. Apart from their bytes (test-models.ts), so
 * a test config in Node can name them too (core's, which ships the int8
 * one in its tests: apps/core/vite.config.ts).
 */
import type { EmbedModel } from "../src/model-files.ts";
import files from "./fixtures/files.json" with { type: "json" };

export const floatModel: EmbedModel = {
  name: "fixture-float",
  tokenizer: files["tokenizer.bin"],
  encoder: files["encoder-float.bin"],
  tokens: files["tokens-float.bin"],
};

export const int8Model: EmbedModel = {
  name: "fixture-int8",
  tokenizer: files["tokenizer.bin"],
  encoder: files["encoder-int8.bin"],
  tokens: files["tokens-int8.bin"],
};
