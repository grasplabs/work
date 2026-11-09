import { fileChannel } from "@grasp-os/sdk/host";
import { appFilesPath, fileLimits } from "@grasp-os/shared/app-file-limits";
import { appIdSchema } from "@grasp-os/shared/ids";
import { pagePersonHeader } from "@grasp-os/shared/page-limits";
import { pageLeaseHeader } from "@grasp-os/shared/pages";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { revokeRelease } from "../src/release-retention.ts";
import { commitApp } from "./app-definitions.ts";
import {
  appsOf,
  answerOf,
  begunFile,
  blobOf,
  codeOf,
  declaration,
  fileStates,
  files,
  never,
  onStore,
  png,
  rawChannel,
  permissions,
  pageOf,
  sha256,
  statusOf,
  storedObjects,
  upload,
  uploadKey,
  utf8,
} from "./app-files.ts";
import { published as publishedApp } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed } from "./sign-in.ts";

// An App's files (spec 9.6, 10.7.5, 32.5), uploaded through core's file
// channel as a running page's page reaches it, attached and read through
// the App's own functions; and, from the threat model (core's file-host.ts
// and app-file-route.ts), every way an upload should fail: another
// person's upload, another App's, a guessed ID, a request without the
// page's lease or from another site, a type or content that isn't what
// it says, a chunk that isn't the one it says, an answer lost on the way.

const { personApi, releasedApp, openedApp, colleagueOf } = appsOf(mockIdp());

