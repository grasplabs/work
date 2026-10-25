import {
  channelErrors,
  channelKeyLimits,
  channelKeyPlatformSchema,
  channelSigningKeySchema,
  channelSigningKeysSchema,
} from "@grasp-os/shared/channel-keys";
import type {
  ChannelKeyPlatform,
  ChannelSigningKey,
  ChannelSigningKeys,
} from "@grasp-os/shared/channel-keys";
import { log } from "@grasp-os/shared/log";
import { z } from "zod";

// The keys a chat platform signs its requests to Grasp with, for core's
// channel door (core's src/channels), which checks every request against
// them and never fetches them itself: Microsoft's Bot Framework for Teams,
// and Google's for the Pub/Sub pushes that tell Gmail's door of new mail.
// Each platform's OpenID metadata names where its key set is.
//
// Threat model, and how each is closed:
//
// - Being sent elsewhere. Only the metadata's fixed URL is asked; the key
//   set's URL it names is followed only over HTTPS to the same host, on
//   the default port, with no credentials in it. Redirects aren't
//   followed: an answer that redirects is refused. A host that names
//   another key set could otherwise have core trust keys it made.
// - Credentials leaving. Nothing of a client's is sent: the requests carry
//   no token, no cookie and nothing core asked with but the platform.
// - Answers too large or too slow. Each answer is read up to
//   `channelKeyLimits.answerBytes`, counted as it arrives; each request
//   has a timeout.
// - Passing on more than a check needs. Only an RSA key's id, modulus,
//   exponent and the channels it is endorsed for are passed on, each
//   checked; anything else in a key is dropped, and a key that isn't one
//   is left out.
// - A failure read as "no keys". Either fetch failing is
//   `channel.keys_unavailable`, never an empty key set, so core refuses
//   every request rather than caching nothing.

/**
 * Each platform's OpenID metadata, the one URL asked first, and the one
 * host its key set may be on.
 */
const sources = {
  teams: {
    metadata: new URL(
      "https://login.botframework.com/v1/.well-known/openidconfiguration"
    ),
    keysHost: "login.botframework.com",
  },
  gmail: {
    metadata: new URL(
      "https://accounts.google.com/.well-known/openid-configuration"
    ),
    keysHost: "www.googleapis.com",
  },
} as const satisfies Record<
  ChannelKeyPlatform,
  { metadata: URL; keysHost: string }
>;

/** How long one request for the keys may take. */
const requestTimeoutMs = 10_000;

/** Whether the key set's URL stays on the platform's own host. */
const onKeysHost = (url: URL, keysHost: string): boolean =>
  url.protocol === "https:" &&
  url.hostname === keysHost &&
  url.port === "" &&
  url.username === "" &&
  url.password === "";

const metadataSchema = z.object({ jwks_uri: z.string().max(2048) });

/** A key as the key set holds it, before it is narrowed down. */
const sentKeySchema = z.object({
  kty: z.string(),
  kid: z.unknown(),
  n: z.unknown(),
  e: z.unknown(),
  endorsements: z.unknown().optional(),
});

const sentKeySetSchema = z.object({ keys: z.array(z.unknown()).max(256) });

const unavailable = (reason: string): Error => {
  log.warn("channel.keys_unavailable", { reason });
  return channelErrors.create("channel.keys_unavailable");
};

/** The body's text, read up to the answer limit, counted as it arrives. */
const readCapped = async (response: Response): Promise<string> => {
  const { body } = response;
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<unknown>;
    try {
      // Each chunk is read in turn: the count decides whether to read on.
      // oxlint-disable-next-line no-await-in-loop
      chunk = await reader.read();
    } catch {
      throw unavailable("cut_off");
    }
    if (chunk.done) {
      break;
    }
    const value: unknown = chunk.value;
    total += value instanceof Uint8Array ? value.byteLength : 0;
    if (
      !(value instanceof Uint8Array) ||
      total > channelKeyLimits.answerBytes
    ) {
      // oxlint-disable-next-line no-await-in-loop
      await reader.cancel();
      throw unavailable("too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

/** `url`'s answer as JSON, asked without credentials, redirects refused. */
const fetchJson = async (url: URL): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    throw unavailable("unreachable");
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw unavailable(`status_${response.status}`);
  }
  const text = await readCapped(response);
  try {
    return JSON.parse(text);
  } catch {
    throw unavailable("unreadable");
  }
};

/** The key set's URL the metadata names, if it is one connect follows. */
const keySetUrl = (metadata: unknown, keysHost: string): URL => {
  const parsed = metadataSchema.safeParse(metadata);
  if (!parsed.success || !URL.canParse(parsed.data.jwks_uri)) {
    throw unavailable("metadata_unreadable");
  }
  const url = new URL(parsed.data.jwks_uri);
  if (!onKeysHost(url, keysHost)) {
    // The URL isn't logged: a host that names another could name anything.
    throw unavailable("jwks_uri_refused");
  }
  return url;
};

/** What of `key` is passed on, or `undefined` when it isn't an RSA key. */
const narrowed = (key: unknown): ChannelSigningKey | undefined => {
  const sent = sentKeySchema.safeParse(key);
  if (!sent.success || sent.data.kty !== "RSA") {
    return undefined;
  }
  const { kid, kty, n, e, endorsements } = sent.data;
  const parsed = channelSigningKeySchema.safeParse({
    kid,
    kty,
    n,
    e,
    endorsements: endorsements ?? [],
  });
  return parsed.success ? parsed.data : undefined;
};

/**
 * The keys `platform` signs its requests to Grasp with, as it publishes
 * them now: `channel.invalid` for a platform connect doesn't fetch keys
 * for, `channel.keys_unavailable` when they can't be read.
 */
export const channelSigningKeys = async (
  platform: unknown
): Promise<ChannelSigningKeys> => {
  const source =
    sources[
      channelErrors.parse("channel.invalid", channelKeyPlatformSchema, platform)
    ];
  const keySet = sentKeySetSchema.safeParse(
    await fetchJson(
      keySetUrl(await fetchJson(source.metadata), source.keysHost)
    )
  );
  if (!keySet.success) {
    throw unavailable("keys_unreadable");
  }
  const keys = keySet.data.keys
    .map(narrowed)
    .filter((key) => key !== undefined)
    .slice(0, channelKeyLimits.keys);
  return channelSigningKeysSchema.parse({ keys });
};
