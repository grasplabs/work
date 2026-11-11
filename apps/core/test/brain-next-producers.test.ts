import type { Message } from "@earendil-works/pi-ai";
import { outcomesOf } from "@grasp-os/brain/outcomes";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { SessionApi } from "@grasp-os/shared/rpc";
import type { Upload } from "@grasp-os/shared/uploads";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { readSourceVersionAs, recallAs } from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
import {
  handOverChatTurn,
  handOverRun,
  handOverUpload,
} from "../src/brain-producers.ts";
import type { TurnCapture } from "../src/chat-harness.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { handOverReadyUpload } from "../src/knowledge/uploads.ts";
import { shareWorkflowResource } from "../src/workflow-resources.ts";
import {
  codeResults,
  codeStep,
  model,
  pausedReply,
  says,
  transcript,
} from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { wordFile } from "./word-file.ts";
import { person, startingApp } from "./workflow-calls.ts";
import {
  builder,
  definitionOf,
  ended,
  published,
  start,
} from "./workflow-resource-runs-harness.ts";

// Core's producers for the new Brain (brain-producers.ts): an upload once
// ready, a chat turn once settled, an independent workflow run once ended,
// each handed over for the one person it is certainly for. From the
// threat model, the ways a hand-over can fail:
//
// - It is read by more people than that one: a team the collection is
//   shared with, its owner, an admin, another member of the chat's
//   organization, the workflow's owner.
// - It hands over what core holds back: a sensitive collection's file, a
//   restricted chat, a restricted run, what a chat's tool returned.
// - A delivery made again becomes a second version; one made late puts
//   older text on top.
// - Text past the Brain's bound is refused, losing the whole record.
// - A refusal fails what it follows (the upload, the run), throws, or
//   logs what was handed over.
// - It adds to a person whose erasure has begun.
// - One message it can't read keeps the rest of the chat from it.

const idp = mockIdp();

/** A word nothing else holds. */
const word = (): string => `w${crypto.randomUUID().replaceAll("-", "")}`;

/** How many passages `personId` recalls holding `question`. */
const recalled = async (
  personId: string,
  question: string
): Promise<number> => {
  const { chunks } = await recallAs(env, personId, question);
  return chunks.length;
};

/** Once `personId` recalls `question`: the versions of what they found. */
const recalledVersions = async (
  personId: string,
  question: string
): Promise<number[]> =>
  await vi.waitFor(
    async () => {
      const { chunks } = await recallAs(env, personId, question);
      expect(chunks).not.toHaveLength(0);
      return chunks.map(({ version }) => version);
    },
    { timeout: 20_000, interval: 100 }
  );

/** Version `version` of `source`, as `personId` may read it: null when none. */
const versionOf = async (
  personId: string,
  source: SourceRef,
  version: number
) => await readSourceVersionAs(env, personId, { source, version });

/** Whether `personId` may read version 2 of `source`: one version only. */
const secondVersionOf = async (personId: string, source: SourceRef) =>
  await versionOf(personId, source, 2);

/** Whether `name` is a method of the console. */
const isConsoleMethod = (name: string): name is keyof Console =>
  /^[a-z]/u.test(name) && typeof Reflect.get(console, name) === "function";

/**
 * Every console line written while `run` runs, as text, and what it
 * returned; `run` sees the lines as they come.
 */
const logsOf = async <T>(
  run: (lines: readonly string[]) => Promise<T>
): Promise<{ value: T; lines: string[] }> => {
  const lines: string[] = [];
  const spies = Object.getOwnPropertyNames(console)
    .filter(isConsoleMethod)
    .map((name) =>
      vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      })
    );
  try {
    return { value: await run(lines), lines };
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
};

/** The line a refused hand-over logs, for `producer`. */
const refusedLine = (producer: string): string =>
  JSON.stringify([{ event: "brain.source_refused", producer }]);

/** The upload once its extraction has ended, ready or failed. */
const uploadEnded = async (
  api: SessionApi,
  uploadId: string
): Promise<Upload> =>
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

/**
 * An uploader and a team-mate in a team collection an admin owns, an
 * outsider, and the admin.
 */
const teamCollection = async (sensitive = false) => {
  const [owner, uploader, teamMate, outsider] = await Promise.all([
    signedInApi(idp, "admin"),
    signedInApi(idp, "user"),
    signedInApi(idp, "user"),
    signedInApi(idp, "user"),
  ]);
  const team = await newTeam(owner, [uploader, teamMate]);
  const { id } = await owner.api.knowledge.createCollection({
    name: `Contracts ${unique()}`,
    access: "teams",
    teams: [team],
    sensitive,
  });
  return { owner, uploader, teamMate, outsider, team, collectionId: id };
};

/**
 * `by` uploads a Word file of `paragraphs` into `collectionId`, named
 * `name`.
 */
