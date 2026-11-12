import { agentDocumentsMax } from "@grasp-os/shared/agents";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { codeResults, codeStep, model, says } from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// An agent's documents: an admin gives an agent a file, core keeps its
// text, and the agent is told it by name and reads it in the chats it
// answers. These start from the ways it can fail: someone who isn't the
// company's own admin adding, listing or removing one; a document told
// to, or read by, another agent; more documents than an agent keeps, two
// under one name, or a file that isn't what its name says, taken; a
// deleted agent's documents left behind, or one added to it after; a
// change unrecorded, or recorded with the file's name or words.

const idp = mockIdp();

const slow = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const objectOf = ({ userId }: { userId: string }) =>
  workspace(env, personalWorkspaceId(userId));

/** An agent everyone reaches, made by `admin`. */
const agentFor = async (admin: Person, name: string) => {
  const agent = await admin.api.connections.makeAgent({
    name,
    face: "stephen",
    job: "",
    instructions: "",
    modelRole: null,
  });
  await admin.api.connections.setAgentReach(agent.id, true, {
    who: "everyone",
  });
  return agent;
};

/** Waits until the agent has stopped working on `chatId`. */
const settled = async (person: Person, chatId: string) => {
  await vi.waitFor(
    async () => {
      const chats = await person.api.chats.list();
      expect(chats.find(({ id }) => id === chatId)?.running).toBeFalsy();
    },
    { timeout: 20_000 }
  );
};

/** How many documents core keeps for `agentId`. */
const keptFor = async (agentId: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS documents FROM agent_documents WHERE agent_id = ?"
  )
    .bind(agentId)
    .first<{ documents: number }>();
  return row?.documents ?? 0;
};

const secret = "Invoices over 5,000 euros need two signatures.";
const fileName = "Close checklist - confidential.md";

