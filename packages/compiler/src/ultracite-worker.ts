/**
 * Ultracite's lint and format of App code (ultracite.ts), in an isolate of
 * its own (`startUltracite`): no bindings, no network, as the compiler's.
 * Its code, ESLint with the plugins of every rule and Prettier, is about as
 * large as the compiler's, so it is apart from it: an isolate that only
 * builds never loads it, core reads it only to start this one, and a lint
 * never shares a build's CPU or memory.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

import { assertNoBindings } from "./authority.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { lintCode, tidy } from "./ultracite.ts";

export default class UltraciteLinter extends WorkerEntrypoint {
  /**
   * `files` (by path in the App) as the agent's write saves them: its
   * TypeScript with what oxlint fixes safely fixed, and formatted, as
   * Ultracite would; every other file as it is.
   */
  async tidy(files: Record<string, string>): Promise<Record<string, string>> {
    assertNoBindings(this.env, this.ctx.props, "Ultracite's lint");
    return await tidy(files);
  }

  /**
   * What Ultracite's rules say of each of `files`' TypeScript files, by
   * path: a check of its own, beside the builds, each file's result kept
   * by core.
   */
  lint(files: Record<string, string>): Record<string, Diagnostic[]> {
    assertNoBindings(this.env, this.ctx.props, "Ultracite's lint");
    return lintCode(files);
  }
}
