import type { LinkChannel, LinkDecision } from "@grasp-os/sdk/host";
import type {
  LinkFailure,
  LinkIntent,
  PageLinkMessage,
} from "@grasp-os/shared/app-link-limits";
import { frameLinkMessageSchema, linkErrors } from "@grasp-os/shared/app-links";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// The page's side of a screen's link port (spec 10.7.7): what the page
// does with a link the frame asks it to open, through core's link channel
// (`LinkChannel`, the SDK's link-channel.ts), and what it answers. Core
// decides whether the URL may open; the page decides whether the person
// asked for it (decision 2 on GRA-259), and opens only the URL core
// answered. The frame hears only whether it was opened.
//
// - Asked for: the person's click in this frame, as downloads take it
//   (`frameGesture`, screen-files.ts: activation reaching the page from
//   the focused frame, never the page's own, one per click), taken as the
//   message arrives. Without one, or for an App that read restricted data
//   (core's `confirm`), the page asks in its own dialog, naming the origin
//   core checked, in ASCII; the frame puts nothing of its own in it. An
//   activation that lapsed while core answered asks too, rather than open
//   a window the browser would block.
// - Opened: by the page, in a browsing context of its own, with no opener
//   and no referrer; the frame never gets a handle on it.
// - Everything the frame sends is untrusted: each message is read against
//   `frameLinkMessageSchema` first; one that doesn't fit is refused as
//   `link.invalid` when it names its call, else dropped.

/** What the page needs to ask the person and open a link. */
export interface LinkPage {
  /** Takes the person's click in the frame, if they made one. */
  readonly take: () => boolean;
  /** Whether the page still has the person's activation, to open with. */
  readonly active: () => boolean;
  /**
   * Asks the person whether to open a link to `link.origin`, in the page's
   * own dialog, showing the whole URL too when it is given; rejects while
   * another question waits (`link.asking_paused`).
   */
  readonly confirm: (link: {
    readonly origin: string;
    readonly url?: string;
  }) => Promise<boolean>;
  /** Opens `url` in a context of its own, with no opener or referrer. */
  readonly open: (url: string) => void;
}

// The page's own refusals, in the person's language; core's are its own.
const failedRequest = msg`The request failed.`;
const notALink = msg`That isn't a link that can be opened.`;
const noLinksHere = msg`Links can't be opened here.`;
const notOpened = msg`The link wasn't opened.`;

/** A refusal of the page's own: its code, and its words in the person's language. */
const pageRefusal = (
  code: "link.invalid" | "link.unavailable" | "link.declined",
  message: MessageDescriptor
): Error => {
  const refusal = linkErrors.create(code);
  refusal.message = i18n._(message);
  return refusal;
};

/**
 * What the person is asked about a link core decided: its origin, and for
 * an App that read restricted data (core's `confirm`), the whole URL, so
 * they see what it would carry out.
 */
const asked = ({
  origin,
  url,
  confirm,
}: LinkDecision): { origin: string; url?: string } =>
  confirm ? { origin, url } : { origin };

/** How a refusal reaches the frame: its code and message, nothing else. */
const failureOf = (error: unknown): LinkFailure => {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return { code: error.code, message: error.message };
  }
  return { code: "internal.unexpected", message: i18n._(failedRequest) };
};

/** The call number a message the page refused names, if it names one. */
const callOf = (data: unknown): number | undefined =>
  typeof data === "object" &&
  data !== null &&
  "call" in data &&
  Number.isSafeInteger(data.call) &&
  typeof data.call === "number" &&
  data.call >= 0
    ? data.call
    : undefined;

/**
 * Opens `url` as a link the person followed out of the page: a new
 * browsing context, with no opener and no referrer.
 */
export const openOutside = (url: string): void => {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.referrerPolicy = "no-referrer";
  anchor.click();
};

/**
 * Answers the frame on `port` with what `channel` decides and `page`
 * asks and opens; with `channel` undefined (a draft's preview), every
 * open is refused. Returns a function that closes the port and stops
 * every open under way.
 */
