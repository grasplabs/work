import { fileChannel } from "@grasp-os/runtime/host";
import { fileLimits } from "@grasp-os/shared/app-file-limits";
import { describe, expect, it, vi } from "vite-plus/test";

import { purgeGraceMs } from "../src/file-host.ts";
import {
  appsOf,
  answerOf,
  asksHeld,
  begunFile,
  blobOf,
  brokenPartway,
  codeOf,
  declaration,
  fileStates,
  neverAnswered,
  orderedChannel,
  png,
  rawChannel,
  permissions,
  storedObjects,
  sweepIn,
  upload,
} from "./app-files.ts";
import { mockIdp } from "./idp.ts";

// An App's files (spec 9.6, 10.7.5, 32.5) from the threat model (core's
// file-host.ts and app-file-route.ts): a cancellation that lost to
// publication, a request stalled, a deletion with a record still holding
// the file, a cleanup gone stale, an upload that outlived its time, the
// rest of a download after its file was deleted, a person's and a store's
// budgets, and a chunk's write that settled late or not at all.

const { openedApp, colleagueOf } = appsOf(mockIdp());

describe("an App's files", { timeout: 120_000 }, () => {
  it("recovers an answer whose body broke partway under the same upload", async () => {
    const { app, release, page } = await openedApp();
    // The connection drops after the headers of the first start's and the
    // first finish's answers, a few bytes into their bodies.
    const broken = new Set<string>();
    const channel = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      fetch: async (path, init) => {
        const response = await page.fetch(path, init);
        const step = path.endsWith("/finish") ? "finish" : path;
        if (
          (path.endsWith("/uploads") || path.endsWith("/finish")) &&
          !broken.has(step)
        ) {
          broken.add(step);
          return brokenPartway(response);
        }
        return response;
      },
    });
    const bytes = png(fileLimits.chunkBytes + 5);
    const id = await upload(channel, blobOf(bytes, "image/png"));
    expect(broken.size).toBe(2);
    await expect(page.channel.describe("files", id)).resolves.toMatchObject({
      size: bytes.length,
    });
    await expect(fileStates(release)).resolves.toStrictEqual(["published:"]);
  });

  it("cancels an upload that failed for good after its start, so it holds none of the person's places", async () => {
    const { app, release, page } = await openedApp();
    // Every chunk is refused for good, with no answer lost to send again.
    const channel = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      fetch: async (path, init) => {
        if (path.includes("/chunks/")) {
          return await Promise.resolve(
            Response.json(
              { code: "file.content_mismatch", message: "Refused." },
              { status: 422 }
            )
          );
        }
        return await page.fetch(path, init);
      },
    });
    const failed = await codeOf(upload(channel, blobOf(png(100), "image/png")));
    expect({
      failed,
      states: await fileStates(release),
    }).toStrictEqual({
      failed: "file.content_mismatch",
      states: ["deleted:cancelled"],
    });
  });

  it("answers an upload whose finish was refused after core published it with its file", async () => {
    const { app, release, page } = await openedApp();
    // Core publishes the file; the page hears a refusal instead.
    const channel = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      fetch: async (path, init) => {
        const response = await page.fetch(path, init);
        if (path.endsWith("/finish")) {
          await response.body?.cancel();
          return Response.json(
            { code: "file.content_mismatch", message: "Refused." },
            { status: 422 }
          );
        }
        return response;
      },
    });
    const bytes = png(100);
    const id = await upload(channel, blobOf(bytes, "image/png"));
    await expect(page.channel.describe("files", id)).resolves.toMatchObject({
      size: bytes.length,
    });
    await expect(fileStates(release)).resolves.toStrictEqual(["published:"]);
  });

  it("answers a cancellation with what won: cancelled, or the file when publication came first", async () => {
    const { app, client, api, release, page } = await openedApp();
    const early = new AbortController();
    const cancelled = page.channel.upload(
      "files",
      blobOf(png(3 * fileLimits.chunkBytes), "image/png"),
      "big.png",
      {
        cancel: early.signal,
        onProgress: ({ bytesUploaded }) => {
          if (bytesUploaded > 0) {
            early.abort();
          }
        },
      }
    );
    await expect(codeOf(cancelled)).resolves.toBe("file.cancelled");
    // Cancelled while its finish is under way, the finish reaching core
    // first: the file, which its uploader has.
    const late = new AbortController();
    const id = await orderedChannel(page, app, "finish").upload(
      "files",
      blobOf(png(), "image/png"),
      "small.png",
      {
        cancel: late.signal,
        onProgress: ({ phase }) => {
          if (phase === "verifying") {
            late.abort();
          }
        },
      }
    );
    const note = await client.mutation(api.create, { title: "Kept" });
    await expect(
      client.mutation(api.attachFile, {
        id: note,
        file: { id },
      })
    ).resolves.toMatchObject({ attachments: [{ id }] });
    // The cancelled upload's chunk goes once its grace passed.
    await sweepIn(release, purgeGraceMs + 1);
    const kept = await storedObjects(release);
    expect(kept).toHaveLength(1);
    expect(
      kept[0]?.startsWith(`app-files/${release.store?.storeId ?? ""}/${id}/0.`)
    ).toBeTruthy();
  });

  it("lets a cancellation sent while its upload is verified win, the file never readable", async () => {
    const { app, release, page } = await openedApp();
    const cancel = new AbortController();
    const finishing = orderedChannel(page, app, "cancel").upload(
      "files",
      blobOf(png(), "image/png"),
      "late.png",
      {
        cancel: cancel.signal,
        onProgress: ({ phase }) => {
          if (phase === "verifying") {
            cancel.abort();
          }
        },
      }
    );
    await expect(codeOf(finishing)).resolves.toBe("file.cancelled");
    await expect(fileStates(release)).resolves.toStrictEqual([
      "deleted:cancelled",
    ]);
  });

  it("answers a mutation sent again under its key as it did, though the file it detached is no longer the caller's to read", async () => {
    const { builder, app, client, api, page } = await openedApp();
    const id = await upload(page.channel, blobOf(png(), "image/png"));
    const pinned = await client.mutation(api.pin, { file: { id } });
    const colleague = await colleagueOf(builder, app);
    const unpin = async () =>
      await colleague.client.mutation(
        api.unpin,
        { id: pinned, file: { id } },
        { idempotencyKey: "unpin-once" }
      );
    // Its answer lost, the colleague sends it again under the same key.
    await expect(unpin()).resolves.toBeNull();
    await expect(unpin()).resolves.toBeNull();
    // A fresh call is a new execution, its files checked again.
    await expect(
      codeOf(
        colleague.client.mutation(api.unpin, {
          id: pinned,
          file: { id },
        })
      )
    ).resolves.toBe("file.not_found");
  });

  it("settles a cancellation on core's answer, though the finish never answers", async () => {
    const { app, release, page } = await openedApp();
    const { promise: stalled, resolve: unstall } =
      Promise.withResolvers<null>();
    const channel = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      fetch: async (path, init) => {
        if (path.endsWith("/finish")) {
          await stalled;
        }
        return await page.fetch(path, init);
      },
    });
    const cancel = new AbortController();
    const { promise: late, resolve: giveUp } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      giveUp("still waiting on the finish");
    }, 5000);
    try {
      const finishing = codeOf(
        channel.upload("files", blobOf(png(), "image/png"), "slow.png", {
          cancel: cancel.signal,
          onProgress: ({ phase }) => {
            if (phase === "verifying") {
              cancel.abort();
            }
          },
        })
      );
      await expect(Promise.race([finishing, late])).resolves.toBe(
        "file.cancelled"
      );
    } finally {
      clearTimeout(timer);
      unstall(null);
    }
    await expect(fileStates(release)).resolves.toStrictEqual([
      "deleted:cancelled",
    ]);
  });

  it("keeps a key one file's, a deletion of a file already deleted keeping it too", async () => {
    const { client, page } = await openedApp();
    const first = await upload(page.channel, blobOf(png(), "image/png"));
    const second = await upload(page.channel, blobOf(png(32), "image/png"));
    await client.files.delete(permissions.files, { id: first });
    const keyed = { idempotencyKey: "tidy-up" };
    // Deleted already: the deletion under the key answers as it did.
    await client.files.delete(permissions.files, { id: first }, keyed);
    await expect(
      Promise.all([
        codeOf(client.files.delete(permissions.files, { id: second }, keyed)),
        client.files.delete(permissions.files, { id: first }, keyed),
      ])
    ).resolves.toStrictEqual(["submission.key_conflict", undefined]);
  });

  it("cancels at once while a chunk's request is stalled, and sends a chunk stalled too long again", async () => {
    const { app, release, page } = await openedApp();
    const cancel = new AbortController();
    const quiet = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      fetch: async (path, init) =>
        path.includes("/chunks/")
          ? await neverAnswered(init)
          : await page.fetch(path, init),
    });
    const { promise: late, resolve: giveUp } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      giveUp("still waiting on the chunk");
    }, 5000);
    try {
      const cancelling = codeOf(
        quiet.upload("files", blobOf(png(), "image/png"), "slow.png", {
          cancel: cancel.signal,
          onProgress: ({ phase }) => {
            if (phase === "uploading") {
              cancel.abort();
            }
          },
        })
      );
      await expect(Promise.race([cancelling, late])).resolves.toBe(
        "file.cancelled"
      );
    } finally {
      clearTimeout(timer);
    }
    await expect(fileStates(release)).resolves.toStrictEqual([
      "deleted:cancelled",
    ]);
    // The first request of the second chunk stalls; given up on, it is
    // sent again, and the upload publishes.
    let stalls = 0;
    const flaky = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      chunkMs: 300,
      fetch: async (path, init) => {
        if (path.endsWith("/chunks/1") && stalls === 0) {
          stalls += 1;
          return await neverAnswered(init);
        }
        return await page.fetch(path, init);
      },
    });
    const bytes = png(fileLimits.chunkBytes + 5);
    const id = await upload(flaky, blobOf(bytes, "image/png"));
    await expect(page.channel.describe("files", id)).resolves.toMatchObject({
      size: bytes.length,
    });
  });

  it("cancels at once while its start is stalled, cancelling the upload the start made under its key", async () => {
    const { app, release, page } = await openedApp();
    const cancel = new AbortController();
    let starts = 0;
    const channel = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      fetch: async (path, init) => {
        if (path.endsWith("/uploads")) {
          starts += 1;
          if (starts === 1) {
            // It reaches core, which makes the upload; its answer never comes.
            await page.fetch(path, init);
            cancel.abort();
            return await neverAnswered(init);
          }
        }
        return await page.fetch(path, init);
      },
    });
    const { promise: late, resolve: giveUp } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      giveUp("still waiting on the start");
    }, 5000);
    try {
      const cancelling = codeOf(
        channel.upload("files", blobOf(png(), "image/png"), "slow.png", {
          cancel: cancel.signal,
          onProgress: () => {
            // Cancelled from the stalled start, not from here.
          },
        })
      );
      await expect(Promise.race([cancelling, late])).resolves.toBe(
        "file.cancelled"
      );
    } finally {
      clearTimeout(timer);
    }
    // One upload, the one the stalled start made, found again and cancelled.
    await expect(fileStates(release)).resolves.toStrictEqual([
      "deleted:cancelled",
    ]);
  });

  it("answers a cancellation during its start as cancelled only once core says so", async () => {
    const { app, release, page } = await openedApp();
    const cancel = new AbortController();
    let starts = 0;
    const channel = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      fetch: async (path, init) => {
        if (path.endsWith("/uploads")) {
          starts += 1;
          if (starts === 1) {
            // It reaches core, which makes the upload; its answer never comes.
            await page.fetch(path, init);
            cancel.abort();
            return await neverAnswered(init);
          }
          // Finding it again fails: nothing says it was cancelled.
          throw Object.assign(new Error("Core can't be reached."), {
            code: "internal.unavailable",
          });
        }
        return await page.fetch(path, init);
      },
    });
    await expect(
      codeOf(
        channel.upload("files", blobOf(png(), "image/png"), "lost.png", {
          cancel: cancel.signal,
          onProgress: () => {
            // Cancelled from the stalled start, not from here.
          },
        })
      )
    ).resolves.toBe("internal.unavailable");
    await expect(fileStates(release)).resolves.toStrictEqual(["uploading:"]);
    // Cancelled before any start is sent: nothing began, so it is cancelled.
    let sent = 0;
    const counting = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      fetch: async (path, init) => {
        sent += 1;
        return await page.fetch(path, init);
      },
    });
    const early = new AbortController();
    early.abort();
    await expect(
      codeOf(
        counting.upload("files", blobOf(png(), "image/png"), "no.png", {
          cancel: early.signal,
          onProgress: () => {
            // Nothing to report.
          },
        })
      )
    ).resolves.toBe("file.cancelled");
    expect(sent).toBe(0);
  });

  it("cancels at once while asking core which chunks it holds is stalled, after a lost chunk or a finish that found one missing", async () => {
    const { app, release, page } = await openedApp();
    const stalledAfter = async (lose: "chunk" | "finish") => {
      const cancel = new AbortController();
      let chunks = 0;
      const channel = fileChannel({
        app,
        lease: page.lease,
        person: page.named,
        fetch: async (path, init) => {
          if (asksHeld(path, init)) {
            cancel.abort();
            return await neverAnswered(init);
          }
          if (path.includes("/chunks/")) {
            chunks += 1;
            if (lose === "finish" && chunks === 1) {
              // Answered without reaching core: the finish finds it missing.
              return new Response(null, { status: 204 });
            }
            const response = await page.fetch(path, init);
            if (lose === "chunk" && chunks === 1) {
              throw new TypeError("The connection was reset.");
            }
            return response;
          }
          return await page.fetch(path, init);
        },
      });
      const { promise: late, resolve: giveUp } =
        Promise.withResolvers<string>();
      const timer = setTimeout(() => {
        giveUp("still waiting on what core holds");
      }, 5000);
      try {
        return await Promise.race([
          codeOf(
            channel.upload("files", blobOf(png(), "image/png"), `${lose}.png`, {
              cancel: cancel.signal,
              onProgress: () => {
                // Cancelled from the stalled request, not from here.
              },
            })
          ),
          late,
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    await expect(stalledAfter("chunk")).resolves.toBe("file.cancelled");
    await expect(stalledAfter("finish")).resolves.toBe("file.cancelled");
    // Both cancelled under the upload each had begun.
    await expect(fileStates(release)).resolves.toStrictEqual([
      "deleted:cancelled",
      "deleted:cancelled",
    ]);
  });

  it("refuses to delete an upload that isn't finished: its uploader cancels it", async () => {
    const { app, client, release, page } = await openedApp();
    const file = await begunFile(
      await rawChannel(page, app).begin(declaration())
    );
    await expect(
      codeOf(client.files.delete(permissions.files, { id: file }))
    ).resolves.toBe("file.not_found");
    await expect(fileStates(release)).resolves.toStrictEqual(["uploading:"]);
  });

  it("refuses to delete a file a record holds, and deletes its uploader's own under a key", async () => {
    const { client, api, page } = await openedApp();
    const held = await upload(page.channel, blobOf(png(), "image/png"));
    const loose = await upload(page.channel, blobOf(png(32), "image/png"));
    const note = await client.mutation(api.create, { title: "Holder" });
    await client.mutation(api.attachFile, {
      id: note,
      file: { id: held },
    });
    const keyed = { idempotencyKey: "clean-up" };
    await client.files.delete(permissions.files, { id: loose }, keyed);
    // The same key again answers the same deletion.
    await client.files.delete(permissions.files, { id: loose }, keyed);
    const other = await client.mutation(api.create, { title: "Late" });
    await expect(
      Promise.all([
        codeOf(client.files.delete(permissions.files, { id: held })),
        codeOf(client.files.delete(permissions.files, { id: held }, keyed)),
        codeOf(page.channel.describe("files", loose)),
        codeOf(
          client.mutation(api.attachFile, {
            id: other,
            file: { id: loose },
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "file.referenced",
      "submission.key_conflict",
      "file.not_found",
      "file.not_found",
    ]);
  });

  it("cleans up a file once nothing holds it for the orphan retention, and never one held again", async () => {
    const { client, api, release, page } = await openedApp();
    const id = await upload(page.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Holder" });
    await client.mutation(api.attachFile, {
      id: note,
      file: { id },
    });
    // Its note deleted: kept through the orphan retention.
    await client.mutation(api.remove, { id: note });
    await sweepIn(release, fileLimits.orphanMs - 60_000);
    await expect(page.channel.describe("files", id)).resolves.toMatchObject({
      id,
    });
    // Held again before it was cleaned up: the cleanup due is stale.
    const again = await client.mutation(api.create, { title: "Again" });
    await client.mutation(api.attachFile, {
      id: again,
      file: { id },
    });
    await sweepIn(release, fileLimits.orphanMs + purgeGraceMs + 1);
    await expect(page.channel.describe("files", id)).resolves.toMatchObject({
      id,
    });
    // Detached, and nothing holds it through the retention: deleted, then
    // its bytes removed.
    await client.mutation(api.detachFile, {
      id: again,
      file: { id },
    });
    await sweepIn(release, fileLimits.orphanMs + 1);
    await sweepIn(release, fileLimits.orphanMs + purgeGraceMs + 2);
    await expect(codeOf(page.channel.describe("files", id))).resolves.toBe(
      "file.not_found"
    );
    await expect(storedObjects(release)).resolves.toStrictEqual([]);
  });

  it("expires an upload that wasn't finished in time, its start sent again answered so too", async () => {
    const { app, release, page } = await openedApp();
    const raw = rawChannel(page, app);
    const declared = declaration();
    const file = await begunFile(await raw.begin(declared));
    // Past its time, before the alarm deleted it.
    vi.useFakeTimers({ toFake: ["Date"] });
    let beforeSweep: unknown;
    try {
      vi.setSystemTime(Date.now() + fileLimits.uploadMs + 1);
      beforeSweep = await answerOf(await raw.begin(declared));
    } finally {
      vi.useRealTimers();
    }
    await sweepIn(release, fileLimits.uploadMs + 1);
    const late = await raw.status(file);
    expect(late.status).toBe(410);
    expect({
      late: await answerOf(late),
      beforeSweep,
      afterSweep: await answerOf(await raw.begin(declared)),
    }).toStrictEqual({
      late: "file.upload_expired",
      beforeSweep: "file.upload_expired",
      afterSweep: "file.upload_expired",
    });
  });
});