describe("an App's files", { timeout: 120_000 }, () => {
  it("uploads a file in chunks, reporting the bytes core holds", async () => {
    const { page } = await openedApp();
    const progress: unknown[] = [];
    const bytes = png(fileLimits.chunkBytes + 100);
    const id = await page.channel.upload(
      "files",
      blobOf(bytes, "image/png"),
      "Plan.png",
      {
        cancel: never,
        onProgress: (step) => {
          progress.push(step);
        },
      }
    );
    expect(progress).toStrictEqual([
      { phase: "uploading", bytesUploaded: 0, bytesTotal: bytes.length },
      {
        phase: "uploading",
        bytesUploaded: fileLimits.chunkBytes,
        bytesTotal: bytes.length,
      },
      {
        phase: "verifying",
        bytesUploaded: bytes.length,
        bytesTotal: bytes.length,
      },
    ]);
    await expect(page.channel.describe("files", id)).resolves.toStrictEqual({
      id,
      name: "Plan.png",
      mimeType: "image/png",
      size: bytes.length,
    });
  });

  it("attaches a file to a note, and downloads it only as an attachment", async () => {
    const { client, api, page, downloads } = await openedApp();
    const id = await upload(page.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Plan" });
    await expect(
      client.mutation(api.attachFile, {
        id: note,
        file: { id },
      })
    ).resolves.toMatchObject({ attachments: [{ id }] });
    await client.files.download(permissions.files, { id });
    expect(downloads.get(id)).toStrictEqual(png());
    const response = await page.channel.content("files", id);
    await response.body?.cancel();
    expect({
      disposition: response.headers.get("content-disposition"),
      sniffing: response.headers.get("x-content-type-options"),
      cache: response.headers.get("cache-control"),
    }).toStrictEqual({
      disposition: `attachment; filename="photo.png"; filename*=UTF-8''photo.png`,
      sniffing: "nosniff",
      cache: "private, no-store",
    });
  });

  it("keeps an unattached upload its uploader's alone, whatever another person asks", async () => {
    const { builder, app, api, page } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(page.channel, blobOf(png(), "image/png"));
    const theirNote = await colleague.client.mutation(api.create, {
      title: "Theirs",
    });
    // The same answer for their upload as for an ID that doesn't exist.
    await expect(
      Promise.all([
        codeOf(colleague.page.channel.describe("files", id)),
        codeOf(colleague.page.channel.describe("files", crypto.randomUUID())),
        codeOf(colleague.page.channel.delete("files", id)),
        codeOf(
          colleague.client.mutation(api.attachFile, {
            id: theirNote,
            file: { id },
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "file.not_found",
      "file.not_found",
      "file.not_found",
      "file.not_found",
    ]);
  });

  it("lets another person read a file while a note they may read holds it, and never delete it", async () => {
    const { builder, app, client, api, page } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(page.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Shared" });
    await client.mutation(api.attachFile, {
      id: note,
      file: { id },
    });
    await colleague.client.files.download(permissions.files, { id });
    expect(colleague.downloads.get(id)).toStrictEqual(png());
    await expect(
      codeOf(colleague.page.channel.delete("files", id))
    ).resolves.toBe("file.not_found");
    // Detached again: theirs to read no longer.
    await client.mutation(api.detachFile, {
      id: note,
      file: { id },
    });
    await expect(
      codeOf(colleague.page.channel.describe("files", id))
    ).resolves.toBe("file.not_found");
  });

  it("keeps each App's files to it, and each use to the operations its resource declares", async () => {
    const one = await openedApp();
    const other = await openedApp();
    const id = await upload(other.page.channel, blobOf(png(), "image/png"));
    const note = await one.client.mutation(one.api.create, { title: "One" });
    await expect(
      Promise.all([
        codeOf(
          one.client.mutation(one.api.attachFile, {
            id: note,
            file: { id },
          })
        ),
        codeOf(one.page.channel.describe("files", id)),
        // Neither `photos` nor `nothing` is the App's files permission.
        codeOf(
          upload(
            one.page.channel,
            blobOf(png(), "image/png"),
            "a.png",
            "photos"
          )
        ),
        codeOf(one.page.channel.describe("nothing", id)),
      ])
    ).resolves.toStrictEqual([
      "file.not_found",
      "file.not_found",
      "file.operation_denied",
      "file.operation_denied",
    ]);
  });

  it("refuses a request without the page's lease, or from another site", async () => {
    const { app, builder } = await openedApp();
    const { lease } = await builder.api.pages.open(app);
    const path = `${appFilesPath}/${app}/files/files/${crypto.randomUUID()}`;
    const statuses = await Promise.all(
      [
        new Headers({ cookie: builder.session }),
        new Headers({
          cookie: builder.session,
          [pageLeaseHeader]: lease,
          "sec-fetch-site": "cross-site",
        }),
      ].map(async (headers) => await statusOf(routed(path, { headers })))
    );
    expect(statuses).toStrictEqual([403, 403]);
  });

  it("refuses a change from no Origin or another site's, though its lease and session are the page's", async () => {
    const { builder, app, page } = await openedApp();
    const id = await upload(page.channel, blobOf(png(), "image/png"));
    const base = `${appFilesPath}/${app}/files`;
    const sent = async (path: string, body: unknown, origin?: string) => {
      const headers = new Headers({
        cookie: builder.session,
        [pageLeaseHeader]: page.lease,
        [pagePersonHeader]: builder.userId,
        "content-type": "application/json",
      });
      if (origin !== undefined) {
        headers.set("origin", origin);
      }
      return await statusOf(
        routed(path, { method: "POST", headers, body: JSON.stringify(body) })
      );
    };
    const start = `${base}/uploads`;
    const deletion = `${base}/files/${id}/delete`;
    const starting = { ...declaration(), size: 100 };
    const deleting = { idempotencyKey: uploadKey() };
    expect([
      await sent(start, starting),
      await sent(start, starting, "https://elsewhere.example"),
      await sent(deletion, deleting),
      await sent(deletion, deleting, "https://elsewhere.example"),
    ]).toStrictEqual([403, 403, 403, 403]);
    // The file is still there: nothing of either reached the store.
    await expect(page.channel.describe("files", id)).resolves.toMatchObject({
      id,
    });
  });

  it("serves a new page's file requests with nobody approving its build, and refuses them once its release is revoked", async () => {
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    await publishedApp(app);
    const { version } = await commitApp(
      builder.api.apps.files,
      app,
      files,
      "First"
    );
    await builder.api.apps.versions.setCurrent(app, version);
    // Made current, its App's data sensitive, and no admin looked at it.
    const page = await pageOf(builder, app);
    const id = await upload(page.channel, blobOf(png(), "image/png"));
    await expect(page.channel.describe("files", id)).resolves.toMatchObject({
      id,
    });
    await revokeRelease(
      env,
      await actingPerson("admin"),
      { app: appIdSchema.parse(app), version },
      "Leaks data"
    );
    expect([
      await codeOf(page.channel.describe("files", id)),
      await codeOf(upload(page.channel, blobOf(png(), "image/png"))),
    ]).toStrictEqual(["page.revoked", "page.revoked"]);
  });

  it("refuses a request whose lease doesn't verify for its person, though the App's data is ordinary", async () => {
    const { builder, app, page } = await openedApp();
    const id = await upload(page.channel, blobOf(png(), "image/png"));
    // Ordinary data: code core didn't serve runs without a valid lease
    // elsewhere.
    const admin = await personApi("admin");
    const { generation } = await admin.api.dataPolicy.read(app);
    await admin.api.dataPolicy.classify(app, "ordinary", generation);
    const colleague = await colleagueOf(builder, app);
    const described = async (lease: string) =>
      await page.fetch(`${appFilesPath}/${app}/files/files/${id}`, {
        headers: { [pageLeaseHeader]: lease },
      });
    const refused = await Promise.all(
      // Forged; then a real lease, but signed for someone else.
      [`${"0".repeat(64)}.${"A".repeat(43)}`, colleague.page.lease].map(
        async (lease) => {
          const response = await described(lease);
          return [response.status, await answerOf(response)];
        }
      )
    );
    expect(refused).toStrictEqual([
      [403, "request.forbidden"],
      [403, "request.forbidden"],
    ]);
    await expect(statusOf(described(page.lease))).resolves.toBe(200);
  });

  it("refuses a request naming someone other than the person signed in, or nobody, before it starts anything", async () => {
    const { builder, app, release, page } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const begin = async (named?: string) =>
      await routed(`${appFilesPath}/${app}/files/uploads`, {
        method: "POST",
        headers: {
          origin: clientOrigin,
          cookie: builder.session,
          "content-type": "application/json",
          [pageLeaseHeader]: page.lease,
          ...(named === undefined ? {} : { [pagePersonHeader]: named }),
        },
        body: JSON.stringify(declaration()),
      });
    const refused = await Promise.all(
      [colleague.userId, undefined].map(async (named) => {
        const response = await begin(named);
        return [response.status, await answerOf(response)];
      })
    );
    expect(refused).toStrictEqual([
      [401, "auth.principal_changed"],
      [403, "page.reload_required"],
    ]);
    // A channel whose frame is someone else's starts nothing either.
    const theirs = fileChannel({
      app,
      lease: page.lease,
      person: colleague.page.named,
      fetch: page.fetch,
    });
    await expect(
      codeOf(upload(theirs, blobOf(png(), "image/png")))
    ).resolves.toBe("auth.principal_changed");
    await expect(fileStates(release)).resolves.toStrictEqual([]);
  });

  it("refuses an upload past its limits, or of a type a browser runs, before any byte", async () => {
    const { app, page } = await openedApp();
    const raw = rawChannel(page, app);
    const refused = await Promise.all(
      [
        { ...declaration(), size: fileLimits.bytes + 1 },
        { ...declaration(), type: "image/svg+xml" },
        { ...declaration(), type: "text/html" },
        { ...declaration(), name: "../photo.png" },
        // Half a surrogate pair: no character, so no name a header encodes.
        { ...declaration(), name: `photo${String.fromCodePoint(0xd8_00)}.png` },
        { ...declaration(), extra: true },
      ].map(async (body) => {
        const response = await raw.begin(body);
        return [response.status, await answerOf(response)];
      })
    );
    expect(refused).toStrictEqual(
      Array.from({ length: 6 }, () => [422, "file.invalid"])
    );
    // The page refuses such a file before asking core at all.
    await expect(
      codeOf(upload(page.channel, blobOf(png(), "image/svg+xml"), "a.svg"))
    ).resolves.toBe("file.type_unsupported");
  });

  it("keeps a chunk only if it is the one its place and hash say", async () => {
    const { app, page } = await openedApp();
    const raw = rawChannel(page, app);
    const file = await begunFile(await raw.begin(declaration()));
    const first = png(fileLimits.chunkBytes);
    const short = first.slice(0, 100);
    const statuses = [
      await statusOf(raw.put(file, 0, first, "0".repeat(64))),
      await statusOf(raw.put(file, 0, short, await sha256(short))),
      await statusOf(raw.put(file, 2, short, await sha256(short))),
    ];
    expect(statuses).toStrictEqual([422, 422, 422]);
    await expect(answerOf(await raw.status(file))).resolves.toMatchObject({
      state: "uploading",
      received: [],
    });
    // A finish before every chunk arrived publishes nothing.
    await expect(answerOf(await raw.finish(file))).resolves.toBe(
      "file.incomplete"
    );
  });

  it("refuses other bytes sent for a chunk it holds, though of the same size", async () => {
    const { app, page } = await openedApp();
    const raw = rawChannel(page, app);
    const bytes = png(100);
    const sha = await sha256(bytes);
    const file = await begunFile(
      await raw.begin({ ...declaration(), size: bytes.length, sha256: sha })
    );
    const other = png(100).fill(7, 8);
    const statuses = [
      await statusOf(raw.put(file, 0, bytes, sha)),
      await statusOf(raw.put(file, 0, other, await sha256(other))),
      await statusOf(raw.put(file, 0, bytes, sha)),
    ];
    expect(statuses).toStrictEqual([200, 422, 200]);
  });

  it("rejects a whole that isn't the file declared, and lets the uploader start another", async () => {
    const { app, page } = await openedApp();
    const raw = rawChannel(page, app);
    const file = await begunFile(await raw.begin(declaration()));
    const first = png(fileLimits.chunkBytes);
    const last = first.slice(0, 10);
    await raw.put(file, 0, first, await sha256(first));
    await raw.put(file, 1, last, await sha256(last));
    await expect(answerOf(await raw.finish(file))).resolves.toBe(
      "file.content_mismatch"
    );
    // The rejected upload is no longer open: they may open as many again.
    const opened = await Promise.all(
      Array.from(
        { length: fileLimits.openUploads },
        async () => await statusOf(raw.begin(declaration()))
      )
    );
    expect(opened.every((status) => status === 200)).toBeTruthy();
    await expect(answerOf(await raw.begin(declaration()))).resolves.toBe(
      "file.uploads_open"
    );
  });

  it("checks a file's bytes against its type when it is finished", async () => {
    const { page } = await openedApp();
    const text = async (content: Uint8Array<ArrayBuffer>) =>
      await upload(page.channel, blobOf(content, "text/plain"), "notes.txt");
    await expect(
      Promise.all([
        codeOf(upload(page.channel, blobOf(utf8("not a png"), "image/png"))),
        // Text that isn't UTF-8, or holds a NUL, isn't text.
        codeOf(text(new Uint8Array([0x68, 0x69, 0xff, 0xfe]))),
        codeOf(text(new Uint8Array([0x68, 0x00, 0x69]))),
        // Nor a PNG declared as text.
        codeOf(text(png())),
      ])
    ).resolves.toStrictEqual(
      Array.from({ length: 4 }, () => "file.content_mismatch")
    );
    await expect(text(utf8("Hello, café"))).resolves.toMatch(
      /^[0-9a-f-]{36}$/u
    );
  });

  it("resumes an upload whose answers were lost under the same upload, never a fresh one", async () => {
    const builder = await personApi("builder");
    const { app, release } = await releasedApp(builder);
    const page = await pageOf(builder, app);
    // The network loses the answers to the start, the second chunk and
    // the first finish: all three reached core.
    const sent = { begins: 0, chunks: 0, finishes: 0 };
    const lossy = async (path: string, init: RequestInit) => {
      const response = await page.fetch(path, init);
      if (path.endsWith("/uploads")) {
        sent.begins += 1;
      }
      if (path.includes("/chunks/")) {
        sent.chunks += 1;
      }
      if (path.endsWith("/finish")) {
        sent.finishes += 1;
      }
      if (
        (path.endsWith("/uploads") && sent.begins === 1) ||
        (path.includes("/chunks/") && sent.chunks === 2) ||
        (path.endsWith("/finish") && sent.finishes === 1)
      ) {
        throw new TypeError("The connection was reset.");
      }
      return response;
    };
    const channel = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      fetch: lossy,
    });
    const bytes = png(2 * fileLimits.chunkBytes + 5);
    const id = await upload(channel, blobOf(bytes, "image/png"));
    // Each chunk sent once: core said it held the one whose answer was lost.
    expect(sent).toStrictEqual({ begins: 2, chunks: 3, finishes: 2 });
    await expect(page.channel.describe("files", id)).resolves.toMatchObject({
      size: bytes.length,
    });
    // One upload, its three chunks, nothing else: the start sent again
    // under its key was the same upload.
    await expect(storedObjects(release)).resolves.toHaveLength(3);
    let uploads = 0;
    await onStore(release, (host) => {
      uploads = host.ctx.storage.sql
        .exec("SELECT file_id FROM sdk_files")
        .toArray().length;
    });
    expect(uploads).toBe(1);
    // A key is one upload's: another declaration under it is a conflict.
    const raw = rawChannel(page, app);
    const declared = declaration();
    const first = await begunFile(await raw.begin(declared));
    const again = await begunFile(await raw.begin(declared));
    const other = await answerOf(
      await raw.begin({ ...declared, name: "other.png" })
    );
    expect([again, other]).toStrictEqual([first, "submission.key_conflict"]);
  });

  it("goes on past answers lost on one chunk after another, each recovered", async () => {
    const { app, page } = await openedApp();
    // The answer to every chunk but the first is lost, once each.
    const lostOnce = new Set<string>();
    const lossy = async (path: string, init: RequestInit) => {
      const response = await page.fetch(path, init);
      const chunk = /\/chunks\/(?<index>\d+)$/u.exec(path)?.groups?.index;
      if (chunk !== undefined && chunk !== "0" && !lostOnce.has(chunk)) {
        lostOnce.add(chunk);
        await response.body?.cancel();
        throw new TypeError("The connection was reset.");
      }
      return response;
    };
    const channel = fileChannel({
      app,
      lease: page.lease,
      person: page.named,
      fetch: lossy,
    });
    const bytes = png(6 * fileLimits.chunkBytes);
    const id = await upload(channel, blobOf(bytes, "image/png"));
    expect(lostOnce.size).toBe(5);
    await expect(page.channel.describe("files", id)).resolves.toMatchObject({
      size: bytes.length,
    });
  });
});