const uploadedBy = async (
  by: { api: SessionApi },
  collectionId: string,
  paragraphs: string[],
  name = `contract-${unique()}.docx`
): Promise<Upload> => {
  const upload = await by.api.uploads.upload({
    collectionId,
    name,
    bytes: wordFile(paragraphs),
  });
  return await uploadEnded(by.api, upload.id);
};

/** A member with their own chat, answered by `replies` in turn. */
const chatter = async (...replies: ProviderReply[]) => {
  const member = await signedInApi(idp, "user");
  const stub = workspace(env, personalWorkspaceId(member.userId));
  await fakeProvider(...replies);
  const chat = await member.api.chats.create("Questions");
  const id = chatIdSchema.parse(chat.id);
  const ask = async (text: string) => await stub.ask(id, { text, model });
  return { person: member, stub, id, ask };
};

/** The id of `refs`' first ref of `kind`; empty with none. */
const refOf = (
  refs: readonly { kind: string; id: string }[],
  kind: string
): string => refs.find((ref) => ref.kind === kind)?.id ?? "";

/**
 * Text past the Brain's 1,000,000 bytes, after `opening`: a lone
 * surrogate, made whole, then a four-byte character across the cut that
 * bounds an upload's or a run's, and `closing` past the Brain's bound.
 */
const pastTheBound = (opening: string, closing: string): string =>
  `${opening} \uD800 ${"x".repeat(899_900)}${"😀".repeat(100)} ${"lorem ".repeat(17_000)}Closing ${closing}`;

/**
 * The captures of chat `chatId`'s turns, once today's Brain took as many
 * as `count`, as its ChatSession delivered them (`captureTurn`): of the
 * events today's Brain kept of them (brain-capture.ts, `turnOutcome`),
 * each naming its turn, its answer and its model. A person's own chat:
 * no audience.
 */
const capturesOf = async (
  chatId: string,
  count: number
): Promise<TurnCapture[]> =>
  await vi.waitFor(
    async () => {
      const events = await outcomesOf(brainOf(env), chatId);
      expect(events).toHaveLength(count);
      return events.map(({ evidenceRefs, versionRefs }): TurnCapture => ({
        turnId: refOf(evidenceRefs, "chat_turn"),
        outcome: "answered",
        answerId: Number(refOf(evidenceRefs, "chat_message")),
        model: refOf(versionRefs, "model"),
        audience: null,
      }));
    },
    { timeout: 15_000, interval: 100 }
  );

/** A question `text`, as pi keeps it. */
const question = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: 0,
});

/** An answer `text`, as pi keeps it. */
const answer = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});

/** A turn's capture naming `answerId`, as its ChatSession delivers it. */
const capture = (answerId: number | undefined): TurnCapture => ({
  turnId: crypto.randomUUID(),
  outcome: "answered",
  answerId: answerId ?? null,
  model,
  audience: null,
});

