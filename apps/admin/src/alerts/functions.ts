/**
 * The alert channels' server functions (src/alerts/channels.ts), behind
 * the Access check every request passes (src/access.ts): read on
 * Platform's Maintenance page, switched and tested there as the verified
 * staff member the request comes from.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { alertChannelIds } from "./alert-channels.ts";
import {
  alertChannelStates,
  sendTestAlert,
  switchAlertChannel,
} from "./channels.ts";

const channelSchema = z.object({ channel: z.enum(alertChannelIds) });

export const fetchAlertChannelsFn = createServerFn({ method: "GET" }).handler(
  async () => await alertChannelStates(env)
);

export const switchAlertChannelFn = createServerFn({ method: "POST" })
  .validator(channelSchema.extend({ on: z.boolean() }))
  .handler(async ({ data, context }) => {
    await switchAlertChannel(env, context.staff, data.channel, data.on);
  });

export const sendTestAlertFn = createServerFn({ method: "POST" })
  .validator(channelSchema)
  .handler(
    async ({ data, context }) =>
      await sendTestAlert(env, context.staff, data.channel)
  );
