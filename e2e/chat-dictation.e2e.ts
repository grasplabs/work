import {
  transcriptionCommitSchema,
  transcriptionStartSchema,
} from "@grasp-os/shared/voice";
import type { TranscriptionStart } from "@grasp-os/shared/voice";
import { expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// Dictating into the chat's box: the microphone at its foot listens through
// core's live line (`/api/transcription`, core's
// src/onboarding/transcription.ts), which a member opens with no link. The
// line is answered in the browser as core relays the upstream: `ready`
// once started, what is heard so far as the sound comes, and the settled
// words once the page commits. The browser's fake microphone gives sound
// without asking.

test.use({
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
});

/** What the person says, settled. */
const said = "Which invoices are late this month?";

/** What is heard before it settles. */
const heardSoFar = "Which invoices";

/** A text frame's JSON, or nothing. */
const jsonOf = (message: string): unknown => {
  try {
    return JSON.parse(message);
  } catch {
    return undefined;
  }
};

/** The live line, as core relays the upstream, noting each start and each frame of sound. */
const liveLine =
  (starts: TranscriptionStart[], onSound?: () => void) =>
  (socket: WebSocketRoute): void => {
    let heard = false;
    socket.onMessage((message) => {
      if (typeof message !== "string") {
        onSound?.();
        // The first sound: what is heard so far.
        if (!heard) {
          heard = true;
          socket.send(JSON.stringify({ type: "partial", text: heardSoFar }));
        }
        return;
      }
      const frame = jsonOf(message);
      const start = transcriptionStartSchema.safeParse(frame);
      if (start.success) {
        starts.push(start.data);
        socket.send(
          JSON.stringify({
            type: "ready",
            session: crypto.randomUUID(),
            maxSeconds: 900,
          })
        );
      } else if (transcriptionCommitSchema.safeParse(frame).success) {
        socket.send(JSON.stringify({ type: "final", text: said, words: [] }));
      }
    });
  };

test("a person dictates into the box, sees what is heard as it is, and sends it once Done writes it in after what they typed", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  const starts: TranscriptionStart[] = [];
  await page.routeWebSocket("**/api/transcription", liveLine(starts));
  await page.goto("/");
  const box = page.getByLabel("Your question");
  await box.fill("For finance:");

  await page.getByRole("button", { name: "Dictate" }).click();
  // Heard, not yet written: shown after the text, lighter, not part of it.
  await expect(box).toHaveAttribute("data-interim", heardSoFar);
  await expect(box).toHaveText("For finance:");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(box).toHaveText(`For finance: ${said}`);
  // A member's own line, opened with no interview link.
  expect(starts.map(({ link }) => link)).toStrictEqual([undefined]);

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page
      .getByRole("log", { name: "Messages" })
      .getByRole("article", { name: "You" })
      .first()
  ).toContainText(`For finance: ${said}`);
});

test("Done pressed while the browser still asks for the microphone leaves nothing listening once it comes: no line, no sound, the microphone let go of", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  let sounds = 0;
  const starts: TranscriptionStart[] = [];
  await page.routeWebSocket(
    "**/api/transcription",
    liveLine(starts, () => {
      sounds += 1;
    })
  );
  // The browser answers the ask for the microphone only when the test
  // says, as a person still deciding would; each stream it gives is kept.
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    const ask = devices.getUserMedia.bind(devices);
    const gate = Promise.withResolvers<boolean>();
    const given: MediaStream[] = [];
    Reflect.set(window, "micGiven", given);
    window.addEventListener("give-mic", () => {
      gate.resolve(true);
    });
    devices.getUserMedia = async (wanted) => {
      await gate.promise;
      const stream = await ask(wanted);
      given.push(stream);
      return stream;
    };
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Dictate" }).click();
  const done = page.getByRole("button", { name: "Done" });
  await expect(done).toBeVisible();
  await done.click();
  await expect(done).toBeHidden();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("give-mic"));
  });
  // Given, and let go of at once.
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          const given: unknown = Reflect.get(window, "micGiven");
          return Array.isArray(given) && given.length > 0
            ? given
                .flatMap((stream: MediaStream) => stream.getTracks())
                .map((track) => track.readyState)
            : [];
        })
    )
    .toStrictEqual(["ended"]);
  // Long enough for a line to open and sound to go, were it to.
  await page.waitForTimeout(1500);

  expect({ starts: starts.length, sounds }).toStrictEqual({
    starts: 0,
    sounds: 0,
  });
  await expect(page.getByRole("group", { name: "Listening" })).toHaveCount(0);
});

test("closing the chat while it dictates stops it: no sound goes once it is out of sight, the microphone is let go of, and the bar dictates afresh", async ({
  pageOf,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(user);
  let sounds = 0;
  const starts: TranscriptionStart[] = [];
  await page.routeWebSocket(
    "**/api/transcription",
    liveLine(starts, () => {
      sounds += 1;
    })
  );
  // Each stream the browser gives is kept, to read its tracks.
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    const ask = devices.getUserMedia.bind(devices);
    const given: MediaStream[] = [];
    Reflect.set(window, "micGiven", given);
    devices.getUserMedia = async (wanted) => {
      const stream = await ask(wanted);
      given.push(stream);
      return stream;
    };
  });
  const tracks = async (): Promise<string[]> =>
    await page.evaluate(() => {
      const given: unknown = Reflect.get(window, "micGiven");
      return Array.isArray(given)
        ? given
            .flatMap((stream: MediaStream) => stream.getTracks())
            .map((track) => track.readyState)
        : [];
    });
  await page.goto("/apps");
  const chat = page.getByRole("region", { name: "Chat" });
  await page.getByRole("button", { name: "Open the chat" }).click();
  await expect(chat).toBeVisible();

  await chat.getByRole("button", { name: "Dictate" }).click();
  await expect(chat.getByRole("group", { name: "Listening" })).toBeVisible();
  await expect.poll(() => sounds).toBeGreaterThan(0);
  await chat.getByRole("button", { name: "Close" }).click();
  await expect(chat).toBeHidden();
  await expect.poll(tracks).toStrictEqual(["ended"]);
  const atClose = sounds;
  // Long enough for many frames to go, were it still listening.
  await page.waitForTimeout(3000);

  expect({ after: sounds - atClose, starts: starts.length }).toStrictEqual({
    after: 0,
    starts: 1,
  });
  // The bar's box offers it again, as a new dictation on a line of its own.
  await page.getByRole("button", { name: "Dictate" }).click();
  await expect(page.getByRole("group", { name: "Listening" })).toBeVisible();
  await expect.poll(() => starts.length).toBe(2);
  await expect.poll(tracks).toStrictEqual(["ended", "live"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Listening" })).toHaveCount(0);
  await expect.poll(tracks).toStrictEqual(["ended", "ended"]);
});
