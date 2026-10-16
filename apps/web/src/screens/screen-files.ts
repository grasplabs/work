import type { FileChannel } from "@grasp-os/sdk/host";
import {
  downloadNameOf,
  fileLimits,
  fitsPreview,
  isPreviewable,
} from "@grasp-os/shared/app-file-limits";
import type {
  FileFailure,
  FrameFileMessage,
  PageFileMessage,
} from "@grasp-os/shared/app-file-limits";
import { frameFileMessageSchema } from "@grasp-os/shared/app-files";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// The page's side of a screen's file port (spec 10.7.5): what the page
// does with the files the frame hands it, through core's file channel
// (`FileChannel`, the SDK's file-channel.ts), and what it answers. The
// frame never gets a URL, a lease or a request of core's: only a file's
// ID, its description and preview, or a coded refusal.
//
// Everything the frame sends is untrusted: each message is read against
// `frameFileMessageSchema` before anything else; one that doesn't fit is
// refused as `file.invalid` when it names its call, else dropped. A frame
// has at most `fileLimits.frameTransfers` calls under way; more wait in
// order, at most `fileLimits.frameQueued` of them (more are refused,
// `file.busy`), and one the frame stops while it waits never starts. A
// preview is fetched only
// for a type that may be previewed, within the preview's bound, and is
// handed over as a `Blob`. A download, only right after a click in the
// frame, goes to the browser's own download, under `downloadNameOf` its name,
// from a URL of the page's that is revoked once the browser took it.

/** What a frame has under way: each call's stop, by number. */
type Calls = Map<number, AbortController>;

// The page's own refusals, in the person's language; core's are its own.
const failedRequest = msg`The request failed.`;
const notAFileCall = msg`That isn't a file call.`;
const uploadCancelled = msg`The upload was cancelled.`;
const clickToDownload = msg`A file is downloaded only when you ask for it, with a click.`;
const previewKeepsNoFiles = msg`A preview keeps no files.`;
const tooManyFiles = msg`Too many files are moving at once. Try again shortly.`;

/** How a refusal reaches the frame: its code and message, nothing else. */
const failureOf = (error: unknown): FileFailure => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error instanceof Error
  ) {
    return { code: error.code, message: error.message };
  }
  // A lost answer, as the client reads one (`internal.unexpected`).
  return { code: "internal.unexpected", message: i18n._(failedRequest) };
};

/** The bytes of a readable file, if it may be previewed in a frame. */
const previewOf = async (
  channel: FileChannel,
  resource: string,
  file: string,
  signal: AbortSignal
) => {
  const description = await channel.describe(resource, file, signal);
  if (!isPreviewable(description.mimeType, description.size)) {
    return { description, preview: null };
  }
  const response = await channel.preview(resource, file, signal);
  const preview = await response.blob();
  // Within the bound in bytes, and in pixels as its header declares them:
  // a small file can decode to an image too large for the tab.
  const fits =
    preview.size <= fileLimits.previewBytes &&
    fitsPreview(
      description.mimeType,
      new Uint8Array(await preview.arrayBuffer())
    );
  return { description, preview: fits ? preview : null };
};

/**
 * Hands file `file` to the browser's own download, as its name: a URL of
 * the page's own for the bytes core sent, revoked once the browser took
 * it.
 */
const download = async (
  channel: FileChannel,
  resource: string,
  file: string,
  signal: AbortSignal
): Promise<void> => {
  const { name, mimeType } = await channel.describe(resource, file, signal);
  const response = await channel.content(resource, file, signal);
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = downloadNameOf(name, mimeType);
    link.rel = "noopener";
    link.click();
  } finally {
    // The browser took the URL with the click; it needs it no longer.
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
};

/** The call number a message the page refused names, if it names one. */
const callOf = (data: unknown): number | undefined =>
  typeof data === "object" &&
  data !== null &&
  "call" in data &&
  typeof data.call === "number" &&
  Number.isSafeInteger(data.call) &&
  data.call >= 0
    ? data.call
    : undefined;

