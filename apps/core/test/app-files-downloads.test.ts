import { fileChannel } from "@grasp-os/sdk/host";
import { fileLimits } from "@grasp-os/shared/app-file-limits";
import { appIdSchema, storeIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DataStore } from "../src/data-store.ts";
import {
  finishClaimMs,
  purgeGraceMs,
  removalRetryMs,
  sweepPage as sweepPageSize,
} from "../src/file-host.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { StoreHost } from "../src/store-host.ts";
import {
  appsOf,
  answerOf,
  asksHeld,
  begunFile,
  blobOf,
  brokenPartway,
  claimOf,
  codeOf,
  declaration,
  failingDeletes,
  fileStates,
  files,
  gatedReads,
  lossyChunkAnswers,
  neverAnswered,
  onStore,
  orderedChannel,
  png,
  rawChannel,
  refusal,
  resources,
  sha256,
  statusOf,
  storedObjects,
  sweepIn,
  upload,
  utf8,
} from "./app-files.ts";
import { mockIdp } from "./idp.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import { callAuth } from "./sign-in.ts";

// An App's files (spec 9.6, 10.7.5, 32.5) from the threat model (core's
// file-host.ts and app-file-route.ts): a cancellation that lost to
// publication, a request stalled, a deletion with a record still holding
// the file, a cleanup gone stale, an upload that outlived its time, the
// rest of a download after its file was deleted, a person's and a store's
// budgets, and a chunk's write that settled late or not at all.

const { openedApp, colleagueOf } = appsOf(mockIdp());

