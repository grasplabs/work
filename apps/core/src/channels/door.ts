/**
 * The chat platforms people reach Stephen through, each a Chat SDK
 * adapter that checks every request it is handed as really sent by its
 * platform before anything reaches a handler (src/channels/teams.ts).
 * Every adapter here must have such a check: core's tests send each an
 * unsigned request and expect it refused.
 *
 * Teams' adapter sends through axios, which workerd refuses as it builds
 * its requests: `@grasp-os/chat/workerd` puts the fix in, so it is
 * imported before any adapter loads.
 */
import "@grasp-os/chat/workerd";
import { teamsAdapter } from "./teams.ts";

/** Every platform's adapter, keyed by the platform's name. */
export const channelAdapters = (env: Env) => ({
  teams: teamsAdapter(env),
});
