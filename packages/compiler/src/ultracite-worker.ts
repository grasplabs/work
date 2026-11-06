/**
 * Ultracite's lint and format of App code (ultracite.ts), with the design
 * system's lint and the server code's (lint.ts, server-lint.ts), in an
 * isolate of its own (`startUltracite`): no bindings, no network, as the
 * compiler's.
 * Apart from the compiler's, so an isolate that only builds never loads
 * oxc.wasm, core reads it only to start this one, and a lint never shares
 * a build's CPU or memory.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

import designKit from "#design-kit";
import config from "#ultracite-config";

import { assertNoBindings } from "./authority.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { startOxcParser } from "./eslint-parser.ts";
import { isDesignLinted } from "./inputs.ts";
import { lintDesign } from "./lint.ts";
import oxcWasm from "./oxc.wasm";
import { lintServerCode } from "./server-lint.ts";
import { ultraciteOf } from "./ultracite.ts";

/** Made once per isolate, on its first call: oxc keeps nothing of a file. */
let ultracite: ReturnType<typeof ultraciteOf> | undefined;

const ultraciteHere = () => {
  if (ultracite === undefined) {
    ultracite = ultraciteOf(oxcWasm, config);
    startOxcParser(ultracite.parse);
  }
  return ultracite;
};

/** Where `a` is before `b` in its file. */
const byPlace = (a: Diagnostic, b: Diagnostic): number =>
  (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0);

/** Whether `diagnostic` says its file couldn't be linted at all: of no line. */
const isUnread = ({ line, rule }: Diagnostic): boolean =>
  line === undefined && rule === "lint";

/**
 * `found`, the lints' findings in one file, in their places, saying once
 * that it couldn't be read, should more than one lint say so (a file
 * nested too deep for oxc.wasm's stack is too deep for each).
 */
const together = (found: Diagnostic[]): Diagnostic[] => {
  const unread = found.find((diagnostic) => isUnread(diagnostic));
  return [
    ...(unread === undefined ? [] : [unread]),
    ...found.filter((diagnostic) => !isUnread(diagnostic)).toSorted(byPlace),
  ];
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
   * in its place: Ultracite's rules, the design system's of a page or a
   * component (lint.ts), and the server code's (server-lint.ts), as an
   * exported App's oxlint runs them all. A check of its own, beside the
   * builds, each file's result kept by core; what it finds blocks a
   * proposal alone, never a build or a preview. `app` is the App's
   * pages and components, which the design lint reads beside a page
   * (the App's own components it wraps the kit's in): `files`' own when
   * not given.
   */
  lint(
    files: Record<string, string>,
    app: Record<string, string> = files
  ): Record<string, Diagnostic[]> {
    assertNoBindings(this.env, this.ctx.props, "Ultracite's lint");
    const linted = ultraciteHere().lintCode(files);
    const code = Object.fromEntries(
      Object.entries(files).filter(([path]) => Object.hasOwn(linted, path))
    );
    const design = lintDesign(
      code,
      Object.fromEntries(
        Object.entries(app).filter(([path]) => isDesignLinted(path))
      ),
      designKit
    );
    const server = lintServerCode(code);
    return Object.fromEntries(
      Object.entries(linted).map(([path, found]) => [
        path,
        together([...found, ...(design[path] ?? []), ...(server[path] ?? [])]),
      ])
    );
  }
}