describe("an App's files", { timeout: 120_000 }, () => {
  it("recovers an answer whose body broke partway under the same upload", async () => {
    const { app, release, screen } = await openedApp();
    // The connection drops after the headers of the first start's and the
    // first finish's answers, a few bytes into their bodies.
    const broken = new Set<string>();
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        const response = await screen.fetch(path, init);
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
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ size: bytes.length });
    await expect(fileStates(release)).resolves.toStrictEqual(["published:"]);
  });

  it("cancels an upload that failed for good after its start, so it holds none of the person's places", async () => {
    const { app, release, screen } = await openedApp();
    // Every chunk is refused for good, with no answer lost to send again.
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        if (path.includes("/chunks/")) {
          return await Promise.resolve(
            Response.json(
              { code: "file.content_mismatch", message: "Refused." },
              { status: 422 }
            )
          );
        }
        return await screen.fetch(path, init);
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
    const { app, release, screen } = await openedApp();
    // Core publishes the file; the screen hears a refusal instead.
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        const response = await screen.fetch(path, init);
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
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ size: bytes.length });
    await expect(fileStates(release)).resolves.toStrictEqual(["published:"]);
  });

  it("answers a cancellation with what won: cancelled, or the file when publication came first", async () => {
    const { app, client, api, release, screen } = await openedApp();
    const early = new AbortController();
    const cancelled = screen.channel.upload(
      "attachments",
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
    const id = await orderedChannel(screen, app, "finish").upload(
      "attachments",
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
        expectedRevision: 1,
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
    const { app, release, screen } = await openedApp();
    const cancel = new AbortController();
    const finishing = orderedChannel(screen, app, "cancel").upload(
      "attachments",
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
    const { builder, app, client, api, screen } = await openedApp();
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const pinned = await client.mutation(api.pin, { file: { id } });
    const colleague = await colleagueOf(builder, app);
    const unpin = async () =>
      await colleague.client.mutation(
        api.unpin,
        { id: pinned, expectedRevision: 1, file: { id } },
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
          expectedRevision: 2,
          file: { id },
        })
      )
    ).resolves.toBe("file.not_found");
  });

  it("settles a cancellation on core's answer, though the finish never answers", async () => {
    const { app, release, screen } = await openedApp();
    const { promise: stalled, resolve: unstall } =
      Promise.withResolvers<null>();
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        if (path.endsWith("/finish")) {
          await stalled;
        }
        return await screen.fetch(path, init);
      },
    });
    const cancel = new AbortController();
    const { promise: late, resolve: giveUp } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      giveUp("still waiting on the finish");
    }, 5000);
    try {
      const finishing = codeOf(
        channel.upload("attachments", blobOf(png(), "image/png"), "slow.png", {
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
    const { client, screen } = await openedApp();
    const first = await upload(screen.channel, blobOf(png(), "image/png"));
    const second = await upload(screen.channel, blobOf(png(32), "image/png"));
    await client.files.delete(resources.attachments, { id: first });
    const keyed = { idempotencyKey: "tidy-up" };
    // Deleted already: the deletion under the key answers as it did.
    await client.files.delete(resources.attachments, { id: first }, keyed);
    await expect(
      Promise.all([
        codeOf(
          client.files.delete(resources.attachments, { id: second }, keyed)
        ),
        client.files.delete(resources.attachments, { id: first }, keyed),
      ])
    ).resolves.toStrictEqual(["submission.key_conflict", undefined]);
  });

  it("cancels at once while a chunk's request is stalled, and sends a chunk stalled too long again", async () => {
    const { app, release, screen } = await openedApp();
    const cancel = new AbortController();
    const quiet = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) =>
        path.includes("/chunks/")
          ? await neverAnswered(init)
          : await screen.fetch(path, init),
    });
    const { promise: late, resolve: giveUp } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      giveUp("still waiting on the chunk");
    }, 5000);
    try {
      const cancelling = codeOf(
        quiet.upload("attachments", blobOf(png(), "image/png"), "slow.png", {
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
      lease: screen.lease,
      person: screen.named,
      chunkMs: 300,
      fetch: async (path, init) => {
        if (path.endsWith("/chunks/1") && stalls === 0) {
          stalls += 1;
          return await neverAnswered(init);
        }
        return await screen.fetch(path, init);
      },
    });
    const bytes = png(fileLimits.chunkBytes + 5);
    const id = await upload(flaky, blobOf(bytes, "image/png"));
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ size: bytes.length });
  });

  it("cancels at once while its start is stalled, cancelling the upload the start made under its key", async () => {
    const { app, release, screen } = await openedApp();
    const cancel = new AbortController();
    let starts = 0;
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        if (path.endsWith("/uploads")) {
          starts += 1;
          if (starts === 1) {
            // It reaches core, which makes the upload; its answer never comes.
            await screen.fetch(path, init);
            cancel.abort();
            return await neverAnswered(init);
          }
        }
        return await screen.fetch(path, init);
      },
    });
    const { promise: late, resolve: giveUp } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      giveUp("still waiting on the start");
    }, 5000);
    try {
      const cancelling = codeOf(
        channel.upload("attachments", blobOf(png(), "image/png"), "slow.png", {
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
    const { app, release, screen } = await openedApp();
    const cancel = new AbortController();
    let starts = 0;
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        if (path.endsWith("/uploads")) {
          starts += 1;
          if (starts === 1) {
            // It reaches core, which makes the upload; its answer never comes.
            await screen.fetch(path, init);
            cancel.abort();
            return await neverAnswered(init);
          }
          // Finding it again fails: nothing says it was cancelled.
          throw Object.assign(new Error("Core can't be reached."), {
            code: "internal.unavailable",
          });
        }
        return await screen.fetch(path, init);
      },
    });
    await expect(
      codeOf(
        channel.upload("attachments", blobOf(png(), "image/png"), "lost.png", {
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
      lease: screen.lease,
      person: screen.named,
      fetch: async (path, init) => {
        sent += 1;
        return await screen.fetch(path, init);
      },
    });
    const early = new AbortController();
    early.abort();
    await expect(
      codeOf(
        counting.upload("attachments", blobOf(png(), "image/png"), "no.png", {
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
    const { app, release, screen } = await openedApp();
    const stalledAfter = async (lose: "chunk" | "finish") => {
      const cancel = new AbortController();
      let chunks = 0;
      const channel = fileChannel({
        app,
        lease: screen.lease,
        person: screen.named,
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
            const response = await screen.fetch(path, init);
            if (lose === "chunk" && chunks === 1) {
              throw new TypeError("The connection was reset.");
            }
            return response;
          }
          return await screen.fetch(path, init);
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
            channel.upload(
              "attachments",
              blobOf(png(), "image/png"),
              `${lose}.png`,
              {
                cancel: cancel.signal,
                onProgress: () => {
                  // Cancelled from the stalled request, not from here.
                },
              }
            )
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
    const { app, client, release, screen } = await openedApp();
    const file = await begunFile(
      await rawChannel(screen, app).begin(declaration())
    );
    await expect(
      codeOf(client.files.delete(resources.attachments, { id: file }))
    ).resolves.toBe("file.not_found");
    await expect(fileStates(release)).resolves.toStrictEqual(["uploading:"]);
  });

  it("refuses to delete a file a record holds, and deletes its uploader's own under a key", async () => {
    const { client, api, screen } = await openedApp();
    const held = await upload(screen.channel, blobOf(png(), "image/png"));
    const loose = await upload(screen.channel, blobOf(png(32), "image/png"));
    const note = await client.mutation(api.create, { title: "Holder" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id: held },
    });
    const keyed = { idempotencyKey: "clean-up" };
    await client.files.delete(resources.attachments, { id: loose }, keyed);
    // The same key again answers the same deletion.
    await client.files.delete(resources.attachments, { id: loose }, keyed);
    const other = await client.mutation(api.create, { title: "Late" });
    await expect(
      Promise.all([
        codeOf(client.files.delete(resources.attachments, { id: held })),
        codeOf(client.files.delete(resources.attachments, { id: held }, keyed)),
        codeOf(screen.channel.describe("attachments", loose)),
        codeOf(
          client.mutation(api.attachFile, {
            id: other,
            expectedRevision: 1,
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
    const { client, api, release, screen } = await openedApp();
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Holder" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id },
    });
    // Its note deleted: kept through the orphan retention.
    await client.mutation(api.remove, { id: note, expectedRevision: 2 });
    await sweepIn(release, fileLimits.orphanMs - 60_000);
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ id });
    // Held again before it was cleaned up: the cleanup due is stale.
    const again = await client.mutation(api.create, { title: "Again" });
    await client.mutation(api.attachFile, {
      id: again,
      expectedRevision: 1,
      file: { id },
    });
    await sweepIn(release, fileLimits.orphanMs + purgeGraceMs + 1);
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ id });
    // Detached, and nothing holds it through the retention: deleted, then
    // its bytes removed.
    await client.mutation(api.detachFile, {
      id: again,
      expectedRevision: 2,
      file: { id },
    });
    await sweepIn(release, fileLimits.orphanMs + 1);
    await sweepIn(release, fileLimits.orphanMs + purgeGraceMs + 2);
    await expect(
      codeOf(screen.channel.describe("attachments", id))
    ).resolves.toBe("file.not_found");
    await expect(storedObjects(release)).resolves.toStrictEqual([]);
  });

  it("expires an upload that wasn't finished in time, its start sent again answered so too", async () => {
    const { app, release, screen } = await openedApp();
    const raw = rawChannel(screen, app);
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

  it("delivers none of a download's remaining bytes once its file is deleted", async () => {
    const { screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const response = await screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    const first: ReadableStreamReadResult<Uint8Array> | undefined =
      await reader?.read();
    expect(first?.value?.byteLength).toBe(fileLimits.chunkBytes);
    await screen.channel.delete("attachments", id);
    await expect(reader?.read()).rejects.toThrow("That file isn't available.");
  });

  it("delivers none of a download's remaining bytes once its reader may no longer read it", async () => {
    const { builder, app, client, api, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const note = await client.mutation(api.create, { title: "Shared" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id },
    });
    const response = await colleague.screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    await reader?.read();
    // Detached: the colleague reads it through no record any more.
    await client.mutation(api.detachFile, {
      id: note,
      expectedRevision: 2,
      file: { id },
    });
    await expect(reader?.read()).rejects.toThrow("That file isn't available.");
  });

  it("delivers none of a download's remaining bytes once its reader signed out", async () => {
    const { builder, screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const response = await screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    await reader?.read();
    await callAuth("/sign-out", builder.session, {});
    await expect(reader?.read()).rejects.toThrow("Sign in to continue.");
  });

  it("delivers none of a download's remaining bytes once another release of its App is current", async () => {
    const { builder, app, screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const response = await screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    await reader?.read();
    // The same files under a second version, so its screens stay trusted.
    const { version } = await builder.api.apps.files.commit(
      app,
      { ...files, "app.ts": `${files["app.ts"] ?? ""}\n// The second.\n` },
      "Second"
    );
    await builder.api.apps.versions.setCurrent(app, version);
    await expect(reader?.read()).rejects.toThrow(
      "That reference belongs to another version"
    );
  });

  it("delivers none of a download's remaining bytes once its screen's build is revoked", async () => {
    const { app, admin, artifacts, screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const response = await screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    await reader?.read();
    for (const artifact of artifacts) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await admin.api.screenTrust.revoke(app, artifact);
    }
    await expect(reader?.read()).rejects.toThrow(
      "The approval of this app's code was taken back."
    );
  });

  it("delivers none of a download's remaining bytes once its release is revoked, and starts none after", async () => {
    const { app, screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    const response = await screen.channel.content("attachments", id);
    const reader = response.body?.getReader();
    await reader?.read();
    await revokeRelease(
      env,
      await actingPerson("admin"),
      { app: appIdSchema.parse(app), version: 1 },
      "Leaks data"
    );
    await expect(reader?.read()).rejects.toThrow(
      "The approval of this app's code was taken back."
    );
    await expect(
      codeOf(screen.channel.describe("attachments", id))
    ).resolves.toBe("screen.revoked");
  });

  it("ends a download that takes longer than a download may", async () => {
    const { screen } = await openedApp();
    const id = await upload(
      screen.channel,
      blobOf(png(2 * fileLimits.chunkBytes), "image/png")
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const response = await screen.channel.content("attachments", id);
      const reader = response.body?.getReader();
      await reader?.read();
      vi.setSystemTime(Date.now() + fileLimits.downloadMs + 1);
      await expect(reader?.read()).rejects.toThrow(
        "That file isn't available."
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a file under its checked type's extension, never one a browser would run", async () => {
    const { app, screen } = await openedApp();
    const disposition = async (
      name: string,
      type: string,
      bytes: Uint8Array<ArrayBuffer>
    ) => {
      const id = await upload(screen.channel, blobOf(bytes, type), name);
      const response = await screen.channel.content("attachments", id);
      await response.body?.cancel();
      return {
        disposition: response.headers.get("content-disposition"),
        type: response.headers.get("content-type"),
        policy: response.headers.get("content-security-policy"),
        resourcePolicy: response.headers.get("cross-origin-resource-policy"),
      };
    };
    await expect(
      disposition(
        "Q3-report.html",
        "text/plain",
        utf8("<script>alert(1)</script>")
      )
    ).resolves.toStrictEqual({
      disposition: `attachment; filename="Q3-report.html.txt"; filename*=UTF-8''Q3-report.html.txt`,
      type: "text/plain; charset=utf-8",
      policy: "default-src 'none'; sandbox",
      resourcePolicy: "same-origin",
    });
    await expect(
      disposition("it's (final).png", "image/png", png())
    ).resolves.toMatchObject({
      disposition: `attachment; filename="it's (final).png"; filename*=UTF-8''it%27s%20%28final%29.png`,
    });
    // A name with a bidi override or another invisible character is no
    // file's name at all.
    const raw = rawChannel(screen, app);
    const refused = await Promise.all(
      [
        `invoice${String.fromCodePoint(0x20_2e)}txt.exe`,
        `zero${String.fromCodePoint(0x20_0b)}width.png`,
        `c1${String.fromCodePoint(0x85)}.png`,
      ].map(
        async (name) =>
          await answerOf(await raw.begin({ ...declaration(), name }))
      )
    );
    expect(refused).toStrictEqual([
      "file.invalid",
      "file.invalid",
      "file.invalid",
    ]);
  });

  it("holds a person to their unattached files and bytes, and a store to its bytes", async () => {
    const { release } = await openedApp();
    const codes: unknown[] = [];
    await onStore(release, (host, storeId) => {
      const start = (principal: string, size = 64): string =>
        host.files.begin(storeId, principal, "attachments", {
          ...declaration(),
          size,
        }).file;
      const published = (principal: string, size?: number): void => {
        const file = start(principal, size);
        host.files.publish(
          storeId,
          principal,
          "attachments",
          file,
          true,
          crypto.randomUUID()
        );
      };
      // As if a record held every file published so far: what the test
      // arranges, since holding is a commit's to do.
      const holdAll = () => {
        host.ctx.storage.sql.exec(
          "UPDATE sdk_files SET expires_at = NULL WHERE state = 'published'"
        );
      };
      const big = fileLimits.bytes;
      for (let file = 0; file < fileLimits.unattachedPerPerson; file += 1) {
        published("one");
      }
      codes.push(
        refusal(() => {
          published("one");
        })
      );
      // One short of the limit, uploads started at once: an open upload
      // holds its slot, so only one may start, and none publish past it.
      for (let file = 1; file < fileLimits.unattachedPerPerson; file += 1) {
        published("three");
      }
      const started = Array.from({ length: fileLimits.openUploads }, () =>
        refusal(() => {
          start("three");
        })
      );
      codes.push(started.filter((code) => code === "admitted").length);
      holdAll();
      const perPerson = Math.floor(fileLimits.personBytes / big);
      for (let file = 0; file < perPerson - 1; file += 1) {
        published("two", big);
        holdAll();
      }
      codes.push(
        refusal(() => {
          published("two", big);
        }),
        refusal(() => {
          published("two", big);
        })
      );
      // The store as a whole, across people each within their own bytes.
      let refused: unknown = "admitted";
      const people =
        Math.ceil(fileLimits.storeBytes / fileLimits.personBytes) + 1;
      for (
        let person = 0;
        person < people && refused === "admitted";
        person += 1
      ) {
        for (
          let file = 0;
          file < perPerson - 1 && refused === "admitted";
          file += 1
        ) {
          refused = refusal(() => {
            published(`many-${person}`, big);
          });
          holdAll();
        }
      }
      codes.push(refused);
    });
    expect(codes).toStrictEqual([
      "file.unattached_limit",
      1,
      "admitted",
      "file.quota_exceeded",
      "file.quota_exceeded",
    ]);
  });

  it("gives chunks a budget of their own, a refused one counting too", async () => {
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const file = crypto.randomUUID();
    // Twice the burst at once: each charged before anything else, so the
    // budget runs out whatever each costs after.
    const statuses = await Promise.all(
      Array.from(
        { length: 2 * fileLimits.chunkRequests.burst },
        async () => await statusOf(raw.put(file, 0, png(10), "0".repeat(64)))
      )
    );
    const limited = statuses.filter((status) => status === 429).length;
    expect(limited).toBeGreaterThan(0);
    expect(limited).toBeLessThanOrEqual(fileLimits.chunkRequests.burst);
  });

  it("keeps a chunk once recorded: a late write removes only its own object", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    // A write admitted, whose bytes are still on their way.
    const admitted: { key: string | null } = { key: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        admitted.key = await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          bytes.length
        );
      }
    );
    // Meanwhile the chunk is sent again, recorded, and the file published.
    await expect(statusOf(raw.put(file, 0, bytes, sha))).resolves.toBe(200);
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
    // The late write lands, other bytes: not recorded, its object removed.
    const other = png(100).fill(7, 8);
    await env.FILES.put(admitted.key ?? "", other);
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        const recorded = instance.chunkStored(
          storeId,
          builder.userId,
          file,
          0,
          other.length,
          await sha256(other),
          admitted.key ?? ""
        );
        if (recorded !== "recorded") {
          await env.FILES.delete(admitted.key ?? "");
        }
      }
    );
    // And one sent after publication is refused outright.
    await expect(
      statusOf(raw.put(file, 0, other, await sha256(other)))
    ).resolves.toBe(409);
    const content = await screen.channel.content("attachments", file);
    const objects = await storedObjects(release);
    expect({
      bytes: await content.bytes(),
      objects: objects.length,
    }).toStrictEqual({
      bytes,
      objects: 1,
    });
  });

  it("records one of two writes of a chunk sent at once, and publishes only what it recorded", async () => {
    const { app, release, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const mine = png(100);
    const theirs = png(100).fill(9, 8);
    const file = await begunFile(
      await raw.begin({
        ...declaration(),
        size: 100,
        sha256: await sha256(mine),
      })
    );
    await Promise.all([
      raw.put(file, 0, mine, await sha256(mine)),
      raw.put(file, 0, theirs, await sha256(theirs)),
    ]);
    await expect(answerOf(await raw.status(file))).resolves.toMatchObject({
      received: [0],
    });
    await expect(storedObjects(release)).resolves.toHaveLength(1);
    const finished = await answerOf(await raw.finish(file));
    if (finished === "file.content_mismatch") {
      // The other write was recorded: rejected, never published.
      return;
    }
    const content = await screen.channel.content("attachments", file);
    await expect(content.bytes()).resolves.toStrictEqual(mine);
  });

  it("keeps a chunk sent again while its first write still ran, whichever is recorded first", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    // The first write's request timed out at the page but ran on in core:
    // while the chunk sent again is being stored, the first records it.
    let firstRecorded: string | undefined;
    const recordFirst = async (): Promise<void> => {
      await runInDurableObject(
        env.DATA_STORES.getByName(storeId),
        async (instance: DataStore) => {
          const key = await instance.admitChunk(
            storeId,
            builder.userId,
            "attachments",
            file,
            0,
            bytes.length
          );
          await env.FILES.put(key ?? "", bytes);
          firstRecorded = instance.chunkStored(
            storeId,
            builder.userId,
            file,
            0,
            bytes.length,
            sha,
            key ?? ""
          );
        }
      );
    };
    const racing = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            await recordFirst();
            return await target.put(...args);
          };
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const again = await raw.put(file, 0, bytes, sha, { ...env, FILES: racing });
    // The chunk sent again is kept, not cancelled: its own object removed,
    // the first write's the chunk's, and the upload goes on.
    expect({
      status: again.status,
      answer: await again.json(),
      firstRecorded,
    }).toStrictEqual({
      status: 200,
      answer: { kept: true },
      firstRecorded: "recorded",
    });
    await expect(storedObjects(release)).resolves.toHaveLength(1);
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
  });

  it("keeps a chunk whose recording committed though its answer was lost", async () => {
    const { app, release, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    // The store records the chunk; its answer never reaches the route.
    const stores = new Proxy(env.DATA_STORES, {
      get: (target, property) => {
        if (property === "getByName") {
          return (name: string) => lossyChunkAnswers(target.getByName(name));
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const sent = await raw.put(file, 0, bytes, sha, {
      ...env,
      DATA_STORES: stores,
    });
    // Kept: the store recorded this write's object, which stays.
    expect({ status: sent.status, answer: await sent.json() }).toStrictEqual({
      status: 200,
      answer: { kept: true },
    });
    await expect(storedObjects(release)).resolves.toHaveLength(1);
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
    const content = await screen.channel.content("attachments", file);
    await expect(content.bytes()).resolves.toStrictEqual(bytes);
  });

  it("removes a write's object once it had time to settle, when neither its recording nor the check after answered", async () => {
    const { app, release, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    // Neither the recording nor the check after reaches the store: the
    // route can't tell whether the chunk is recorded, so its object stays.
    const unreachable = new Proxy(env.DATA_STORES, {
      get: (target, property) => {
        if (property === "getByName") {
          return (name: string) =>
            new Proxy(target.getByName(name), {
              get: (stub, method) => {
                const value: unknown = Reflect.get(stub, method);
                if (typeof value !== "function") {
                  return value;
                }
                if (method === "chunkStored" || method === "chunkKey") {
                  return async () => {
                    await Promise.resolve();
                    throw new Error("The connection was reset.");
                  };
                }
                // A stub's methods are called on it, never bound.
                return async (...args: unknown[]) => {
                  const answer: unknown = await Reflect.apply(
                    value,
                    stub,
                    args
                  );
                  return answer;
                };
              },
            });
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const lost = await raw.put(file, 0, bytes, sha, {
      ...env,
      DATA_STORES: unreachable,
    });
    await lost.body?.cancel();
    // Sent again, recorded, and published: the first write's object stays.
    const sent = await raw.put(file, 0, bytes, sha);
    await sent.body?.cancel();
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
    const before = await storedObjects(release);

    await sweepIn(release, purgeGraceMs + 1);

    const after = await storedObjects(release);
    expect({ before: before.length, after: after.length }).toStrictEqual({
      before: 2,
      after: 1,
    });
    const content = await screen.channel.content("attachments", file);
    await expect(content.bytes()).resolves.toStrictEqual(bytes);
  });

  it("removes a losing write's object once it had time to settle, though its writer never did", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const admitted: { key: string | null } = { key: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        admitted.key = await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          bytes.length
        );
      }
    );
    // Another write of the chunk is recorded first; this one's bytes land
    // after, and it loses, but its writer never removes them.
    await expect(statusOf(raw.put(file, 0, bytes, sha))).resolves.toBe(200);
    await env.FILES.put(admitted.key ?? "", bytes);
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      (instance: DataStore) => {
        instance.chunkStored(
          storeId,
          builder.userId,
          file,
          0,
          bytes.length,
          sha,
          admitted.key ?? ""
        );
      }
    );
    const before = await storedObjects(release);
    await sweepIn(release, purgeGraceMs + 1);
    const after = await storedObjects(release);
    expect({ before: before.length, after: after.length }).toStrictEqual({
      before: 2,
      after: 1,
    });
  });

  it("removes again a write's object that lands after the alarm removed it", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const admitted: { key: string | null } = { key: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        admitted.key = await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          bytes.length
        );
      }
    );
    await sweepIn(release, purgeGraceMs + 1);
    // Its put lands only now, and its writer never removes it.
    await env.FILES.put(admitted.key ?? "", bytes);
    await sweepIn(release, purgeGraceMs + 2);
    await expect(storedObjects(release)).resolves.toStrictEqual([]);
  });

  it("tries again at the alarm's next try to remove a write's object whose removal failed", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const admitted: { key: string | null } = { key: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        admitted.key = await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          bytes.length
        );
      }
    );
    // Its put lands, and its writer never records it.
    await env.FILES.put(admitted.key ?? "", bytes);
    const due: {
      failed?: unknown;
      next: number | null;
      alarm: number | null;
      now: number;
    } = { next: null, alarm: null, now: 0 };
    // The write's lifetime, and leeway for the test's own time.
    const writeLifetime = 60 * 60_000;
    const retrySlackMs = 5000;
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (_instance, state) => {
        const host = new StoreHost(state, { ...env, FILES: failingDeletes });
        try {
          await host.files.sweep(storeId, Date.now() + purgeGraceMs + 1);
        } catch (error) {
          due.failed = error;
        }
        due.next = host.files.nextDue();
        // The store's activity sets the alarm again (a commit, a chunk):
        // the failed removal stays a retry's wait away all the same.
        await state.storage.deleteAlarm();
        await host.schedule();
        due.alarm = await state.storage.getAlarm();
        due.now = Date.now();
      }
    );
    const kept = await storedObjects(release);
    // Past the retry's wait, R2 working again.
    await sweepIn(release, purgeGraceMs + removalRetryMs + 2);
    expect({
      failed: due.failed instanceof Error,
      // Due again a retry's wait after it was tried: never only once the
      // write could no longer land.
      dueSoon: (due.next ?? Number.POSITIVE_INFINITY) < due.now + writeLifetime,
      // Nor at every alarm the store's activity brings forward.
      alarmWaits: (due.alarm ?? 0) - due.now >= removalRetryMs - retrySlackMs,
      kept: kept.length,
      after: await storedObjects(release),
    }).toStrictEqual({
      failed: true,
      dueSoon: true,
      alarmWaits: true,
      kept: 1,
      after: [],
    });
  });

  it("tries a failed removal again only after the retry's wait, however often the alarm comes", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const tried = { deletes: 0 };
    const counted = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "delete") {
          return async () => {
            tried.deletes += 1;
            await Promise.resolve();
            throw new Error("R2 is unavailable.");
          };
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const seen: number[] = [];
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore, state) => {
        await instance.admitChunk(
          storeId,
          builder.userId,
          "attachments",
          file,
          0,
          bytes.length
        );
        const host = new StoreHost(state, { ...env, FILES: counted });
        const at = Date.now() + purgeGraceMs + 1;
        // The first sweep tries and fails; one a second later, as a busy
        // store's alarm comes, tries nothing; one past the wait tries again.
        for (const offset of [0, 1000, removalRetryMs + 1]) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- one sweep after another
            await host.files.sweep(storeId, at + offset);
          } catch {
            // Its removal failed, as arranged.
          }
          seen.push(tried.deletes);
        }
      }
    );
    expect(seen).toStrictEqual([1, 1, 2]);
  });

  it("tries again a failed removal behind a full page of writes removed already and kept for late puts", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const admit = async (): Promise<string> => {
      const admitted: { key: string | null } = { key: null };
      await runInDurableObject(
        env.DATA_STORES.getByName(storeId),
        async (instance: DataStore) => {
          admitted.key = await instance.admitChunk(
            storeId,
            builder.userId,
            "attachments",
            file,
            0,
            bytes.length
          );
        }
      );
      return admitted.key ?? "";
    };
    // More writes than a page, never recorded, removed by the alarm and
    // kept, as removed writes are, until a write could no longer land.
    for (let write = 0; write <= sweepPageSize; write += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one write at a time
      await admit();
    }
    await sweepIn(release, purgeGraceMs + 1);
    // A later write whose object lands, and whose removal fails.
    const late = await admit();
    await env.FILES.put(late, bytes);
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (_instance, state) => {
        const host = new StoreHost(state, { ...env, FILES: failingDeletes });
        try {
          await host.files.sweep(storeId, Date.now() + purgeGraceMs + 2);
        } catch {
          // Its removal failed, as arranged.
        }
      }
    );
    const kept = await storedObjects(release);
    await sweepIn(release, purgeGraceMs + removalRetryMs + 3);
    expect({ kept, after: await storedObjects(release) }).toStrictEqual({
      kept: [late],
      after: [],
    });
  });

  it("ends only its own finish claim, never one another finish took once its own expired", async () => {
    const { app, release, screen, builder } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    await expect(statusOf(raw.put(file, 0, bytes, sha))).resolves.toBe(200);
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const seen: { stale?: unknown; afterOwn?: unknown } = {};
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (_instance, state) => {
        const host = new StoreHost(state, env);
        const first = claimOf(
          await host.files.publishable(
            storeId,
            builder.userId,
            "attachments",
            file
          )
        );
        // The first check runs past its claim: the next finish claims it.
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime(Date.now() + finishClaimMs + 1);
          const second = claimOf(
            await host.files.publishable(
              storeId,
              builder.userId,
              "attachments",
              file
            )
          );
          const third = host.files.publishable(
            storeId,
            builder.userId,
            "attachments",
            file
          );
          const waiting = async () =>
            await Promise.race([
              third.then(() => "answered"),
              scheduler.wait(100).then(() => "waiting"),
            ]);
          // The first check, late, ends its own claim: not the second's.
          host.files.abandonFinish(file, first);
          seen.stale = await waiting();
          host.files.abandonFinish(file, second);
          seen.afterOwn = await waiting();
        } finally {
          vi.useRealTimers();
        }
      }
    );
    expect(seen).toStrictEqual({ stale: "waiting", afterOwn: "answered" });
  });

  it("checks an upload's bytes once however many finishes arrive at once, answering each with the file", async () => {
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    await expect(statusOf(raw.put(file, 0, bytes, sha))).resolves.toBe(200);
    const { promise: open, resolve: letThrough } =
      Promise.withResolvers<null>();
    const { seen, reading } = gatedReads(open);
    const gated = { ...env, FILES: reading };
    const first = raw.finish(file, gated);
    await vi.waitFor(() => {
      expect(seen.reads).toBe(1);
    });
    const second = raw.finish(file, gated);
    // The second has reached the store, where it waits for the first.
    await scheduler.wait(250);
    letThrough(null);
    const answers = await Promise.all([
      answerOf(await first),
      answerOf(await second),
    ]);
    expect({
      reads: seen.reads,
      answers: answers.map((answer) =>
        typeof answer === "object" && answer !== null && "state" in answer
          ? answer.state
          : answer
      ),
    }).toStrictEqual({ reads: 1, answers: ["published", "published"] });
  });
});