/** A call the frame makes, as opposed to stopping one. */
type FileCall = Exclude<FrameFileMessage, { type: "cancel" | "stop" }>;

/** Whether `message` makes a call, rather than stopping one. */
const isCall = (message: FrameFileMessage): message is FileCall =>
  message.type !== "cancel" && message.type !== "stop";

/**
 * What `message` asks of the file channel, answered as the frame reads
 * it; `stop` stops it (a deletion apart: one sent goes on, and its
 * outcome is core's durable record of it).
 */
const workOf =
  (
    message: FileCall,
    stop: AbortSignal,
    send: (message: PageFileMessage) => void
  ) =>
  async (files: FileChannel): Promise<PageFileMessage> => {
    const { call } = message;
    switch (message.type) {
      case "upload": {
        return {
          type: "uploaded",
          call,
          file: await files.upload(
            message.resource,
            message.file,
            message.name,
            {
              cancel: stop,
              onProgress: (progress) => {
                send({ type: "progress", call, ...progress });
              },
            }
          ),
        };
      }
      case "read": {
        return {
          type: "read",
          call,
          ...(await previewOf(files, message.resource, message.file, stop)),
        };
      }
      case "download": {
        await download(files, message.resource, message.file, stop);
        return { type: "done", call };
      }
      case "delete": {
        await files.delete(
          message.resource,
          message.file,
          message.idempotencyKey
        );
        return { type: "done", call };
      }
      default: {
        throw new Error("Not a call the frame makes.");
      }
    }
  };

/** How often a spent activation is looked at, for when it ends. */
const activationWatchMs = 250;

/**
 * The events by which the page itself gains activation (a click or a key
 * on the page, outside every frame): a click or a key inside a frame
 * reaches the frame's own document, never the page's.
 */
const pageActivationEvents = [
  "keydown",
  "mousedown",
  "pointerdown",
  "pointerup",
  "touchend",
] as const;

/** What a frame's download gesture is read from, as the browser shows it. */
export interface GesturePage {
  /** Where the page's own input arrives: its window. */
  readonly events: EventTarget;
  /** Whether the page has transient activation now. */
  readonly active: () => boolean;
  /** What the page has focused now. */
  readonly focused: () => unknown;
}

/**
 * Whether the person asked for a download in `frame`: the page has
 * activation, `frame` is focused, and that activation isn't the page's
 * own. A frame can focus itself, so focus alone would let it borrow a
 * click elsewhere on the page; activation the page gained from its own
 * input counts for no frame until it ends. Returns the check and a
 * function that stops listening.
 */
export const frameGesture = (
  frame: unknown,
  page: GesturePage
): { readonly asked: () => boolean; readonly close: () => void } => {
  let pageOwn = false;
  let watching: ReturnType<typeof setInterval> | undefined;
  const own = (): void => {
    pageOwn = true;
    clearInterval(watching);
    watching = setInterval(() => {
      if (!page.active()) {
        pageOwn = false;
        clearInterval(watching);
      }
    }, activationWatchMs);
  };
  for (const type of pageActivationEvents) {
    page.events.addEventListener(type, own, { capture: true });
  }
  // An activation the page has already, as the frame opens (a click that
  // opened it), is the page's: it counts for the frame no more than one
  // that comes after.
  if (page.active()) {
    own();
  }
  return {
    asked: () => !pageOwn && page.active() && page.focused() === frame,
    close: () => {
      clearInterval(watching);
      for (const type of pageActivationEvents) {
        page.events.removeEventListener(type, own, { capture: true });
      }
    },
  };
};

/**
 * Answers the frame on `port` with what `channel` does, for a running
 * App's screen; with `channel` undefined (a draft's preview), every call
 * is refused. Returns a function that closes the port and stops every call
 * under way.
 */
