import type { Source } from "@grasp-os/shared/brain";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { SessionApi } from "@grasp-os/shared/rpc";
import type { Upload } from "@grasp-os/shared/uploads";
import { describe, expect, it, vi } from "vite-plus/test";

import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import {
  callAuth,
  letSessionRecheckPass,
  openRpc,
  outcome,
  signedInApi,
  unique,
} from "./sign-in.ts";

// Transcripts on the brain's sources (`Source.transcript`, served by
// `brain.read`), from the producer people use: a WebVTT file uploaded into
// Knowledge, its text extracted in the sandbox, its turns saved with its
// document (src/brain-transcripts.ts, packages/brain transcripts.ts). A
// team's interviews' transcript is tried in brain-intake.test.ts, and the
// kickoff's absence in brain.test.ts. The ways it can leak, tried here:
//
// - To someone who may not read the document: another person, an admin
//   (who reads the collections for admins, never a person's own), or
//   someone who could read it a moment ago and no longer may.
// - Past an edit that replaced the text.
// - Past a purge: a name left in a speaker or a turn, or found by search;
//   anything of a Personal collection after a personal purge.
// - Into the audit log: a speaker or a word.
// - From a file that isn't WebVTT, or markup in a caption.

const idp = mockIdp();

/** A meeting's captions, as Teams exports them: voices, a note, some markup. */
const meetingVtt = (name: string): string => `WEBVTT

NOTE Exported by the meeting tool.

00:00:01.000 --> 00:00:04.000
<v ${name} Visser>Welcome all, let's start with the budget.

00:00:04.000 --> 00:00:06.500
<v ${name} Visser><b>It</b> is due on Friday.

00:00:07.000 --> 00:00:12.000
<v Grasp>What takes the longest each month?

01:02:03.000 --> 01:02:05.000
<v ${name} Visser><c.loud>Copying</c> invoices &amp; receipts by hand.
`;

/** A person with a collection of their own (`me`), and what they upload. */
const personWithCollection = async (role: "user" | "admin" = "user") => {
  const person = await signedInApi(idp, role);
  const collection = await person.api.knowledge.createCollection({
    name: `Meetings ${unique()}`,
    access: role === "admin" ? "everyone" : "me",
  });
  return { ...person, collectionId: collection.id };
};

/** The upload once its extraction has ended, ready or failed. */
const ended = async (api: SessionApi, uploadId: string): Promise<Upload> =>
  await vi.waitFor(
    async () => {
      const upload = await api.uploads.get(uploadId);
      if (upload.status !== "ready" && upload.status !== "failed") {
        throw new Error(`Upload ${uploadId} is ${upload.status}`);
      }
      return upload;
    },
    { timeout: 30_000, interval: 100 }
  );

/** Uploads `text` as `name` into the person's collection, and waits for it. */
const uploaded = async (
  person: { api: SessionApi; collectionId: string },
  name: string,
  text: string
): Promise<Upload> => {
  const upload = await person.api.uploads.upload({
    collectionId: person.collectionId,
    name,
    bytes: new TextEncoder().encode(text),
  });
  return await ended(person.api, upload.id);
};

/** The brain's source for a Knowledge document, as `api` reads the brain. */
const sourceOf = async (
  api: SessionApi,
  documentId: string | null
): Promise<Source | undefined> => {
  const { sources } = await api.brain.read();
  return sources.find(({ id }) => id === `src.knowledge-${documentId}`);
};

