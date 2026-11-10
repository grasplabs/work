import { fileChannel } from "@grasp-os/runtime/host";
import { appFilesPath } from "@grasp-os/shared/app-file-limits";
import { readDeadlineMs } from "@grasp-os/shared/http";
import { pageLeaseHeader } from "@grasp-os/shared/pages";
import { describe, expect, it, vi } from "vite-plus/test";

import { appsOf, blobOf, fileStates, png, upload } from "./app-files.ts";
import { mockIdp } from "./idp.ts";

// An App's files (spec 9.6, 10.7.5, 32.5), uploaded through core's file
// channel as a running page's page reaches it, attached and read through
// the App's own functions; and, from the threat model (core's file-host.ts
// and app-file-route.ts), every way an upload should fail: another
// person's upload, another App's, a guessed ID, a request without the
// page's lease or from another site, a type or content that isn't what
// it says, a chunk that isn't the one it says, an answer lost on the way.

const { openedApp } = appsOf(mockIdp());

describe("an App's files", { timeout: 120_000 }, () => {
  it("sends a chunk again whose body core took too long to read, and finishes the upload", async () => {
    const { app, release, page } = await openedApp();
    // The first chunk's body reaches core too slowly: it answers so.
    const slow = { first: true };
    const channel = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      fetch: async (path, init) => {
        if (path.includes("/chunks/") && slow.first) {
          slow.first = false;
          return await Promise.resolve(
            Response.json(
              { code: "request.timeout", message: "Too slow." },
              { status: 408 }
            )
          );
        }
        return await page.fetch(path, init);
      },
    });
    const bytes = png(100);
    const id = await upload(channel, blobOf(bytes, "image/png"));
    await expect(page.channel.describe("files", id)).resolves.toMatchObject({
      size: bytes.length,
    });
    await expect(fileStates(release)).resolves.toStrictEqual(["published:"]);
  });

  it("answers a body that stops arriving as one that took too long, for the page to send again", async () => {
    const { app, page } = await openedApp();
    // A start whose body never ends: core gives up reading it.
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    // Core's clock, which the test moves past the read's deadline
    // (`readDeadlineMs`) instead of waiting it out.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let response: Response;
    try {
      const answer = page.fetch(`${appFilesPath}/${app}/files/uploads`, {
        method: "POST",
        headers: {
          [pageLeaseHeader]: page.lease,
          "content-type": "application/json",
        },
        body,
      });
      // The clock moves on until core answers: past the read's deadline
      // once it waits for the rest of the body, and no further than a
      // second at a time, so a test that never gets its answer times out
      // rather than hangs.
      const settled = { now: false };
      const watched = (async () => {
        try {
          await answer;
        } finally {
          settled.now = true;
        }
      })();
      // Once core reads the body and waits for the rest.
      await vi.waitFor(() => {
        expect(vi.getTimerCount()).toBeGreaterThan(0);
      });
      for (let moved = 0; !settled.now; moved += 1000) {
        if (moved > 2 * readDeadlineMs) {
          throw new Error("No answer once the read's deadline long passed");
        }
        // oxlint-disable-next-line no-await-in-loop -- one second after the other
        await vi.advanceTimersByTimeAsync(1000);
        // Real time for what core does over I/O meanwhile (scheduler.wait
        // isn't faked).
        // oxlint-disable-next-line no-await-in-loop -- one second after the other
        await scheduler.wait(10);
      }
      await watched;
      response = await answer;
    } finally {
      vi.useRealTimers();
    }
    expect({
      status: response.status,
      answer: await response.json(),
    }).toMatchObject({ status: 408, answer: { code: "request.timeout" } });
  });
});
