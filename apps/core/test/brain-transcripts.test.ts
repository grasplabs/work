import type { Source, Transcript } from "@grasp-os/shared/brain";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { SessionApi } from "@grasp-os/shared/rpc";
import type { Upload } from "@grasp-os/shared/uploads";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { eventsAfter, logHead } from "./audit-events.ts";
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

// Transcripts on the brain's sources, from the producer people use: a
// WebVTT file uploaded into Knowledge, its text extracted in the sandbox,
// its turns saved with its document (src/brain-transcripts.ts,
// packages/brain transcripts.ts). `brain.read` lists such a source by how
// many turns it has; `brain.transcript` opens one. A team's interviews'
// transcript is tried in brain-intake.test.ts, and the kickoff's absence
// in brain.test.ts. The ways it can leak, tried here:
//
// - To someone who may not read the document: another person, an admin
//   (who reads the collections for admins, never a person's own), or
//   someone who could read it a moment ago and no longer may.
// - Past an edit that replaced the text.
// - Past a purge: a name left in a speaker or a turn, or found by search;
//   anything of a Personal collection after a personal purge.
// - Into the audit log: a speaker or a word, in any event of the upload.
// - From a file that isn't WebVTT; from captions built to slip past the
//   Brain's limits, hide text (direction overrides) or make links and
//   headings in the document's text.

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

/** A Knowledge document's source id, as the brain names it. */
const sourceIdOf = (documentId: string | null): string =>
  `src.knowledge-${documentId}`;

/** The brain's listed source for a Knowledge document, as `api` reads the brain. */
const listedOf = async (
  api: SessionApi,
  documentId: string | null
): Promise<Source | undefined> => {
  const { sources } = await api.brain.read();
  return sources.find(({ id }) => id === sourceIdOf(documentId));
};

/** A Knowledge document's transcript, as `api` opens its source. */
const openedOf = async (
  api: SessionApi,
  documentId: string | null
): Promise<Transcript | null> =>
  await api.brain.transcript(sourceIdOf(documentId));

