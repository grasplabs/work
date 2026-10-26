import { fileChannel } from "@grasp-os/sdk/host";
import { appFilesPath, fileLimits } from "@grasp-os/shared/app-file-limits";
import { screenPersonHeader } from "@grasp-os/shared/screen-limits";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import { screenLeaseHeader } from "@grasp-os/shared/screens";
import { describe, expect, it } from "vite-plus/test";

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
  resources,
  screenOf,
  sha256,
  statusOf,
  storedObjects,
  upload,
  uploadKey,
  utf8,
} from "./app-files.ts";
import { published as publishedApp } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed } from "./sign-in.ts";

// An App's files (spec 9.6, 10.7.5, 32.5), uploaded through core's file
// channel as a running screen's page reaches it, attached and read through
// the App's own functions; and, from the threat model (core's file-host.ts
// and app-file-route.ts), every way an upload should fail: another
// person's upload, another App's, a guessed ID, a request without the
// screen's lease or from another site, a type or content that isn't what
// it says, a chunk that isn't the one it says, an answer lost on the way.

const { personApi, releasedApp, openedApp, colleagueOf } = appsOf(mockIdp());

describe("an App's files", { timeout: 120_000 }, () => {
  it("uploads a file in chunks, reporting the bytes core holds", async () => {
    const { screen } = await openedApp();
    const progress: unknown[] = [];
    const bytes = png(fileLimits.chunkBytes + 100);
    const id = await screen.channel.upload(
      "attachments",
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
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toStrictEqual({
      id,
      name: "Plan.png",
      mimeType: "image/png",
      size: bytes.length,
    });
  });

  it("attaches a file to a note under its revision, and downloads it only as an attachment", async () => {
    const { client, api, screen, downloads } = await openedApp();
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Plan" });
    await expect(
      client.mutation(api.attachFile, {
        id: note,
        expectedRevision: 1,
        file: { id },
      })
    ).resolves.toMatchObject({ _rev: 2, attachments: [{ id }] });
    // A stale revision is a conflict, the attachment as it was.
    await expect(
      codeOf(
        client.mutation(api.detachFile, {
          id: note,
          expectedRevision: 1,
          file: { id },
        })
      )
    ).resolves.toBe("data.conflict");
    await client.files.download(resources.attachments, { id });
    expect(downloads.get(id)).toStrictEqual(png());
    const response = await screen.channel.content("attachments", id);
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
    const { builder, app, api, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const theirNote = await colleague.client.mutation(api.create, {
      title: "Theirs",
    });
    // The same answer for their upload as for an ID that doesn't exist.
    await expect(
      Promise.all([
        codeOf(colleague.screen.channel.describe("attachments", id)),
        codeOf(
          colleague.screen.channel.describe("attachments", crypto.randomUUID())
        ),
        codeOf(colleague.screen.channel.delete("attachments", id)),
        codeOf(
          colleague.client.mutation(api.attachFile, {
            id: theirNote,
            expectedRevision: 1,
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
    const { builder, app, client, api, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const note = await client.mutation(api.create, { title: "Shared" });
    await client.mutation(api.attachFile, {
      id: note,
      expectedRevision: 1,
      file: { id },
    });
    await colleague.client.files.download(resources.attachments, { id });
    expect(colleague.downloads.get(id)).toStrictEqual(png());
    await expect(
      codeOf(colleague.screen.channel.delete("attachments", id))
    ).resolves.toBe("file.not_found");
    // Detached again: theirs to read no longer.
    await client.mutation(api.detachFile, {
      id: note,
      expectedRevision: 2,
      file: { id },
    });
    await expect(
      codeOf(colleague.screen.channel.describe("attachments", id))
    ).resolves.toBe("file.not_found");
  });

  it("keeps each App's files to it, and each use to the operations its resource declares", async () => {
    const one = await openedApp();
    const other = await openedApp();
    const id = await upload(other.screen.channel, blobOf(png(), "image/png"));
    const note = await one.client.mutation(one.api.create, { title: "One" });
    await expect(
      Promise.all([
        codeOf(
          one.client.mutation(one.api.attachFile, {
            id: note,
            expectedRevision: 1,
            file: { id },
          })
        ),
        codeOf(one.screen.channel.describe("attachments", id)),
        // `photos` declares only `read`, `nothing` nothing at all.
        codeOf(
          upload(
            one.screen.channel,
            blobOf(png(), "image/png"),
            "a.png",
            "photos"
          )
        ),
        codeOf(one.screen.channel.describe("nothing", id)),
      ])
    ).resolves.toStrictEqual([
      "file.not_found",
      "file.not_found",
      "file.operation_denied",
      "file.operation_denied",
    ]);
  });

  it("refuses a request without the screen's lease, or from another site", async () => {
    const { app, builder } = await openedApp();
    const { lease } = await builder.api.screens.open(app, "notes");
    const path = `${appFilesPath}/${app}/attachments/files/${crypto.randomUUID()}`;
    const statuses = await Promise.all(
      [
        new Headers({ cookie: builder.session }),
        new Headers({
          cookie: builder.session,
          [screenLeaseHeader]: lease,
          "sec-fetch-site": "cross-site",
        }),
      ].map(async (headers) => await statusOf(routed(path, { headers })))
    );
    expect(statuses).toStrictEqual([403, 403]);
  });

  it("refuses a change from no Origin or another site's, though its lease and session are the screen's", async () => {
    const { builder, app, screen } = await openedApp();
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const base = `${appFilesPath}/${app}/attachments`;
    const sent = async (path: string, body: unknown, origin?: string) => {
      const headers = new Headers({
        cookie: builder.session,
        [screenLeaseHeader]: screen.lease,
        [screenPersonHeader]: builder.userId,
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
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ id });
  });

  it("refuses a screen's file requests once its build is unreviewed, or revoked", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    await publishedApp(app);
    const { version } = await builder.api.apps.files.commit(
      app,
      files,
      "First"
    );
    await builder.api.apps.versions.setCurrent(app, version);
    // Its data ordinary: a screen nobody approved runs, and gets a lease.
    const first = await admin.api.screenTrust.review(app);
    await admin.api.screenTrust.classify(app, "ordinary", first.generation);
    const screen = await screenOf(builder, app);
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    const refusals = async () => [
      await codeOf(screen.channel.describe("attachments", id)),
      await codeOf(upload(screen.channel, blobOf(png(), "image/png"))),
    ];
    // Sensitive again: the build nobody approved gets none of it.
    const second = await admin.api.screenTrust.review(app);
    await admin.api.screenTrust.classify(app, "sensitive", second.generation);
    const unreviewed = await refusals();
    // Approved, then revoked.
    const third = await admin.api.screenTrust.review(app);
    const artifacts = builtArtifacts(third.screens);
    await admin.api.screenTrust.approve(app, {
      version: third.version,
      generation: third.generation,
      artifacts,
    });
    for (const artifact of artifacts) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await admin.api.screenTrust.revoke(app, artifact);
    }
    expect({ unreviewed, revoked: await refusals() }).toStrictEqual({
      unreviewed: ["screen.unreviewed", "screen.unreviewed"],
      revoked: ["screen.revoked", "screen.revoked"],
    });
  });

  it("refuses a request whose lease doesn't verify for its person, though the App's data is ordinary", async () => {
    const { builder, app, screen } = await openedApp();
    const id = await upload(screen.channel, blobOf(png(), "image/png"));
    // Ordinary data: a screen of it runs without a valid lease elsewhere.
    const admin = await personApi("admin");
    const { generation } = await admin.api.screenTrust.review(app);
    await admin.api.screenTrust.classify(app, "ordinary", generation);
    const colleague = await colleagueOf(builder, app);
    const described = async (lease: string) =>
      await screen.fetch(`${appFilesPath}/${app}/attachments/files/${id}`, {
        headers: { [screenLeaseHeader]: lease },
      });
    const refused = await Promise.all(
      // Forged; then a real lease, but signed for someone else.
      [`${"0".repeat(64)}.${"A".repeat(43)}`, colleague.screen.lease].map(
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
    await expect(statusOf(described(screen.lease))).resolves.toBe(200);
  });

  it("refuses a request naming someone other than the person signed in, or nobody, before it starts anything", async () => {
    const { builder, app, release, screen } = await openedApp();
    const colleague = await colleagueOf(builder, app);
    const begin = async (named?: string) =>
      await routed(`${appFilesPath}/${app}/attachments/uploads`, {
        method: "POST",
        headers: {
          origin: clientOrigin,
          cookie: builder.session,
          "content-type": "application/json",
          [screenLeaseHeader]: screen.lease,
          ...(named === undefined ? {} : { [screenPersonHeader]: named }),
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
      [403, "screen.reload_required"],
    ]);
    // A channel whose frame is someone else's starts nothing either.
    const theirs = fileChannel({
      app,
      lease: screen.lease,
      person: colleague.screen.named,
      fetch: screen.fetch,
    });
    await expect(
      codeOf(upload(theirs, blobOf(png(), "image/png")))
    ).resolves.toBe("auth.principal_changed");
    await expect(fileStates(release)).resolves.toStrictEqual([]);
  });

  it("refuses an upload past its limits, or of a type a browser runs, before any byte", async () => {
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
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
      codeOf(upload(screen.channel, blobOf(png(), "image/svg+xml"), "a.svg"))
    ).resolves.toBe("file.type_unsupported");
  });

  it("keeps a chunk only if it is the one its place and hash say", async () => {
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
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
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
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
    const { app, screen } = await openedApp();
    const raw = rawChannel(screen, app);
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
    const { screen } = await openedApp();
    const text = async (content: Uint8Array<ArrayBuffer>) =>
      await upload(screen.channel, blobOf(content, "text/plain"), "notes.txt");
    await expect(
      Promise.all([
        codeOf(upload(screen.channel, blobOf(utf8("not a png"), "image/png"))),
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
    const screen = await screenOf(builder, app);
    // The network loses the answers to the start, the second chunk and
    // the first finish: all three reached core.
    const sent = { begins: 0, chunks: 0, finishes: 0 };
    const lossy = async (path: string, init: RequestInit) => {
      const response = await screen.fetch(path, init);
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
      lease: screen.lease,
      person: screen.named,
      fetch: lossy,
    });
    const bytes = png(2 * fileLimits.chunkBytes + 5);
    const id = await upload(channel, blobOf(bytes, "image/png"));
    // Each chunk sent once: core said it held the one whose answer was lost.
    expect(sent).toStrictEqual({ begins: 2, chunks: 3, finishes: 2 });
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ size: bytes.length });
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
    const raw = rawChannel(screen, app);
    const declared = declaration();
    const first = await begunFile(await raw.begin(declared));
    const again = await begunFile(await raw.begin(declared));
    const other = await answerOf(
      await raw.begin({ ...declared, name: "other.png" })
    );
    expect([again, other]).toStrictEqual([first, "submission.key_conflict"]);
  });

  it("goes on past answers lost on one chunk after another, each recovered", async () => {
    const { app, screen } = await openedApp();
    // The answer to every chunk but the first is lost, once each.
    const lostOnce = new Set<string>();
    const lossy = async (path: string, init: RequestInit) => {
      const response = await screen.fetch(path, init);
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
      lease: screen.lease,
      person: screen.named,
      fetch: lossy,
    });
    const bytes = png(6 * fileLimits.chunkBytes);
    const id = await upload(channel, blobOf(bytes, "image/png"));
    expect(lostOnce.size).toBe(5);
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ size: bytes.length });
  });

  it("sends a chunk again whose body core took too long to read, and finishes the upload", async () => {
    const { app, release, screen } = await openedApp();
    // The first chunk's body reaches core too slowly: it answers so.
    const slow = { first: true };
    const channel = fileChannel({
      app,
      lease: screen.lease,
      person: screen.named,
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
        return await screen.fetch(path, init);
      },
    });
    const bytes = png(100);
    const id = await upload(channel, blobOf(bytes, "image/png"));
    await expect(
      screen.channel.describe("attachments", id)
    ).resolves.toMatchObject({ size: bytes.length });
    await expect(fileStates(release)).resolves.toStrictEqual(["published:"]);
  });

  it("answers a body that stops arriving as one that took too long, for the page to send again", async () => {
    const { app, screen } = await openedApp();
    // A start whose body never ends: core gives up reading it.
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    const response = await screen.fetch(
      `${appFilesPath}/${app}/attachments/uploads`,
      {
        method: "POST",
        headers: {
          [screenLeaseHeader]: screen.lease,
          "content-type": "application/json",
        },
        body,
      }
    );
    expect({
      status: response.status,
      answer: await response.json(),
    }).toMatchObject({ status: 408, answer: { code: "request.timeout" } });
  });
});
