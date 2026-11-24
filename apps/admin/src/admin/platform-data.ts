/**
 * The Platform page's server functions (src/admin/platform-reads.ts reads
 * what they answer): only these here, so the browser's build of this file
 * keeps nothing of the reads.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { channelsProgress } from "../rollout/progress.ts";
import type { ChannelProgress } from "../rollout/progress.ts";
import { platformData } from "./platform-reads.ts";

/** The Platform page's channels, history and staff's actions. */
export const fetchPlatform = createServerFn({ method: "GET" }).handler(
  async () => await platformData(env)
);

/**
 * Each channel's progress alone, read again while a deploy moves on. The
 * rest of the Platform page, its AI spend above all (a read of every
 * company's core), stays as it was read.
 */
export const fetchChannels = createServerFn({ method: "GET" }).handler(
  async (): Promise<ChannelProgress[]> => {
    const { channels } = await channelsProgress(env);
    return channels;
  }
);
