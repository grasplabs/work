/**
 * The type checker, as it runs in an isolate of its own: it type-checks
 * the App files it is handed against the kit's type chunks, with tsrs
 * (type-check.ts), and answers the diagnostics. It has no bindings and no
 * network, and keeps nothing between checks: every check is a fresh
 * instance of tsrs's module, so the isolate is shared by every App of a
 * release, and one that is recycled starts again under the same name.
 * Kept apart from the compiler's: tsrs takes about as much memory as the
 * compiler's transform, and together they would leave little before the
 * isolate's limit.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import types from "#types";

import { assertNoBindings } from "./authority.ts";
import type { Diagnostic } from "./diagnostic.ts";
import tsrsWasm from "./tsrs.wasm";
import { typeCheck } from "./type-check.ts";

/** A check as it comes over RPC: anything else is refused. */
const requestSchema = z.strictObject({
  files: z.record(z.string(), z.string()),
  options: z.record(z.string(), z.unknown()),
  allowed: z.array(z.string()).optional(),
  unreported: z.array(z.string()).optional(),
});

export default class TypeChecker extends WorkerEntrypoint {
  /** The diagnostics of `request`'s App files (type-check.ts `TypeCheckRequest`). */
  // RPC exposes prototype methods only, so this can't be static.
  check(request: unknown): Diagnostic[] {
    assertNoBindings(this.env, this.ctx.props, "The type checker");
    return typeCheck(tsrsWasm, types, requestSchema.parse(request));
  }
}
