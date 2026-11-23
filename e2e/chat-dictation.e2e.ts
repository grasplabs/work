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

/** The live line, as core relays the upstream, noting each start. */
const liveLine =
  (starts: TranscriptionStart[]) =>
  (socket: WebSocketRoute): void => {
    let heard = false;
    socket.onMessage((message) => {
      if (typeof message !== "string") {
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