describe("an agent's documents", slow, () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM agents"),
      env.DB.prepare("DELETE FROM agent_reach"),
      env.DB.prepare("DELETE FROM agent_tool_classes"),
      env.DB.prepare("DELETE FROM agent_documents"),
    ]);
  });

  it("are added, listed and removed by the company's own admins alone, and recorded without their names or words", async () => {
    const admin = await signedInApi(idp, "admin");
    const user = await signedInApi(idp, "user");
    const claire = await agentFor(admin, "Claire");
    const file = { name: fileName, bytes: utf8(`# Close\n\n${secret}`) };

    const refused = [
      await outcome(user.api.connections.addAgentDocument(claire.id, file)),
      await outcome(user.api.connections.agentDocuments(claire.id)),
    ];
    const added = await admin.api.connections.addAgentDocument(claire.id, file);
    const listed = await admin.api.connections.agentDocuments(claire.id);
    const refusedRemove = await outcome(
      user.api.connections.removeAgentDocument(claire.id, added.id)
    );
    const keptAfterRefusals = await keptFor(claire.id);
    await admin.api.connections.removeAgentDocument(claire.id, added.id);
    const events = await allEvents();
    const recorded = events.filter(
      ({ action, target }) =>
        action.startsWith("agent.document.") && target?.id === claire.id
    );

    expect({
      refused,
      refusedRemove,
      keptAfterRefusals,
      listed: listed.map(({ id, name, type, bytes }) => [
        id,
        name,
        type,
        bytes,
      ]),
      after: await admin.api.connections.agentDocuments(claire.id),
      removedAgain: await outcome(
        admin.api.connections.removeAgentDocument(claire.id, added.id)
      ),
      recorded: recorded.map(({ action, detail }) => [action, detail]),
      named: JSON.stringify(recorded).includes("confidential"),
      quoted: JSON.stringify(recorded).includes("signatures"),
    }).toStrictEqual({
      refused: ["role.forbidden", "role.forbidden"],
      refusedRemove: "role.forbidden",
      keptAfterRefusals: 1,
      listed: [[added.id, fileName, "md", file.bytes.byteLength]],
      after: [],
      removedAgain: "agent.document_unknown",
      recorded: [
        [
          "agent.document.added",
          { documentId: added.id, type: "md", bytes: file.bytes.byteLength },
        ],
        [
          "agent.document.removed",
          { documentId: added.id, type: "md", bytes: file.bytes.byteLength },
        ],
      ],
      named: false,
      quoted: false,
    });
  });

  it("take only files that are what their names say, one under each name, and no more than an agent keeps", async () => {
    const admin = await signedInApi(idp, "admin");
    const claire = await agentFor(admin, "Claire");
    const add = async (name: string, bytes: Uint8Array) =>
      await outcome(
        admin.api.connections.addAgentDocument(claire.id, { name, bytes })
      );

    const outcomes = {
      notPdf: await add("policy.pdf", utf8("not a PDF")),
      noType: await add("policy.exe", utf8("MZ")),
      empty: await add("empty.md", utf8("   ")),
      unknownAgent: await outcome(
        admin.api.connections.addAgentDocument("nobody-made-this", {
          name: "a.md",
          bytes: utf8("a"),
        })
      ),
      first: await add("a.md", utf8("a")),
      sameName: await add("a.md", utf8("another")),
    };
    // All at once: the insert itself holds the most an agent keeps.
    const filled = await Promise.all(
      Array.from(
        { length: agentDocumentsMax - 1 },
        async (_each, index) =>
          await add(`more-${index}.md`, utf8(`more ${index}`))
      )
    );

    expect({
      outcomes,
      filled: filled.every((ended) => ended === "ok"),
      past: await add("one-too-many.md", utf8("one too many")),
      kept: await keptFor(claire.id),
    }).toStrictEqual({
      outcomes: {
        notPdf: "agent.file_unsupported",
        noType: "agent.file_unsupported",
        empty: "upload.no_text",
        unknownAgent: "agent.unknown",
        first: "ok",
        sameName: "agent.document_named",
      },
      filled: true,
      past: "agent.too_many_documents",
      kept: agentDocumentsMax,
    });
  });

  it("are told to their agent by name and read by its code, and never told to or read by another agent", async () => {
    const admin = await signedInApi(idp, "admin");
    const ann = await signedInApi(idp, "user");
    const claire = await agentFor(admin, "Claire");
    const other = await agentFor(admin, "Other");
    const document = await admin.api.connections.addAgentDocument(claire.id, {
      name: fileName,
      bytes: utf8(`# Close\n\n${secret}`),
    });
    const code = `export default async (self, env) => [await env.chat.documents(), await env.chat.readDocument(${JSON.stringify(document.id)})];`;
    const provider = await fakeProvider(
      codeStep(code),
      says("Two signatures."),
      codeStep(code),
      says("I have no such document.")
    );

    const hers = await ann.api.chats.create("With Claire", claire.id);
    await ann.api.chats.send(hers.id, { text: "Who signs?", model });
    await settled(ann, hers.id);
    const theirs = await ann.api.chats.create("With Other", other.id);
    await ann.api.chats.send(theirs.id, { text: "Who signs?", model });
    await settled(ann, theirs.id);

    const [read] = await codeResults(objectOf(ann), hers.id);
    const [refused] = await codeResults(objectOf(ann), theirs.id);
    const asked = provider.requests.map(({ body }) => JSON.stringify(body));
    expect({
      // Claire is told the document's name and ID, never its words…
      told: [document.id, fileName].map((each) => asked[0]?.includes(each)),
      toldWords: asked[0]?.includes("two signatures"),
      // …and her code lists it and reads its text.
      listed: read?.text.includes(`"name":"${fileName}"`),
      text: read?.text.includes("two signatures"),
      readFailed: read?.isError,
      // The other agent is told nothing of it and can't read it.
      toldOther: asked[2]?.includes(document.id),
      otherRead: refused?.text.includes("two signatures"),
      otherRefused:
        refused?.isError === true &&
        refused.text.includes("The agent has no such document."),
    }).toStrictEqual({
      told: [true, true],
      toldWords: false,
      listed: true,
      text: true,
      readFailed: false,
      toldOther: false,
      otherRead: false,
      otherRefused: true,
    });
  });

  it("go with their agent when it is deleted, and none is added to it after", async () => {
    const admin = await signedInApi(idp, "admin");
    const claire = await agentFor(admin, "Claire");
    await admin.api.connections.addAgentDocument(claire.id, {
      name: "a.md",
      bytes: utf8("a"),
    });
    await admin.api.connections.deleteAgent(claire.id);

    expect({
      kept: await keptFor(claire.id),
      added: await outcome(
        admin.api.connections.addAgentDocument(claire.id, {
          name: "b.md",
          bytes: utf8("b"),
        })
      ),
      listed: await outcome(admin.api.connections.agentDocuments(claire.id)),
    }).toStrictEqual({
      kept: 0,
      added: "agent.unknown",
      listed: "agent.unknown",
    });
  });
});
