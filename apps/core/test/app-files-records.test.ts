import { fileLimits } from "@grasp-os/shared/app-file-limits";
import { storeIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { DataStore } from "../src/data-store.ts";
import { purgeGraceMs } from "../src/file-host.ts";
import { StoreHost } from "../src/store-host.ts";
import {
  appsOf,
  answerOf,
  begunFile,
  blobOf,
  codeOf,
  declaration,
  fileEvents,
  gaps,
  png,
  rawChannel,
  permissions,
  sha256,
  storedObjects,
  sweepIn,
  upload,
  utf8,
} from "./app-files.ts";
import { mockIdp } from "./idp.ts";

// An App's files (spec 9.6, 10.7.5, 32.5): an upload's finish, checked
// once however often it is asked, and what the alarm removes after a write
// that never settled; a file held by records a person may and may not
// read; and the audit of each file's publication, deletion and reads.

const { openedApp, colleagueOf } = appsOf(mockIdp());

describe("an App's files", { timeout: 120_000 }, () => {
  it("sets the alarm for a chunk write's cleanup once it admits one", async () => {
    const { app, release, page, builder } = await openedApp();
    const raw = rawChannel(page, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    const alarm: { at: number | null } = { at: null };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore, state) => {
        // The upload's own expiry put off, as an idle store's would be.
        await state.storage.deleteAlarm();
        await instance.admitChunk(
          storeId,
          builder.userId,
          "files",
          file,
          0,
          bytes.length
        );
        alarm.at = await state.storage.getAlarm();
      }
    );
    expect(alarm.at).not.toBeNull();
    expect((alarm.at ?? 0) - Date.now()).toBeLessThanOrEqual(
      purgeGraceMs + 60_000
    );
  });

  it("never records a write the alarm removed for taking too long to settle, and takes the chunk sent again", async () => {
    const { app, release, page, builder } = await openedApp();
    const raw = rawChannel(page, app);
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
          "files",
          file,
          0,
          bytes.length
        );
      }
    );
    // Its bytes land, but its recording comes only after the alarm took
    // it for one that never settled.
    await env.FILES.put(admitted.key ?? "", bytes);
    await sweepIn(release, purgeGraceMs + 1);
    const answered: { record: unknown } = { record: undefined };
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      (instance: DataStore) => {
        answered.record = instance.chunkStored(
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
    expect({
      record: answered.record,
      objects: await storedObjects(release),
    }).toStrictEqual({ record: "expired", objects: [] });
    // The upload is still open: the chunk sent again is kept, and it
    // publishes.
    await expect(
      answerOf(await raw.put(file, 0, bytes, sha))
    ).resolves.toStrictEqual({ kept: true });
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
  });

  it("answers a chunk whose write took too long to settle as one to send again, its upload still open", async () => {
    const { app, release, page } = await openedApp();
    const raw = rawChannel(page, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    // Its put lands only once the alarm took it for one that never settles.
    const slow = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            await sweepIn(release, purgeGraceMs + 1);
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
    const slowAnswer = await raw.put(file, 0, bytes, sha, {
      ...env,
      FILES: slow,
    });
    expect({
      status: slowAnswer.status,
      code: await answerOf(slowAnswer),
    }).toStrictEqual({ status: 503, code: "internal.unexpected" });
    await expect(
      answerOf(await raw.put(file, 0, bytes, sha))
    ).resolves.toStrictEqual({ kept: true });
    await expect(answerOf(await raw.finish(file))).resolves.toMatchObject({
      state: "published",
    });
  });

  it("records nothing of a chunk written after its store was deleted, so its writer removes it", async () => {
    const { app, release, page, builder } = await openedApp();
    const raw = rawChannel(page, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: 100, sha256: sha })
    );
    const storeId = storeIdSchema.parse(release.store?.storeId);
    let answered: string | undefined;
    await runInDurableObject(
      env.DATA_STORES.getByName(storeId),
      async (instance: DataStore, state) => {
        const key = await instance.admitChunk(
          storeId,
          builder.userId,
          "files",
          file,
          0,
          100
        );
        await new StoreHost(state, env).close(storeId, { type: "system" });
        answered = instance.chunkStored(
          storeId,
          builder.userId,
          file,
          0,
          100,
          sha,
          key ?? ""
        );
      }
    );
    expect(answered).toBe("ended");
  });

  it("reads an uploader's file through its record once a record holds it", async () => {
    const { builder, app, api } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(colleague.page.channel, blobOf(png(), "image/png"));
    await expect(
      colleague.page.channel.describe("files", id)
    ).resolves.toMatchObject({ id });
    // In the vault, which only builders read: not even its uploader reads it.
    await colleague.client.mutation(api.stash, { file: { id } });
    await expect(
      codeOf(colleague.page.channel.describe("files", id))
    ).resolves.toBe("file.not_found");
  });

  it("moves a file from a record deleted to one written before it in the same commit", async () => {
    const { client, api, page } = await openedApp();
    const id = await upload(page.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Old" });
    await client.mutation(api.attachFile, {
      id: note,
      file: { id },
    });
    const renewed = await client.mutation(api.renew, {
      id: note,
      file: { id },
    });
    expect({
      renewed: typeof renewed,
      read: await page.channel.describe("files", id),
    }).toMatchObject({ renewed: "string", read: { id } });
  });

  it("lets an uploader attach a new file to records they can and can't read in one commit, in either order", async () => {
    const { builder, app, api } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const kept = async (vaultFirst: boolean) => {
      const id = await upload(
        colleague.page.channel,
        blobOf(png(), "image/png")
      );
      await colleague.client.mutation(api.keepTwice, {
        file: { id },
        vaultFirst,
      });
      // Readable through the board, whatever the vault says.
      const read = await colleague.page.channel.describe("files", id);
      return read.id === id;
    };
    expect([await kept(true), await kept(false)]).toStrictEqual([true, true]);
  });

  it("never lets its uploader hold a file again through App code once a record they can't read holds it", async () => {
    const { builder, app, api } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const held = await upload(
      colleague.page.channel,
      blobOf(png(), "image/png")
    );
    const loose = await upload(
      colleague.page.channel,
      blobOf(png(), "image/png")
    );
    // In the vault, which only builders read; then pinned to the board,
    // which every member reads, by a reference App code made itself.
    await colleague.client.mutation(api.stash, { file: { id: held } });
    expect({
      held: await codeOf(
        colleague.client.mutation(api.pinById, { fileId: held })
      ),
      loose: typeof (await colleague.client.mutation(api.pinById, {
        fileId: loose,
      })),
      read: await codeOf(colleague.page.channel.describe("files", held)),
    }).toStrictEqual({
      held: "file.not_found",
      loose: "string",
      read: "file.not_found",
    });
  });

  it("lets a person read a file through the one record of many holding it they may read", async () => {
    const { builder, app, client, api, page } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(page.channel, blobOf(png(), "image/png"));
    // Many vault entries, which only builders read; then the board, which
    // every member reads.
    await client.mutation(api.stashMany, { file: { id }, count: 80 });
    await client.mutation(api.pin, { file: { id } });
    await expect(
      colleague.page.channel.describe("files", id)
    ).resolves.toMatchObject({ id });
  });

  it("audits someone else's preview as a preview and their download as a download, and previews only an image", async () => {
    const { builder, app, client, api, page } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const image = await upload(page.channel, blobOf(png(), "image/png"));
    const text = await upload(
      page.channel,
      blobOf(utf8("Plain words."), "text/plain")
    );
    const note = await client.mutation(api.create, { title: "Shared" });
    await client.mutation(api.attachFile, {
      id: note,
      file: { id: image },
    });
    await client.mutation(api.attachFile, {
      id: note,
      file: { id: text },
    });
    const previewed = await colleague.page.channel.preview("files", image);
    await previewed.arrayBuffer();
    const refused = await codeOf(colleague.page.channel.preview("files", text));
    await colleague.client.files.download(permissions.files, {
      id: image,
    });
    const events = await fileEvents();
    expect({
      image: events
        .filter(({ file }) => file === image)
        .map(({ said }) => said)
        .toSorted(),
      refused,
    }).toStrictEqual({
      image: [
        `file.downloaded:${colleague.userId}`,
        `file.previewed:${colleague.userId}`,
        `file.published:${builder.userId}`,
      ].toSorted(),
      refused: "file.invalid",
    });
  });

  it("audits a person's downloads of a file once a day, though the first was logged before the next", async () => {
    const { builder, app, client, api, page } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const kept = await upload(page.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Shared" });
    await client.mutation(api.attachFile, {
      id: note,
      file: { id: kept },
    });
    await colleague.client.files.download(permissions.files, { id: kept });
    // Logged, its outbox row gone, before the next download that day.
    const before = await gaps();
    await colleague.client.files.download(permissions.files, { id: kept });
    const after = await gaps();
    const events = await fileEvents();
    expect({
      gaps: after - before,
      downloads: events.filter(
        ({ file, said }) =>
          file === kept && said === `file.downloaded:${colleague.userId}`
      ).length,
    }).toStrictEqual({ gaps: 0, downloads: 1 });
  });

  it("audits publication, deletion by its uploader or the platform, and downloads by anyone else", async () => {
    const { builder, app, client, api, release, page } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const kept = await upload(page.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Shared" });
    await client.mutation(api.attachFile, {
      id: note,
      file: { id: kept },
    });
    // Downloaded twice by a colleague, once by its uploader.
    await colleague.client.files.download(permissions.files, { id: kept });
    await colleague.client.files.download(permissions.files, { id: kept });
    await client.files.download(permissions.files, { id: kept });
    const deleted = await upload(page.channel, blobOf(png(), "image/png"));
    await client.files.delete(permissions.files, { id: deleted });
    const orphan = await upload(page.channel, blobOf(png(), "image/png"));
    await sweepIn(release, fileLimits.orphanMs + 1);
    await codeOf(upload(page.channel, blobOf(utf8("not a png"), "image/png")));
    const events = await fileEvents();
    expect({
      kept: events.filter(({ file }) => file === kept).map(({ said }) => said),
      deleted: events
        .filter(({ file }) => file === deleted)
        .map(({ said }) => said),
      orphan: events
        .filter(({ file }) => file === orphan)
        .map(({ said }) => said),
      rejected: events.filter(
        ({ said, uploadedBy }) =>
          said === "file.deleted:system:rejected" &&
          uploadedBy === builder.userId
      ).length,
    }).toStrictEqual({
      kept: [
        `file.published:${builder.userId}`,
        `file.downloaded:${colleague.userId}`,
      ],
      deleted: [
        `file.published:${builder.userId}`,
        `file.deleted:${builder.userId}`,
      ],
      orphan: [
        `file.published:${builder.userId}`,
        "file.deleted:system:orphaned",
      ],
      rejected: 1,
    });
  });
});