export const openLinkPort = (
  port: MessagePort,
  channel: LinkChannel | undefined,
  page: LinkPage
): (() => void) => {
  /** Each open under way's stop, by its call. */
  const stops = new Map<number, AbortController>();
  const send = (message: PageLinkMessage): void => {
    port.postMessage(message);
  };
  const opened = async (
    use: LinkChannel,
    resource: string,
    url: string,
    clicked: boolean,
    signal: AbortSignal
  ): Promise<void> => {
    const checked = await use.check(resource, url, signal);
    const intent: LinkIntent =
      clicked && !checked.confirm && page.active()
        ? "activation"
        : "confirmation";
    /** Whether the person was shown the whole URL already. */
    let shownWhole = false;
    if (intent === "confirmation") {
      const question = asked(checked);
      shownWhole = question.url !== undefined;
      if (!(await page.confirm(question))) {
        throw pageRefusal("link.declined", notOpened);
      }
      signal.throwIfAborted();
    }
    // Core decides again, and records it: what it answers is what opens.
    let decided = await use.open(resource, url, intent, signal);
    signal.throwIfAborted();
    // The activation it opens with (the click in the frame, or on the
    // dialog's Open) may have lapsed while core answered: ask (again),
    // rather than open a window the browser would block unseen. Core
    // recorded what it accepted; the person decides whether it opens. An
    // App that read restricted data since the person saw only the origin
    // asks again too, showing the whole URL.
    /**
     * Asks the person about `decision`, then core again at the moment they
     * confirm: they may have read the dialog for a long while, so a link
     * whose permission (or App's release) was revoked meanwhile opens
     * nothing, and what core answers now is what opens. A frame that ended
     * meanwhile aborted `signal`, so its confirmation counts for nothing.
     */
    const confirmedNow = async (
      decision: LinkDecision
    ): Promise<LinkDecision> => {
      const question = asked(decision);
      shownWhole ||= question.url !== undefined;
      if (!(await page.confirm(question))) {
        throw pageRefusal("link.declined", notOpened);
      }
      signal.throwIfAborted();
      const now = await use.check(resource, url, signal);
      signal.throwIfAborted();
      return now;
    };
    /** Whether opening now needs the person's say first. */
    const mustAsk = (): boolean =>
      !page.active() || (decided.confirm && !shownWhole);
    if (mustAsk()) {
      decided = await confirmedNow(decided);
      // Once more if the dialog's own activation lapsed while core decided
      // again (a slow answer), or to show the whole URL of an App that read
      // restricted data meanwhile.
      if (mustAsk()) {
        decided = await confirmedNow(decided);
        // Still without an activation to open with, or with more to show:
        // refused, never answered as opened when the browser would block
        // the tab unseen.
        if (mustAsk()) {
          throw pageRefusal("link.declined", notOpened);
        }
      }
    }
    page.open(decided.url);
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    // Taken as the message arrives, before anything is awaited: the
    // person's click is the one that sent it.
    const clicked = page.take();
    const parsed = frameLinkMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      const call = callOf(event.data);
      if (call !== undefined) {
        send({
          type: "failed",
          call,
          error: failureOf(pageRefusal("link.invalid", notALink)),
        });
      }
      return;
    }
    const { call, resource, url } = parsed.data;
    if (channel === undefined) {
      send({
        type: "failed",
        call,
        error: failureOf(pageRefusal("link.unavailable", noLinksHere)),
      });
      return;
    }
    // A call number already under way is refused: each open is tracked,
    // and stopped with the port, under its own number.
    if (stops.has(call)) {
      send({
        type: "failed",
        call,
        error: failureOf(pageRefusal("link.invalid", notALink)),
      });
      return;
    }
    const stop = new AbortController();
    stops.set(call, stop);
    void (async () => {
      try {
        await opened(channel, resource, url, clicked, stop.signal);
        if (!stop.signal.aborted) {
          send({ type: "opened", call });
        }
      } catch (error) {
        if (!stop.signal.aborted) {
          send({ type: "failed", call, error: failureOf(error) });
        }
      } finally {
        stops.delete(call);
      }
    })();
  };
  port.addEventListener("message", onMessage);
  port.start();
  return () => {
    port.removeEventListener("message", onMessage);
    // An open under way when the port closes is answered as one that
    // can't go on here, so its caller in the frame never waits for ever.
    for (const [call, stop] of stops) {
      send({
        type: "failed",
        call,
        error: failureOf(pageRefusal("link.unavailable", noLinksHere)),
      });
      stop.abort();
    }
    stops.clear();
    port.close();
  };
};