describe("core's producers for the new Brain", { timeout: 120_000 }, () => {
  it("hands over an upload for its uploader alone: not the team it is shared with, the collection's owner, an admin or an outsider", async () => {
    const { owner, uploader, teamMate, outsider, collectionId } =
      await teamCollection();
    const admin = await signedInApi(idp, "admin");
    const secret = word();
    const upload = await uploadedBy(uploader, collectionId, [
      `The renewal terms ${secret} are confidential.`,
    ]);

    const versions = await recalledVersions(uploader.userId, secret);

    expect({
      status: upload.status,
      versions,
      teamMate: await recalled(teamMate.userId, secret),
      owner: await recalled(owner.userId, secret),
      admin: await recalled(admin.userId, secret),
      outsider: await recalled(outsider.userId, secret),
    }).toStrictEqual({
      status: "ready",
      versions: [1],
      teamMate: 0,
      owner: 0,
      admin: 0,
      outsider: 0,
    });
  });

  it("hands over nothing of an upload into a sensitive collection, which is ready all the same", async () => {
    const { owner, uploader, teamMate, team, collectionId } =
      await teamCollection(true);
    const open = await owner.api.knowledge.createCollection({
      name: `Notes ${unique()}`,
      access: "teams",
      teams: [team],
      sensitive: false,
    });
    const [secret, shared] = [word(), word()];
    const upload = await uploadedBy(uploader, collectionId, [
      `The diagnosis ${secret} stays in the team.`,
    ]);
    // Then an upload of theirs into a collection that isn't sensitive:
    // once it is handed over, anything of the first would have been
    // before it. Best-effort, each hand-over in the background of its
    // own extraction, but a sensitive upload's makes no call to the Brain
    // at all, so nothing of it can land later.
    await uploadedBy(uploader, open.id, [`The agenda ${shared}.`]);

    expect({
      status: upload.status,
      shared: await recalledVersions(uploader.userId, shared),
      uploader: await recalled(uploader.userId, secret),
      teamMate: await recalled(teamMate.userId, secret),
      owner: await recalled(owner.userId, secret),
    }).toStrictEqual({
      status: "ready",
      shared: [1],
      uploader: 0,
      teamMate: 0,
      owner: 0,
    });
  });

  it("cuts an upload past the Brain's bound to its start, rather than refusing it", async () => {
    const { uploader, collectionId } = await teamCollection();
    const [opening, closing] = [word(), word()];
    // Past the Brain's million bytes, within the Knowledge document's
    // megabyte.
    const filler = "lorem ".repeat(170);
    const upload = await uploadedBy(uploader, collectionId, [
      `Opening ${opening}`,
      ...Array.from({ length: 1000 }, () => filler),
      `Closing ${closing}`,
    ]);

    expect({
      status: upload.status,
      opening: await recalledVersions(uploader.userId, opening),
      closing: await recalled(uploader.userId, closing),
    }).toStrictEqual({ status: "ready", opening: [1], closing: 0 });
  });

  it("keeps a later upload of the same name current when an earlier upload's hand-over lands after it", async () => {
    const { uploader, collectionId } = await teamCollection();
    const [older, newer] = [word(), word()];
    const name = `contract-${unique()}.docx`;
    const first = await uploadedBy(
      uploader,
      collectionId,
      [`Draft ${older}`],
      name
    );
    await recalledVersions(uploader.userId, older);
    const second = await uploadedBy(
      uploader,
      collectionId,
      [`Signed ${newer}`],
      name
    );
    const versions = await recalledVersions(uploader.userId, newer);
    const documentId = first.documentId ?? "";
    const source: SourceRef = { producer: "upload", id: documentId };
    // The first upload's text, as its own hand-over carried it.
    const firstVersion = await versionOf(uploader.userId, source, 1);

    // The first upload's hand-over, landing after the second's as a late
    // one would: its own record and text, through the call its extraction
    // makes (uploads.ts).
    const { value: late, lines } = await logsOf(
      async () =>
        await handOverReadyUpload(env, {
          uploadId: first.id,
          uploadedBy: uploader.userId,
          collectionId,
          sensitive: false,
          path: first.name,
          documentId,
          version: first.version ?? 0,
          text: firstVersion?.text ?? "",
        })
    );
    const secondVersion = await versionOf(uploader.userId, source, 2);

    expect({
      saved: [second.documentId === documentId, first.version, second.version],
      late,
      refused: lines.filter((line) => line.includes("brain.source_refused")),
      versions,
      newerInCurrent: secondVersion?.text.includes(newer),
      olderInCurrent: secondVersion?.text.includes(older),
      third: await versionOf(uploader.userId, source, 3),
      older: await recalled(uploader.userId, older),
    }).toStrictEqual({
      saved: [true, 1, 2],
      late: false,
      refused: [],
      versions: [2],
      newerInCurrent: true,
      olderInCurrent: false,
      third: null,
      older: 0,
    });
  });

  it("cuts an upload's and a run's text past the Brain's bound to its start, at a character, and makes a chat's half surrogate whole, the same each time", async () => {
    const { userId } = await signedInApi(idp, "user");
    const [uploadWord, runWord, chatWord, closing] = [
      word(),
      word(),
      word(),
      word(),
    ];
    const upload = {
      uploadId: crypto.randomUUID(),
      documentId: crypto.randomUUID(),
      uploadedBy: userId,
      sensitive: false,
      text: pastTheBound(`Contract ${uploadWord}`, closing),
      stillCurrent: async () => await Promise.resolve(true),
    };
    const run = {
      runId: crypto.randomUUID(),
      principalId: userId,
      restricted: false,
      status: "completed",
      readEnd: async () =>
        await Promise.resolve({ result: pastTheBound(runWord, closing) }),
    };
    // A said message cut at half a surrogate pair, as a chat's can be.
    const turn = {
      chatId: crypto.randomUUID(),
      answerId: 1,
      personId: userId,
      restricted: false,
      said: [
        { role: "user", text: `Asked ${chatWord} \uD800` },
        { role: "assistant", text: "Answered \uD800" },
      ] as const,
    };

    const handedOver = [
      await handOverUpload(env, upload),
      await handOverRun(env, run),
      await handOverChatTurn(env, turn),
      await handOverUpload(env, upload),
      await handOverRun(env, run),
      await handOverChatTurn(env, turn),
    ];

    expect({
      handedOver,
      versions: [
        await recalledVersions(userId, uploadWord),
        await recalledVersions(userId, runWord),
        await recalledVersions(userId, chatWord),
      ],
      second: [
        await secondVersionOf(userId, {
          producer: "upload",
          id: upload.documentId,
        }),
        await secondVersionOf(userId, { producer: "run", id: run.runId }),
        await secondVersionOf(userId, { producer: "chat", id: turn.chatId }),
      ],
      closing: await recalled(userId, closing),
    }).toStrictEqual({
      handedOver: [true, true, true, true, true, true],
      versions: [[1], [1], [1]],
      second: [null, null, null],
      closing: 0,
    });
  });

  it("leaves an upload the Brain refuses ready, logging only that it was refused", async () => {
    const { uploader, collectionId } = await teamCollection();
    const secret = word();
    // Within the Brain's bytes as given, past them as its word index folds
    // them ("ﷺ" is 3 bytes, and 33 folded): Knowledge takes it, the Brain
    // refuses it.
    const unfolding = "ﷺ".repeat(400);
    const { value: upload, lines } = await logsOf(async (logged) => {
      const kept = await uploadedBy(uploader, collectionId, [
        `Opening ${secret}`,
        ...Array.from({ length: 100 }, () => unfolding),
      ]);
      // Handed over once the upload is ready, so refused a moment after.
      await vi.waitFor(
        () => {
          expect(logged.join("\n")).toContain("brain.source_refused");
        },
        { timeout: 10_000, interval: 50 }
      );
      return kept;
    });

    expect({
      status: upload.status,
      refused: lines.filter((line) => line.includes("brain.source_refused")),
      secretLogged: lines.some((line) => line.includes(secret)),
      recalled: await recalled(uploader.userId, secret),
    }).toStrictEqual({
      status: "ready",
      refused: [refusedLine("upload")],
      secretLogged: false,
      recalled: 0,
    });
  });

  it("hands over a chat as of its latest answer for the chat's person alone: a capture delivered again, or late, adds no version and nothing after that answer", async () => {
    const [asked, first, second, later, last] = [
      word(),
      word(),
      word(),
      word(),
      word(),
    ];
    const lastReply = pausedReply(says(`Floor ${last}.`), 1);
    const {
      person: member,
      stub,
      ask,
      id,
    } = await chatter(
      says(`The answer is ${first}.`),
      says(`Then ${second}.`),
      lastReply.reply
    );
    const source: SourceRef = { producer: "chat", id };
    const [other, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    await ask(`Where is ${asked}?`);
    const firstVersions = await recalledVersions(member.userId, first);
    const [firstCapture] = await capturesOf(id, 1);
    await ask("And then?");
    const secondVersions = await recalledVersions(member.userId, second);
    if (firstCapture === undefined) {
      throw new Error("Turn 1 kept no capture");
    }
    // A third question kept, its answer still to come: past the latest
    // answer. Observed from the start (`thirdSettled`), then released and
    // awaited whatever fails below: never left pending, nor rejected
    // unobserved.
    const third = ask(`What of ${later}?`);
    const thirdSettled = Promise.allSettled([third]);
    let delivered: {
      value: { lastVersions: number[]; fourth: unknown };
      lines: string[];
    };
    try {
      await vi.waitFor(
        async () => {
          const said = JSON.stringify(await transcript(stub, id));
          expect(said).toContain(later);
        },
        { timeout: 10_000, interval: 50 }
      );
      // Turn 1's capture delivered again, late, as its ChatSession
      // delivers it: through the object's own method. Each names the
      // latest answer's change with the same text, so it adds no version
      // and logs nothing. Then the third answer, handed over after them:
      // once it is the chat's, any version the re-deliveries added would
      // be under it. Logs are read until then, and no version past it.
      delivered = await logsOf(async () => {
        await stub.captureTurn(id, firstCapture);
        await stub.captureTurn(id, firstCapture);
        lastReply.release();
        await third;
        const lastVersions = await recalledVersions(member.userId, last);
        return {
          lastVersions,
          fourth: await versionOf(member.userId, source, 4),
        };
      });
    } finally {
      lastReply.release();
      await thirdSettled;
    }
    const {
      value: { lastVersions, fourth },
      lines,
    } = delivered;
    const secondVersion = await versionOf(member.userId, source, 2);

    expect({
      refused: lines.filter((line) => line.includes("brain.source_refused")),
      laterInSecond: secondVersion?.text.includes(later),
      firstVersions,
      secondVersions,
      lastVersions,
      later: await recalledVersions(member.userId, later),
      fourth,
      other: await recalled(other.userId, `${asked} ${first} ${second}`),
      admin: await recalled(admin.userId, `${asked} ${first} ${second}`),
    }).toStrictEqual({
      refused: [],
      laterInSecond: false,
      firstVersions: [1],
      secondVersions: [2],
      lastVersions: [3],
      later: [3],
      fourth: null,
      other: 0,
      admin: 0,
    });
  });

  it("keeps a chat's later answer current when an earlier turn's capture first arrives after the later turn's", async () => {
    const member = await signedInApi(idp, "user");
    const stub = workspace(env, personalWorkspaceId(member.userId));
    const chat = await member.api.chats.create("Questions");
    const id = chatIdSchema.parse(chat.id);
    const [first, second, third] = [word(), word(), word()];
    // Two turns' messages, as their ChatSession copies them.
    const firstAnswer = await stub.keepTurnMessages(id, [
      { entryId: 1, message: question("Where?") },
      { entryId: 2, message: answer(`Floor ${first}.`) },
    ]);
    const secondAnswer = await stub.keepTurnMessages(id, [
      { entryId: 3, message: question("And then?") },
      { entryId: 4, message: answer(`Room ${second}.`) },
    ]);
    // Turn 2's capture delivered first, turn 1's only after it.
    await stub.captureTurn(id, capture(secondAnswer));
    const versions = await recalledVersions(member.userId, second);
    await stub.captureTurn(id, capture(firstAnswer));
    // A third turn's, handed over after it: once that is the chat's, any
    // version turn 1's late capture added would be under it.
    const thirdAnswer = await stub.keepTurnMessages(id, [
      { entryId: 5, message: question("And last?") },
      { entryId: 6, message: answer(`Desk ${third}.`) },
    ]);
    await stub.captureTurn(id, capture(thirdAnswer));
    const thirdVersions = await recalledVersions(member.userId, third);
    const source: SourceRef = { producer: "chat", id };
    const firstVersion = await versionOf(member.userId, source, 1);

    expect({
      versions,
      firstInCurrent: firstVersion?.text.includes(first),
      secondInCurrent: firstVersion?.text.includes(second),
      thirdVersions,
      third: await versionOf(member.userId, source, 3),
    }).toStrictEqual({
      versions: [1],
      firstInCurrent: true,
      secondInCurrent: true,
      thirdVersions: [2],
      third: null,
    });
  });

  it("hands over a chat's questions and answers, never what its tools returned", async () => {
    const answered = word();
    const returned = word();
    // The marker only in what the code returns: its halves are in the
    // call, the whole word only in the result.
    const half = returned.length / 2;
    const {
      person: member,
      stub,
      ask,
      id,
    } = await chatter(
      codeStep(
        `export default async () => ${JSON.stringify(returned.slice(0, half))} + ${JSON.stringify(returned.slice(half))};`
      ),
      says(`Found ${answered}.`)
    );

    await ask("Look it up.");
    const versions = await recalledVersions(member.userId, answered);
    const [result] = await codeResults(stub, id);
    const handed = await versionOf(member.userId, { producer: "chat", id }, 1);

    expect({
      returned: result?.text.includes(returned),
      versions,
      recalled: await recalled(member.userId, returned),
      answeredInText: handed?.text.includes(answered),
      returnedInText: handed?.text.includes(returned),
    }).toStrictEqual({
      returned: true,
      versions: [1],
      recalled: 0,
      answeredInText: true,
      returnedInText: false,
    });
  });

  it("hands over what a chat said before searches kept it, read from its messages", async () => {
    const [before, after] = [word(), word()];
    const {
      person: member,
      stub,
      ask,
      id,
    } = await chatter(says(`Kept ${before}.`), says(`Then ${after}.`));
    await ask("Where?");
    await recalledVersions(member.userId, before);
    // A chat from before search rows existed: no row of what it said.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM chat_search_text");
    });

    await ask("And then?");
    const versions = await recalledVersions(member.userId, after);
    const handed = await versionOf(member.userId, { producer: "chat", id }, 2);

    expect({
      versions,
      beforeInText: handed?.text.includes(before),
    }).toStrictEqual({ versions: [2], beforeInText: true });
  });

  it("hands over a chat's own messages alone, never another chat of its person's", async () => {
    const [answered, elsewhere] = [word(), word()];
    const {
      person: member,
      stub,
      ask,
      id,
    } = await chatter(says("Kept apart."), says(`Found ${answered}.`));
    // The person's other chat, in the same Workspace, its messages kept
    // before this chat's answer: restricted, so nothing of it is handed
    // over of its own.
    const elsewhereChat = await member.api.chats.create("Elsewhere");
    const other = chatIdSchema.parse(elsewhereChat.id);
    await stub.restrictChat(other);
    await stub.ask(other, { text: `Where is ${elsewhere}?`, model });

    await ask("Look it up.");
    const versions = await recalledVersions(member.userId, answered);
    const handed = await versionOf(member.userId, { producer: "chat", id }, 1);

    expect({
      versions,
      recalled: await recalled(member.userId, elsewhere),
      elsewhereInText: handed?.text.includes(elsewhere),
    }).toStrictEqual({
      versions: [1],
      recalled: 0,
      elsewhereInText: false,
    });
  });

  it("hands over nothing of a chat in restricted mode", async () => {
    const [asked, open] = [word(), word()];
    const {
      person: member,
      stub,
      ask,
      id,
    } = await chatter(says("Floor 3."), says(`Room ${open}.`));
    await stub.restrictChat(id);

    await ask(`Where is ${asked}?`);
    await runDurableObjectAlarm(stub);
    // Then a chat of theirs not in restricted mode: once it is handed
    // over, anything of the first would have been before it. Best-effort,
    // each in the background of its own capture, but a restricted chat's
    // capture makes no call to the Brain at all, so nothing of it can
    // land later.
    const openChat = await member.api.chats.create("Open");
    await stub.ask(chatIdSchema.parse(openChat.id), {
      text: "And then?",
      model,
    });

    expect({
      open: await recalledVersions(member.userId, open),
      asked: await recalled(member.userId, asked),
    }).toStrictEqual({ open: [1], asked: 0 });
  });

  it("hands over nothing of a run started in restricted mode, as it does a run started unrestricted, for the person it acted for", async () => {
    const [ada, admin] = await Promise.all([
      person("builder"),
      person("admin"),
    ]);
    const [held, open] = [word(), word()];
    const flow = async (restricted: boolean, secret: string) => {
      const workflow = await published(
        ada,
        definitionOf([], { value: { status: secret } })
      );
      const starter = await startingApp(ada, admin, workflow.id, {
        restricted,
      });
      const runId = await starter.start();
      return await ended(ada, workflow.id, runId);
    };

    const restrictedRun = await flow(true, held);
    const openRun = await flow(false, open);
    // Ended after the restricted run: anything of that one would be
    // handed over by the time this one is. Best-effort, each in the
    // background of its own end, but a restricted run's makes no call to
    // the Brain at all, not even to read its end, so nothing of it can
    // land later.
    const versions = await recalledVersions(ada.userId, open);

    expect({
      status: [restrictedRun.status, openRun.status],
      versions,
      held: await recalled(ada.userId, held),
    }).toStrictEqual({
      status: ["completed", "completed"],
      versions: [1],
      held: 0,
    });
  });

  it("hands over a run's result for the person it acted for alone: not the workflow's owner, an admin or an outsider", async () => {
    const [owner, actedFor, admin, outsider] = await Promise.all([
      builder(),
      builder("user"),
      builder("admin"),
      builder("user"),
    ]);
    const secret = word();
    const workflow = await published(
      owner,
      definitionOf([], { value: { status: secret } })
    );
    await shareWorkflowResource(env, owner, workflow.id, {
      type: "person",
      id: actedFor.userId,
      role: "user",
    });
    const { runId } = await start(actedFor, workflow.id);
    const run = await ended(actedFor, workflow.id, runId);

    const versions = await recalledVersions(actedFor.userId, secret);

    expect({
      status: run.status,
      versions,
      second: await secondVersionOf(actedFor.userId, {
        producer: "run",
        id: runId ?? "",
      }),
      owner: await recalled(owner.userId, secret),
      admin: await recalled(admin.userId, secret),
      outsider: await recalled(outsider.userId, secret),
    }).toStrictEqual({
      status: "completed",
      versions: [1],
      second: null,
      owner: 0,
      admin: 0,
      outsider: 0,
    });
  });

  it("refuses each hand-over without a person, logging only the producer, and takes the same change for a person after as its first version", async () => {
    const { userId } = await signedInApi(idp, "user");
    const [uploadWord, chatWord, runWord] = [word(), word(), word()];
    const upload = {
      uploadId: crypto.randomUUID(),
      documentId: crypto.randomUUID(),
      sensitive: false,
      text: `Contract ${uploadWord}`,
      stillCurrent: async () => await Promise.resolve(true),
    };
    const turn = {
      chatId: crypto.randomUUID(),
      answerId: 1,
      restricted: false,
      said: [{ role: "user", text: `Asked ${chatWord}` }] as const,
    };
    const run = {
      runId: crypto.randomUUID(),
      restricted: false,
      status: "completed",
      readEnd: async () => await Promise.resolve({ result: { note: runWord } }),
    };

    const { value: refused, lines } = await logsOf(async () => [
      await handOverUpload(env, { ...upload, uploadedBy: "" }),
      await handOverChatTurn(env, { ...turn, personId: "" }),
      await handOverRun(env, { ...run, principalId: "" }),
    ]);
    const nobody = [
      await recalled(userId, uploadWord),
      await recalled(userId, chatWord),
      await recalled(userId, runWord),
    ];
    const taken = [
      await handOverUpload(env, { ...upload, uploadedBy: userId }),
      await handOverChatTurn(env, { ...turn, personId: userId }),
      await handOverRun(env, { ...run, principalId: userId }),
    ];

    expect({
      refused,
      lines,
      nobody,
      taken,
      versions: [
        await recalledVersions(userId, uploadWord),
        await recalledVersions(userId, chatWord),
        await recalledVersions(userId, runWord),
      ],
    }).toStrictEqual({
      refused: [false, false, false],
      lines: [refusedLine("upload"), refusedLine("chat"), refusedLine("run")],
      nobody: [0, 0, 0],
      taken: [true, true, true],
      versions: [[1], [1], [1]],
    });
  });

  it("hands over nothing of a run whose end can't be read, logging only that, and its end once it can be read as its first version", async () => {
    const { userId } = await signedInApi(idp, "user");
    const result = word();
    const run = {
      runId: crypto.randomUUID(),
      principalId: userId,
      restricted: false,
      status: "completed",
    };

    const { value: unread, lines } = await logsOf(
      async () =>
        await handOverRun(env, {
          ...run,
          readEnd: async () => {
            await Promise.resolve();
            throw new Error(`Result ${result} out of reach`);
          },
        })
    );
    const read = await handOverRun(env, {
      ...run,
      readEnd: async () => await Promise.resolve({ result: { note: result } }),
    });
    const source: SourceRef = { producer: "run", id: run.runId };
    const first = await versionOf(userId, source, 1);

    expect({
      unread,
      lines,
      read,
      versions: await recalledVersions(userId, result),
      first: first?.text.includes(result),
      second: await secondVersionOf(userId, source),
    }).toStrictEqual({
      unread: false,
      lines: [refusedLine("run")],
      read: true,
      versions: [1],
      first: true,
      second: null,
    });
  });

  // Each producer called directly, as each call site calls it: a real
  // erasure deletes the person's Workspace storage, their chats with it,
  // so no capture of theirs reaches the chat producer through it after.
  it("hands over nothing of a run, an upload or a chat turn for a person who was erased, logging nothing, as it does for someone else", async () => {
    const [erased, kept, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const result = word();
    const runFor = (principalId: string) => ({
      runId: crypto.randomUUID(),
      principalId,
      restricted: false,
      status: "completed",
      readEnd: async () => await Promise.resolve({ result: { note: result } }),
    });
    const [erasedRun, keptRun] = [runFor(erased.userId), runFor(kept.userId)];
    const erasedUpload = {
      uploadId: crypto.randomUUID(),
      documentId: crypto.randomUUID(),
      uploadedBy: erased.userId,
      sensitive: false,
      text: `An upload ${word()}`,
      stillCurrent: async () => await Promise.resolve(true),
    };
    const erasedTurn = {
      chatId: crypto.randomUUID(),
      answerId: 1,
      personId: erased.userId,
      restricted: false,
      said: [
        { role: "user", text: `Where is ${word()}?` },
        { role: "assistant", text: "Floor 3." },
      ] as const,
    };
    await admin.api.members.remove(erased.userId);
    await admin.api.members.erase(erased.userId, String(erased.person.name));

    // Skipped, not refused: a refusal always logs its line, so false
    // with no line is the erasure's skip.
    const { value: handedOver, lines } = await logsOf(async () => [
      await handOverRun(env, erasedRun),
      await handOverRun(env, keptRun),
      await handOverUpload(env, erasedUpload),
      await handOverChatTurn(env, erasedTurn),
    ]);

    expect({
      handedOver,
      refused: lines.filter((line) => line.includes("brain.source_refused")),
      kept: await recalledVersions(kept.userId, result),
    }).toStrictEqual({
      handedOver: [false, true, false, false],
      refused: [],
      kept: [1],
    });
  });

  it("hands a chat over past a stored message it can't read", async () => {
    const member = await signedInApi(idp, "user");
    const stub = workspace(env, personalWorkspaceId(member.userId));
    const chat = await member.api.chats.create("Questions");
    const id = chatIdSchema.parse(chat.id);
    const [first, second] = [word(), word()];
    const firstAnswer = await stub.keepTurnMessages(id, [
      { entryId: 1, message: question("Where?") },
      { entryId: 2, message: answer(`Floor ${first}.`) },
    ]);
    await stub.captureTurn(id, capture(firstAnswer));
    await recalledVersions(member.userId, first);
    // A stored message that no longer parses, between the two turns.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO chat_messages (chat_id, message, created_at) VALUES (?, ?, ?)",
        id,
        "{not json",
        Date.now()
      );
    });

    const secondAnswer = await stub.keepTurnMessages(id, [
      { entryId: 3, message: question("And then?") },
      { entryId: 4, message: answer(`Room ${second}.`) },
    ]);
    await stub.captureTurn(id, capture(secondAnswer));
    const versions = await recalledVersions(member.userId, second);
    const handed = await versionOf(member.userId, { producer: "chat", id }, 2);

    expect({
      versions,
      firstInText: handed?.text.includes(first),
      malformedInText: handed?.text.includes("not json"),
    }).toStrictEqual({
      versions: [2],
      firstInText: true,
      malformedInText: false,
    });
  });

  it("keeps a chat's later answer current when two turns' captures arrive back to back", async () => {
    const member = await signedInApi(idp, "user");
    const stub = workspace(env, personalWorkspaceId(member.userId));
    const chat = await member.api.chats.create("Questions");
    const id = chatIdSchema.parse(chat.id);
    const source: SourceRef = { producer: "chat", id };
    const [first, second, third] = [word(), word(), word()];
    const firstAnswer = await stub.keepTurnMessages(id, [
      { entryId: 1, message: question("Where?") },
      { entryId: 2, message: answer(`Floor ${first}.`) },
    ]);
    const secondAnswer = await stub.keepTurnMessages(id, [
      { entryId: 3, message: question("And then?") },
      { entryId: 4, message: answer(`Room ${second}.`) },
    ]);
    // Both captures delivered with nothing awaited between them, so their
    // hand-overs are under way together: the earlier one, landing last,
    // would put the older conversation on top.
    await Promise.all([
      stub.captureTurn(id, capture(firstAnswer)),
      stub.captureTurn(id, capture(secondAnswer)),
    ]);
    const [secondVersion = 0] = await recalledVersions(member.userId, second);
    // A third turn's, handed over after them: once that is the chat's,
    // every hand-over before it has landed.
    const thirdAnswer = await stub.keepTurnMessages(id, [
      { entryId: 5, message: question("And last?") },
      { entryId: 6, message: answer(`Desk ${third}.`) },
    ]);
    await stub.captureTurn(id, capture(thirdAnswer));
    const [thirdVersion = 0] = await recalledVersions(member.userId, third);
    const texts = await Promise.all(
      Array.from({ length: thirdVersion }, async (_, index) => {
        const version = await versionOf(member.userId, source, index + 1);
        return version?.text ?? "";
      })
    );

    expect({
      thirdAfterSecond: thirdVersion === secondVersion + 1,
      onlyFirstAfterSecond: texts
        .slice(secondVersion)
        .some((text) => text.includes(first) && !text.includes(second)),
      secondInItsVersion: texts[secondVersion - 1]?.includes(second),
      past: await versionOf(member.userId, source, thirdVersion + 1),
    }).toStrictEqual({
      thirdAfterSecond: true,
      onlyFirstAfterSecond: false,
      secondInItsVersion: true,
      past: null,
    });
  });

  it("hands over all of an answer longer than what a search looks through", async () => {
    const member = await signedInApi(idp, "user");
    const stub = workspace(env, personalWorkspaceId(member.userId));
    const chat = await member.api.chats.create("Questions");
    const id = chatIdSchema.parse(chat.id);
    const closing = word();
    // Past the 100,000 characters a search keeps of one message
    // (`saidMax`), its one marker near its end.
    const long = `${"lorem ".repeat(17_000)}Closing ${closing}.`;
    const answerId = await stub.keepTurnMessages(id, [
      { entryId: 1, message: question("Tell me everything.") },
      { entryId: 2, message: answer(long) },
    ]);

    await stub.captureTurn(id, capture(answerId));

    expect({
      long: long.length > 100_000,
      versions: await recalledVersions(member.userId, closing),
    }).toStrictEqual({ long: true, versions: [1] });
  });

  it("hands over a long chat's latest messages, leaving out its oldest past the Brain's bound", async () => {
    const member = await signedInApi(idp, "user");
    const stub = workspace(env, personalWorkspaceId(member.userId));
    const chat = await member.api.chats.create("Questions");
    const id = chatIdSchema.parse(chat.id);
    const [oldest, kept, latest] = [word(), word(), word()];
    await stub.keepTurnMessages(id, [
      { entryId: 1, message: question("Where?") },
      { entryId: 2, message: answer(`Floor ${oldest}.`) },
    ]);
    // 25 more turns of 42,000 characters each: more than the 900,000
    // bytes the chat's text keeps, and more messages than one read takes.
    // Turn 5 on fits it, 42 messages; turn 4 on is past it.
    const filler = "lorem ".repeat(7000);
    const turns = 25;
    const answerId = await stub.keepTurnMessages(
      id,
      Array.from({ length: turns }, (_, index) => {
        const turn = index + 1;
        const marker = { 5: kept, [turns]: latest }[turn] ?? "";
        return [
          { entryId: 2 * turn + 1, message: question("Next?") },
          {
            entryId: 2 * turn + 2,
            message: answer(`Turn ${turn} ${marker} ${filler}`),
          },
        ];
      }).flat()
    );

    await stub.captureTurn(id, capture(answerId));
    const versions = await recalledVersions(member.userId, latest);
    const handed = await versionOf(member.userId, { producer: "chat", id }, 1);
    const text = handed?.text ?? "";

    expect({
      versions,
      latest: text.includes(latest),
      kept: text.includes(kept),
      oldest: text.includes(oldest),
      fits: new TextEncoder().encode(text).byteLength <= 900_000,
    }).toStrictEqual({
      versions: [1],
      latest: true,
      kept: true,
      oldest: false,
      fits: true,
    });
  });
});
