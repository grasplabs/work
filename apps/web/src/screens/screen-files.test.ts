import { fileChannel } from "@grasp-os/sdk/host";
import { fileLimits } from "@grasp-os/shared/app-file-limits";
import { describe, expect, it } from "vite-plus/test";

import { frameGesture, openFilePort } from "./screen-files.ts";

// The page's side of a screen's file port: whatever the frame sends is
// answered, a call the page won't make with a coded refusal, so the
// frame's caller never waits on a message the page dropped.

/**
 * A file channel whose core answers what each file is (a PDF, so nothing
 * is previewed) once `release` is called, counting the requests it holds.
 */
const heldChannel = () => {
  const { promise: released, resolve: release } = Promise.withResolvers<null>();
  const asked: string[] = [];
  const seen = { now: 0, most: 0, asked };
  const channel = fileChannel({
    app: "app",
    lease: "lease",
    person: async () => await Promise.resolve("person"),
    fetch: async (path) => {
      const file = path.split("/").at(-1) ?? "";
      seen.asked.push(file);
      seen.now += 1;
      seen.most = Math.max(seen.most, seen.now);
      await released;
      seen.now -= 1;
      return Response.json({
        id: file,
        name: "notes.pdf",
        mimeType: "application/pdf",
        size: 1,
      });
    },
  });
  return {
    channel,
    seen,
    release: () => {
      release(null);
    },
  };
};

/** How long a transfer waits for bytes in these tests, in ms. */
const stallMs = 100;

/**
 * A file channel whose core sends a file's bytes as `pieces`, one every
 * `everyMs`, then keeps the connection open sending nothing: as a browser
 * connection does that stalls, stopped only by the request's signal.
 */
const tricklingChannel = (pieces: number, everyMs: number) =>
  fileChannel({
    app: "app",
    lease: "lease",
    person: async () => await Promise.resolve("person"),
    chunkMs: stallMs,
    fetch: async (_path, init) => {
      const { signal } = init;
      let sent = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          timer = setInterval(() => {
            if (sent < pieces) {
              sent += 1;
              controller.enqueue(new Uint8Array([sent]));
            }
          }, everyMs);
          signal?.addEventListener("abort", () => {
            clearInterval(timer);
            controller.error(signal.reason);
          });
        },
        cancel: () => {
          clearInterval(timer);
        },
      });
      return await Promise.resolve(new Response(body));
    },
  });

/** `promise`'s outcome, or "still waiting" after `ms`. */
const within = async (promise: Promise<unknown>, ms: number) => {
  const { promise: late, resolve } = Promise.withResolvers<string>();
  const timer = setTimeout(() => {
    resolve("still waiting");
  }, ms);
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** The frame's end of a port the page answers through `channel`. */
const frameOf = (channel: ReturnType<typeof fileChannel>) => {
  const { port1: port, port2: page } = new MessageChannel();
  const close = openFilePort(page, channel);
  const answers: unknown[] = [];
  port.addEventListener("message", (event: MessageEvent<unknown>) => {
    answers.push(event.data);
  });
  port.start();
  return {
    post: (message: unknown) => {
      port.postMessage(message);
    },
    answers,
    close: () => {
      close();
      port.close();
    },
  };
};

/** Lets the ports deliver what was posted. */
const settle = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<null>();
  setTimeout(() => {
    resolve(null);
  }, 20);
  await promise;
};

/** Call `call`'s file: an ID as core mints them. */
const fileOf = (call: number): string =>
  `00000000-0000-4000-8000-${String(call).padStart(12, "0")}`;

const read = (call: number) => ({
  type: "read",
  call,
  resource: "attachments",
  file: fileOf(call),
});