export const openFilePort = (
  port: MessagePort,
  channel?: FileChannel,
  asked: () => boolean = () => false
): (() => void) => {
  const calls: Calls = new Map();
  /**
   * Whether the activation the page has now admitted a download already:
   * one click, one download. Spent until the activation ends, which the
   * page looks for while it is spent.
   */
  let spent = false;
  let watching: ReturnType<typeof setInterval> | undefined;
  const spend = (): void => {
    spent = true;
    clearInterval(watching);
    watching = setInterval(() => {
      if (!navigator.userActivation.isActive) {
        spent = false;
        clearInterval(watching);
      }
    }, activationWatchMs);
  };
  const send = (message: PageFileMessage): void => {
    port.postMessage(message);
  };
  const run = async (
    call: number,
    stop: AbortController,
    work: (channel: FileChannel) => Promise<PageFileMessage>
  ): Promise<void> => {
    try {
      if (channel === undefined) {
        throw Object.assign(new Error(i18n._(previewKeepsNoFiles)), {
          code: "file.unavailable",
        });
      }
      const answer = await work(channel);
      if (!stop.signal.aborted || answer.type === "uploaded") {
        send(answer);
      }
    } catch (error) {
      send({ type: "failed", call, error: failureOf(error) });
    } finally {
      calls.delete(call);
    }
  };

  /** Calls waiting for a transfer to end, in the order they came. */
  const waiting = new Map<number, FileCall>();
  /** Runs `message` now; once it ends, the call that waited longest. */
  const start = async (message: FileCall): Promise<void> => {
    const stop = new AbortController();
    calls.set(message.call, stop);
    await run(message.call, stop, workOf(message, stop.signal, send));
    const [next] = waiting.values();
    if (next !== undefined && calls.size < fileLimits.frameTransfers) {
      waiting.delete(next.call);
      await start(next);
    }
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    const read = frameFileMessageSchema.safeParse(event.data);
    if (!read.success) {
      // A call the page won't make is answered, never left waiting; one
      // that doesn't even name its call is dropped.
      const call = callOf(event.data);
      if (call !== undefined) {
        send({
          type: "failed",
          call,
          error: { code: "file.invalid", message: i18n._(notAFileCall) },
        });
      }
      return;
    }
    const message = read.data;
    if (!isCall(message)) {
      calls.get(message.call)?.abort();
      if (waiting.delete(message.call) && message.type === "cancel") {
        // An upload cancelled before it started: nothing reached core.
        send({
          type: "failed",
          call: message.call,
          error: {
            code: "file.cancelled",
            message: i18n._(uploadCancelled),
          },
        });
      }
      return;
    }
    if (calls.has(message.call) || waiting.has(message.call)) {
      return;
    }
    // A download only for a person who asked for it, in this frame:
    // `asked` says the page has transient activation (a click in the
    // frame gives it, activation reaching a frame's ancestors, which a
    // screen's code can't fake) and that the frame has the focus, so a
    // click elsewhere on the page admits none. One per activation: a
    // screen can't turn one click into many downloads.
    if (message.type === "download" && (spent || !asked())) {
      send({
        type: "failed",
        call: message.call,
        error: {
          code: "file.gesture_required",
          message: i18n._(clickToDownload),
        },
      });
      return;
    }
    if (message.type === "download") {
      spend();
    }
    if (calls.size < fileLimits.frameTransfers) {
      void start(message);
      return;
    }
    if (waiting.size < fileLimits.frameQueued) {
      waiting.set(message.call, message);
      return;
    }
    send({
      type: "failed",
      call: message.call,
      error: {
        code: "file.busy",
        message: i18n._(tooManyFiles),
      },
    });
  };
  port.addEventListener("message", onMessage);
  port.start();
  return () => {
    port.removeEventListener("message", onMessage);
    clearInterval(watching);
    waiting.clear();
    for (const stop of calls.values()) {
      stop.abort();
    }
    port.close();
  };
};
