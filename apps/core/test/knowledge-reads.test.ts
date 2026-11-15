import { getDocument, history, listDocuments } from "@grasp-os/brain/documents";
import { recall } from "@grasp-os/brain/recall";
import { search } from "@grasp-os/brain/search";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainOf } from "../src/knowledge/ports.ts";
import { mockIdp } from "./idp.ts";
import { seed } from "./knowledge.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Core reads nothing of today's Brain (GRA-1938): whatever reaches
// Knowledge through core's ports (ports.ts) is refused before it reads a
// row, even a document everyone may read, as its own person asks for it.
// What still runs on those ports (a person's erasure, a chat's deletion,
// the clock's cleanups) only writes and erases: person-erasure.test.ts,
// knowledge-purge*.test.ts and knowledge-payloads.test.ts.

const idp = mockIdp();

/** What a read was refused with, or "read" when it wasn't. */
const refusal = async (read: Promise<unknown>): Promise<string> => {
  try {
    await read;
    return "read";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe("today's Brain, through core", () => {
  it("refuses every read, even of its own person's document everyone may read", async () => {
    const admin = await signedInApi(idp, "admin");
    const word = `zq${unique()}`;
    const { id: collectionId } = await seed(admin.api).createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const saved = await seed(admin.api).saveDocument({
      collectionId,
      path: "policy.md",
      text: `# Policy\n${word} applies.`,
      ifVersion: 0,
    });
    const brain = brainOf(env);
    const reader = {
      type: "person" as const,
      person: await admin.api.whoami(),
    };

    const refused = {
      document: await refusal(getDocument(brain, reader, saved.id)),
      history: await refusal(history(brain, reader, saved.id)),
      listing: await refusal(listDocuments(brain, reader, collectionId)),
      search: await refusal(search(brain, reader, word)),
      recall: await refusal(recall(brain, reader, { query: word })),
    };

    const none = "Core reads nothing of today's Brain";
    expect(refused).toStrictEqual({
      document: none,
      history: none,
      listing: none,
      search: none,
      recall: none,
    });
  });
});
