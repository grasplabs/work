/**
 * Platform → AI's server functions (src/platform-ai.ts): reading the
 * platform's AI settings, and choosing them, as the staff member Access
 * vouches for; and what the features cost Grasp in all
 * (src/clients/platform-spend.ts).
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { platformSpend } from "./clients/platform-spend.ts";
import { adminDatabase } from "./db/act.ts";
import { platformKeyProviders } from "./deploy/context.ts";
import { platformAiView, setPlatformAi } from "./platform-ai.ts";

/** Platform → AI: the settings, and the providers that may be chosen. */
export const fetchPlatformAi = createServerFn({ method: "GET" }).handler(
  async () => await platformAiView(env)
);

/** Choosing each feature's provider and model. */
export const setPlatformAiFn = createServerFn({ method: "POST" })
  .validator(z.object({ settings: z.unknown() }))
  .handler(
    async ({ data, context }) =>
      await setPlatformAi(
        adminDatabase(env.DB),
        context.staff,
        data.settings,
        await platformKeyProviders(env)
      )
  );

/** What Grasp's own AI features cost in all, read from every active organization's core now. */
export const fetchPlatformSpend = createServerFn({ method: "GET" }).handler(
  async () => await platformSpend(env)
);
