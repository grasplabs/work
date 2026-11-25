/**
 * The Voice Lab's server functions (src/admin/voice-lab.ts), behind the
 * Access check every request passes (src/access.ts): a session is opened
 * as the verified staff member the request comes from.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import {
  closeVoiceSession,
  openVoiceSession,
  voiceLabInputSchema,
  voiceSessionIdSchema,
} from "./voice-lab.ts";
import type { VoiceLabSession } from "./voice-lab.ts";

export const openVoiceSessionFn = createServerFn({ method: "POST" })
  .validator(voiceLabInputSchema)
  .handler(
    async ({ data, context }): Promise<VoiceLabSession> =>
      await openVoiceSession(env, context.staff, data)
  );

export const closeVoiceSessionFn = createServerFn({ method: "POST" })
  .validator(z.object({ sessionId: voiceSessionIdSchema }))
  .handler(async ({ data }): Promise<void> => {
    await closeVoiceSession(env, data.sessionId);
  });
