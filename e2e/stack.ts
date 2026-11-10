/**
 * Where the e2e stack runs, apart from `vp run dev`'s and from every other
 * checkout's, so a run always starts empty, as in CI, and never tests a
 * server another worktree started.
 */
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

/**
 * Ports from 20000 up, six per checkout, picked by its path: parallel
 * worktrees each get their own, and none is dev's (8787 and 8788). Two
 * checkouts that land on the same six fail loudly, as Playwright never
 * reuses a server (playwright.config.ts); `E2E_PORT` then moves one.
 *
 * All below 32768, where Linux starts handing out ephemeral ports (the
 * local end of an outgoing connection, or a port 0 a process listens on):
 * the stack's own servers start at once and connect to each other, and
 * one took the fake AI providers' port as its local end before they
 * listened on it (EADDRINUSE on a CI runner, November 2026). macOS starts
 * at 49152.
 */
const firstPort = 20_000;
const ephemeralPorts = 32_768;
const portsEach = 6;
const portBlocks = Math.floor((ephemeralPorts - firstPort) / portsEach);
const hashed =
  firstPort +
  portsEach *
    (createHash("sha256").update(root).digest().readUInt32BE(0) % portBlocks);

const portOf = (value: string | undefined): number => {
  if (value === undefined) {
    return hashed;
  }
  const port = Number(value);
  // Its whole block below the ephemeral ports too, so an override can't
  // bring the race back.
  const highest = ephemeralPorts - portsEach;
  if (!Number.isInteger(port) || port < 1024 || port > highest) {
    throw new Error(
      `E2E_PORT must be a port from 1024 to ${highest}, below the ephemeral ports from ${ephemeralPorts}, not "${value}"`
    );
  }
  return port;
};

export const corePort = portOf(process.env.E2E_PORT);

/**
 * How many tests a stack runs at once (playwright.config.ts's `workers`),
 * locally as in CI's parts (scripts/e2e-parts.ts): one local dev server
 * serves every test, and more at once slow it past the tests' waits
 * (pages, live updates).
 */
export const workersPerStack = 2;
export const idpPort = corePort + 1;
/** The fake AI providers' (e2e/model-fake.ts). */
export const modelFakePort = corePort + 2;
/**
 * Each wrangler's inspector: core's (with connect's), and the IdP's. Left
 * to wrangler, both took the first free port from 9229 as they started at
 * once, and one then found it taken (November 2026).
 */
export const coreInspectorPort = corePort + 3;
export const idpInspectorPort = corePort + 4;
/**
 * The admin's dev server (playwright.admin.config.ts), on a stack of its
 * own, in this checkout's block like the rest.
 */
export const adminPort = corePort + 5;

export const origin = `http://localhost:${corePort}`;
export const idpOrigin = `http://localhost:${idpPort}`;
export const modelFakeOrigin = `http://localhost:${modelFakePort}`;

/**
 * The stack's local state (D1, Durable Objects, R2, KV), for core and
 * connect together. Emptied each time the stack starts; `vp run dev` keeps
 * its own in `.wrangler/state`.
 */
export const stateDir = path.join(root, "apps/core/.wrangler/e2e-state");

/**
 * The stack's empty state with every migration applied, as e2e/build.ts
 * makes it: a prebuilt stack starts from a copy, so it starts empty each
 * time too.
 */
export const migratedStateDir = path.join(
  root,
  "apps/core/.wrangler/e2e-state-migrated"
);

/**
 * Connect's Wrangler config for the stack, written before it starts
 * (e2e/connect-config.ts): connect's own, which sends the AI providers'
 * requests to the fake ones.
 */
export const connectConfig = path.join(
  root,
  "apps/connect/.wrangler/e2e/wrangler.json"
);

/**
 * The AI providers the stack's organization connects before any test, as
 * an admin does in Settings (`signInCast`, e2e/people.ts), and the models
 * it chooses: one that doesn't think, its default, and one that does, so
 * the composer offers how hard it thinks. Both have list prices, so AI
 * spend shows what they cost. Connect sends
 * their requests to the stack's fake providers, never to Mistral or
 * Anthropic (e2e/model-fake.ts), which answer an agent's turn in a chat
 * a script opens (e2e/model-scripts.ts) and refuse the key of any other
 * request (401), as a provider refuses one it doesn't know: the chat test
 * shows both, the refusal as the model failing to answer (e2e/chat.e2e.ts).
 */
export const e2eModel = "mistral/mistral-large-latest";
export const e2eThinkingModel = "anthropic/claude-sonnet-4-6";
export const e2eModelKey = "e2e-not-a-real-key";
