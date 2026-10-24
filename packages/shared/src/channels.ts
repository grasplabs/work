import { chatPlatformSchema } from "./chat.ts";
import type { ChatChannel } from "./chat.ts";

// The door chat platforms post to (core's src/channels/door.ts): one path
// per platform, `/api/channels/<platform>`, reached without a session, as
// each platform's webhook. Each request is checked as sent by its platform
// for the client's own bot before anything of it is read; the router limits
// the path per client address (`CHANNELS_RATE_LIMIT`).

/** Where every chat platform posts, under its own name. */
export const channelsApiPath = "/api/channels";

/** The path a platform posts to. */
export const channelPath = (platform: Exclude<ChatChannel, "web">): string =>
  `${channelsApiPath}/${platform}`;

const platformSegment = /^\/api\/channels\/(?<platform>[^/]+)$/u;

/**
 * The platform `pathname` is the door of, or undefined when it isn't one:
 * a path outside `/api/channels/`, or a segment that is no platform's name.
 */
export const channelPlatformOf = (pathname: string): string | undefined => {
  const platform = platformSegment.exec(pathname)?.groups?.platform;
  return chatPlatformSchema.safeParse(platform).success ? platform : undefined;
};
