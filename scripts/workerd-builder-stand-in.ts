/**
 * What the package builder's on-prem tests (workerd-sandbox-builds*.test.ts)
 * share: a stand-in core (apps/core/test/workerd/builds-worker.ts) that runs
 * the same `runBuilder` a build runs, with `SANDBOX_HOST` bound to a
 * supervisor (workerd-sandbox.ts) and the builder core's build makes, and
 * what it answers. Split into files so their waits for a builder's deadline
 * run on different workers and shards.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import { z } from "zod";

import { serveStandIn } from "./workerd-stand-in.ts";
import { tempDir } from "./workerd-test-server.ts";

const repo = path.join(import.meta.dirname, "..");

/** How long core may take to answer another request meanwhile. */
export const ANSWER_MS = 500;

/**
 * How long a builder's call may take on the sandbox host here: longer than
 * a session waits for its owner's room (3 s), so a second call gives up
 * waiting while the first still holds the owner's share.
 */
export const DEADLINE_MS = 6000;

export const outcomeSchema = z.object({
  status: z.enum(["ok", "bound", "unavailable", "failed"]),
  value: z.unknown().optional(),
  error: z.string().optional(),
  httpStatus: z.number().nullable().optional(),
  ms: z.number(),
});

export type Outcome = z.infer<typeof outcomeSchema>;

/** What the stand-in says of each module a build returned. */
export const builtModulesSchema = z
  .array(
    z.object({ entry: z.string(), bytes: z.number(), holdsExport: z.boolean() })
  )
  .min(1);

let built: string | undefined;

/**
 * The builder as core's build makes it, esbuild and all: only the
 * builder, not the rest of a release. Built once per file, into a
 * directory `cleanUp` removes.
 */
const builder = (): string => {
  if (built === undefined) {
    const dir = tempDir();
    execFileSync(
      process.execPath,
      [path.join(repo, "packages/compiler/build-package-builder.ts"), dir],
      { cwd: path.join(repo, "packages/compiler"), stdio: "ignore" }
    );
    built = dir;
  }
  return built;
};

/** A stand-in core on the supervisor at `socket`: its URL. */
export const serveBuilderStandIn = async (socket: string): Promise<string> => {
  const dir = builder();
  return await serveStandIn(
    "builds-worker.ts",
    socket,
    { SANDBOX_DEADLINE_MS: String(DEADLINE_MS) },
    { PACKAGE_BUILDER: path.join(dir, "package-builder.js") },
    { ESBUILD_WASM: path.join(dir, "esbuild.wasm") }
  );
};

/** Asks the stand-in at `url` for `route` with `query`: how it went. */
export const callStandIn = async (
  query: string,
  route: string,
  url: string
): Promise<Outcome> => {
  const response = await fetch(`${url}${route.slice(1)}?${query}`, {
    method: "POST",
  });
  return outcomeSchema.parse(await response.json());
};
