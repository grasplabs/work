import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { getDocument, writeVersion } from "../src/documents.ts";
import { knowledgeErrors } from "../src/knowledge.ts";
import { preparePurge, purge } from "../src/purge.ts";
import { recall } from "../src/recall.ts";
import { search } from "../src/search.ts";
import type { Caller } from "./host.ts";
import { newCollection, noCopies, testHost, writerOf } from "./host.ts";

// The Brain on its own, with a host of fake ports (host.ts): a plain D1
// database and R2 bucket, nothing of Grasp. The ways a standalone Brain
// could fail its host, tried below:
// 1. It shows a caller something the host's `authorize` didn't give them:
//    a read, a search or a recall of a collection they may not read.
// 2. It changes something without telling the host: a write with no
//    event in its outbox, a read the host's `onRead` never saw.
// 3. Two writers lose a change: a save from a stale version goes through.
// 4. An erase leaves a term behind: in an earlier version, or in search.
// 5. It needs its host's code to run at all: everything here is the
//    package and its ports.

/** The code of what `promise` refused with, or "ok". */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return knowledgeErrors.codeOf(error) ?? String(error);
  }
};

/** A word no other test's text has. */
const word = () => `w${crypto.randomUUID().replaceAll("-", "")}`;

describe("a standalone Brain", () => {
  it("shows a caller only what the host's authorize gives them", async () => {
    const { brain } = testHost();
    const open = await newCollection(brain, "Open");
    const closed = await newCollection(brain, "Closed");
    const secret = word();
    const writer = writerOf("owner");
    const shared = await writeVersion(brain, writer, {
      collection: open,
      path: "desks.md",
      text: `# Desks\nFloor 3 is quiet, ${secret}.`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const hidden = await writeVersion(brain, writer, {
      collection: closed,
      path: "plans.md",
      text: `# Plans\nA reorganisation, ${secret}.`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const reader: Caller = { userId: "reader", reads: [open.id] };
    const { hits } = await search(brain, reader, secret);
    const pack = await recall(brain, reader, { query: secret });

    expect({
      shared: await outcome(getDocument(brain, reader, shared.id)),
      hidden: await outcome(getDocument(brain, reader, hidden.id)),
      found: hits.map(({ documentId }) => documentId),
      recalled: [
        ...new Set(
          pack.items.flatMap(({ sourceRefs }) =>
            sourceRefs.map((ref) =>
              ref.kind === "document" ? ref.documentId : ref.memoryId
            )
          )
        ),
      ],
    }).toStrictEqual({
      shared: "ok",
      hidden: "knowledge.not_found",
      found: [shared.id],
      recalled: [shared.id],
    });
  });

  it("tells the host of every write and every read", async () => {
    const { brain, reads, events } = testHost();
    const collection = await newCollection(brain, "Handbook");
    const document = await writeVersion(brain, writerOf("writer"), {
      collection,
      path: "leave.md",
      text: "# Leave\nAsk your lead.",
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    await getDocument(
      brain,
      { userId: "reader", reads: [collection.id] },
      document.id
    );
    // Its own events: the database outlives a test.
    const outbox = await env.BRAIN.prepare(
      "SELECT event FROM audit_outbox WHERE instr(event, ?) > 0"
    )
      .bind(collection.id)
      .all<{ event: string }>();

    expect({
      events: events.map(({ action }) => action),
      outboxed: outbox.results.length,
      reads: reads.map(({ caller, record }) => [caller, record.action]),
    }).toStrictEqual({
      events: ["knowledge.collection.created", "knowledge.document.saved"],
      outboxed: 2,
      reads: [["reader", "knowledge.read"]],
    });
  });

  it("refuses a save from a version that is no longer current", async () => {
    const { brain } = testHost();
    const collection = await newCollection(brain, "Handbook");
    const write = async (text: string) =>
      await writeVersion(brain, writerOf("writer"), {
        collection,
        path: "leave.md",
        text,
        ifVersion: 0,
        message: null,
        restoredFrom: null,
      });
    await write("# Leave\nFirst.");

    await expect(outcome(write("# Leave\nSecond."))).resolves.toBe(
      "knowledge.conflict"
    );
  });

  it("erases a term from every version and from search", async () => {
    const { brain } = testHost();
    const collection = await newCollection(brain, "People");
    const name = word();
    const caller: Caller = { userId: "admin", reads: [collection.id] };
    const writer = writerOf("admin");
    const first = await writeVersion(brain, writer, {
      collection,
      path: "team.md",
      text: `# Team\n${name} leads it.`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    await writeVersion(brain, writer, {
      collection,
      path: "team.md",
      text: `# Team\nSomeone leads it. ${name} left.`,
      ifVersion: 1,
      message: null,
      restoredFrom: null,
    });
    const input = {
      type: "content",
      documentIds: [first.id],
      terms: [name],
      reason: "erasure_request",
    };
    const { token } = await preparePurge(brain, writer, input, noCopies);
    await purge(brain, writer, input, token, noCopies);
    const texts = await Promise.all(
      [1, 2, 3].map(async (version) => {
        const read = await getDocument(brain, caller, first.id, version);
        return read.version.text;
      })
    );
    const { hits } = await search(brain, caller, name);

    expect({
      left: texts.filter((text) => text.includes(name)).length,
      found: hits.length,
    }).toStrictEqual({ left: 0, found: 0 });
  });
});