describe("transcripts on the brain's sources", { timeout: 120_000 }, () => {
  it("lists a WebVTT upload by its turn count alone and opens its turns, by voice and minute, for whoever may read its document and nobody else", async () => {
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
        `(0:01) ${name} Visser: Welcome all, let's start with the budget. It is due on Friday.`
      ),
      listed: await listedOf(owner.api, upload.documentId),
      opened: await openedOf(owner.api, upload.documentId),
      other: {
        listed: await listedOf(other.api, upload.documentId),
        opened: await openedOf(other.api, upload.documentId),
      },
      admin: {
        listed: await listedOf(admin.api, upload.documentId),
        opened: await openedOf(admin.api, upload.documentId),
      },
    }).toStrictEqual({
      status: "ready",
      mediaType: "text/vtt",
      text: true,
      listed: {
        id: sourceIdOf(upload.documentId),
        kind: "document",
        title: "Budget call",
        date: new Date().toISOString().slice(0, 10),
        transcriptTurns: 3,
      },
      opened: {
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
      other: { listed: undefined, opened: null },
      admin: { listed: undefined, opened: null },
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
    const before = await openedOf(reader.api, upload.documentId);
    // They leave the team, on the session they read it in.
    await callAuth("/organization/remove-team-member", owner.session, {
      teamId,
      userId: reader.userId,
    });
    // A new connection reads who they are now; an open one reads again
    // once its reading of the session is due (`sessionRecheckMs`, as for
    // every call): the transcript itself is never kept.
    const { core: fresh } = await openRpc(reader.session);
    const freshApi = fresh.authenticate();
    const afterFresh = {
      listed: await listedOf(freshApi, upload.documentId),
      opened: await openedOf(freshApi, upload.documentId),
    };
    const afterHeld = await (async () => {
      using _clock = letSessionRecheckPass();
      return await openedOf(reader.api, upload.documentId);
    })();
    const ownerStill = await openedOf(owner.api, upload.documentId);

    expect({
      before: { turns: before?.turns.length, chapters: before?.chapters },
      afterFresh,
      afterHeld,
      owner: ownerStill?.turns.length,
    }).toStrictEqual({
      // Captions have no chapters (a WebVTT chapters track is a file of
      // its own): the field is there, empty.
      before: { turns: 3, chapters: [] },
      afterFresh: { listed: undefined, opened: null },
      afterHeld: null,
      owner: 3,
    });
  });

  it("opens nothing for a source id that isn't one, and refuses one that isn't an id", async () => {
    const owner = await personWithCollection();
    expect({
      notADocument: await owner.api.brain.transcript("src.knowledge-nope"),
      unknown: await owner.api.brain.transcript("src-kickoff"),
      tooLong: await outcome(owner.api.brain.transcript("x".repeat(201))),
    }).toStrictEqual({
      notADocument: null,
      unknown: null,
      tooLong: "brain.invalid",
    });
  });

  it("takes captions built to slip past the limits or hide text, and renders them as plain lines without a link or heading", async () => {
    const owner = await personWithCollection();
    const longVoice = "L".repeat(300);
    const upload = await uploaded(
      owner,
      "Crafted.vtt",
      `WEBVTT

00:00:01.000 --> 00:00:03.000
<v ${longVoice}>A voice past the limit.

00:00:05.000 --> 00:00:04.000
<v Ann\u202EelA>Ends &#8203;before &#8238;it starts.

00:00:06.000 --> 00:00:07.000
<v # Injected>hi [[[Secret]]] and [[Plan]]

00:00:08.000 --> 00:00:09.000
<v Grasp>Spaced &#8203; out

99999999999999999999:00:00.000 --> 99999999999999999999:00:01.000
<v Grasp>Far past any recording.
`
    );
    const opened = await openedOf(owner.api, upload.documentId);
    const document =
      upload.documentId === null
        ? null
        : await owner.api.knowledge.getDocument(upload.documentId);
    const body = (document?.version.text ?? "").split("\n---\n").at(-1) ?? "";
    const links = await env.KNOWLEDGE.prepare(
      "SELECT count(*) AS n FROM links WHERE from_document_id = ?"
    )
      .bind(upload.documentId)
      .first<{ n: number }>();

    expect({
      status: upload.status,
      speakers: opened?.turns.map(({ speaker }) => speaker),
      texts: opened?.turns.map(({ text }) => text),
      at: opened?.turns.map(({ at }) => at),
      headings: body
        .split("\n")
        .filter((line) => line.startsWith("#") && !/^## \d+:\d\d$/u.test(line)),
      links: links?.n,
    }).toStrictEqual({
      status: "ready",
      speakers: ["L".repeat(200), "AnnelA", "# Injected", "Grasp"],
      // The cue past what a time can be exactly is left out, the rest kept.
      texts: [
        "A voice past the limit.",
        "Ends before it starts.",
        "hi [[[Secret]]] and [[Plan]]",
        "Spaced out",
      ],
      at: ["0:01", "0:05", "0:06", "0:08"],
      headings: [],
      links: 0,
    });
  });

  it("fails captions without a word as having no text, and keeps nothing of them", async () => {
    const owner = await personWithCollection();
    const upload = await uploaded(
      owner,
      "Silence.vtt",
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<b> </b>&#8203;\n"
    );
    const { documents } = await owner.api.knowledge.listDocuments(
      owner.collectionId
    );

    expect({
      status: upload.status,
      failure: upload.failure?.code,
      documents: documents.length,
    }).toStrictEqual({
      status: "failed",
      failure: "upload.no_text",
      documents: 0,
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
    const before = await listedOf(owner.api, upload.documentId);
    await owner.api.knowledge.saveDocument({
      collectionId: owner.collectionId,
      path: "Standup.vtt",
      text: "# Standup\n\nRewritten as notes, without the call.",
      ifVersion: 1,
    });

    expect({
      before: before?.transcriptTurns,
      listed: await listedOf(owner.api, upload.documentId),
      opened: await openedOf(owner.api, upload.documentId),
    }).toStrictEqual({ before: 3, listed: undefined, opened: null });
  });

  it("loses a purged name from every speaker and turn, and search no longer finds it", async () => {
    const admin = await personWithCollection("admin");
    const reader = await signedInApi(idp, "user");
    const name = `Cora${unique()}`;
    const upload = await uploaded(admin, "Board call.vtt", meetingVtt(name));
    const before = await openedOf(reader.api, upload.documentId);
    const input: PurgeInput = {
      type: "content",
      documentIds: [upload.documentId ?? ""],
      terms: [name],
      reason: "erasure_request",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    const result = await admin.api.knowledge.purge(input, plan.token);
    const after = await openedOf(reader.api, upload.documentId);
    const { hits } = await reader.api.knowledge.search(name);

    expect({
      before: before?.turns.map(({ speaker }) => speaker),
      stillFound: result.stillFound,
      speakers: after?.turns.map(({ speaker }) => speaker),
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
    const before = await openedOf(leaver.api, upload.documentId);
    const input: PurgeInput = {
      type: "personal",
      userId: leaver.userId,
      reason: "offboarding",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    await admin.api.knowledge.purge(input, plan.token);

    expect({
      before: before?.turns.length,
      listed: await listedOf(leaver.api, upload.documentId),
      opened: await openedOf(leaver.api, upload.documentId),
    }).toStrictEqual({ before: 3, listed: undefined, opened: null });
  });

  it("is recorded in the audit log by counts and identifiers alone: no event of the upload, listing or opening holds a speaker or a word", async () => {
    const owner = await personWithCollection();
    const name = `Eva${unique()}`;
    const head = await logHead();
    const upload = await uploaded(owner, "Retro.vtt", meetingVtt(name));
    await listedOf(owner.api, upload.documentId);
    await openedOf(owner.api, upload.documentId);
    const events = await eventsAfter(head);
    const recorded = JSON.stringify(events);
    const ofDocument = events.filter((event) =>
      JSON.stringify(event).includes(upload.documentId ?? "")
    );

    expect({
      upload: events
        .filter(({ target }) => target?.id === upload.id)
        .map(({ action }) => action)
        .toSorted(),
      saved: ofDocument
        .filter(({ action }) => action === "knowledge.document.saved")
        .map(({ detail }) => ({
          turns: detail?.transcriptTurns,
          chapters: detail?.transcriptChapters,
        })),
      reads: ofDocument
        .filter(({ action }) => action === "knowledge.read")
        .map(({ detail }) => String(detail?.read))
        .toSorted(),
      holds: [name, "Visser", "budget", "invoices", "Friday"].filter((words) =>
        recorded.includes(words)
      ),
    }).toStrictEqual({
      upload: ["knowledge.upload.extracted", "knowledge.upload.received"],
      saved: [{ turns: 3, chapters: 0 }],
      reads: ["transcript", "transcripts"],
      holds: [],
    });
  });
});
