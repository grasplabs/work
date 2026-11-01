/**
 * Where the e2e stack runs, apart from `vp run dev`'s and from every other
 * checkout's, so a run always starts empty, as in CI, and never tests a
 * server another worktree started.
 */
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

/**
 * Ports from 20000 up, three per checkout, picked by its path: parallel
 * worktrees each get their own, and none is dev's (8787 and 8788). Two
 * checkouts that land on the same three fail loudly, as Playwright never
 * reuses a server (playwright.config.ts); `E2E_PORT` then moves one.
 */
const firstPort = 20_000;
const portTriples = 5000;
const portsEach = 3;
const hashed =
  firstPort +
  portsEach *
    (createHash("sha256").update(root).digest().readUInt32BE(0) % portTriples);

const portOf = (value: string | undefined): number => {
  if (value === undefined) {
    return hashed;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_533) {
    throw new Error(
      `E2E_PORT must be a port from 1024 to 65533, not "${value}"`
    );
  }
  return port;
};

export const corePort = portOf(process.env.E2E_PORT);
export const idpPort = corePort + 1;
/** The fake AI providers' (e2e/model-fake.ts). */
export const modelFakePort = corePort + 2;

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
 * the composer offers how hard it thinks. Both have list prices, which
 * the stack's budgets need (playwright.config.ts): an OpenAI-compatible
 * endpoint's models have none, so no budget admits them. Connect sends
 * their requests to the stack's fake providers, never to Mistral or
 * Anthropic (e2e/model-fake.ts), which refuse the key (401), as a
 * provider refuses one it doesn't know: the chat test shows that as the
 * model failing to answer (e2e/chat.e2e.ts).
 */
export const e2eModel = "mistral/mistral-large-latest";
export const e2eThinkingModel = "anthropic/claude-sonnet-4-6";
export const e2eModelKey = "e2e-not-a-real-key";
