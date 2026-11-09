import { fileLimits } from "@grasp-os/shared/app-file-limits";
import { storeIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DataStore } from "../src/data-store.ts";
import { finishClaimMs, purgeGraceMs } from "../src/file-host.ts";
import { StoreHost } from "../src/store-host.ts";
import {
  appsOf,
  answerOf,
  begunFile,
  declaration,
  failingDeletes,
  gatedReads,
  png,
  rawChannel,
  sha256,
  statusOf,
  utf8,
} from "./app-files.ts";
import { mockIdp } from "./idp.ts";

// An App's files (spec 9.6, 10.7.5, 32.5): an upload's finish, checked
// once however often it is asked, and what the alarm removes after a write
// that never settled; a file held by records a person may and may not
// read; and the audit of each file's publication, deletion and reads.

const { openedApp } = appsOf(mockIdp());

describe("an App's files", { timeout: 120_000 }, () => {
  it("answers a finish waiting behind a check that never reported back before the page gives up", async () => {
    const { app, release, page, builder } = await openedApp();
    const raw = rawChannel(page, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    await expect(statusOf(raw.put(file, 0, bytes, sha))).resolves.toBe(200);
    // A finish claims the upload for its check, then its request dies.
    const storeId = storeIdSchema.parse(release.store?.storeId);
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore) => {
        await instance.publishable(storeId, builder.userId, "files", file);
      }
    );
    const started = Date.now();
    const answer = await answerOf(await raw.finish(file));
    expect({
      answer,
      inTime: Date.now() - started < fileLimits.chunkSendMs,
    }).toMatchObject({ answer: { state: "published" }, inTime: true });
  });

  it("answers a finish whose check failed with that failure, though ending its claim failed too", async () => {
    const { app, page } = await openedApp();
    const raw = rawChannel(page, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    await expect(statusOf(raw.put(file, 0, bytes, sha))).resolves.toBe(200);
    const unreadable = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "get") {
          return async () => {
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
    // Ending the claim fails with a refusal of its own.
    const stores = new Proxy(env.DATA_STORES, {
      get: (target, property) => {
        if (property === "getByName") {
          return (name: string) =>
            new Proxy(target.getByName(name), {
              get: (stub, method) => {
                const value: unknown = Reflect.get(stub, method);
                if (typeof value !== "function") {
                  return value;
                }
                if (method === "abandonFinish") {
                  return async () => {
                    await Promise.resolve();
                    throw Object.assign(new Error("Expired."), {
                      code: "file.upload_expired",
                    });
                  };
                }
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
    const failed = await raw.finish(file, {
      ...env,
      FILES: unreadable,
      DATA_STORES: stores,
    });
    expect({
      status: failed.status,
      answer: await failed.json(),
    }).toMatchObject({
      status: 500,
      answer: { code: "internal.unexpected" },
    });
  });

  it("answers a finish that waited for a check that rejected the bytes with the rejection", async () => {
    const { app, page } = await openedApp();
    const raw = rawChannel(page, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    // The whole is declared as other bytes than the chunk sent.
    const file = await begunFile(
      await raw.begin({
        ...declaration(),
        size: bytes.length,
        sha256: await sha256(utf8("other bytes than the chunk sent")),
      })
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
    await scheduler.wait(250);
    letThrough(null);
    const answers = await Promise.all([
      answerOf(await first),
      answerOf(await second),
    ]);
    expect(answers).toStrictEqual([
      "file.content_mismatch",
      "file.content_mismatch",
    ]);
  });

  it("hands the store's audit events over though removing write objects keeps failing", async () => {
    const { release } = await openedApp();
    const left: { before?: number; events?: number; failed?: boolean } = {};
    await runInDurableObject(
      env.DATA_STORES.getByName(storeIdSchema.parse(release.store?.storeId)),
      async (_instance, state) => {
        const host = new StoreHost(state, { ...env, FILES: failingDeletes });
        const storeId = storeIdSchema.parse(release.store?.storeId);
        const principal = `person-${crypto.randomUUID()}`;
        const { file } = host.files.begin(storeId, principal, "files", {
          ...declaration(),
          size: 64,
        });
        // A write never recorded, due for removal; and an audit event,
        // of its publication.
        host.files.admitChunk(storeId, principal, "files", file, 0, 64);
        host.files.publish(
          storeId,
          principal,
          "files",
          file,
          true,
          crypto.randomUUID()
        );
        left.before = state.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM sdk_file_events")
          .one().n;
        try {
          await host.files.sweep(storeId, Date.now() + purgeGraceMs + 1);
          left.failed = false;
        } catch {
          left.failed = true;
        }
        left.events = state.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM sdk_file_events")
          .one().n;
      }
    );
    expect(left).toStrictEqual({ before: 1, failed: true, events: 0 });
  });

  it("lets the next finish check an upload at once when a check failed before it could say", async () => {
    const { app, page } = await openedApp();
    const raw = rawChannel(page, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    await expect(statusOf(raw.put(file, 0, bytes, sha))).resolves.toBe(200);
    const unreadable = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "get") {
          return async () => {
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
    const failed = await statusOf(
      raw.finish(file, { ...env, FILES: unreadable })
    );
    const started = Date.now();
    const again = await answerOf(await raw.finish(file));
    expect({
      failed,
      again,
      // Not held back until the failed check's claim ran out.
      atOnce: Date.now() - started < finishClaimMs / 2,
    }).toMatchObject({
      failed: 500,
      again: { state: "published" },
      atOnce: true,
    });
  });
});
