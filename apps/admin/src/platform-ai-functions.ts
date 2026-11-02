/**
 * Platform → AI's server function: what Grasp's own AI features cost in
 * all, read from every active organization's core now
 * (src/clients/platform-spend.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { platformSpend } from "./clients/platform-spend.ts";

/** What Grasp's own AI features cost in all, read from every active organization's core now. */
export const fetchPlatformSpend = createServerFn({ method: "GET" }).handler(
  async () => await platformSpend(env)
);
