import type { AuditEvent } from "@grasp-os/shared/audit";
import { auditExportPath } from "@grasp-os/shared/audit-log";
import { screenPersonHeader } from "@grasp-os/shared/screen-limits";
import { uploadOriginalPath } from "@grasp-os/shared/uploads";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { collectionWithNote } from "./knowledge.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// Every view and action of Grasp's staff is in the client's audit log
// (GRA-1087, its threat model): staff may read everything, and each read,
// over `/rpc` or a route, writes one entry the client's admins see, as
// "(Grasp staff)", naming what was viewed and never what it holds. The
// ways it can fail, tried here:
// 1. A surface reads for staff and writes no entry.
// 2. A page asking again floods the log, or a view of something else is
//    folded into another's entry.
// 3. An entry repeats what was read: a search's terms, a document's text.
// 4. A person who isn't staff writes staff entries.

const idp = mockIdp();

/** A staff session and its API, on a connection of its own. */
const staffOn = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return { session, api: core.authenticate() };
};

/** The staff entries among `events`. */
const staffViews = (events: readonly AuditEvent[]): AuditEvent[] =>
  events.filter(({ action }) => action === "staff.accessed");

/** The surface each staff entry among `events` names. */
const surfacesOf = (events: readonly AuditEvent[]): unknown[] =>
  staffViews(events).map(({ detail }) => detail.surface);

/** A text that must never reach the log. */
const secret = `Salary${crypto.randomUUID().slice(0, 8)}`;

describe("Grasp staff's views, audited", () => {
  it("write one entry for each read, over /rpc or a route, without content", async () => {
    const admin = await signedInApi(idp, "admin");
    const { noteId } = await collectionWithNote(admin.api, {
      name: `Handbook ${secret}`,
      access: "everyone",
    });
    const { session, api } = await staffOn();
    const { userId } = await api.whoami();
    const uploadId = crypto.randomUUID();
    const app = crypto.randomUUID();
    const reads: [string, () => Promise<unknown>][] = [
      [
        "knowledge.listCollections",
        async () => await api.knowledge.listCollections(),
      ],
      ["knowledge.search", async () => await api.knowledge.search(secret)],
      [
        "knowledge.getDocument",
        async () => await api.knowledge.getDocument(noteId),
      ],
      ["memory.collections", async () => await api.memory.collections()],
      ["brain.notes", async () => await api.brain.notes()],
      ["chats.list", async () => await api.chats.list()],
      ["decisions.waiting", async () => await api.decisions.waiting()],
      ["audit.search", async () => await api.audit.search()],
      ["workflows.runs", async () => await api.workflows.runs()],
      [
        "screenSubmissions.list",
        async () => await api.screenSubmissions.list(),
      ],
      [
        "audit.export",
        async () =>
          await routed(`${auditExportPath}?format=csv`, {
            headers: { cookie: session },
          }),
      ],
      [
        "uploads.original",
        async () =>
          await routed(uploadOriginalPath(uploadId), {
            headers: { cookie: session },
          }),
      ],
      [
        "app.functions",
        async () =>
          await routed(`/api/app-functions/${app}`, {
            method: "POST",
            headers: {
              cookie: session,
              origin: clientOrigin,
              "content-type": "application/json",
              [screenPersonHeader]: userId,
            },
            body: JSON.stringify({}),
          }),
      ],
    ];
    const written: Record<string, unknown[]> = {};
    const all: AuditEvent[] = [];
    for (const [surface, read] of reads) {
      // oxlint-disable-next-line no-await-in-loop -- one read, then its entries
      const events = await auditedDuring(async () => {
        await outcome(read());
      });
      written[surface] = surfacesOf(events);
      all.push(...staffViews(events));
    }
    const seen = await admin.api.audit.search({ action: "staff.accessed" });

    expect(written).toStrictEqual(
      Object.fromEntries(reads.map(([surface]) => [surface, [surface]]))
    );
    expect({
      actors: [...new Set(all.map(({ actor }) => actor.type))],
      document: all.find(
        ({ detail }) => detail.surface === "knowledge.getDocument"
      )?.provenance,
      upload: all.find(({ detail }) => detail.surface === "uploads.original")
        ?.provenance,
      content: JSON.stringify(all).includes(secret),
      // The client's admins read them in their own log.
      visible: all.every(({ id }) =>
        seen.records.some(({ event }) => event?.id === id)
      ),
    }).toStrictEqual({
      actors: ["staff"],
      document: [noteId],
      upload: [uploadId],
      content: false,
      visible: true,
    });
  });

  it("write the same view once a window, and every other view apart", async () => {
    const admin = await signedInApi(idp, "admin");
    const first = await collectionWithNote(admin.api, {
      name: "First",
      access: "everyone",
    });
    const second = await collectionWithNote(admin.api, {
      name: "Second",
      access: "everyone",
    });
    const { api } = await staffOn();
    await api.whoami();

    const events = await auditedDuring(async () => {
      for (let time = 0; time < 5; time += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a page asking again
        await api.knowledge.getDocument(first.noteId);
      }
      await api.knowledge.getDocument(second.noteId);
    });

    expect(
      staffViews(events).map(({ detail, provenance }) => [
        detail.surface,
        provenance,
      ])
    ).toStrictEqual([
      ["knowledge.getDocument", [first.noteId]],
      ["knowledge.getDocument", [second.noteId]],
    ]);
  });

  it("write no staff entry for an admin who isn't staff", async () => {
    const admin = await signedInApi(idp, "admin");
    const { noteId } = await collectionWithNote(admin.api, {
      name: "Handbook",
      access: "everyone",
    });

    const events = await auditedDuring(async () => {
      await admin.api.knowledge.getDocument(noteId);
      await admin.api.knowledge.search("handbook");
      await admin.api.chats.list();
      await routed(`${auditExportPath}?format=csv`, {
        headers: { cookie: admin.session },
      });
    });

    expect(staffViews(events)).toStrictEqual([]);
  });
});
