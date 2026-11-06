/**
 * Ultracite's lint and format of App code (ultracite.ts), in an isolate of
 * its own (`startUltracite`): no bindings, no network, as the compiler's.
 * Apart from the compiler's, so a lint never shares a build's CPU or
 * memory.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

import config from "#ultracite-config";

import { assertNoBindings } from "./authority.ts";
import type { Diagnostic } from "./diagnostic.ts";
import oxcWasm from "./oxc.wasm";
import { ultraciteOf } from "./ultracite.ts";

/** Made once per isolate, on its first call: oxc keeps nothing of a file. */
let ultracite: ReturnType<typeof ultraciteOf> | undefined;

const ultraciteHere = () => {
  ultracite ??= ultraciteOf(oxcWasm, config);
  return ultracite;
};

export default class UltraciteLinter extends WorkerEntrypoint {
  /**
   * `files` (by path in the App) as the agent's write saves them: its
   * TypeScript with what oxlint fixes safely fixed, and formatted, as
   * Ultracite would; every other file as it is; null for one to keep as
   * written (`Ultracite.tidy`).
   */
  tidy(files: Record<string, string>): Record<string, string | null> {
    assertNoBindings(this.env, this.ctx.props, "Ultracite's lint");
    return ultraciteHere().tidy(files);
  }

  /**
   * What each of `files`' TypeScript files, by path, is found to break,
   * in its place: Ultracite's rules, with the pages' own (page-rules.ts),
   * as an exported App's oxlint runs them. A check of its own, beside the
   * builds, each file's result kept by core; what it finds blocks a
   * proposal alone, never a build or a preview.
   */
  lint(files: Record<string, string>): Record<string, Diagnostic[]> {
    assertNoBindings(this.env, this.ctx.props, "Ultracite's lint");
    return ultraciteHere().lintCode(files);
  }
}