/** The start of a PNG declaring `width` by `height` pixels. */
const pngOf = (width: number, height: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set(
    Array.from("IHDR", (letter) => letter.codePointAt(0) ?? 0),
    12
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

/** A file channel whose core holds one small PNG, `image`. */
const imageChannel = (image: Uint8Array<ArrayBuffer>) =>
  fileChannel({
    app: "app",
    lease: "lease",
    person: async () => await Promise.resolve("person"),
    fetch: async (path) => {
      if (path.endsWith("/preview")) {
        return await Promise.resolve(new Response(image));
      }
      return Response.json({
        id: path.split("/").at(-1) ?? "",
        name: "photo.png",
        mimeType: "image/png",
        size: image.length,
      });
    },
  });

describe("a screen's file port", () => {
  it("previews an image only while the pixels its header declares are within the bound", async () => {
    const previews: unknown[] = [];
    for (const image of [pngOf(640, 480), pngOf(100_000, 100_000)]) {
      const frame = frameOf(imageChannel(image));
      try {
        frame.post(read(1));
        // oxlint-disable-next-line no-await-in-loop -- one image at a time
        await expect
          .poll(() => frame.answers.length, { timeout: 2000 })
          .toBe(1);
        const [answer] = frame.answers;
        previews.push(
          typeof answer === "object" &&
            answer !== null &&
            "preview" in answer &&
            answer.preview instanceof Blob
        );
      } finally {
        frame.close();
      }
    }
    expect(previews).toStrictEqual([true, false]);
  });

  it("reads more files than transfers at once in turn, never refusing an ordinary list, and never starts one stopped while it waited", async () => {
    const { channel, seen, release } = heldChannel();
    const frame = frameOf(channel);
    try {
      // Twenty attachments, each read by its own reader; the last unmounts
      // while it waits.
      for (let call = 1; call <= 20; call += 1) {
        frame.post(read(call));
      }
      frame.post({ type: "stop", call: 20 });
      // An upload cancelled while it waits is answered as cancelled.
      frame.post({
        type: "upload",
        call: 21,
        resource: "attachments",
        file: new Blob(["notes"], { type: "text/plain" }),
        name: "notes.txt",
      });
      frame.post({ type: "cancel", call: 21 });
      // Answered once the ports deliver both messages, however slowly.
      await expect
        .poll(() => frame.answers, { timeout: 2000 })
        .toMatchObject([
          { type: "failed", call: 21, error: { code: "file.cancelled" } },
        ]);
      release();
      await expect.poll(() => frame.answers.length, { timeout: 2000 }).toBe(20);
      expect(frame.answers.slice(1)).toMatchObject(
        Array.from({ length: 19 }, () => ({ type: "read" }))
      );
      expect(seen.most).toBe(fileLimits.frameTransfers);
      expect(seen.asked).not.toContain(fileOf(20));
    } finally {
      frame.close();
    }
  });

  it("gives up a file's bytes once they stop coming, however long they kept coming", async () => {
    // Bytes that keep coming, past the stall's time in all: read to the end.
    const steady = tricklingChannel(6, stallMs / 2);
    const response = await steady.content("attachments", "file");
    const kept = await within(
      // Six pieces, then nothing: the read ends once nothing more comes.
      (async () => {
        const reader = response.body?.getReader();
        const arrived: number[] = [];
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- piece after piece
          const piece = await reader?.read();
          if (piece === undefined || piece.done) {
            return arrived;
          }
          arrived.push(...piece.value);
          if (arrived.length === 6) {
            return arrived;
          }
        }
      })(),
      2000
    );
    expect(kept).toStrictEqual({ value: [1, 2, 3, 4, 5, 6] });
    // Bytes that stop coming: the read fails rather than waiting forever.
    const stalled = tricklingChannel(1, 10);
    const stopping = await stalled.content("attachments", "file");
    const outcome = await within(stopping.blob(), 2000);
    expect(typeof outcome === "object" && "error" in outcome).toBeTruthy();
  });

  it("downloads only what the person asked for in this frame, one a second at most", async () => {
    const { channel, release } = heldChannel();
    const { port1: port, port2: page } = new MessageChannel();
    // Not asked for the first; asked for the next two, made at once.
    const asking = [false, true, true];
    const close = openFilePort(page, channel, () => asking.shift() ?? false);
    const answers: unknown[] = [];
    port.addEventListener("message", (event: MessageEvent<unknown>) => {
      answers.push(event.data);
    });
    port.start();
    const download = (call: number) => ({
      type: "download",
      call,
      resource: "attachments",
      file: fileOf(call),
    });
    try {
      port.postMessage(download(1));
      port.postMessage(download(2));
      port.postMessage(download(3));
      await settle();
      expect(answers).toMatchObject([
        { type: "failed", call: 1, error: { code: "file.gesture_required" } },
        { type: "failed", call: 3, error: { code: "file.gesture_required" } },
      ]);
    } finally {
      release();
      close();
      port.close();
    }
  });

  it("counts a click elsewhere on the page for no frame, though the frame focuses itself, for as long as it can last", () => {
    const events = new EventTarget();
    const frame = {};
    const page: { active: boolean; focused: unknown; now: number } = {
      active: false,
      focused: null,
      now: 0,
    };
    const gesture = frameGesture(frame, {
      events,
      active: () => page.active,
      focused: () => page.focused,
      now: () => page.now,
    });
    try {
      // A click inside the frame: the page has activation, the frame focus.
      page.active = true;
      page.focused = frame;
      const inFrame = gesture.asked();
      // A click on the page itself, then the frame takes focus.
      page.focused = null;
      events.dispatchEvent(new Event("pointerdown"));
      page.focused = frame;
      page.now += 4000;
      const borrowed = gesture.asked();
      // That click's activation is over; a click in the frame counts again.
      page.now += 1000;
      expect([inFrame, borrowed, gesture.asked()]).toStrictEqual([
        true,
        false,
        true,
      ]);
    } finally {
      gesture.close();
    }
  });

  it("counts the click that opened a frame for none of its downloads, however soon the person clicks on in the frame", () => {
    const frame = {};
    const page = { now: 0 };
    // The page has activation as the frame opens, which then takes focus,
    // and the person's clicks in the frame keep the page's going.
    const gesture = frameGesture(frame, {
      events: new EventTarget(),
      active: () => true,
      focused: () => frame,
      now: () => page.now,
    });
    try {
      const opening = gesture.asked();
      page.now += 2000;
      const soon = gesture.asked();
      page.now += 3000;
      expect([opening, soon, gesture.asked()]).toStrictEqual([
        false,
        false,
        true,
      ]);
    } finally {
      gesture.close();
    }
  });

  it("refuses a call past the transfers and the queue", async () => {
    const { channel, release } = heldChannel();
    const frame = frameOf(channel);
    const most = fileLimits.frameTransfers + fileLimits.frameQueued;
    try {
      for (let call = 1; call <= most + 1; call += 1) {
        frame.post(read(call));
      }
      await settle();
      expect(frame.answers).toMatchObject([
        { type: "failed", call: most + 1, error: { code: "file.busy" } },
      ]);
    } finally {
      release();
      frame.close();
    }
  });

  it("refuses a call it won't make by its number, and drops what names none", async () => {
    const { port1: port, port2: page } = new MessageChannel();
    const close = openFilePort(page);
    const answers: unknown[] = [];
    const { promise: answered, resolve } = Promise.withResolvers<unknown>();
    port.addEventListener("message", (event) => {
      answers.push(event.data);
      resolve(event.data);
    });
    port.start();
    try {
      // Nothing that names a call; then a file ID core couldn't have minted.
      port.postMessage({ type: "nothing", resource: "attachments" });
      port.postMessage({
        type: "delete",
        call: 3,
        resource: "attachments",
        file: "missing",
      });
      await expect(answered).resolves.toMatchObject({
        type: "failed",
        call: 3,
        error: { code: "file.invalid" },
      });
      expect(answers).toHaveLength(1);
    } finally {
      close();
      port.close();
    }
  });
});
