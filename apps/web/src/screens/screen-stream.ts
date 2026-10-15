import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { boundedRpcTarget } from "@grasp-os/shared/rpc-target";
import {
  appFunctionPath,
  rpcArgumentDepth,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import type { StreamCallAction } from "@grasp-os/shared/screens";

// The page's side of a screen's streaming action (spec 10.7.6, core's
// app-function-route.ts and action-invocation.ts): the request posted
// under the screen's lease, its frames read as JSON lines and handed to
// the frame one at a time. The frame's port drops a session that has
// more waiting unread than it holds (@grasp-os/shared/screen-port), so
// the page never sends a frame before the frame has answered the last
// one; meanwhile it reads no further, which holds core back too, where
// the invocation keeps only its latest progress. Of the lines already
// read, only the newest progress is handed on: each snapshot is whole.

/** A failure that isn't core's refusal, as the frame gets it. */
const callFailed = (): Error =>
  Object.assign(new Error("The call failed."), {
    code: "internal.unexpected",
  });

/** What the frame is told once the connection ends without a result. */
const closed = { type: "closed" } as const;

/** A frame core sent, parsed, or undefined for a line that isn't one. */
const parsedLine = (line: string): unknown => {
  try {
    const frame: unknown = JSON.parse(line);
    return frame;
  } catch {
    return undefined;
  }
};

/** Whether `frame` ends the stream: its result, or a refusal. */
const isTerminal = (frame: unknown): boolean =>
  typeof frame === "object" &&
  frame !== null &&
  "type" in frame &&
  (frame.type === "result" || frame.type === "refused");

/**
 * The frames worth handing on of `frames`, in order: the newest progress
 * only (each is whole), then the end, if there is one.
 */
const coalesced = (frames: readonly unknown[]): unknown[] => {
  const end = frames.find((frame) => isTerminal(frame));
  const progress = frames.findLast(
    (frame) => frame !== undefined && !isTerminal(frame)
  );
  return [
    ...(progress === undefined ? [] : [progress]),
    ...(end === undefined ? [] : [end]),
  ];
};

/**
 * Hands `body`'s frames to `deliver`, one at a time, until the result,
 * the end of the connection (then `{ type: "closed" }`) or `stop`.
 */
const relay = async (
  body: ReadableStream<Uint8Array>,
  deliver: (frame: unknown) => Promise<unknown>,
  stop: AbortController,
  onEnded: () => void
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let ended = false;
  try {
    while (!(ended || stop.signal.aborted)) {
      // oxlint-disable-next-line no-await-in-loop -- one chunk after another
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const frame of coalesced(lines.map((line) => parsedLine(line)))) {
        // oxlint-disable-next-line no-await-in-loop -- the next only once the frame took the last
        await deliver(frame);
        ended ||= isTerminal(frame);
      }
    }
    if (!(ended || stop.signal.aborted)) {
      await deliver(closed);
    }
  } catch {
    if (!stop.signal.aborted) {
      try {
        await deliver(closed);
      } catch {
        // The frame is gone.
      }
    }
  } finally {
    stop.abort();
    onEnded();
    try {
      await reader.cancel();
    } catch {
      // Closed already.
    }
  }
};

/** What a subscription's one method takes: nothing. */
const SubscriptionTarget = boundedRpcTarget({
  depth: rpcArgumentDepth,
  size: 1024,
});

/** A stream the frame follows: `release()` lets go of it. */
export class StreamSubscription extends SubscriptionTarget {
  readonly #stop: AbortController;

  constructor(stop: AbortController) {
    super();
    this.#stop = stop;
  }

  release(): void {
    this.#stop.abort();
  }

  // Dropped by the frame, or with its session: let go of all the same.
  [Symbol.dispose](): void {
    this.release();
  }
}

/** Who a stream's requests are for: the frame's lease and its person. */
interface Seat {
  readonly lease: string;
  readonly person: string;
}

/**
 * Posts `request` to `<app>/<what>` under the frame's lease, naming the
 * person it is for: core's response, or its refusal thrown.
 */
const post = async (
  app: string,
  { lease, person }: Seat,
  what: StreamCallAction,
  request: string,
  signal?: AbortSignal
): Promise<Response> => {
  let response: Response;
  try {
    response = await fetch(
      `${appFunctionPath}/${encodeURIComponent(app)}/${what}`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          [screenLeaseHeader]: lease,
          [screenPersonHeader]: person,
        },
        body: request,
        ...(signal === undefined ? {} : { signal }),
      }
    );
  } catch {
    throw callFailed();
  }
  if (response.ok) {
    return response;
  }
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    throw callFailed();
  }
  const payload = errorPayloadSchema.safeParse(answer);
  if (!payload.success) {
    throw callFailed();
  }
  throw Object.assign(new Error(payload.data.message), {
    code: payload.data.code,
  });
};

/**
 * Follows one of `app`'s streaming actions for the build `lease` names:
 * starts it (`stream`) or attaches to it again (`attach`), and hands its
 * frames to `deliver` (see the header). Answers its subscription once
 * core accepted the request; a refusal is thrown with its code.
 */
export const followStream = async (
  app: string,
  seat: Seat,
  what: "stream" | "attach",
  request: string,
  deliver: (frame: unknown) => Promise<unknown>,
  onEnded: () => void
): Promise<StreamSubscription> => {
  const stop = new AbortController();
  const response = await post(app, seat, what, request, stop.signal);
  if (response.body === null) {
    throw callFailed();
  }
  void relay(response.body, deliver, stop, onEnded);
  return new StreamSubscription(stop);
};

/** Cancels the invocation of `app`'s streaming action `request` names. */
export const cancelStream = async (
  app: string,
  seat: Seat,
  request: string
): Promise<unknown> => {
  const response = await post(app, seat, "cancel", request);
  try {
    const answer: unknown = await response.json();
    return answer;
  } catch {
    throw callFailed();
  }
};