describe("transcripts on the brain's sources", { timeout: 120_000 }, () => {
  it("shows a WebVTT upload's turns, by voice and minute, to whoever may read its document and nobody else", async () => {
    const owner = await personWithCollection();
    const other = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const name = `Anna${unique()}`;
    const upload = await uploaded(owner, "Budget call.vtt", meetingVtt(name));
    const document =
      upload.documentId === null
        ? null
        : await owner.api.knowledge.getDocument(upload.documentId);

    expect({
      status: upload.status,
      mediaType: upload.mediaType,
      text: document?.version.text.includes(
        `${name} Visser (0:01) Welcome all, let's start with the budget. It is due on Friday.`
      ),
      source: await sourceOf(owner.api, upload.documentId),
      other: await sourceOf(other.api, upload.documentId),
      admin: await sourceOf(admin.api, upload.documentId),
    }).toStrictEqual({
      status: "ready",
      mediaType: "text/vtt",
      text: true,
      source: {
        id: `src.knowledge-${upload.documentId}`,
        kind: "document",
        title: "Budget call",
        date: new Date().toISOString().slice(0, 10),
        transcript: {
          unit: "minute",
          turns: [
            {
              at: "0:01",
              speaker: `${name} Visser`,
              text: "Welcome all, let's start with the budget. It is due on Friday.",
            },
            {
              at: "0:07",
              speaker: "Grasp",
              text: "What takes the longest each month?",
            },
            {
              at: "62:03",
              speaker: `${name} Visser`,
              text: "Copying invoices & receipts by hand.",
            },
          ],
          chapters: [],
        },
      },
      other: undefined,
      admin: undefined,
    });
  });

  it("is checked on every read: a reader who leaves the team loses its turns, on a new connection at once and on an open one at its next session check", async () => {
    const owner = await signedInApi(idp, "admin");
    const reader = await signedInApi(idp, "user");
    const teamId = await newTeam(owner, [reader]);
    const collection = await owner.api.knowledge.createCollection({
      name: `Finance ${unique()}`,
      access: "teams",
      teams: [teamId],
    });
    const upload = await uploaded(
      { api: owner.api, collectionId: collection.id },
      "Finance call.vtt",
      meetingVtt(`Fay${unique()}`)
    );
    const before = await sourceOf(reader.api, upload.documentId);
    // They leave the team, on the session they read it in.
    await callAuth("/organization/remove-team-member", owner.session, {
      teamId,
      userId: reader.userId,
    });
    // A new connection reads who they are now; an open one reads again
    // once its reading of the session is due (`sessionRecheckMs`, as for
    // every call): the transcript itself is never kept.
    const { core: fresh } = await openRpc(reader.session);
    const afterFresh = await sourceOf(fresh.authenticate(), upload.documentId);
    const afterHeld = await (async () => {
      using _clock = letSessionRecheckPass();
      return await sourceOf(reader.api, upload.documentId);
    })();

    const ownerStill = await sourceOf(owner.api, upload.documentId);

    expect({
      before: {
        turns: before?.transcript?.turns.length,
        chapters: before?.transcript?.chapters,
      },
      afterFresh,
      afterHeld,
      owner: ownerStill?.id,
    }).toStrictEqual({
      // Captions have no chapters (a WebVTT chapters track is a file of
      // its own): the field is there, empty.
      before: { turns: 3, chapters: [] },
      afterFresh: undefined,
      afterHeld: undefined,
      owner: `src.knowledge-${upload.documentId}`,
    });
  });

  it("refuses a .vtt that doesn't start as WebVTT, and keeps nothing of it", async () => {
    const owner = await personWithCollection();
    const result = await outcome(
      owner.api.uploads.upload({
        collectionId: owner.collectionId,
        name: "notes.vtt",
        bytes: new TextEncoder().encode(
          "1\n00:00:01,000 --> 00:00:02,000\nAn SRT file, renamed.\n"
        ),
      })
    );
    const { documents } = await owner.api.knowledge.listDocuments(
      owner.collectionId
    );

    expect({ result, documents: documents.length }).toStrictEqual({
      result: "upload.unsupported",
      documents: 0,
    });
  });

  it("drops the turns once the document is saved again without them", async () => {
    const owner = await personWithCollection();
    const upload = await uploaded(
      owner,
      "Standup.vtt",
      meetingVtt(`Bo${unique()}`)
    );
    const before = await sourceOf(owner.api, upload.documentId);
    await owner.api.knowledge.saveDocument({
      collectionId: owner.collectionId,
      path: "Standup.vtt",
      text: "# Standup\n\nRewritten as notes, without the call.",
      ifVersion: 1,
    });

    expect({
      before: before?.transcript?.turns.length,
      after: await sourceOf(owner.api, upload.documentId),
    }).toStrictEqual({ before: 3, after: undefined });
  });

  it("loses a purged name from every speaker and turn, and search no longer finds it", async () => {
    const admin = await personWithCollection("admin");
    const reader = await signedInApi(idp, "user");
    const name = `Cora${unique()}`;
    const upload = await uploaded(admin, "Board call.vtt", meetingVtt(name));
    const before = await sourceOf(reader.api, upload.documentId);
    const input: PurgeInput = {
      type: "content",
      documentIds: [upload.documentId ?? ""],
      terms: [name],
      reason: "erasure_request",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    const result = await admin.api.knowledge.purge(input, plan.token);
    const after = await sourceOf(reader.api, upload.documentId);
    const { hits } = await reader.api.knowledge.search(name);

    expect({
      before: before?.transcript?.turns.map(({ speaker }) => speaker),
      stillFound: result.stillFound,
      speakers: after?.transcript?.turns.map(({ speaker }) => speaker),
      holds: JSON.stringify(after).includes(name),
      found: hits.length,
    }).toStrictEqual({
      before: [`${name} Visser`, "Grasp", `${name} Visser`],
      stillFound: 0,
      speakers: ["(removed) Visser", "Grasp", "(removed) Visser"],
      holds: false,
      found: 0,
    });
  });

  it("is gone with the person's Personal collection after a personal purge", async () => {
    const leaver = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const { personal } = await leaver.api.memory.collections();
    const upload = await uploaded(
      { api: leaver.api, collectionId: personal },
      "One to one.vtt",
      meetingVtt(`Dirk${unique()}`)
    );
    const before = await sourceOf(leaver.api, upload.documentId);
    const input: PurgeInput = {
      type: "personal",
      userId: leaver.userId,
      reason: "offboarding",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    await admin.api.knowledge.purge(input, plan.token);

    expect({
      before: before?.transcript?.turns.length,
      after: await sourceOf(leaver.api, upload.documentId),
    }).toStrictEqual({ before: 3, after: undefined });
  });

  it("is recorded in the audit log by counts and identifiers alone: no speaker, no word", async () => {
    const owner = await personWithCollection();
    const name = `Eva${unique()}`;
    const upload = await uploaded(owner, "Retro.vtt", meetingVtt(name));
    await sourceOf(owner.api, upload.documentId);
    const logged = await allEvents();
    const events = logged.filter((event) =>
      JSON.stringify(event).includes(upload.documentId ?? upload.id)
    );
    const recorded = JSON.stringify(events);

    expect({
      saved: events
        .filter(({ action }) => action === "knowledge.document.saved")
        .map(({ detail }) => ({
          turns: detail?.transcriptTurns,
          chapters: detail?.transcriptChapters,
        })),
      read: events.some(
        ({ action, detail }) =>
          action === "knowledge.read" && detail?.read === "transcripts"
      ),
      holds: [name, "budget", "invoices"].filter((words) =>
        recorded.includes(words)
      ),
    }).toStrictEqual({
      saved: [{ turns: 3, chapters: 0 }],
      read: true,
      holds: [],
    });
  });
});
