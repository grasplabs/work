/**
 * Fails when the client state registry (@grasp-os/shared/state-registry)
 * and what the repo declares as client state differ: a D1 database or
 * table, a Durable Object class, binding or table, or an R2 bucket that
 * has no entry, or an entry for one that no longer exists. A client's
 * export enumerates its state from the registry (spec 46.1), so state it
 * doesn't list would be left behind when the client moves.
 */
import path from "node:path";

import { clientStateRegistry } from "@grasp-os/shared/state-registry";

import { coverageErrors } from "./state-coverage.ts";
import { foundStateOf } from "./state-found.ts";

const root = path.join(import.meta.dirname, "..");

const errors = coverageErrors(
  clientStateRegistry,
  foundStateOf(root, clientStateRegistry)
);

if (errors.length > 0) {
  console.error(
    `The client state registry (packages/shared/src/state-registry.ts) doesn't match the repo:\n${errors.map((line) => `  ${line}`).join("\n")}`
  );
  process.exit(1);
}
