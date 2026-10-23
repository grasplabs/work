import { appLinksPath } from "@grasp-os/shared/app-link-limits";
import type { LinkIntent } from "@grasp-os/shared/app-link-limits";
import {
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screen-limits";

import type { CoreFetch } from "./file-channel.ts";
import { isPlainObject } from "./value-descriptor.ts";

// The page's side of core's link channel (core's app-link-route.ts): what
// the trusted page around a screen's frame asks core before it opens a
// link the frame asked for, and what a host's own bootstrap would ask. It
// speaks to core for one App's screen, under that screen's lease. Core
// decides, and answers the URL to open: the page opens that URL, never
// the one the frame sent, and never hands the frame more than the outcome.
// Nothing is sent again on a lost answer: an open is recorded, and the
// person can ask again.

/** One App's screen's link channel, under its lease. */
export interface LinkChannelOptions {
  readonly app: string;
  readonly lease: string;
  /**
   * The person the frame was opened for, named on every request so core
   * refuses one whose session is someone else's.
   */
  readonly person: () => Promise<string>;
  readonly fetch: CoreFetch;
}

/** What core decided of a link: the URL to open, its origin, the dialog. */
export interface LinkDecision {
  /** The URL as core parsed it: the one to open. */
  readonly url: string;
  /** Its origin, in ASCII: what the confirmation names. */
  readonly origin: string;
  /** Whether the person must confirm it, whatever they clicked. */
  readonly confirm: boolean;
}

/** Core's link channel for one screen (see the header). */
export interface LinkChannel {
  /** Whether `url` may open through `resource`, before the person is asked. */
  check: (
    resource: string,
    url: string,
    signal?: AbortSignal
  ) => Promise<LinkDecision>;
  /** Records `url` opened through `resource`, as the person asked for it. */
  open: (
    resource: string,
    url: string,
    intent: LinkIntent,
    signal?: AbortSignal
  ) => Promise<LinkDecision>;
}

/** A refusal core answered, with its code. */
const refusal = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

/** Core's decision, read as what it is. */
const decisionOf = (body: unknown): LinkDecision => {
  if (
    !isPlainObject(body) ||
    typeof body.url !== "string" ||
    typeof body.origin !== "string" ||
    typeof body.confirm !== "boolean"
  ) {
    throw new Error("Core's answer isn't a link decision.");
  }
  return { url: body.url, origin: body.origin, confirm: body.confirm };
};

/** The page's side of core's link channel for one App's screen. */
export const linkChannel = ({
  app,
  lease,
  person,
  fetch,
}: LinkChannelOptions): LinkChannel => {
  const send = async (
    resource: string,
    kind: "check" | "open",
    body: unknown,
    signal: AbortSignal | undefined
  ): Promise<LinkDecision> => {
    signal?.throwIfAborted();
    const response = await fetch(
      `${appLinksPath}/${encodeURIComponent(app)}/${encodeURIComponent(resource)}/${kind}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [screenLeaseHeader]: lease,
          [screenPersonHeader]: await person(),
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      }
    );
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (response.ok) {
      return decisionOf(payload);
    }
    if (
      isPlainObject(payload) &&
      typeof payload.code === "string" &&
      typeof payload.message === "string"
    ) {
      throw refusal(payload.code, payload.message);
    }
    throw new Error(`Core answered ${response.status}.`);
  };
  return {
    check: async (resource, url, signal) =>
      await send(resource, "check", { url }, signal),
    open: async (resource, url, intent, signal) =>
      await send(resource, "open", { url, intent }, signal),
  };
};
