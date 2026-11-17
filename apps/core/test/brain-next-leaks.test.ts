import {
  brainOf,
  exactCandidatesMax,
  onlyInOwnStore,
  personalBrainOf,
  recallBudgetMax,
} from "@grasp-os/brain-next/contract";
import type { Access } from "@grasp-os/brain-next/contract";
import { brainUploadReadersSchema } from "@grasp-os/shared/brain-sources";
import type { BrainUploadReaders } from "@grasp-os/shared/brain-sources";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { organizationId } from "../src/auth/auth.ts";
import { memberOf } from "../src/auth/identity.ts";
import { handOverProducers } from "../src/brain-hand-overs.ts";
import {
  brainExportsPath,
  brainRestorePath,
} from "../src/brain-next-exports.ts";
import {
  addInstructionFile,
  addSource,
  brainExportFile,
  brainExportStatus,
  brainStaffReport,
  eraseSource,
  erasePerson,
  listVersionsAs,
  memoriesAs,
  readableMemoriesAs,
  readSourceVersionAs,
  recallAs,
  rememberAs,
  startBrainExport,
  versionRefSchema,
  workBrain,
} from "../src/brain-next.ts";
import type {
  InstructionFile,
  Said,
  SourceReaders,
  SourceRef,
} from "../src/brain-next.ts";
import { removeLostRunSources } from "../src/brain-run-sources.ts";
import { selectSkillsFor } from "../src/brain-skills.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import {
  answerCaptureIdOf,
  captureIdOf,
} from "../src/connection-capture-key.ts";
import { captureRead } from "../src/connection-capture.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { instructionFilesFor } from "../src/instruction-files.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import {
  shareWorkflowResource,
  unshareWorkflowResource,
} from "../src/workflow-members.ts";
import { codeStep, says, toolStep } from "./agent-chat.ts";
import { published, requestGranted } from "./apps.ts";
import { brainModules } from "./brain-next-modules.ts";
import {
  asIfOlderLate,
  asIfOlderVersion,
  caughtUp,
  companyMemorySurfaces,
  contestedInRecall,
  currentIn,
  inStoreOf,
  judged,
  memorySurfaces,
  midPass,
  newWorld,
  outWord,
  ownMemorySurfaces,
  outReadsOf,
  remember,
  tablesHolding,
  transcriptOf,
  shownIn,
  textHolding,
  tick,
  unlikeTwin,
  wordRulesOf,
  writesOf,
} from "./brain-next-out-reads.ts";
import type { OutWorld } from "./brain-next-out-reads.ts";
import { ageOwnErasure } from "./brain-next-own-store.ts";
import { copyOfStore, restoreStore } from "./brain-next-store-copy.ts";
import type { StoreCopy } from "./brain-next-store-copy.ts";
import { brainSurfaces, membersOf, textOf } from "./brain-next-surfaces.ts";
import type { Answer, Probe, Probing } from "./brain-next-surfaces.ts";
import { chatIdsOf, codeStepTrace } from "./code-step-trace.ts";
import { mockIdp } from "./idp.ts";
import { addedSharedFile, saveInstructions } from "./instruction-saves.ts";
import {
  approveAgreed,
  onLink,
  openLinkAs,
  signedInAs,
} from "./interview-link.ts";
import { answeringProvider, testModel } from "./model-provider.ts";
import { noProducers } from "./no-producers.ts";
import { carrying } from "./platform-providers.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi, signedInWithRole, unique } from "./sign-in.ts";
import { holdsNothing } from "./stored-skills.ts";
import {
  member as teamsMember,
  memberAnsweredBy,
  mentionIn,
  messageFrom,
  newGroup,
  onGroupRoster,
  post,
  reached,
  teamsPerson,
  watched as teamsWatched,
} from "./teams-door.ts";
import { connectDb } from "./test-env.ts";
import {
  definitionOf,
  ended,
  published as publishedWorkflow,
  start,
} from "./workflow-resource-runs-harness.ts";

// The marker test (GRA-1722): the gate every later Brain issue keeps
// green. Unique marker words are planted in sources a reader may not
// read: someone else's own, a team's they aren't in, one nobody is known
// to read, and the first version of one whose readers changed: narrowed
// away from the outsider (they could read that version, and no longer
// can), and so widened to the holder, who may read its current version
// but was never among the first one's readers. Then every surface (brain-next-surfaces.ts) is called as
// that reader, every way it answers, and:
//
// - no marker may be in anything that comes back (results, "nothing
//   found", every part of an error), in a console line written meanwhile,
//   or in any request that reached a model provider;
// - what the reader gets asking only of what they may not read must be
//   exactly what they get asking of words nothing holds, so no count,
//   note or field can tell hidden matches exist.
//
// The same runs again across a change in membership, which counts from
// the very next recall, and as a reader of everything but the source
// nobody may read.

const idp = mockIdp();

/** The Brain's one store, as the test reads what extraction drew. */
const brainStore = () =>
  inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/** Words said now by `by`, to draw memories from first. */
const saidNow = (by: Said["by"]): Said => ({
  by,
  at: new Date(),
  priority: "asked",
});
teamsWatched();

/** A chat's agent acting for `personId`. */
const agentFor = (personId: string) =>
  authoritySchema.parse({
    subject: { type: "agent", agentId: `agent-${unique()}` },
    onBehalfOf: personId,
    mode: "interactive",
  });

let chatAgentGrant: Promise<unknown> | undefined;

/**
 * Grants the chat agent the Brain permission, once for the file: its
 * binding name can be granted only once.
 */
const chatAgentReadsBrain = async (): Promise<void> => {
  chatAgentGrant ??= (async () =>
    await requestGranted(idp, await signedInApi(idp, "admin"), {
      subject: { type: "agent", agentId: chatAgentId },
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    }))();
  await chatAgentGrant;
};

/**
 * Every producer core hands sources to the Brain through, from core's own
 * lists: each kind a source's key may have (brain-next.ts `producerKinds`,
 * as `versionRefSchema` takes it) and each producer whose hand-overs core
 * relays (brain-hand-overs.ts), an upload once for each choice of its
 * readers. A new one is planted in the world the reader passes read, or
 * the file fails naming it.
 */
const producerNames = (): string[] =>
  [
    ...new Set<string>([
      ...versionRefSchema.shape.source.shape.producer.options,
      ...Object.keys(handOverProducers),
    ]),
  ].flatMap((kind) =>
    kind === "upload"
      ? brainUploadReadersSchema.options.map(
          ({ shape }) => `upload for ${shape.kind.value}`
        )
      : [kind]
  );

/**
 * A word nothing else holds: 64 random bits. Short, as a pass asks every
 * marker it may not read at once, in a question and in a name of the
 * memory probes' fixture (brain-next-surfaces.ts), each with its limit.
 */
const markerWord = (): string =>
  `m${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

/** Something a pass found that it may not. */
interface Finding {
  /** Who was reading. */
  pass: string;
  /** Where: a surface's answers, the logs, or the model prompts. */
  in: string;
  /** What: the marker found (by the source it was planted in), or why. */
  found: string;
}

/** The markers of `forbidden` that `found` holds, by name. */
const markersIn = (
  found: unknown,
  forbidden: Readonly<Record<string, string>>
): string[] => {
  const text = textOf(found).toLowerCase();
  return Object.entries(forbidden)
    .filter(([, marker]) => text.includes(marker))
    .map(([name]) => name);
};

/** Whether `name` is a method of the console. */
const isConsoleMethod = (name: string): name is keyof Console =>
  /^[a-z]/u.test(name) && typeof Reflect.get(console, name) === "function";

/** Every console line written while `run` runs, and what it returned. */
const logsOf = async <T>(
  run: () => Promise<T>
): Promise<{ value: T; lines: unknown[] }> => {
  const lines: unknown[] = [];
  // Every method the console has, so a way of writing added later is read
  // too.
  const spies = Object.getOwnPropertyNames(console)
    .filter(isConsoleMethod)
    .map((name) =>
      vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      })
    );
  try {
    return { value: await run(), lines };
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
};

/** Every member of every surface, by name, with its probe. */
const surfaces: [string, Probe][] = brainSurfaces.flatMap(({ name, probes }) =>
  Object.entries(probes).map(([member, probe]): [string, Probe] => [
    `${name} ${member}`,
    probe,
  ])
);

/**
 * What a surface's answers give away: a forbidden marker, a hidden-only
 * answer unlike its answer to words nothing holds, or no answer worth the
 * name (a probe that calls nothing, or only ever gets errors, covers
 * nothing).
 */
const findingsIn = (
  answers: readonly Answer[],
  forbidden: Readonly<Record<string, string>>
): string[] => {
  // Each hidden answer against the nothing answer of its comparison.
  const nothingOf = (like: string | undefined) =>
    answers.find((one) => one.about === "nothing" && one.like === like);
  const unlike = answers.flatMap(({ about, got, call, like }) => {
    const nothing = nothingOf(like);
    return about === "hidden" && textOf(got) !== textOf(nothing?.got)
      ? [
          `"${call}" answered ${textOf(got)}, unlike "${nothing?.call}": ${textOf(nothing?.got)}`,
        ]
      : [];
  });
  const thin = answers.some(({ got }) => "value" in got)
    ? []
    : ["no call answered"];
  return [...markersIn(answers, forbidden), ...unlike, ...thin];
};

/**
 * The surfaces that read what the Brain holds, as a member: those probed
 * as a team-mate and an admin besides the full passes.
 */
const readingSurfaces = new Set([
  "core recallAs",
  "core recallOwnedAs",
  "core readSourceVersionAs",
  "core readInstructionFilesAs",
  "core brainStaffReport",
  "core listSourcesAs",
  "core listVersionsAs",
  "sources list",
  "sources versions",
  "sources read",
  "sources search",
  "core entitiesAs",
  "core memoriesAs",
  "core contestedAs",
  "core ownEntityAs",
  "core ownEntityIdAs",
  "memoriesRpc entities",
  "memoriesRpc memories",
  "memoriesRpc contested",
  "store listSources",
  "store listVersions",
  "store recall",
  "store find",
  "store readVersion",
  "store readCurrent",
  "store searchVectors",
  "store readMemories",
  "store readableMemories",
  "store findEntities",
  "store readEntityNames",
  "store readEntity",
  "store ownEntity",
  "store readCard",
  "store findPassages",
  "store listContested",
  "store readableVersions",
  "store changeVersion",
  "core recallPassagesAs",
  "core readableVersionsAs",
  "core readableMemoriesAs",
]);

/** The reading surfaces' probes: every reader's pass goes through them. */
const reading = surfaces.filter(([name]) => readingSurfaces.has(name));

/** The surfaces that recall, where no instruction file may ever show. */
const recallSurfaces = new Set([
  "core recallAs",
  "core recallOwnedAs",
  "core recallPassagesAs",
  "store recall",
  "store findPassages",
  "recall recallFor",
]);

/**
 * Calls every surface (or those `among`) as `probing`'s reader; what they
 * gave away, in their answers or in the console. `inRecall` is forbidden
 * in what the recall surfaces answer too: instruction files, which no
 * recall finds, the reader's own included.
 */
const findingsOf = async (
  pass: string,
  probing: Probing,
  forbidden: Readonly<Record<string, string>>,
  {
    among = surfaces,
    inRecall = {},
  }: {
    among?: readonly [string, Probe][];
    inRecall?: Readonly<Record<string, string>>;
  } = {}
): Promise<Finding[]> => {
  const { value: answered, lines } = await logsOf(async () => {
    const found: [string, Answer[]][] = [];
    for (const [name, probe] of among) {
      // oxlint-disable-next-line no-await-in-loop -- one surface at a time
      found.push([name, await probe(probing)]);
    }
    return found;
  });
  return [
    ...answered.flatMap(([name, answers]) =>
      findingsIn(
        answers,
        recallSurfaces.has(name) ? { ...forbidden, ...inRecall } : forbidden
      ).map((found) => ({ pass, in: name, found }))
    ),
    ...markersIn(lines, forbidden).map((found) => ({
      pass,
      in: "logs",
      found,
    })),
  ];
};

/**
 * The names of the Brain's stores core addressed while `run` ran (the
 * shared one, `brain`, and a person's own, `person:<id>`), and what it
 * returned: through the binding itself, so no way core names a store
 * goes unseen.
 */
const addressedBy = async <T>(
  run: () => Promise<T>
): Promise<{ value: T; names: string[] }> => {
  const binding = env.BRAIN_STORE;
  const byName = vi.spyOn(binding, "getByName");
  const idsByName = vi.spyOn(binding, "idFromName");
  const byId = vi.spyOn(binding, "get");
  try {
    const value = await run();
    return {
      value,
      names: [
        ...byName.mock.calls.map(([name]) => name),
        ...idsByName.mock.calls.map(([name]) => name),
        ...byId.mock.calls.map(([id]) => id.name ?? `id:${String(id)}`),
      ],
    };
  } finally {
    byName.mockRestore();
    idsByName.mockRestore();
    byId.mockRestore();
  }
};

/**
 * What `findingsOf` found, and every store core addressed while it ran
 * (`addressedBy`).
 */
const watched = async (
  ...args: Parameters<typeof findingsOf>
): Promise<{ findings: Finding[]; addressed: string[] }> => {
  const { value: findings, names } = await addressedBy(
    async () => await findingsOf(...args)
  );
  return { findings, addressed: names };
};

/**
 * The markers of `markers` that any request any model provider has got so
 * far carried, whoever's key it carried, past the `before` requests that
 * carried each (by name) before: as found by `pass`, the pass that ran
 * last.
 */
const promptedWith = async (
  pass: string,
  markers: Readonly<Record<string, string>>,
  before: Readonly<Record<string, number>> = {}
): Promise<Finding[]> => {
  const prompted: Finding[] = [];
  for (const [name, marker] of Object.entries(markers)) {
    // oxlint-disable-next-line no-await-in-loop -- one marker at a time
    const carried = await carrying(marker);
    if (carried.length > (before[name] ?? 0)) {
      prompted.push({ pass, in: "model prompts", found: name });
    }
  }
  return prompted;
};

/** `person`'s own store, as core names it. */
const ownStoreOf = (person: string) =>
  inJurisdiction(env, env.BRAIN_STORE).getByName(`person:${person}`);

const join = async (teamId: string, userId: string): Promise<void> => {
  await drizzle(env.DB)
    .insert(teamMembers)
    .values({ id: crypto.randomUUID(), teamId, userId, createdAt: new Date() });
};

const leave = async (teamId: string, userId: string): Promise<void> => {
  await drizzle(env.DB)
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
};

/** A team of the organization, with `members`. */
const newTeam = async (...members: string[]): Promise<string> => {
  const id = crypto.randomUUID();
  await drizzle(env.DB)
    .insert(teams)
    .values({ id, name: `Team ${id}`, organizationId, createdAt: new Date() });
  for (const userId of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await join(id, userId);
  }
  return id;
};

/**
 * Every version of `sources` a probe asks of: the first three, those past
 * a source's last as missing as any.
 */
const everyVersionOf = (...sources: SourceRef[]) =>
  sources.flatMap((source) =>
    [1, 2, 3].map((version) => ({ source, version }))
  );

/** The shared store, as core reaches it. */
const sharedStore = () =>
  inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/**
 * A request of core's own page as the admin signed in on `cookie`: its
 * answer's JSON, whose `state` it holds.
 */
const adminRequest = async (
  cookie: string,
  path: string,
  body?: unknown
): Promise<{ id?: string; state?: string }> => {
  const response = await routed(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return z
    .looseObject({ id: z.string().optional(), state: z.string().optional() })
    .parse(await response.json());
};

/** Ticks the Brain until `path` no longer answers `state`: at most 20 ticks. */
const tickedPast = async (
  cookie: string,
  path: string,
  state: string
): Promise<string | undefined> => {
  for (let ticks = 0; ticks < 20; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await workBrain(env, new Date(), noProducers);
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const status = await adminRequest(cookie, path);
    if (status.state !== state) {
      return status.state;
    }
  }
  throw new Error(`Still ${state} after 20 ticks`);
};

/** A source of its own, as an upload names it. */
const newSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

/** Adds `text` as a version of `source` (a new one by default). */
/**
 * A staff-list team of seven who each told their own work and agreed to
 * it, the first of them signed in as `cookie` at `address`: so core counts
 * them in the team's group, which a team claim is read by (GRA-1741), as
 * the onboarding says at each read. No model is asked anything. Its id.
 */
const interviewedTeam = async (
  address: string,
  cookie: string
): Promise<string> => {
  const store = onboardingStore(env);
  const team = `roster-${unique()}`;
  const people = Array.from({ length: 7 }, (_, at) => ({
    id: `teller-${at}-${unique()}`,
    email: at === 0 ? address : `teller-${unique()}@acme.test`,
  }));
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(
    {
      teams: [{ id: team, name: "Desk", lead: null, does: "", off: false }],
      people: people.map(({ id, email }) => ({
        id,
        name: "Teller",
        team,
        email,
        title: "",
        away: false,
      })),
    },
    by
  );
  await store.savePlan(
    {
      start: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      days: 14,
    },
    by
  );
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const cookies = await Promise.all(
    people.map(async ({ email }, at) =>
      at === 0 ? cookie : await signedInAs(email)
    )
  );
  for (const [at, { id }] of people.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- one interview at a time
    const secret = ((await store.linkOf(id)) ?? "").split("#")[1] ?? "";
    // oxlint-disable-next-line no-await-in-loop -- one interview at a time
    const { link } = await openLinkAs(secret, cookies[at] ?? "");
    const facts = [
      {
        id: "t1",
        tag: "step" as const,
        text: "You answer the phone.",
        record: "Answers the phone.",
        agreed: true as const,
      },
    ];
    // oxlint-disable-next-line no-await-in-loop -- one interview at a time
    await onLink({
      action: "save",
      ...link,
      version: 0,
      progress: {
        person: "completed",
        told: true,
        mode: "type",
        lines: [{ from: "stephen", text: "What do you do first?" }],
        facts,
        phase: "readback",
        wants: "end",
        startedAt: Date.now(),
        confirmed: facts.length,
        adding: false,
        addedAt: 0,
      },
    });
    // oxlint-disable-next-line no-await-in-loop -- one interview at a time
    await approveAgreed(link, facts);
  }
  return team;
};

const add = async (
  text: string,
  readers: SourceReaders,
  source: SourceRef = newSource()
): Promise<SourceRef> => {
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
  return source;
};

/** The trigger that holds the shared store's erasures (`whileErasureHeld`). */
const heldErasures = "leaks_test_holds_erasures";

/**
 * Runs `run` while the shared store's erasures are held part-way: an
 * erasure hides what it covers and returns, and every deletion of a
 * version fails, in the erasure's own batch and in each tick's, so what
 * it hid stays stored and hidden (erasure.ts) until a tick after `run`.
 */
const whileErasureHeld = async (run: () => Promise<void>): Promise<void> => {
  await runInDurableObject(sharedStore(), (_store, state) => {
    state.storage.sql.exec(
      `CREATE TRIGGER IF NOT EXISTS ${heldErasures} BEFORE DELETE ON source_versions
      BEGIN SELECT RAISE(ABORT, 'held by the test'); END`
    );
  });
  try {
    await run();
  } finally {
    await runInDurableObject(sharedStore(), (_store, state) => {
      state.storage.sql.exec(`DROP TRIGGER IF EXISTS ${heldErasures}`);
    });
  }
};

/** Whether the shared store has an erasure recorded and not yet done. */
const erasureUnfinished = async (): Promise<boolean> => {
  const { erasing } = await sharedStore().workOverview();
  return erasing > 0;
};

/** What a read answered: its value, or its error's message. */
const answerOf = async (read: () => Promise<unknown>): Promise<string> => {
  try {
    return textOf(await read());
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * `read` of what an erasure covers (`true`) against `read` of what no one
 * added (`false`): "as if never added" when they answer alike, else what
 * the first answered.
 */
const asIfNeverAdded = async (
  read: (erased: boolean) => Promise<unknown>
): Promise<string> => {
  const erased = await answerOf(async () => await read(true));
  const missing = await answerOf(async () => await read(false));
  return erased === missing ? "as if never added" : erased;
};

/** What the holder's producers planted in the reader passes' world. */
interface HoldersProduced {
  ownUploadMarker: string;
  captureMarker: string;
  toolkitCaptureMarker: string;
  runMarker: string;
  askedMarker: string;
  answerMarker: string;
  ownUpload: SourceRef;
  captureId: SourceRef;
  toolkitCaptureId: SourceRef;
  runSource: SourceRef;
  turnSource: SourceRef;
}

/**
 * What the holder's producers planted for the holder alone (an upload for
 * only them, what their agent fetched, their run and their chat's turn):
 * its markers, by name, and its sources. Kept in their own store, so no
 * one else, and no recall of theirs that leaves that store out, may read
 * any of it.
 */
const holdersOwnProduced = (world: HoldersProduced) => {
  const forbidden = {
    "the holder's upload for only them": world.ownUploadMarker,
    "what the holder's agent fetched through a connection": world.captureMarker,
    "what the holder's agent fetched through a toolkit":
      world.toolkitCaptureMarker,
    "the holder's run": world.runMarker,
    "a question in the holder's chat": world.askedMarker,
    "an answer in the holder's chat": world.answerMarker,
  };
  return {
    forbidden,
    markers: Object.values(forbidden),
    sources: [
      world.ownUpload,
      world.captureId,
      world.toolkitCaptureId,
      world.runSource,
      world.turnSource,
    ],
  };
};

/** What `personId` recalls for `question`: each chunk's text. */
const textsFor = async (
  personId: string,
  question: string
): Promise<string[]> => {
  const { items } = await recallAs(env, personId, {
    personal: true,
    question,
    budget: { tokens: recallBudgetMax },
  });
  return items.map(({ text }) => text);
};

describe(
  "the new Brain leaks nothing to a reader without access",
  { timeout: 120_000 },
  () => {
    /** The shared store before any test of this file added to it: empty. */
    let emptyStore: StoreCopy = { tables: [], triggers: [] };

    beforeAll(async () => {
      emptyStore = await copyOfStore();
    });

    it("has a probe for every member of every surface, and a surface for every module that reaches the Brain", () => {
      const names = new Set<string>(brainSurfaces.map(({ name }) => name));
      // Core's module and the store are the Brain itself; every module the
      // lint config lets import core's module names its own surface.
      const reaching: [string, string][] = [
        ["apps/core/src/brain-next.ts", "core"],
        ["BrainStore", "store"],
        ...Object.entries(brainModules),
      ];

      expect({
        // Pairs, not an object: two surfaces of one name are both compared.
        members: brainSurfaces.map(({ name, module }) => [
          name,
          membersOf(module).toSorted(),
        ]),
        unprobed: reaching.filter(([, name]) => !names.has(name)),
        // A member the passes below single out is one: a name of none
        // would leave it out of a reader's pass without a word.
        singledOut: [...readingSurfaces, ...recallSurfaces].filter(
          (name) => !surfaces.some(([member]) => member === name)
        ),
      }).toStrictEqual({
        members: brainSurfaces.map(({ name, probes }) => [
          name,
          Object.keys(probes).toSorted(),
        ]),
        unprobed: [],
        singledOut: [],
      });
    });

    /**
     * The world the reader passes below read: markers planted where the
     * outsider (and some where the holder) may not read them. Planted once
     * for the file, by whichever of the passes runs first
     * (`plantedWorld`), so each pass is a test of its own, with its own
     * time, and a failure names the reader whose pass found something.
     */
    const plantWorld = async () => {
      // A provider is connected, so anything that prompts a model reaches
      // the providers stub, which keeps every request it gets.
      await answeringProvider(() => {});
      // The holder builds Apps, so they can make the outsider a user of
      // two.
      const [holderApi, { userId: outsider }] = await Promise.all([
        signedInApi(idp, "builder"),
        signedInWithRole(idp, "user"),
      ]);
      const holder = holderApi.userId;
      const secretTeam = await newTeam(holder);
      const ownTeam = await newTeam(outsider);
      const sharedWord = `s${unique()}`;
      const markers = {
        "the holder's own source": markerWord(),
        "a team's source the outsider isn't in": markerWord(),
        "a source nobody is known to read": markerWord(),
        "a staff-list team's claim": markerWord(),
        "the holder's interview": markerWord(),
        "a source narrowed away from the outsider": markerWord(),
        "a source narrowed to the holder alone": markerWord(),
        "the holder's instruction file": markerWord(),
        "another agent's instruction file": markerWord(),
        "an App's instruction file the outsider doesn't build": markerWord(),
        "an App's instruction file the outsider uses": markerWord(),
        "the holder's upload for only them": markerWord(),
        "an upload for a team the outsider isn't in": markerWord(),
        "what the holder's agent fetched through a connection": markerWord(),
        "what the holder's agent fetched through a toolkit": markerWord(),
        "the holder's own skill": markerWord(),
        "a team's skill the outsider isn't in": markerWord(),
        "the holder's run": markerWord(),
        "a question in the holder's chat": markerWord(),
        "an answer in the holder's chat": markerWord(),
      };
      // What every member may read, and nobody outside the company.
      const companyMarkers = {
        "an upload for everyone": markerWord(),
        "the company's vision from the kickoff": markerWord(),
      };
      const {
        "an upload for everyone": everyoneUploadMarker,
        "the company's vision from the kickoff": kickoffMarker,
      } = companyMarkers;
      const {
        "the holder's own source": ownerMarker,
        "a team's source the outsider isn't in": teamMarker,
        "a source nobody is known to read": noneMarker,
        "a staff-list team's claim": claimMarker,
        "the holder's interview": interviewMarker,
        "a source narrowed away from the outsider": narrowedMarker,
        "a source narrowed to the holder alone": toHolderMarker,
        "the holder's instruction file": holderFileMarker,
        "another agent's instruction file": agentFileMarker,
        "an App's instruction file the outsider doesn't build": appFileMarker,
        "an App's instruction file the outsider uses": usedAppFileMarker,
        "the holder's upload for only them": ownUploadMarker,
        "an upload for a team the outsider isn't in": teamUploadMarker,
        "what the holder's agent fetched through a connection": captureMarker,
        "what the holder's agent fetched through a toolkit":
          toolkitCaptureMarker,
        "the holder's own skill": holderSkillMarker,
        "a team's skill the outsider isn't in": teamSkillMarker,
        "the holder's run": runMarker,
        "a question in the holder's chat": askedMarker,
        "an answer in the holder's chat": answerMarker,
      } = markers;
      // Instruction files the outsider may not get: the holder's own,
      // another agent's than theirs, and an App's they don't build (one no
      // one made, so no one builds it).
      const holderFile: InstructionFile = { scope: "person", personId: holder };
      const agentFile: InstructionFile = {
        scope: "agent",
        agentId: `agent-${unique()}`,
      };
      const appFile: InstructionFile = {
        scope: "app",
        appId: crypto.randomUUID(),
      };
      // Two Apps the holder builds and the outsider uses, through core's
      // own records: one with a file, one without. A file is for an App's
      // builders, so the outsider gets neither.
      const { id: withFile } = await holderApi.api.apps.create({
        name: "Desk",
      });
      const { id: withoutFile } = await holderApi.api.apps.create({
        name: "Ledger",
      });
      for (const appId of [withFile, withoutFile]) {
        // Published, so its users may open it: a draft is its builders'.
        // oxlint-disable-next-line no-await-in-loop -- one App at a time
        await published(appId);
        // oxlint-disable-next-line no-await-in-loop -- one App at a time
        await holderApi.api.apps.members.add(appId, {
          type: "person",
          id: outsider,
          role: "user",
        });
      }
      const usedApps = { withFile, withoutFile };
      const usedAppFile: InstructionFile = { scope: "app", appId: withFile };
      const usedAppText = `Instructions ${sharedWord} ${usedAppFileMarker}`;
      for (const [file, marker] of [
        [holderFile, holderFileMarker],
        [agentFile, agentFileMarker],
        [appFile, appFileMarker],
        [usedAppFile, usedAppFileMarker],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time
        await addInstructionFile(env, {
          file,
          change: crypto.randomUUID(),
          text: `Instructions ${sharedWord} ${marker}`,
          after: 0,
        });
      }
      const instructionMarkers = [
        holderFileMarker,
        agentFileMarker,
        appFileMarker,
        usedAppFileMarker,
      ];
      // The holder's own skill, named by its marker, written and asked to
      // be shared on the holder's own session: theirs alone, and the share
      // waits on admins, which the outsider isn't.
      const holderSkill = await holderApi.api.skills.save(
        `---\nname: ${holderSkillMarker}\ndescription: How to ${sharedWord} ${holderSkillMarker}\n---\nSteps ${sharedWord} ${holderSkillMarker}`
      );
      await holderApi.api.skills.share(
        holderSkill.name,
        holderSkill.version,
        "company"
      );
      // The holder's own chat lists it, and selects it for a task of it.
      await expect(
        selectSkillsFor(env, agentFor(holder), "person", holdsNothing, {
          task: holderSkillMarker,
        })
      ).resolves.toMatchObject([{ scope: "person", name: holderSkillMarker }]);
      // A skill of the holder's team, named by its marker: shared with the
      // team on the holder's session and approved by an admin, so the
      // team's members alone are given it.
      const deciderApi = await signedInApi(idp, "admin");
      const teamSkill = await holderApi.api.skills.save(
        `---\nname: ${teamSkillMarker}\ndescription: How to ${sharedWord} ${teamSkillMarker}\n---\nSteps ${sharedWord} ${teamSkillMarker}`
      );
      const teamShare = await holderApi.api.skills.share(
        teamSkill.name,
        teamSkill.version,
        { team: secretTeam }
      );
      await deciderApi.api.skills.approve(teamShare.id);
      /** The team skills `personId`'s agent selects for the team skill's task. */
      const teamSkillsOf = async (personId: string): Promise<string[]> => {
        const selected = await selectSkillsFor(
          env,
          agentFor(personId),
          "teams",
          holdsNothing,
          { task: teamSkillMarker }
        );
        return selected.flatMap((skill) =>
          skill.scope === "team" ? [`${skill.team}:${skill.name}`] : []
        );
      };
      const teamSkillSelected = {
        byTheHolder: await teamSkillsOf(holder),
        byTheOutsider: await teamSkillsOf(outsider),
      };
      // No recall ever finds an instruction file, a reader's own included.
      const inRecall = {
        "the holder's instruction file": holderFileMarker,
        "another agent's instruction file": agentFileMarker,
        "an App's instruction file the outsider doesn't build": appFileMarker,
        "an App's instruction file the outsider uses": usedAppFileMarker,
      };
      const instructionGroups = [
        "company",
        ...[withFile, withoutFile, appFile.appId].map((id) => `app:${id}`),
      ];
      const ownerIds = [
        await add(`Salary review ${sharedWord} ${ownerMarker}`, {
          kind: "owner",
          personId: holder,
        }),
      ];
      // Read in the holder's chat through their own Gmail and captured
      // as capture keeps it (connection-capture.ts): theirs alone, its
      // connection's ID holding a marker too, so a pack or a citation that
      // named it for anyone else would show it.
      const captureConnection = `connection-${captureMarker}`;
      const readAtNow = Date.now();
      await connectDb()
        .prepare(
          "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'google', 'personal', ?, 'active', 'native', 'google-workspace', ?, ?)"
        )
        .bind(captureConnection, holder, readAtNow, readAtNow)
        .run();
      const capturedItem = `quote-${captureMarker}`;
      await captureRead(
        env,
        {
          workspaceId: personalWorkspaceId(holder),
          agentId: chatAgentId,
          chatId: chatIdSchema.parse(crypto.randomUUID()),
          personId: holder,
          runId: crypto.randomUUID(),
        },
        captureConnection,
        "mail.get",
        { mailbox: `${holder}@acme.test`, message: capturedItem },
        {
          result: {
            output: JSON.stringify({
              message: {
                id: capturedItem,
                subject: `Supplier quote ${sharedWord} ${captureMarker}`,
              },
            }),
            provenance: [capturedItem],
            keep: true,
          },
          readAt: new Date(readAtNow),
        }
      );
      const captureId: SourceRef = {
        producer: "capture",
        id: await captureIdOf(
          captureConnection,
          holder,
          "mail.get",
          capturedItem
        ),
      };
      // Read in the holder's chat through their own toolkit connection,
      // whose server names no item: its whole answer one source, keyed by
      // the call (connection-capture.ts, GRA-1845), theirs alone, its
      // connection's ID holding a marker too.
      const toolkitConnection = `connection-${toolkitCaptureMarker}`;
      await connectDb()
        .prepare(
          "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tools, created_at, updated_at) VALUES (?, 'mail_own', 'personal', ?, 'active', 'composio', 'https://mail.test/mcp', ?, ?, ?)"
        )
        .bind(
          toolkitConnection,
          holder,
          JSON.stringify([{ name: "mail.search", read: true }]),
          readAtNow,
          readAtNow
        )
        .run();
      const toolkitCall = { query: `notes ${toolkitCaptureMarker}` };
      await captureRead(
        env,
        {
          workspaceId: personalWorkspaceId(holder),
          agentId: chatAgentId,
          chatId: chatIdSchema.parse(crypto.randomUUID()),
          personId: holder,
          runId: crypto.randomUUID(),
        },
        toolkitConnection,
        "mail.search",
        toolkitCall,
        {
          result: {
            output: JSON.stringify(
              `Supplier notes ${sharedWord} ${toolkitCaptureMarker}`
            ),
            provenance: ["mail_own/mail.search"],
            keep: true,
          },
          readAt: new Date(readAtNow),
        }
      );
      const toolkitCaptureId: SourceRef = {
        producer: "capture",
        id: await answerCaptureIdOf(
          toolkitConnection,
          holder,
          "mail.search",
          toolkitCall
        ),
      };
      const teamSource = `Board minutes ${sharedWord} ${teamMarker}`;
      const teamId = await add(teamSource, {
        kind: "team",
        teamId: secretTeam,
      });
      const noneId = await add(`Unfiled note ${sharedWord} ${noneMarker}`, {
        kind: "none",
      });
      // A claim five or more of a staff-list team made in their interviews
      // (GRA-1741), readable by that team's group alone: the holder told
      // their work in it, and no one else probing is in it.
      const rosterTeam = await interviewedTeam(
        String(holderApi.person.email),
        holderApi.session
      );
      const claimId = await add(
        `Team claim ${sharedWord} ${claimMarker}`,
        { kind: "interviews", teamId: rosterTeam },
        { producer: "claim", id: crypto.randomUUID() }
      );
      // The holder's interview (GRA-1790): what they approved in it, theirs
      // alone, as the onboarding hands it over.
      const interviewId = await add(
        `Every refund needs ${sharedWord} ${interviewMarker} first.`,
        { kind: "owner", personId: holder },
        { producer: "interview", id: crypto.randomUUID() }
      );
      ownerIds.push(interviewId);
      // More marked matches than a recall returns, each shorter than the
      // outsider's own, so hidden ones would crowd it out if they took
      // places.
      for (let index = 0; index <= 10; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one source at a time
        const id = await add(`${sharedWord} ${ownerMarker}`, {
          kind: "owner",
          personId: holder,
        });
        ownerIds.push(id);
      }
      // More hidden chunks holding a marker than the exact way checks of
      // a part: its cap counts only what the reader may read, so a marker
      // the reader asks for is still not found, as its twin is. They hold
      // an ID the outsider's own longer chunk holds too: ranked past the
      // hidden ones, it would be missed if the cap counted them.
      // An ID by the exact way's rule (exact.ts: a letter and two digits
      // or more), whatever the random part draws: eight hex characters
      // hold fewer than two digits about once in 180 draws, and then the
      // ID was a word, found "words" instead of "exact".
      const capId = `CAP-42-${unique()}`;
      for (let index = 0; index <= exactCandidatesMax; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one source at a time
        await add(`Copy ${index} ${ownerMarker} ${capId}`, {
          kind: "owner",
          personId: holder,
        });
      }
      const capped = `The outsider's own, much longer than any copy: ${capId}.`;
      await add(capped, { kind: "owner", personId: outsider });
      // The outsider's own source, with more earlier versions than a
      // recall returns, each holding the shared word and shorter than the
      // current one: superseded, they may neither show nor take its place.
      const handbookId = await add(`${sharedWord} draft 0`, {
        kind: "team",
        teamId: ownTeam,
      });
      for (let draft = 1; draft <= 11; draft += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one version at a time
        await add(
          `${sharedWord} draft ${draft}`,
          { kind: "team", teamId: ownTeam },
          handbookId
        );
      }
      const handbook = `The handbook for everyone who joins the team, ${sharedWord}`;
      await add(handbook, { kind: "team", teamId: ownTeam }, handbookId);
      // First for the outsider's own team, the marker in that version only;
      // then narrowed to a team of the holder alone. Its first version is neither
      // the outsider's now (taken off) nor ever the holder's (not among its
      // readers), though the holder reads the current one. A source keeps
      // its kind of readers, so both versions are in the shared store.
      // Added two hours ago, by a clock faked in this isolate, which the
      // store shares: the final version, added now, comes an hour after
      // `whileDraft` whatever the machine's speed. As of then, the
      // outsider was among the draft's readers, and is still, but not
      // among the current version's.
      const hourMs = 3_600_000;
      const draftAt = Date.now() - 2 * hourMs;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(draftAt);
      let narrowedId: SourceRef;
      try {
        narrowedId = await add(`Draft plan ${sharedWord} ${narrowedMarker}`, {
          kind: "team",
          teamId: ownTeam,
        });
      } finally {
        vi.useRealTimers();
      }
      const whileDraft = new Date(draftAt + hourMs);
      const holdersTeam = await newTeam(holder);
      await add(
        `Final plan ${sharedWord}`,
        { kind: "team", teamId: holdersTeam },
        narrowedId
      );
      // First for the outsider's own team, then narrowed to the holder
      // alone: refused, as a source keeps the readers it was first added
      // for, so the version for the holder alone is kept nowhere.
      const toHolder = await add("Shared plan for the quarter", {
        kind: "team",
        teamId: ownTeam,
      });
      const narrowedToHolder = await add(
        `Plan for the holder ${sharedWord} ${toHolderMarker}`,
        { kind: "owner", personId: holder },
        toHolder
      ).then(
        () => "added",
        () => "refused"
      );

      // Through the upload producer too (brain-uploads.ts): the holder's
      // file for only them, and one for a team the outsider isn't in,
      // each with its marker in its file's name as well as its text, as a
      // name is its readers' alone too (an admin's shared uploads).
      const uploaded = async (
        marker: string,
        readers: BrainUploadReaders,
        words = sharedWord
      ) => {
        const { source } = await holderApi.api.brainSources.upload(
          {
            name: `Captions ${marker}.vtt`,
            bytes: new TextEncoder().encode(
              `WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nUploaded ${words} ${marker}\n`
            ),
          },
          readers,
          crypto.randomUUID()
        );
        return source;
      };
      const ownUpload = await uploaded(ownUploadMarker, { kind: "me" });
      const teamUpload = await uploaded(teamUploadMarker, {
        kind: "team",
        teamId: secretTeam,
      });
      // And one for everyone, without the shared word: the outsider may
      // read it, and finds their own source by that word past the rest.
      const everyoneUpload = await uploaded(
        everyoneUploadMarker,
        { kind: "everyone" },
        "for everyone"
      );
      // The company's vision, as the onboarding hands its kickoff over
      // (GRA-1748): every member's, without the shared word.
      const kickoffSource = await add(
        `The company's vision ${kickoffMarker}`,
        { kind: "everyone" },
        { producer: "kickoff", id: crypto.randomUUID() }
      );

      // Through each producer core hands over (brain-hand-overs.ts), as it
      // does: a workflow run of the holder's that ended, and a turn of the
      // holder's own chat (GRA-1805), its question and answer both marked
      // (the question alone is kept). Each is the holder's alone.
      const holderMember = await memberOf(env.DB, holder);
      if (holderMember === undefined) {
        throw new Error("The holder is not a member");
      }
      const workflow = await publishedWorkflow(
        holderMember,
        definitionOf([], { value: { status: `${sharedWord} ${runMarker}` } })
      );
      const { runId } = await start(holderMember, workflow.id);
      await ended(holderMember, workflow.id, runId);
      const runSource: SourceRef = { producer: "run", id: runId ?? "" };
      await answeringProvider(() => says(`${sharedWord} ${answerMarker}`));
      const chat = await holderApi.api.chats.create("Questions");
      await workspace(env, personalWorkspaceId(holder)).ask(
        chatIdSchema.parse(chat.id),
        { text: `${sharedWord} ${askedMarker}?`, model: testModel }
      );
      await answeringProvider(() => {});
      // Each reaches the Brain once its outbox drained and its hand-over
      // was relayed and worked.
      const turn = await vi.waitFor(
        async () => {
          await drainAuditOutboxes(env);
          await relayHandOvers(env);
          await workBrain(env, new Date(), producersOf(env));
          const { items } = await recallAs(env, holder, {
            personal: true,
            question: askedMarker,
            budget: { tokens: recallBudgetMax },
          });
          const [found] = items;
          expect(found, "the chat's turn was never handed over").toBeDefined();
          await expect(
            textsFor(holder, runMarker),
            "the run was never handed over"
          ).resolves.toHaveLength(1);
          return found?.source;
        },
        { timeout: 15_000, interval: 200 }
      );
      const turnSource: SourceRef = turn ?? { producer: "chat", id: "" };

      // The markers are there to find for those who may read them.
      await expect(textsFor(holder, teamMarker)).resolves.toStrictEqual([
        teamSource,
      ]);
      await expect(textsFor(holder, teamUploadMarker)).resolves.toContainEqual(
        expect.stringContaining(teamUploadMarker)
      );
      await expect(
        textsFor(holder, `salary ${ownerMarker}`)
      ).resolves.toContain(`Salary review ${sharedWord} ${ownerMarker}`);
      // What the outsider finds by the shared word: their own source, past
      // the marked ones.
      const outsiderFinds = await textsFor(outsider, sharedWord);
      /** Whether `personId` finds the upload for everyone. */
      const findsEveryone = async (personId: string): Promise<boolean> => {
        const texts = await textsFor(personId, everyoneUploadMarker);
        return texts.some((text) => text.includes(everyoneUploadMarker));
      };
      // The holder's own recall finds what was captured for them.
      const holderTexts = await textsFor(holder, `supplier ${captureMarker}`);
      const holderFindsCapture = holderTexts.some((text) =>
        text.includes(captureMarker)
      );
      // And what their toolkit's answer was kept as, by its own key.
      const { items: toolkitItems } = await recallAs(env, holder, {
        personal: true,
        question: `notes ${toolkitCaptureMarker}`,
        budget: { tokens: recallBudgetMax },
      });
      const holderFindsToolkitCapture = toolkitItems.some(
        ({ source, text }) =>
          source.id === toolkitCaptureId.id &&
          text.includes(toolkitCaptureMarker)
      );
      // And by the ID the hidden copies share: their own chunk, as exact.
      const { items: cappedItems } = await recallAs(env, outsider, {
        personal: true,
        question: capId,
        budget: { tokens: recallBudgetMax },
      });
      const cappedFinds = cappedItems.map(({ text, found }) => ({
        text,
        found,
      }));

      const asOutsider = (groups: string[]): Probing => ({
        personId: outsider,
        reader: { person: outsider, groups: groups.map((id) => `team:${id}`) },
        personal: true,
        sharedWord,
        markers: [
          ownerMarker,
          interviewMarker,
          teamMarker,
          noneMarker,
          claimMarker,
          narrowedMarker,
          captureMarker,
          toolkitCaptureMarker,
          toHolderMarker,
          ...instructionMarkers,
          ownUploadMarker,
          teamUploadMarker,
          holderSkillMarker,
          teamSkillMarker,
          runMarker,
          askedMarker,
          answerMarker,
        ],
        hiddenVersions: everyVersionOf(
          ...ownerIds,
          teamId,
          noneId,
          claimId,
          narrowedId,
          ownUpload,
          teamUpload,
          captureId,
          toolkitCaptureId,
          runSource,
          turnSource
        ),
        hiddenUploads: [ownUpload.id, teamUpload.id],
        hiddenInstructionFiles: [holderFile, agentFile, appFile, usedAppFile],
        hiddenSkills: [holderSkillMarker],
        hiddenTeamSkills: [{ team: secretTeam, name: teamSkillMarker }],
        usedApps,
        instructionGroups,
        moments: [whileDraft],
        // Code's recall under an App grant naming the outsider's team and
        // the team they aren't in: the second's source stays hidden.
        codeTeams: [ownTeam, secretTeam],
      });
      // The holder builds the App, so its file is theirs to get.
      const holderAppFiles = await instructionFilesFor(
        env,
        authoritySchema.parse({
          subject: { type: "agent", agentId: `agent-${unique()}` },
          onBehalfOf: holder,
          mode: "interactive",
        }),
        { conversation: "own", appId: withFile, personal: true }
      );
      // Each producer (`producerNames`) and what was planted through it
      // above: the source, its marker by its name in `markers` or
      // `companyMarkers`, and someone who may read it.
      const plantedThrough: Readonly<
        Record<string, { marker: string; source: SourceRef; reader: string }>
      > = {
        "upload for me": {
          marker: "the holder's upload for only them",
          source: ownUpload,
          reader: holder,
        },
        "upload for team": {
          marker: "an upload for a team the outsider isn't in",
          source: teamUpload,
          reader: holder,
        },
        "upload for everyone": {
          marker: "an upload for everyone",
          source: everyoneUpload,
          reader: outsider,
        },
        capture: {
          marker: "what the holder's agent fetched through a connection",
          source: captureId,
          reader: holder,
        },
        run: { marker: "the holder's run", source: runSource, reader: holder },
        chat: {
          marker: "a question in the holder's chat",
          source: turnSource,
          reader: holder,
        },
        interview: {
          marker: "the holder's interview",
          source: interviewId,
          reader: holder,
        },
        claim: {
          marker: "a staff-list team's claim",
          source: claimId,
          reader: holder,
        },
        kickoff: {
          marker: "the company's vision from the kickoff",
          source: kickoffSource,
          reader: outsider,
        },
      };
      // The model prompts that carried each marker while the world was
      // planted, by the marker's name: the first test holds them to the
      // holder's own chat, and each pass fails on any prompt after.
      const promptedAtPlanting = Object.fromEntries(
        await Promise.all(
          Object.entries({ ...markers, ...companyMarkers }).map(
            async ([name, marker]) => {
              const carried = await carrying(marker);
              return [name, carried.map(({ body }) => body)] as const;
            }
          )
        )
      );
      const promptedBefore = Object.fromEntries(
        Object.entries(promptedAtPlanting).map(([name, bodies]) => [
          name,
          bodies.length,
        ])
      );
      // And the outsider does use it: it is theirs to open.
      const outsiderMember = await memberOf(env.DB, outsider);
      const outsiderOpens =
        outsiderMember === undefined
          ? "not a member"
          : await appFor(env, outsiderMember, withFile, "user").then(
              () => "opens it",
              String
            );

      return {
        holder,
        outsider,
        secretTeam,
        ownTeam,
        holdersTeam,
        sharedWord,
        markers,
        companyMarkers,
        promptedAtPlanting,
        promptedBefore,
        plantedThrough,
        ownerMarker,
        interviewMarker,
        teamMarker,
        noneMarker,
        claimMarker,
        narrowedMarker,
        captureMarker,
        captureId,
        toolkitCaptureMarker,
        toolkitCaptureId,
        runMarker,
        askedMarker,
        answerMarker,
        runSource,
        turnSource,
        everyoneUploadMarker,
        everyoneUpload,
        toHolderMarker,
        agentFileMarker,
        appFileMarker,
        ownUploadMarker,
        teamUploadMarker,
        teamSkillMarker,
        instructionMarkers,
        inRecall,
        instructionGroups,
        ownerIds,
        teamId,
        noneId,
        claimId,
        narrowedId,
        ownUpload,
        teamUpload,
        holderFile,
        agentFile,
        appFile,
        usedAppFile,
        whileDraft,
        teamSource,
        asOutsider,
        teamSkillsOf,
        // What whoever may read the markers finds of them, and what the
        // outsider finds of their own, past them.
        found: {
          narrowedToHolder,
          outsiderFinds,
          holderFindsCapture,
          holderFindsToolkitCapture,
          cappedFinds,
          teamSkillSelected,
          holderAppFile: holderAppFiles.some(
            ({ text }) => text === usedAppText
          ),
          outsiderOpens,
          everyoneFinds: {
            holder: await findsEveryone(holder),
            outsider: await findsEveryone(outsider),
          },
        },
        findsEveryone,
        handbook,
        capped,
      };
    };

    let planting: ReturnType<typeof plantWorld> | undefined;

    /**
     * The world, planted by the first pass that asks for it; planted again
     * by the next one if planting failed, as a retried pass does.
     */
    const plantedWorld = async () => {
      planting ??= plantWorld();
      try {
        return await planting;
      } catch (error) {
        planting = undefined;
        throw error;
      }
    };

    // A pass that finds nothing, in any answer, log line or prompt, and
    // never addresses the holder's own store.
    const nothingGivenAway = { findings: [], holdersStoreAddressed: false };

    it("finds each planted marker for whoever may read it, and the outsider's own past them", async () => {
      const {
        found,
        handbook,
        capped,
        secretTeam,
        teamSkillMarker,
        findsEveryone,
        promptedAtPlanting,
      } = await plantedWorld();
      // Every member finds the upload for everyone: one who joined after
      // it was made, and an admin, too.
      const [{ userId: member }, { userId: admin }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "admin"),
      ]);

      // What was sent to a model while planting: only the holder's own
      // chat turn, which carries their question and what their chat is
      // given (their instruction file, their skill, their team's skill).
      // The passes count prompts from there, so this is where any other
      // marker in a prompt then must fail.
      const chat = promptedAtPlanting["a question in the holder's chat"] ?? [];
      const ownChat = new Set([
        "a question in the holder's chat",
        "the holder's instruction file",
        "the holder's own skill",
        "a team's skill the outsider isn't in",
      ]);

      expect({
        ...found,
        everyoneFinds: {
          ...found.everyoneFinds,
          member: await findsEveryone(member),
          admin: await findsEveryone(admin),
        },
        chatPrompts: chat.length,
        prompted: Object.fromEntries(
          Object.entries(promptedAtPlanting).map(([name, bodies]) => {
            if (bodies.length === 0) {
              return [name, 0];
            }
            return [
              name,
              textOf(bodies) === textOf(chat)
                ? "in the holder's own chat"
                : bodies.length,
            ];
          })
        ),
      }).toStrictEqual({
        chatPrompts: 1,
        prompted: Object.fromEntries(
          Object.keys(promptedAtPlanting).map((name) => [
            name,
            ownChat.has(name) ? "in the holder's own chat" : 0,
          ])
        ),
        narrowedToHolder: "refused",
        outsiderFinds: [handbook],
        holderFindsCapture: true,
        holderFindsToolkitCapture: true,
        cappedFinds: [{ text: capped, found: "exact" }],
        teamSkillSelected: {
          byTheHolder: [`${secretTeam}:${teamSkillMarker}`],
          byTheOutsider: [],
        },
        holderAppFile: true,
        outsiderOpens: "opens it",
        everyoneFinds: {
          holder: true,
          outsider: true,
          member: true,
          admin: true,
        },
      });
    });

    it("plants a marker through every producer core hands sources over through, and every choice of an upload's readers", async () => {
      const { plantedThrough, markers, companyMarkers } = await plantedWorld();
      // Forbidden in the passes below: to all but the holder (`markers`),
      // or to anyone outside the company (`companyMarkers`).
      const forbidden = new Map(
        Object.entries({ ...markers, ...companyMarkers })
      );
      /**
       * Whether `producer` planted its source, of its kind, whose marker
       * the passes forbid, and which someone who may read it recalls by
       * that marker: that source, holding it.
       */
      const isPlanted = async (producer: string): Promise<boolean> => {
        const planted = plantedThrough[producer];
        const marker = forbidden.get(planted?.marker ?? "");
        const kind = producer.startsWith("upload for ") ? "upload" : producer;
        if (
          planted === undefined ||
          marker === undefined ||
          planted.source.producer !== kind
        ) {
          return false;
        }
        const { items } = await recallAs(env, planted.reader, {
          personal: true,
          question: marker,
          budget: { tokens: recallBudgetMax },
        });
        return items.some(
          ({ source, text }) =>
            textOf(source) === textOf(planted.source) && text.includes(marker)
        );
      };
      const unplanted: string[] = [];
      for (const producer of producerNames()) {
        // oxlint-disable-next-line no-await-in-loop -- one producer at a time
        if (!(await isPlanted(producer))) {
          unplanted.push(producer);
        }
      }

      expect(unplanted).toStrictEqual([]);
    });

    it("gives someone who isn't a member, or was one, nothing of the upload for everyone, nor anything else", async () => {
      const world = await plantedWorld();
      const { markers, companyMarkers } = world;
      // Someone who never was a member, and someone an admin removed:
      // through every surface that reads as the reader it is handed (the
      // store's, and the instruction files' rules). Core's own refuse
      // anyone who isn't a member before they read
      // (`permission.person_inactive`): a probe that only ever gets errors
      // covers nothing.
      const [admin, former] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInWithRole(idp, "user"),
      ]);
      await admin.api.members.remove(former.userId);
      const forbidden = { ...markers, ...companyMarkers };
      const among = surfaces.filter(
        ([name]) =>
          (readingSurfaces.has(name) && name.startsWith("store ")) ||
          name === "instructions instructionFilesFor"
      );
      // As the outsider is probed, but using no App, and asking of the
      // upload for everyone too.
      const { usedApps: _usedApps, ...asOutsider } = world.asOutsider([]);
      const findings: Finding[] = [];
      for (const [pass, personId] of [
        ["someone who never was a member", `stranger-${crypto.randomUUID()}`],
        ["someone an admin removed", former.userId],
      ] as const) {
        findings.push(
          // oxlint-disable-next-line no-await-in-loop -- one pass at a time
          ...(await findingsOf(
            pass,
            {
              ...asOutsider,
              personId,
              reader: { person: personId, groups: [] },
              markers: [...asOutsider.markers, world.everyoneUploadMarker],
              hiddenVersions: [
                ...asOutsider.hiddenVersions,
                ...everyVersionOf(world.everyoneUpload),
              ],
              hiddenUploads: [
                ...(asOutsider.hiddenUploads ?? []),
                world.everyoneUpload.id,
              ],
            },
            forbidden,
            { among, inRecall: world.inRecall }
          ))
        );
      }

      // Core's surfaces that read refuse the removed member as no longer
      // one before anything is read: each call is refused so, or refused
      // for its input, which is checked first. Not staff's report, which
      // reads as no one. And code's entity reads, an App's and a chat's
      // agent's in its person's own chat among them, the same in the
      // function host's words (`permission.unavailable`,
      // `permission.invalid_args`).
      const answeredOrOtherwise: string[] = [];
      const neverInactive: string[] = [];
      const codeEntities = "recall entitiesCallFor";
      for (const [name, probe] of [
        ...reading,
        ...surfaces.filter(([each]) => each === codeEntities),
      ]) {
        if (
          (!name.startsWith("core ") && name !== codeEntities) ||
          name === "core brainStaffReport"
        ) {
          continue;
        }
        const [noLonger, forInput] =
          name === codeEntities
            ? ["permission.unavailable", "permission.invalid_args"]
            : ["permission.person_inactive", "brain.request_invalid"];
        // oxlint-disable-next-line no-await-in-loop -- one surface at a time
        const answers = await probe({
          ...asOutsider,
          personId: former.userId,
          reader: { person: former.userId, groups: [] },
        });
        const inactive = answers.filter(
          ({ got }) => "error" in got && textOf(got).includes(noLonger)
        );
        if (inactive.length === 0) {
          neverInactive.push(name);
        }
        answeredOrOtherwise.push(
          ...answers
            .filter(
              ({ got }) =>
                !("error" in got) ||
                !(
                  textOf(got).includes(noLonger) ||
                  textOf(got).includes(forInput)
                )
            )
            .map(({ call }) => `${name}: ${call}`)
        );
      }

      expect({
        findings: [
          ...findings,
          ...(await promptedWith(
            "someone who isn't a member",
            forbidden,
            world.promptedBefore
          )),
        ],
        answeredOrOtherwise,
        neverInactive,
      }).toStrictEqual({
        findings: [],
        answeredOrOtherwise: [],
        neverInactive: [],
      });
    });

    it("gives the outsider no marker or hidden match through any surface, in an answer, a log line or a prompt", async () => {
      const {
        holder,
        outsider,
        ownTeam,
        markers,
        inRecall,
        asOutsider,
        promptedBefore,
      } = await plantedWorld();

      const { findings, addressed } = await watched(
        "the outsider",
        asOutsider([ownTeam]),
        markers,
        { inRecall }
      );

      expect({
        findings: [
          ...findings,
          ...(await promptedWith("the outsider", markers, promptedBefore)),
        ],
        holdersStoreAddressed: addressed.includes(`person:${holder}`),
        // The binding was watched: the shared store and the outsider's own
        // were addressed through it.
        othersAddressed: [
          addressed.includes("brain"),
          addressed.includes(`person:${outsider}`),
        ],
      }).toStrictEqual({ ...nothingGivenAway, othersAddressed: [true, true] });
    });

    it("gives the outsider, from the very next recall once they join the team, its source and nothing else", async () => {
      const world = await plantedWorld();
      const {
        holder,
        outsider,
        secretTeam,
        ownTeam,
        markers,
        inRecall,
        asOutsider,
        teamSkillsOf,
      } = world;

      // Out of the team, whatever a pass before left (a retry of this one
      // among them), and recalling as such: then joining it counts from
      // the very next recall. Its source is theirs to read, and nothing
      // else is.
      await leave(secretTeam, outsider);
      const outsideFinds = await textsFor(outsider, world.teamMarker);
      const outsideSkills = await teamSkillsOf(outsider);
      await join(secretTeam, outsider);
      const joinedFinds = await textsFor(outsider, world.teamMarker);
      const joinedSkills = await teamSkillsOf(outsider);
      const {
        "a team's source the outsider isn't in": _joined,
        "an upload for a team the outsider isn't in": _joinedUpload,
        "a team's skill the outsider isn't in": _joinedSkill,
        ...notJoined
      } = markers;
      const { findings, addressed } = await watched(
        "the outsider, in the team",
        {
          ...asOutsider([ownTeam, secretTeam]),
          markers: [
            world.ownerMarker,
            world.interviewMarker,
            world.noneMarker,
            world.claimMarker,
            world.narrowedMarker,
            world.captureMarker,
            world.toolkitCaptureMarker,
            world.toHolderMarker,
            ...world.instructionMarkers,
            world.ownUploadMarker,
            world.runMarker,
            world.askedMarker,
            world.answerMarker,
          ],
          hiddenVersions: everyVersionOf(
            ...world.ownerIds,
            world.noneId,
            world.claimId,
            world.narrowedId,
            world.ownUpload,
            world.captureId,
            world.toolkitCaptureId,
            world.runSource,
            world.turnSource
          ),
          hiddenUploads: [world.ownUpload.id],
          hiddenTeamSkills: [],
        },
        notJoined,
        { inRecall }
      );

      expect({
        findings: [
          ...findings,
          ...(await promptedWith(
            "the outsider, in the team",
            markers,
            world.promptedBefore
          )),
        ],
        holdersStoreAddressed: addressed.includes(`person:${holder}`),
        outsideFinds,
        outsideSkills,
        joinedFinds,
        joinedSkills,
      }).toStrictEqual({
        ...nothingGivenAway,
        outsideFinds: [],
        outsideSkills: [],
        joinedFinds: [world.teamSource],
        joinedSkills: [`${secretTeam}:${world.teamSkillMarker}`],
      });
    });

    it("gives the outsider nothing of the team again from the very next recall once they leave it", async () => {
      const {
        holder,
        outsider,
        secretTeam,
        ownTeam,
        markers,
        inRecall,
        asOutsider,
        teamSkillsOf,
        teamMarker,
        teamSource,
        teamSkillMarker,
        promptedBefore,
      } = await plantedWorld();

      // In the team, whatever a pass before left (a retry of this one
      // among them), and recalling as a member: then leaving counts from
      // the very next recall too.
      await leave(secretTeam, outsider);
      await join(secretTeam, outsider);
      const memberFinds = await textsFor(outsider, teamMarker);
      const memberSkills = await teamSkillsOf(outsider);
      await leave(secretTeam, outsider);
      const leftFinds = await textsFor(outsider, teamMarker);
      const leftSkills = await teamSkillsOf(outsider);
      const { findings, addressed } = await watched(
        "the outsider, out of the team again",
        asOutsider([ownTeam]),
        markers,
        { inRecall }
      );

      expect({
        findings: [
          ...findings,
          ...(await promptedWith(
            "the outsider, out of the team again",
            markers,
            promptedBefore
          )),
        ],
        holdersStoreAddressed: addressed.includes(`person:${holder}`),
        memberFinds,
        memberSkills,
        leftFinds,
        leftSkills,
      }).toStrictEqual({
        ...nothingGivenAway,
        memberFinds: [teamSource],
        memberSkills: [`${secretTeam}:${teamSkillMarker}`],
        leftFinds: [],
        leftSkills: [],
      });
    });

    it("gives the holder, who may read everything else, nothing of the source nobody may read or of a version never theirs", async () => {
      const world = await plantedWorld();
      const { holder, secretTeam, holdersTeam, markers } = world;

      // Someone who may read everything else still never gets the source
      // nobody is known to read, nor the first version of the source widened
      // to them, which was never theirs.
      const findings = await findingsOf(
        "the holder",
        {
          personId: holder,
          reader: {
            person: holder,
            groups: [`team:${secretTeam}`, `team:${holdersTeam}`],
          },
          personal: true,
          sharedWord: world.sharedWord,
          // The team claim is theirs to read: they told their work in it.
          markers: [
            world.noneMarker,
            world.narrowedMarker,
            world.agentFileMarker,
            world.appFileMarker,
          ],
          hiddenVersions: [
            ...everyVersionOf(world.noneId),
            { source: world.narrowedId, version: 1 },
          ],
          // Their own instruction file is theirs, and so are the Apps'
          // they build.
          hiddenInstructionFiles: [world.agentFile, world.appFile],
          instructionGroups: world.instructionGroups,
          moments: [world.whileDraft],
        },
        {
          "a source nobody is known to read": world.noneMarker,
          "a source narrowed away from the outsider": world.narrowedMarker,
          "another agent's instruction file": world.agentFileMarker,
          "an App's instruction file the outsider doesn't build":
            world.appFileMarker,
        },
        { inRecall: world.inRecall }
      );

      expect([
        ...findings,
        ...(await promptedWith("the holder", markers, world.promptedBefore)),
      ]).toStrictEqual([]);
    });

    it("gives the holder, through code's recall, only what the whole company may read, and never addresses their own store", async () => {
      const world = await plantedWorld();
      const { holder, secretTeam, markers } = world;

      // Code's recall from a workflow, or an App whose grant names no
      // team, reads only what everyone in the company may: no person, no
      // team. So nothing team-only reaches it even for someone in that team, nothing of the
      // holder's own, and their own store is never addressed.
      const { findings, addressed } = await watched(
        "the holder, through code's recall",
        {
          personId: holder,
          reader: { person: holder, groups: [`team:${secretTeam}`] },
          personal: false,
          sharedWord: world.sharedWord,
          markers: [
            world.ownerMarker,
            world.interviewMarker,
            world.teamMarker,
            world.noneMarker,
            world.claimMarker,
            world.narrowedMarker,
            ...holdersOwnProduced(world).markers,
          ],
          hiddenVersions: everyVersionOf(
            ...world.ownerIds,
            world.teamId,
            world.noneId,
            world.claimId,
            ...holdersOwnProduced(world).sources
          ),
          hiddenInstructionFiles: [world.agentFile, world.appFile],
          instructionGroups: world.instructionGroups,
          moments: [world.whileDraft],
        },
        {
          "the holder's own source": world.ownerMarker,
          "the holder's interview": world.interviewMarker,
          "a team's source, though the holder is in the team": world.teamMarker,
          "a source nobody is known to read": world.noneMarker,
          "a staff-list team's claim": world.claimMarker,
          "a source narrowed away from the outsider": world.narrowedMarker,
          ...holdersOwnProduced(world).forbidden,
        },
        {
          among: surfaces.filter(([name]) => name.startsWith("recall ")),
          inRecall: world.inRecall,
        }
      );

      expect({
        findings: [
          ...findings,
          ...(await promptedWith(
            "the holder, through code's recall",
            markers,
            world.promptedBefore
          )),
        ],
        holdersStoreAddressed: addressed.includes(`person:${holder}`),
      }).toStrictEqual(nothingGivenAway);
    });

    it("gives the holder, through an App's recall under a grant naming another team of theirs, nothing of the team it doesn't name", async () => {
      const world = await plantedWorld();
      const { holder, secretTeam, holdersTeam, markers } = world;
      const pass =
        "the holder, through an App's recall under a grant naming another team of theirs";

      // An App's grant naming another team of the holder's: the team's
      // source the grant doesn't name stays hidden though the holder is
      // in that team, and so does everything else that isn't theirs.
      const { findings, addressed } = await watched(
        pass,
        {
          personId: holder,
          reader: {
            person: holder,
            groups: [`team:${secretTeam}`, `team:${holdersTeam}`],
          },
          personal: false,
          sharedWord: world.sharedWord,
          markers: [
            world.ownerMarker,
            world.interviewMarker,
            world.teamMarker,
            world.noneMarker,
            world.claimMarker,
            world.narrowedMarker,
            ...holdersOwnProduced(world).markers,
          ],
          hiddenVersions: everyVersionOf(
            ...world.ownerIds,
            world.teamId,
            world.noneId,
            world.claimId,
            ...holdersOwnProduced(world).sources
          ),
          hiddenInstructionFiles: [world.agentFile, world.appFile],
          instructionGroups: world.instructionGroups,
          moments: [world.whileDraft],
          codeTeams: [holdersTeam],
        },
        {
          "the holder's own source": world.ownerMarker,
          "the holder's interview": world.interviewMarker,
          "a team's source the grant doesn't name, though the holder is in the team":
            world.teamMarker,
          "a source nobody is known to read": world.noneMarker,
          "a staff-list team's claim": world.claimMarker,
          "a source narrowed away from the outsider": world.narrowedMarker,
          ...holdersOwnProduced(world).forbidden,
        },
        {
          among: surfaces.filter(([name]) => name === "recall recallFor"),
          inRecall: world.inRecall,
        }
      );

      expect({
        findings: [
          ...findings,
          ...(await promptedWith(pass, markers, world.promptedBefore)),
        ],
        holdersStoreAddressed: addressed.includes(`person:${holder}`),
      }).toStrictEqual(nothingGivenAway);
    });

    it("gives the holder, recalling as an App does, nothing of what is theirs alone", async () => {
      const world = await plantedWorld();
      const { holder, secretTeam, holdersTeam, markers } = world;

      // Recalling as an App does (`personal: false`), the holder finds
      // nothing of what is theirs alone: it is in their own store, which
      // that recall never addresses.
      const { findings, addressed } = await watched(
        "the holder, recalling as an App does",
        {
          personId: holder,
          reader: {
            person: holder,
            groups: [`team:${secretTeam}`, `team:${holdersTeam}`],
          },
          personal: false,
          sharedWord: world.sharedWord,
          markers: [
            world.ownerMarker,
            world.interviewMarker,
            ...holdersOwnProduced(world).markers,
          ],
          hiddenVersions: [],
          hiddenInstructionFiles: [],
          instructionGroups: world.instructionGroups,
          moments: [world.whileDraft],
        },
        {
          "the holder's own source": world.ownerMarker,
          "the holder's interview": world.interviewMarker,
          ...holdersOwnProduced(world).forbidden,
        },
        { among: surfaces.filter(([name]) => name === "core recallAs") }
      );

      expect({
        findings: [
          ...findings,
          ...(await promptedWith(
            "the holder, recalling as an App does",
            markers,
            world.promptedBefore
          )),
        ],
        holdersStoreAddressed: addressed.includes(`person:${holder}`),
      }).toStrictEqual(nothingGivenAway);
    });

    // GRA-1822: what one person alone may read is never in the shared
    // store, whoever calls it, so no reader of it can be given any: the
    // store refuses it before it writes anything, in words naming no one.
    // Core, given the same, keeps it in their own store.
    it("keeps nothing of one person's own in the shared store, whoever adds it there, and core keeps it in their own", async () => {
      const [{ userId: holder }, { userId: mate }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const team = `team:${await newTeam(holder, mate)}`;
      const marker = markerWord();
      const text = `Salary review ${marker}`;
      const theirs: Access = { kind: "owner", person: holder };
      const source = newSource();
      const key = `${source.producer}:${source.id}`;
      const file = `instructions:person:${holder}`;

      const refusals = [
        await answerOf(
          async () =>
            await sharedStore().addSource({
              source: key,
              change: "1",
              text,
              access: theirs,
            })
        ),
        await answerOf(
          async () =>
            await sharedStore().addInstructions({
              source: file,
              change: "1",
              text,
              access: theirs,
            })
        ),
        await answerOf(
          async () =>
            await sharedStore().addMemories({
              change: crypto.randomUUID(),
              access: theirs,
              entities: [{ key: "c", kind: "customer", names: [marker] }],
              memories: [
                {
                  about: "c",
                  type: "fact",
                  statement: text,
                  speaker: { kind: "internal", person: holder },
                  basis: { kind: "writer", writer: holder },
                },
              ],
            })
        ),
      ];
      await addSource(env, {
        source,
        change: "1",
        text,
        readers: { kind: "owner", personId: holder },
      });
      /** What the shared store gives `person`, in `team`, for the marker. */
      const sharedGives = async (person: string) => {
        const reader = { person, groups: [team] };
        const { items, memories } = await sharedStore().recall({
          question: marker,
          reader,
          budget: { tokens: recallBudgetMax },
        });
        const current = await sharedStore().readCurrent({
          sources: [key, file],
          reader,
        });
        const { entities } = await sharedStore().findEntities({
          reader,
          name: marker,
        });
        return [...items, ...memories, ...current, ...entities].length;
      };
      const read = async (person: string) => {
        const version = await readSourceVersionAs(env, person, {
          source,
          version: 1,
        });
        return version?.text ?? null;
      };

      expect({
        refusals,
        sharedKeys: [
          await sharedStore().keyState(key),
          await sharedStore().keyState(file),
        ],
        sharedGives: {
          holder: await sharedGives(holder),
          mate: await sharedGives(mate),
        },
        read: { holder: await read(holder), mate: await read(mate) },
      }).toStrictEqual({
        refusals: [onlyInOwnStore, onlyInOwnStore, onlyInOwnStore],
        sharedKeys: ["free", "free"],
        sharedGives: { holder: 0, mate: 0 },
        read: { holder: text, mate: null },
      });
    });

    it("gives a team-mate of the holder's nothing of the holder's own through any surface that reads", async () => {
      const world = await plantedWorld();
      const { holder, secretTeam, markers } = world;

      // A team-mate of the holder's, through every surface that reads:
      // nothing of the holder's own reaches them.
      const { userId: teamMate } = await signedInWithRole(idp, "user");
      await join(secretTeam, teamMate);
      const {
        "a team's source the outsider isn't in": _team,
        "an upload for a team the outsider isn't in": _teamUpload,
        "a team's skill the outsider isn't in": _teamSkill,
        ...notTeams
      } = markers;
      const { findings, addressed } = await watched(
        "a team-mate of the holder's",
        {
          personId: teamMate,
          reader: { person: teamMate, groups: [`team:${secretTeam}`] },
          personal: true,
          sharedWord: world.sharedWord,
          markers: [
            world.ownerMarker,
            world.interviewMarker,
            world.noneMarker,
            world.claimMarker,
            world.narrowedMarker,
            world.toHolderMarker,
            ...world.instructionMarkers,
            ...holdersOwnProduced(world).markers,
          ],
          hiddenVersions: everyVersionOf(
            ...world.ownerIds,
            world.noneId,
            world.claimId,
            world.narrowedId,
            ...holdersOwnProduced(world).sources
          ),
          hiddenUploads: [world.ownUpload.id],
          hiddenInstructionFiles: [
            world.holderFile,
            world.agentFile,
            world.appFile,
            world.usedAppFile,
          ],
          instructionGroups: world.instructionGroups,
          moments: [world.whileDraft],
        },
        notTeams,
        { among: reading, inRecall: world.inRecall }
      );

      expect({
        findings: [
          ...findings,
          ...(await promptedWith(
            "a team-mate of the holder's",
            markers,
            world.promptedBefore
          )),
        ],
        holdersStoreAddressed: addressed.includes(`person:${holder}`),
      }).toStrictEqual(nothingGivenAway);
    });

    it("gives an admin nothing they may not read through any surface that reads, or any of core's", async () => {
      const world = await plantedWorld();
      const { holder, markers } = world;

      // An admin, through every surface that reads and every one of
      // core's: nothing of the holder's own, nor of a team they aren't in,
      // reaches them.
      const { userId: admin } = await signedInWithRole(idp, "admin");
      const { findings, addressed } = await watched(
        "an admin",
        {
          personId: admin,
          reader: { person: admin, groups: [] },
          personal: true,
          sharedWord: world.sharedWord,
          markers: [
            world.ownerMarker,
            world.interviewMarker,
            world.teamMarker,
            world.noneMarker,
            world.claimMarker,
            world.narrowedMarker,
            world.toHolderMarker,
            ...world.instructionMarkers,
            ...holdersOwnProduced(world).markers,
            world.teamUploadMarker,
          ],
          hiddenVersions: everyVersionOf(
            ...world.ownerIds,
            world.teamId,
            world.noneId,
            world.claimId,
            world.narrowedId,
            ...holdersOwnProduced(world).sources,
            world.teamUpload
          ),
          hiddenUploads: [world.ownUpload.id, world.teamUpload.id],
          hiddenInstructionFiles: [
            world.holderFile,
            world.agentFile,
            world.appFile,
            world.usedAppFile,
          ],
          instructionGroups: world.instructionGroups,
          moments: [world.whileDraft],
        },
        markers,
        {
          among: surfaces.filter(
            ([name]) => readingSurfaces.has(name) || name.startsWith("core ")
          ),
          inRecall: world.inRecall,
        }
      );

      expect({
        findings: [
          ...findings,
          ...(await promptedWith("an admin", markers, world.promptedBefore)),
        ],
        holdersStoreAddressed: addressed.includes(`person:${holder}`),
      }).toStrictEqual(nothingGivenAway);
    });

    it("gives a reader nothing a model drew from what they may not read, and prompts a model with one version's text at a time", async () => {
      // Extraction sends restricted text to a model on purpose, so the
      // rule for prompts is: no marker in a prompt made for a reader who
      // may not read it. An extraction prompt is made for its version's
      // readers alone, so it may hold that version's marker and no other.
      // The model tells everything it is shown, and more: every marker it
      // saw as names, statements, quotes and values, and every other
      // marker as names it never saw.
      const [{ userId: holder }, { userId: outsider }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const secretTeam = await newTeam(holder);
      const ownTeam = await newTeam(outsider);
      const sharedWord = `s${unique()}`;
      const markers = {
        "the holder's own words": markerWord(),
        "a team's source the outsider isn't in": markerWord(),
        "a source nobody is known to read": markerWord(),
      };
      const all = Object.values(markers);
      const provider = await answeringProvider((requests) => {
        const body = JSON.stringify(requests.at(-1)?.body);
        if (body.includes("You check statements")) {
          return {
            text: JSON.stringify({
              supported: Array.from({ length: 10 }, (_, index) => index),
            }),
            inputTokens: 10,
            outputTokens: 10,
          };
        }
        const shown = all.filter((marker) => body.includes(marker));
        return {
          text: JSON.stringify({
            entities: [
              { key: "c", kind: "customer", names: [...shown, ...all] },
              { key: "p", kind: "person", names: shown },
            ],
            memories: shown.flatMap((marker) => [
              {
                about: "c",
                attribute: "status",
                value: marker,
                type: "fact",
                statement: `Customer ${marker} is active`,
                quote: `Customer ${marker} is active`,
              },
              {
                about: "p",
                type: "instruction",
                statement: `Always ask ${marker}`,
                quote: `Always ask ${marker}`,
              },
            ]),
          }),
          inputTokens: 10,
          outputTokens: 10,
        };
      });
      const textOfMarker = (marker: string) =>
        `${sharedWord}: Customer ${marker} is active. Always ask ${marker}.`;
      const addSaid = async (
        marker: string,
        readers: SourceReaders,
        by: Said["by"]
      ): Promise<SourceRef> => {
        const source = newSource();
        await addSource(env, {
          source,
          change: crypto.randomUUID(),
          text: textOfMarker(marker),
          readers,
          said: saidNow(by),
        });
        return source;
      };
      const own = await addSaid(
        markers["the holder's own words"],
        { kind: "owner", personId: holder },
        { kind: "person", personId: holder }
      );
      const team = await addSaid(
        markers["a team's source the outsider isn't in"],
        { kind: "team", teamId: secretTeam },
        { kind: "outside" }
      );
      const none = await addSaid(
        markers["a source nobody is known to read"],
        { kind: "none" },
        { kind: "outside" }
      );
      // The outsider's own, drawn from too.
      await addSaid(
        `own${unique()}`,
        { kind: "team", teamId: ownTeam },
        { kind: "outside" }
      );
      await workBrain(env, new Date(), noProducers);

      // Drawn for those who may read them: the test holds only if the
      // model's memories exist.
      const holderReads: number[] = [];
      for (const name of [
        markers["the holder's own words"],
        markers["a team's source the outsider isn't in"],
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one name at a time
        const found = await brainStore().findEntities({
          reader: { person: holder, groups: [`team:${secretTeam}`] },
          name,
        });
        holderReads.push(found.entities.length);
      }
      const prompts = provider.requests.map(({ body }) =>
        all.filter((marker) => JSON.stringify(body).includes(marker))
      );
      const findings = await findingsOf(
        "the outsider, after extraction",
        {
          personId: outsider,
          reader: { person: outsider, groups: [`team:${ownTeam}`] },
          personal: true,
          sharedWord,
          markers: all,
          hiddenVersions: everyVersionOf(own, team, none),
          hiddenInstructionFiles: [],
          instructionGroups: ["company"],
        },
        markers
      );

      expect({
        holderReads,
        // Two calls for the team's version; one for the outsider's own,
        // where the model proposed nothing to check; none for the one
        // nobody may read, nor for the holder's own: it is kept in the
        // holder's own store, which draws from it on its own tick.
        promptCount: prompts.length,
        mixed: prompts.filter((held) => held.length > 1),
        findings,
      }).toStrictEqual({
        // In the shared store: nothing of the holder's own source; of the
        // team's, the customer alone, as the instruction the model proposed
        // about a person is never drawn from a source.
        holderReads: [0, 1],
        promptCount: 3,
        mixed: [],
        findings: [],
      });
    });

    it("gives a reader of a memory alone that memory current when its restatement lands for a team they aren't in, and a reader of both one current (GRA-1752)", async () => {
      const [{ userId: holder }, { userId: outsider }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      // The outsider and the holder share a team; the holder alone is in
      // the other.
      const sharedTeam = await newTeam(outsider, holder);
      const holdersTeam = await newTeam(holder);
      const name = `Merge${unique().replaceAll("-", "").slice(0, 10)}`;
      const said = {
        about: "c",
        type: "fact" as const,
        statement: `${name} works from Delft.`,
        speaker: { kind: "system" as const },
        basis: { kind: "writer" as const, writer: holder },
      };
      const earlier = await brainStore().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: `team:${sharedTeam}` },
        entities: [{ key: "c", kind: "customer", names: [`${name} Group`] }],
        memories: [said],
      });
      const entity = earlier.entities.c ?? "";
      // The same fact said again by the same writer, for the holder's team.
      const later = await brainStore().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: `team:${holdersTeam}` },
        reader: {
          person: holder,
          groups: [`team:${sharedTeam}`, `team:${holdersTeam}`],
        },
        entities: [{ key: "c", id: entity, kind: "customer", names: [] }],
        memories: [said],
      });
      const ids = [...earlier.memories, ...later.memories];
      /** What `personId` reads of the two through core: each one's state, and which they may read. */
      const readBy = async (personId: string) => {
        const page = await memoriesAs(env, personId, {
          entity: { store: "shared", id: entity },
        });
        const readable = await readableMemoriesAs(
          env,
          personId,
          ids.map((memory) => ({ store: "shared", memory }))
        );
        return ids.map((id) => {
          const read = page.memories.find((memory) => memory.id === id);
          let state = "unread";
          if (read !== undefined) {
            state = read.endedAt === null ? "current" : "ended";
          }
          return {
            state,
            readable: readable.some(({ memory }) => memory === id),
          };
        });
      };

      expect({
        outsider: await readBy(outsider),
        holder: await readBy(holder),
      }).toStrictEqual({
        // As in a store without the restatement: the earlier, current.
        outsider: [
          { state: "current", readable: true },
          { state: "unread", readable: false },
        ],
        holder: [
          { state: "ended", readable: true },
          { state: "current", readable: true },
        ],
      });
    });

    it("gives someone who isn't a member, or was one, nothing of the company's instruction files", async () => {
      await answeringProvider(() => {});
      // Every member may read the company's files, so they are probed as
      // someone who never was one, and someone an admin removed: the
      // surfaces that load, read and recall them.
      const [admin, former] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInWithRole(idp, "user"),
      ]);
      await admin.api.members.remove(former.userId);
      const marker = markerWord();
      const companyFiles: Extract<InstructionFile, { scope: "company" }>[] = [
        { scope: "company", name: "instructions" },
        { scope: "company", name: "facts" },
      ];
      for (const file of companyFiles) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time
        await addedSharedFile(
          file,
          `Company instructions ${marker}`,
          admin.userId
        );
      }
      const forbidden = { "the company's instruction files": marker };
      const findings: Finding[] = [];
      for (const [pass, personId] of [
        ["someone who never was a member", `stranger-${crypto.randomUUID()}`],
        ["someone an admin removed", former.userId],
      ] as const) {
        findings.push(
          // oxlint-disable-next-line no-await-in-loop -- one pass at a time
          ...(await findingsOf(
            pass,
            {
              personId,
              reader: { person: personId, groups: [] },
              personal: true,
              sharedWord: `s${unique()}`,
              markers: [marker],
              hiddenVersions: [],
              hiddenInstructionFiles: companyFiles,
              instructionGroups: ["company"],
            },
            forbidden,
            {
              among: surfaces.filter(([name]) =>
                [
                  "instructions instructionFilesFor",
                  "store readCurrent",
                  "store recall",
                ].includes(name)
              ),
            }
          ))
        );
      }
      const prompted = await carrying(marker);

      expect({ findings, prompted }).toStrictEqual({
        findings: [],
        prompted: [],
      });
    });

    it("gives no surface anything erased, once the store is restored from a copy taken before the erasure", async () => {
      await answeringProvider(() => {});
      // The holder's own sources, under each producer's kind (an upload, a
      // chat, a run), their instruction file, and a team's source: each
      // erased, then a copy of
      // the store from before the erasures comes back. Every surface is
      // then probed as those who could read them before.
      const [{ userId: holder }, { userId: teamMate }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const team = await newTeam(holder, teamMate);
      const markers = {
        "the holder's own source": markerWord(),
        "a team's source": markerWord(),
        "the holder's upload": markerWord(),
        "the holder's chat turn": markerWord(),
        "the holder's run": markerWord(),
        "the holder's instruction file": markerWord(),
      };
      const {
        "the holder's own source": ownMarker,
        "a team's source": teamMarker,
        "the holder's upload": uploadMarker,
        "the holder's chat turn": chatMarker,
        "the holder's run": runMarker,
        "the holder's instruction file": fileMarker,
      } = markers;
      const sharedWord = `s${unique()}`;
      const own = await add(`Salary ${sharedWord} ${ownMarker}`, {
        kind: "owner",
        personId: holder,
      });
      const teamSource = await add(`Minutes ${sharedWord} ${teamMarker}`, {
        kind: "team",
        teamId: team,
      });
      const upload: SourceRef = { producer: "upload", id: crypto.randomUUID() };
      const chat: SourceRef = { producer: "chat", id: crypto.randomUUID() };
      const run: SourceRef = { producer: "run", id: crypto.randomUUID() };
      const holders: SourceReaders = { kind: "owner", personId: holder };
      await add(`Contract ${sharedWord} ${uploadMarker}`, holders, upload);
      await add(`Asked ${sharedWord} ${chatMarker}`, holders, chat);
      await add(`Run note ${sharedWord} ${runMarker}`, holders, run);
      const holderFile: InstructionFile = { scope: "person", personId: holder };
      await addInstructionFile(env, {
        file: holderFile,
        change: crypto.randomUUID(),
        text: `Instructions ${sharedWord} ${fileMarker}`,
        after: 0,
      });
      const backup = await copyOfStore();

      // A chat and an upload deleted for good, a run past its retention,
      // the team's source deleted, and then the holder erased.
      const teamReaders: SourceReaders = { kind: "team", teamId: team };
      await eraseSource(env, {
        source: chat,
        readers: holders,
        reason: "deleted",
      });
      await eraseSource(env, {
        source: upload,
        readers: holders,
        reason: "deleted",
      });
      await eraseSource(env, {
        source: run,
        readers: holders,
        reason: "retention",
      });
      await eraseSource(env, {
        source: teamSource,
        readers: teamReaders,
        reason: "deleted",
      });
      // Their own store answers that it is still deleting until an add
      // under way could have written its file: as if that time had passed.
      await Promise.allSettled([
        erasePerson(env, { personId: holder, reason: "person_erased" }),
      ]);
      await ageOwnErasure(holder);
      await erasePerson(env, { personId: holder, reason: "person_erased" });
      await workBrain(env, new Date(), noProducers);
      await restoreStore(backup);

      const erased = [own, teamSource, upload, chat, run].flatMap((source) =>
        [1, 2].map((version) => ({ source, version }))
      );
      const asReader = (
        personId: string,
        hiddenInstructionFiles: InstructionFile[]
      ): Probing => ({
        personId,
        reader: { person: personId, groups: [`team:${team}`] },
        personal: true,
        sharedWord,
        markers: Object.values(markers),
        hiddenVersions: erased,
        hiddenInstructionFiles,
        instructionGroups: ["company"],
      });
      // Their own store was erased whole, and takes nothing from then on:
      // the surfaces that write a skill of theirs (and decide a share of
      // one) can only be refused for them, and are probed as the
      // team-mate.
      const holderWritesOwn = new Set([
        "instructions saveInstructionFile",
        "core addOwnSkill",
        "shares readSkill",
        "shares saveOwnSkill",
        "shares shareOwnSkill",
        "shares approveShare",
        "shares declineShare",
        "shares retireSkill",
      ]);
      const findings = [
        // Their own file is theirs to write again, and what they write
        // after an erasure is new: saving it is probed as the team-mate
        // only, so the holder's pass finds their erased file if it came
        // back, and nothing they wrote since.
        ...(await findingsOf(
          "the holder, after a restore",
          asReader(holder, []),
          markers,
          {
            among: surfaces.filter(([name]) => !holderWritesOwn.has(name)),
          }
        )),
        ...(await findingsOf(
          "a team-mate, after a restore",
          asReader(teamMate, [holderFile]),
          markers
        )),
      ];
      const carried = await Promise.all(Object.values(markers).map(carrying));
      const prompted = carried.flat();

      expect({ findings, prompted }).toStrictEqual({
        findings: [],
        prompted: [],
      });
    });

    /**
     * A team's source with a version before its current one, both marked,
     * and a memory drawn from each, about a customer only they name: what
     * the two tests below erase through core, its markers by name, and the
     * readers it had: the holder and a team-mate.
     */
    const teamSourceToErase = async () => {
      await answeringProvider(() => {});
      const [{ userId: holder }, { userId: teamMate }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const teamId = await newTeam(holder, teamMate);
      const group = `team:${teamId}`;
      const sharedWord = `s${unique()}`;
      const markers = {
        "a version before the current one": markerWord(),
        "the current version": markerWord(),
        "a memory drawn from them": markerWord(),
        "a customer only they name": markerWord(),
      };
      const readers: SourceReaders = { kind: "team", teamId };
      const source = await add(
        `Minutes ${sharedWord} ${markers["a version before the current one"]}`,
        readers
      );
      await add(
        `Minutes ${sharedWord} ${markers["the current version"]}`,
        readers,
        source
      );
      const key = `${source.producer}:${source.id}`;
      const customer = markers["a customer only they name"];
      const drawn = await sharedStore().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group },
        entities: [
          {
            key: "c",
            kind: "customer",
            names: [`${sharedWord} ${customer}`],
            identifiers: [{ type: "ref", value: `ref:${customer}` }],
          },
        ],
        memories: [1, 2].map((version) => ({
          about: "c",
          type: "fact" as const,
          statement: `${sharedWord} ${markers["a memory drawn from them"]} ${version}`,
          speaker: { kind: "system" as const },
          basis: {
            kind: "source" as const,
            source: key,
            version,
            quote: sharedWord,
          },
        })),
      });
      return {
        holder,
        teamMate,
        group,
        readers,
        sharedWord,
        markers,
        source,
        key,
        customer,
        entity: drawn.entities.c ?? "",
      };
    };

    /** A team's source with memories drawn from two of its versions, as `teamSourceToErase` and `teamUploadToRemove` make it. */
    interface TeamSource {
      group: string;
      sharedWord: string;
      markers: Readonly<Record<string, string>>;
      source: SourceRef;
      key: string;
      customer: string;
      entity: string;
    }

    /**
     * What `personId` gets of `team`'s source's versions, history,
     * passages, memories and customer, through core and the store, each
     * against what they get of what no one added.
     */
    const readsOfTeamSource = async (team: TeamSource, personId: string) => {
      const { group, sharedWord, markers, source, key, customer, entity } =
        team;
      const missing = newSource();
      const unknownEntity = crypto.randomUUID();
      const unknownWord = markerWord();
      const reader = { person: personId, groups: [group, "company"] };
      const pack = await recallAs(env, personId, {
        personal: true,
        question: `${sharedWord} ${Object.values(markers).join(" ")}`,
        budget: { tokens: recallBudgetMax },
      });
      return {
        versions: await Promise.all(
          [1, 2].map(
            async (version) =>
              await asIfNeverAdded(
                async (erased) =>
                  await readSourceVersionAs(env, personId, {
                    source: erased ? source : missing,
                    version,
                  })
              )
          )
        ),
        history: await asIfNeverAdded(
          async (erased) =>
            await listVersionsAs(env, personId, {
              source: erased ? source : missing,
            })
        ),
        // What it found: its "not found" holds the question's words.
        recalled: markersIn(
          [pack.items, pack.memories, pack.contested],
          markers
        ),
        memories: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().readMemories({
              entity: erased ? entity : unknownEntity,
              reader,
              history: true,
            })
        ),
        names: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().readEntityNames({
              entity: erased ? entity : unknownEntity,
              reader,
            })
        ),
        customer: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().readEntity({
              entity: erased ? entity : unknownEntity,
              reader,
            })
        ),
        byName: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().findEntities({
              reader,
              name: `${sharedWord} ${erased ? customer : unknownWord}`,
            })
        ),
        byReference: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().findEntities({
              reader,
              identifier: {
                type: "ref",
                value: `ref:${erased ? customer : unknownWord}`,
              },
            })
        ),
        // Drawing from a version, as extraction does: refused alike.
        drawing: await asIfNeverAdded(
          async (erased) =>
            await sharedStore().addMemories({
              change: crypto.randomUUID(),
              access: { kind: "audience", group },
              entities: [{ key: "c", kind: "customer", names: ["Plain"] }],
              memories: [
                {
                  about: "c",
                  type: "fact",
                  statement: "Plain",
                  speaker: { kind: "system" },
                  basis: {
                    kind: "source",
                    source: erased ? key : `upload:${missing.id}`,
                    version: 1,
                    quote: sharedWord,
                  },
                },
              ],
            })
        ),
      };
    };

    /** What a source answers to its readers once nothing of it may be read: as if no one added it. */
    const unreadable = {
      versions: ["as if never added", "as if never added"],
      history: "as if never added",
      recalled: [],
      memories: "as if never added",
      names: "as if never added",
      customer: "as if never added",
      byName: "as if never added",
      byReference: "as if never added",
      drawing: "as if never added",
    };

    /** The reads of `read` that answered as unreadable (`unreadable`). */
    const asUnreadable = (read: Readonly<Record<string, unknown>>): string[] =>
      Object.entries(unreadable)
        .filter(([name, got]) => textOf(read[name]) === textOf(got))
        .map(([name]) => name);

    it("answers a team's source as erased to each of its readers, and leaves it out of an export, while its erasure is still under way, as once it is done", async () => {
      const erasing = await teamSourceToErase();
      const { markers, source } = erasing;
      const readsOf = async (personId: string) =>
        await readsOfTeamSource(erasing, personId);
      /** What each of its readers gets. */
      const reads = async () => ({
        holder: await readsOf(erasing.holder),
        teamMate: await readsOf(erasing.teamMate),
      });
      /**
       * The company's export, written: whether it holds no marker. Any
       * export still being written (a probe's, which a test before started)
       * is written first, so this one is started now.
       */
      const exportHoldsNone = async (): Promise<string[]> => {
        const exported = async (): Promise<string[]> => {
          const { id } = await startBrainExport(env);
          let status = await brainExportStatus(env, { id });
          for (let ticks = 0; status?.state === "writing"; ticks += 1) {
            if (ticks === 20) {
              throw new Error(
                "An export was still being written after 20 ticks"
              );
            }
            // oxlint-disable-next-line no-await-in-loop -- a tick at a time
            await workBrain(env, new Date(), noProducers);
            // oxlint-disable-next-line no-await-in-loop -- a tick at a time
            status = await brainExportStatus(env, { id });
          }
          const files = await Promise.all(
            (status?.files ?? []).map(
              async (file) => await brainExportFile(env, { id, file })
            )
          );
          return [
            `${status?.state} with ${files.length > 0 ? "files" : "none"}`,
            ...markersIn(files, markers),
          ];
        };
        await exported();
        return await exported();
      };
      const before = await reads();
      let held = false;
      let during;
      let exportedDuring: string[] = [];
      await whileErasureHeld(async () => {
        await eraseSource(env, {
          source,
          readers: erasing.readers,
          reason: "deleted",
        });
        held = await erasureUnfinished();
        during = await reads();
        exportedDuring = await exportHoldsNone();
      });
      await workBrain(env, new Date(), noProducers);
      const after = await reads();
      const erased = unreadable;

      expect({
        // Before, each of them read it all: none of this holds by chance.
        before: Object.values(before).map(asUnreadable),
        held,
        during,
        exportedDuring,
        after,
        unfinished: await erasureUnfinished(),
      }).toStrictEqual({
        before: [[], []],
        held: true,
        during: { holder: erased, teamMate: erased },
        exportedDuring: ["done with files"],
        after: { holder: erased, teamMate: erased },
        unfinished: false,
      });
    });

    /**
     * What `pass` finds through `among` (every surface by default) as one
     * of the readers of a team's source (`teamSourceToErase`), the holder
     * or the team-mate, while its erasure through core is under way, and
     * every model prompt that carried its markers.
     */
    const foundWhileErasing = async (
      pass: string,
      who: "holder" | "teamMate",
      among?: readonly [string, Probe][]
    ) => {
      const erasing = await teamSourceToErase();
      const personId = erasing[who];
      const findings: Finding[] = [];
      let held = false;
      await whileErasureHeld(async () => {
        await eraseSource(env, {
          source: erasing.source,
          readers: erasing.readers,
          reason: "deleted",
        });
        held = await erasureUnfinished();
        findings.push(
          ...(await findingsOf(
            pass,
            {
              personId,
              reader: { person: personId, groups: [erasing.group] },
              personal: true,
              sharedWord: erasing.sharedWord,
              markers: Object.values(erasing.markers),
              hiddenVersions: everyVersionOf(erasing.source),
              hiddenInstructionFiles: [],
              instructionGroups: ["company"],
            },
            erasing.markers,
            among === undefined ? {} : { among }
          ))
        );
      });
      await workBrain(env, new Date(), noProducers);
      const carried = await Promise.all(
        Object.values(erasing.markers).map(carrying)
      );
      return { held, findings, prompted: carried.flat() };
    };

    // One of its readers through every surface, and the other through
    // every surface that reads: a test each, for its time.
    it("gives a team's source's holder nothing of it through any surface while its erasure is still under way", async () => {
      await expect(
        foundWhileErasing(
          "the holder, while its erasure is under way",
          "holder"
        )
      ).resolves.toStrictEqual({ held: true, findings: [], prompted: [] });
    });

    it("gives a team-mate nothing of the team's source through any surface that reads while its erasure is still under way", async () => {
      await expect(
        foundWhileErasing(
          "a team-mate, while its erasure is under way",
          "teamMate",
          reading
        )
      ).resolves.toStrictEqual({ held: true, findings: [], prompted: [] });
    });

    /**
     * A team's upload, removed by its uploader's Delete (GRA-1877) through
     * core's route: a version before its current one, both marked, and a
     * memory drawn from each about a customer only they name, as
     * `teamSourceToErase` makes it; its readers the uploader, a team-mate
     * and an admin of the team. `removed` removes it, as many times as
     * asked: once is the state every test below reads.
     */
    const teamUploadToRemove = async () => {
      await answeringProvider(() => {});
      const [uploader, { userId: teamMate }, admin] = await Promise.all([
        signedInApi(idp, "user"),
        signedInWithRole(idp, "user"),
        signedInApi(idp, "admin"),
      ]);
      const holder = uploader.userId;
      const teamId = await newTeam(holder, teamMate, admin.userId);
      const group = `team:${teamId}`;
      const sharedWord = `s${unique()}`;
      const markers = {
        "a version before the current one": markerWord(),
        "the current version": markerWord(),
        "a memory drawn from them": markerWord(),
        "a customer only they name": markerWord(),
      };
      const file = (marker: string) => ({
        name: "Minutes.vtt",
        bytes: new TextEncoder().encode(
          `WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nMinutes ${sharedWord} ${marker}\n`
        ),
      });
      const { source } = await uploader.api.brainSources.upload(
        file(markers["a version before the current one"]),
        { kind: "team", teamId },
        crypto.randomUUID()
      );
      await uploader.api.brainSources.uploadVersion(
        source.id,
        file(markers["the current version"]),
        crypto.randomUUID()
      );
      const key = `${source.producer}:${source.id}`;
      const customer = markers["a customer only they name"];
      const drawn = await sharedStore().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group },
        entities: [
          {
            key: "c",
            kind: "customer",
            names: [`${sharedWord} ${customer}`],
            identifiers: [{ type: "ref", value: `ref:${customer}` }],
          },
        ],
        memories: [1, 2].map((version) => ({
          about: "c",
          type: "fact" as const,
          statement: `${sharedWord} ${markers["a memory drawn from them"]} ${version}`,
          speaker: { kind: "system" as const },
          basis: {
            kind: "source" as const,
            source: key,
            version,
            quote: sharedWord,
          },
        })),
      });
      return {
        holder,
        teamMate,
        admin: admin.userId,
        teamId,
        group,
        sharedWord,
        markers,
        source,
        key,
        customer,
        entity: drawn.entities.c ?? "",
        removed: async () => {
          await uploader.api.brainSources.deleteUpload(source.id);
        },
      };
    };

    it("answers a team's upload its uploader removed as never added to each of its readers, through core and the store", async () => {
      const removing = await teamUploadToRemove();
      const reads = async () => ({
        holder: await readsOfTeamSource(removing, removing.holder),
        teamMate: await readsOfTeamSource(removing, removing.teamMate),
        admin: await readsOfTeamSource(removing, removing.admin),
      });
      const before = await reads();
      await removing.removed();
      // A tick, as the store's own work would run: nothing comes back.
      await workBrain(env, new Date(), noProducers);
      const after = await reads();

      expect({
        // Before, each of them read it all: none of this holds by chance.
        before: Object.values(before).map(asUnreadable),
        after,
      }).toStrictEqual({
        before: [[], [], []],
        after: { holder: unreadable, teamMate: unreadable, admin: unreadable },
      });
    });

    /**
     * What `pass` finds through `among` (every surface by default) as one
     * of the readers of a removed team upload (`teamUploadToRemove`), and
     * every model prompt that carried its markers.
     */
    const foundOnceRemoved = async (
      pass: string,
      who: "holder" | "teamMate" | "admin",
      among?: readonly [string, Probe][]
    ) => {
      const removing = await teamUploadToRemove();
      await removing.removed();
      const personId = removing[who];
      const findings = await findingsOf(
        pass,
        {
          personId,
          reader: { person: personId, groups: [removing.group] },
          personal: true,
          sharedWord: removing.sharedWord,
          markers: Object.values(removing.markers),
          hiddenVersions: everyVersionOf(removing.source),
          // Its uploader may no longer reach it at all; an admin may, to
          // erase it (brain-uploads.test.ts).
          hiddenUploads: who === "admin" ? [] : [removing.source.id],
          hiddenInstructionFiles: [],
          instructionGroups: ["company"],
        },
        removing.markers,
        among === undefined ? {} : { among }
      );
      const carried = await Promise.all(
        Object.values(removing.markers).map(carrying)
      );
      return { findings, prompted: carried.flat() };
    };

    it("gives a removed upload's uploader nothing of it through any surface", async () => {
      await expect(
        foundOnceRemoved("the uploader, once they removed it", "holder")
      ).resolves.toStrictEqual({ findings: [], prompted: [] });
    });

    it("gives a team-mate and an admin of the team nothing of a removed upload through any surface that reads", async () => {
      await expect(
        foundOnceRemoved(
          "a team-mate, once it was removed",
          "teamMate",
          reading
        )
      ).resolves.toStrictEqual({ findings: [], prompted: [] });
      await expect(
        foundOnceRemoved("an admin, once it was removed", "admin", reading)
      ).resolves.toStrictEqual({ findings: [], prompted: [] });
    });

    it("gives an uploader who left the team nothing of their team's upload through any surface, and no way to remove it from the team", async () => {
      const shared = await teamUploadToRemove();
      await leave(shared.teamId, shared.holder);
      const findings = await findingsOf(
        "the uploader, once they left the team",
        {
          personId: shared.holder,
          reader: { person: shared.holder, groups: [] },
          personal: true,
          sharedWord: shared.sharedWord,
          markers: Object.values(shared.markers),
          hiddenVersions: everyVersionOf(shared.source),
          // Asked of, a new version and a delete among them, as an upload
          // nobody made.
          hiddenUploads: [shared.source.id],
          hiddenInstructionFiles: [],
          instructionGroups: ["company"],
        },
        shared.markers
      );

      expect({
        findings,
        // Still the team's: nothing the former member asked removed it.
        teamMate: asUnreadable(
          await readsOfTeamSource(shared, shared.teamMate)
        ),
      }).toStrictEqual({ findings: [], teamMate: [] });
    });

    it("gives a person who lost a workflow nothing of their earlier run's result through any surface", async () => {
      const [{ userId: ownerId }, { userId: personId }] = await Promise.all([
        signedInWithRole(idp, "builder"),
        signedInWithRole(idp, "user"),
      ]);
      const [owner, person] = await Promise.all([
        memberOf(env.DB, ownerId),
        memberOf(env.DB, personId),
      ]);
      if (owner === undefined || person === undefined) {
        throw new Error("Not members");
      }
      const sharedWord = `s${unique()}`;
      const markers = { "what their run returned": markerWord() };
      const returned = markers["what their run returned"];
      const workflow = await publishedWorkflow(
        owner,
        definitionOf([], { value: { status: `${sharedWord} ${returned}` } })
      );
      await shareWorkflowResource(env, owner, workflow.id, {
        type: "person",
        id: personId,
        role: "user",
      });
      const { runId } = await start(person, workflow.id);
      await ended(person, workflow.id, runId);
      const source: SourceRef = { producer: "run", id: runId ?? "" };
      // In their own store, theirs to recall while they hold the workflow.
      await vi.waitFor(
        async () => {
          await drainAuditOutboxes(env);
          await relayHandOvers(env);
          await workBrain(env, new Date(), producersOf(env));
          await expect(
            textsFor(personId, returned),
            "the run was never handed over"
          ).resolves.toHaveLength(1);
        },
        { timeout: 15_000, interval: 200 }
      );

      await unshareWorkflowResource(env, owner, workflow.id, {
        type: "person",
        id: personId,
      });
      await removeLostRunSources(env);
      const findings = await findingsOf(
        "a person who lost the workflow",
        {
          personId,
          reader: { person: personId, groups: [] },
          personal: true,
          sharedWord,
          markers: Object.values(markers),
          hiddenVersions: everyVersionOf(source),
          hiddenUploads: [],
          hiddenInstructionFiles: [],
          instructionGroups: ["company"],
        },
        markers
      );
      const carried = await Promise.all(Object.values(markers).map(carrying));

      expect({ findings, prompted: carried.flat() }).toStrictEqual({
        findings: [],
        prompted: [],
      });
    });

    it("never wakes or addresses one person's own store for another's activity, their store's own work or staff's report", async () => {
      const [{ userId: holder }, { userId: other }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const sharedWord = `s${unique()}`;
      await add(`Holder's own ${sharedWord}`, {
        kind: "owner",
        personId: holder,
      });
      const holderAlarm = async () =>
        await runInDurableObject(
          ownStoreOf(holder),
          async (_store, state) => await state.storage.getAlarm()
        );
      const before = await holderAlarm();

      const { names } = await addressedBy(async () => {
        // The other person's own source, kept, erased (work for their
        // store's alarm), recalled, their alarm run, the clock's tick of
        // the shared store, staff's report, and their erasure.
        const theirs = await add(`Other's own ${sharedWord}`, {
          kind: "owner",
          personId: other,
        });
        await textsFor(other, sharedWord);
        await eraseSource(env, {
          source: theirs,
          readers: { kind: "owner", personId: other },
          reason: "deleted",
        });
        await runDurableObjectAlarm(ownStoreOf(other));
        await workBrain(env, new Date(), noProducers);
        await brainStaffReport(env);
        await Promise.allSettled([
          erasePerson(env, { personId: other, reason: "person_erased" }),
        ]);
      });

      expect({
        holdersStoreAddressed: names.includes(`person:${holder}`),
        othersStoreAddressed: names.includes(`person:${other}`),
        holdersAlarm: await holderAlarm(),
      }).toStrictEqual({
        holdersStoreAddressed: false,
        othersStoreAddressed: true,
        holdersAlarm: before,
      });
    });

    it("puts a person's own content in no chat-app conversation others read, and in their direct message, their own chat, answers it to them alone", async () => {
      // Through Teams' door as Teams posts (channels/door.ts), each turn
      // answered by the fake provider behind connect, which keeps what
      // reached it. A person's own source, memory, skill or instruction
      // file reaches a model only in their own chat: in Grasp, or their
      // direct message, which the platform names one-to-one (GRA-1821,
      // workspace.ts `answersAlone`). Never in a thread others read, even
      // one whose roster holds them alone: no instruction file of theirs,
      // and none of their own chat's tools, their connections first.
      await chatAgentReadsBrain();
      const depot = `d${unique()}`;
      const marker = markerWord();
      const userMarker = markerWord();
      const answered = `Your note says ${marker}.`;
      // Each turn runs code that says whether it holds connections, then
      // answers. The threads are asked first, then her direct message,
      // whose (scripted) answer alone carries the marker: found in a
      // thread or another's chat, it went astray.
      // What it returns ("held:" or "none:" then the marker) is put
      // together as it runs: the code's own text never holds it.
      const holdsConnections = codeStep(
        `export default async (self, env) => { let held = false; try { held = env.connections !== undefined; } catch {} return [held ? "held" : "none", "${marker}"].join(":"); };`
      );
      const ann = await teamsMember(
        idp,
        holdsConnections,
        says("Noted."),
        holdsConnections,
        says("Noted."),
        holdsConnections,
        says("Noted."),
        holdsConnections,
        says(answered)
      );
      const ben = await memberAnsweredBy(idp, ann.provider);
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: crypto.randomUUID(),
        text: `Depot ${depot} keeps Ann's own note ${marker}`,
        readers: { kind: "owner", personId: ann.userId },
      });
      const ownMemory = `Depot ${depot} keeps Ann's own memory ${marker}`;
      await rememberAs(env, ann.userId, {
        change: crypto.randomUUID(),
        about: { kind: "customer", names: [`Depot ${depot}`] },
        type: "fact",
        statement: ownMemory,
        quote: ownMemory,
      });
      await saveInstructions(
        ann.api,
        { scope: "person", personId: ann.userId },
        `Call me ${userMarker}.`
      );
      const skill = `depot-${unique()}`;
      await ann.api.skills.save(
        `---\nname: ${skill}\ndescription: Look up a depot\n---\n\nThe steps.\n`
      );
      const question = `What about depot ${depot}?`;
      const annsWorkspace = workspace(env, personalWorkspaceId(ann.userId));
      /** What a failure may print: the planted words taken out. */
      const redact = (text: string) =>
        text
          .replaceAll(marker, "<marker>")
          .replaceAll(userMarker, "<userMarker>")
          .replaceAll(depot, "<depot>");
      /**
       * What reached the model for what `ask` posted; and, where the code
       * step's output didn't, what the turn did with its code step
       * instead (`codeStepTrace`), for the failure to show.
       */
      const sentFor = async (ask: () => Promise<unknown>) => {
        const before = ann.provider.requests.length;
        const listed = await chatIdsOf(annsWorkspace, ann.userId);
        const chatsBefore = new Set(listed.map(({ id }) => id));
        const since = Date.now();
        await ask();
        const requests = ann.provider.requests.slice(before);
        const sent = JSON.stringify(requests.map(({ body }) => body));
        const ran = sent.includes(`:${marker}`);
        return {
          own: sent.includes(`Depot ${depot} keeps Ann's own note`),
          ownMemory: sent.includes(ownMemory),
          userMd: sent.includes(userMarker),
          ownSkill: sent.includes(`- ${skill} (person`),
          connections: sent.includes(`held:${marker}`),
          ran,
          ...(ran
            ? {}
            : {
                codeStepMissing: await codeStepTrace(
                  annsWorkspace,
                  ann.userId,
                  { chatsBefore, requests, since, redact }
                ),
              }),
        };
      };
      // A group chat whose roster holds Ann alone is still one others can
      // join: shared, as Teams names it.
      const alone = newGroup();
      await onGroupRoster(alone, [{ person: ann.teams }]);
      const withBen = newGroup();
      await onGroupRoster(withBen, [
        { person: ann.teams },
        { person: ben.teams },
      ]);
      const channel = `19:${unique()}@thread.tacv2`;
      await onGroupRoster(channel, [{ person: ann.teams }]);
      const threads = [alone, withBen, channel];

      const inThreads = [
        await sentFor(
          async () => await post(mentionIn(ann.teams, alone, question))
        ),
        await sentFor(
          async () => await post(mentionIn(ann.teams, withBen, question))
        ),
        await sentFor(
          async () =>
            await post(
              mentionIn(
                ann.teams,
                `${channel};messageid=${unique()}`,
                question,
                "channel"
              )
            )
        ),
      ];
      // Her direct message, after the threads: each message is judged as
      // it comes, so asking there first or after changes nothing.
      const inDirect = await sentFor(
        async () => await post(messageFrom(ann.teams, { text: question }))
      );
      const found = await textsFor(ann.userId, `depot ${depot}`);
      const postedIn = async (conversation: string) => {
        const { activities } = await reached(conversation);
        return JSON.stringify(activities).includes(marker);
      };

      expect({
        // Her own recall finds it: what the model got is no empty Brain.
        found: found.length,
        inThreads,
        inDirect,
        postedInThreads: await Promise.all(threads.map(postedIn)),
        postedInDirect: await postedIn(ann.teams.conversation),
        postedToBen: await postedIn(ben.teams.conversation),
      }).toStrictEqual({
        found: 1,
        inThreads: threads.map(() => ({
          own: false,
          ownMemory: false,
          userMd: false,
          ownSkill: false,
          connections: false,
          ran: true,
        })),
        // Her own chat on Teams, as in Grasp: its tools, her own
        // instruction file, skills and memories, and her own store's
        // recall (GRA-1821).
        inDirect: {
          own: true,
          ownMemory: true,
          userMd: true,
          ownSkill: true,
          connections: true,
          ran: true,
        },
        postedInThreads: [false, false, false],
        postedInDirect: true,
        postedToBen: false,
      });
    });

    it("recalls only what the whole company may read in every conversation but a person's own chat, in Grasp or their direct message, and nothing while anyone unnamed is in it", async () => {
      // Through Teams' door as Teams posts (channels/door.ts): who is in a
      // group chat or channel comes from its roster, read for each
      // message. Ann asks in each; what reached the model tells what was
      // recalled. A team she and Ben are both in, and one of hers alone,
      // are never recalled where others read the answer (GRA-1820); her
      // direct message is her own chat, as in Grasp (GRA-1821).
      await chatAgentReadsBrain();
      const ann = await teamsMember(
        idp,
        ...Array.from({ length: 8 }, () => says("Noted."))
      );
      const ben = await memberAnsweredBy(idp, ann.provider);
      const depot = `d${unique()}`;
      const annTeam = markerWord();
      const both = markerWord();
      const own = markerWord();
      const company = markerWord();
      await add(`Depot ${depot} for Ann's team: ${annTeam}`, {
        kind: "team",
        teamId: await newTeam(ann.userId),
      });
      await add(`Depot ${depot} for both: ${both}`, {
        kind: "team",
        teamId: await newTeam(ann.userId, ben.userId),
      });
      await add(`Depot ${depot} Ann's own: ${own}`, {
        kind: "owner",
        personId: ann.userId,
      });
      // Everyone in the company may read it, as an upload shared with
      // everyone is (brain-uploads.ts), added to the shared store directly.
      await brainOf(inJurisdiction(env, env.BRAIN_STORE)).addSource({
        source: `upload:${crypto.randomUUID()}`,
        change: crypto.randomUUID(),
        text: `Depot ${depot} for everyone: ${company}`,
        access: { kind: "audience", group: "company" },
      });
      const question = `What about depot ${depot}?`;
      /** What reached the model for what Ann posted. */
      const sentFor = async (activity: unknown) => {
        const before = ann.provider.requests.length;
        await post(activity);
        const sent = JSON.stringify(
          ann.provider.requests.slice(before).map(({ body }) => body)
        );
        return {
          answered: ann.provider.requests.length > before,
          annTeam: sent.includes(annTeam),
          both: sent.includes(both),
          own: sent.includes(own),
          company: sent.includes(company),
        };
      };
      const askedIn = async (
        conversation: string,
        kind: "groupChat" | "channel" = "groupChat",
        changes: Record<string, unknown> = {}
      ) =>
        await sentFor({
          ...mentionIn(ann.teams, conversation, question, kind),
          ...changes,
        });
      const withBen = newGroup();
      await onGroupRoster(withBen, [
        { person: ann.teams },
        { person: ben.teams },
      ]);
      const withGuest = newGroup();
      await onGroupRoster(withGuest, [
        { person: ann.teams },
        { person: ben.teams },
        { person: teamsPerson(), userRole: "guest" },
      ]);
      // A channel where both are, then a guest joins before Ann asks again
      // in the same thread: what was recalled before is sent no more.
      const channel = `19:${unique()}@thread.tacv2`;
      const thread = `${channel};messageid=${unique()}`;
      await onGroupRoster(channel, [
        { person: ann.teams },
        { person: ben.teams },
      ]);
      // A meeting's chat, whose roster leaves out anonymous attendees: both
      // on it, named a meeting by its channel data or by its id.
      const meeting = newGroup();
      const meetingById = `19:meeting_${unique()}@thread.v2`;
      for (const conversation of [meeting, meetingById]) {
        // oxlint-disable-next-line no-await-in-loop -- one roster at a time
        await onGroupRoster(conversation, [
          { person: ann.teams },
          { person: ben.teams },
        ]);
      }

      const inWithBen = await askedIn(withBen);
      const inWithGuest = await askedIn(withGuest);
      const beforeGuest = await askedIn(thread, "channel");
      await onGroupRoster(channel, [
        { person: ann.teams },
        { person: ben.teams },
        { person: teamsPerson(), userRole: "guest" },
      ]);
      const afterGuestJoined = await askedIn(thread, "channel");
      const inMeeting = await askedIn(meeting, "groupChat", {
        channelData: {
          tenant: { id: acmeTenant },
          meeting: { id: `MCMx${unique()}` },
        },
      });
      const inMeetingById = await askedIn(meetingById);
      const inDirect = await sentFor(
        messageFrom(ann.teams, { text: question })
      );
      // Her own recall finds all four: what the model got is no empty Brain.
      const texts = await textsFor(ann.userId, `depot ${depot}`);
      const found = texts.join(" ");

      const companyOnly = {
        answered: true,
        annTeam: false,
        both: false,
        own: false,
        company: true,
      };
      const nothing = { ...companyOnly, company: false };
      expect({
        found: [annTeam, both, own, company].map((marker) =>
          found.includes(marker)
        ),
        inWithBen,
        inWithGuest,
        beforeGuest,
        afterGuestJoined,
        inMeeting,
        inMeetingById,
        inDirect,
      }).toStrictEqual({
        found: [true, true, true, true],
        inWithBen: companyOnly,
        // Someone Grasp can't name as a member: nothing at all.
        inWithGuest: nothing,
        beforeGuest: companyOnly,
        // Nothing recalled, and the earlier recall withheld from history.
        afterGuestJoined: nothing,
        inMeeting: nothing,
        inMeetingById: nothing,
        inDirect: {
          answered: true,
          annTeam: true,
          both: true,
          own: true,
          company: true,
        },
      });
    });

    it("hands no memory of a person's own or of a team to a shared chat, on the first turn or when history is read again, and checks a company memory again as the company reads it; their Teams direct message gets what their own chat in Grasp does", async () => {
      // Through Teams' door as Teams posts (channels/door.ts), as the test
      // above does for sources (GRA-1820), with memories (GRA-1864): her
      // own, her team's, and one the whole company may read, resting on a
      // company source whose own words no question here holds, so only the
      // memory can carry its marker. Then that source is narrowed to her
      // team: Ann may still read it, the company no longer may, and the
      // next turn in the shared chat must no longer carry it. Her direct
      // message is her own chat (GRA-1821): her memories, read as her,
      // there and when history is read again.
      await chatAgentReadsBrain();
      const ann = await teamsMember(
        idp,
        ...Array.from({ length: 4 }, () => says("Noted."))
      );
      const ben = await memberAnsweredBy(idp, ann.provider);
      const depot = `d${unique()}`;
      const [own, team, company] = [markerWord(), markerWord(), markerWord()];
      const annTeam = await newTeam(ann.userId);
      const ownStatement = `Depot ${depot} Ann's own memory ${own}`;
      await rememberAs(env, ann.userId, {
        change: crypto.randomUUID(),
        about: { kind: "customer", names: [`Depot ${depot}`] },
        type: "fact",
        statement: ownStatement,
        quote: ownStatement,
      });
      const store = brainOf(inJurisdiction(env, env.BRAIN_STORE));
      const companySource = `upload:${crypto.randomUUID()}`;
      const companyText = "Opening hours are weekdays only.";
      await store.addSource({
        source: companySource,
        change: crypto.randomUUID(),
        text: companyText,
        access: { kind: "audience", group: "company" },
      });
      const remembered = async (
        group: string,
        statement: string,
        basis: Parameters<
          typeof store.addMemories
        >[0]["memories"][number]["basis"]
      ) =>
        await store.addMemories({
          change: crypto.randomUUID(),
          access: { kind: "audience", group },
          entities: [{ key: "c", kind: "customer", names: [`Depot ${depot}`] }],
          memories: [
            {
              about: "c",
              type: "fact",
              statement,
              speaker: { kind: "system" },
              basis,
            },
          ],
        });
      await remembered(
        `team:${annTeam}`,
        `Depot ${depot} for Ann's team ${team}`,
        {
          kind: "writer",
          writer: "crm",
        }
      );
      await remembered("company", `Depot ${depot} for everyone ${company}`, {
        kind: "source",
        source: companySource,
        version: 1,
        quote: companyText,
      });
      /** What reached the model for what Ann posted. */
      const sentFor = async (activity: unknown) => {
        const before = ann.provider.requests.length;
        await post(activity);
        const sent = JSON.stringify(
          ann.provider.requests.slice(before).map(({ body }) => body)
        );
        return {
          answered: ann.provider.requests.length > before,
          own: sent.includes(own),
          team: sent.includes(team),
          company: sent.includes(company),
        };
      };
      const withBen = newGroup();
      await onGroupRoster(withBen, [
        { person: ann.teams },
        { person: ben.teams },
      ]);
      const question = `What about depot ${depot}?`;

      const sharedFirst = await sentFor(
        mentionIn(ann.teams, withBen, question)
      );
      const directFirst = await sentFor(
        messageFrom(ann.teams, { text: question })
      );
      // Her team's alone now: she may still read it, the company may not.
      await store.addSource({
        source: companySource,
        change: crypto.randomUUID(),
        text: companyText,
        access: { kind: "audience", group: `team:${annTeam}` },
      });
      const directAgain = await sentFor(
        messageFrom(ann.teams, { text: "Thanks!" })
      );
      const sharedAgain = await sentFor(
        mentionIn(ann.teams, withBen, "Thanks!")
      );
      // Her own recall finds all three: what the model got is no empty Brain.
      const { memories } = await recallAs(env, ann.userId, {
        personal: true,
        question: `depot ${depot}`,
        budget: { tokens: recallBudgetMax },
      });
      const found = JSON.stringify(memories);

      expect({
        found: [own, team].map((marker) => found.includes(marker)),
        sharedFirst,
        directFirst,
        directAgain,
        sharedAgain,
      }).toStrictEqual({
        found: [true, true],
        sharedFirst: { answered: true, own: false, team: false, company: true },
        directFirst: { answered: true, own: true, team: true, company: true },
        // Checked as her: she may still read what it rests on.
        directAgain: { answered: true, own: true, team: true, company: true },
        // Withheld: the company no longer may read what it rests on.
        sharedAgain: {
          answered: true,
          own: false,
          team: false,
          company: false,
        },
      });
    });

    it("reads the company alone in a turn something woke in a person's Teams direct message, though a turn they start there reads their own", async () => {
      // A direct message is the person's own chat (GRA-1821) only in a
      // turn they start: one a schedule or an event woke there
      // (`askUnattended`) is steered by what woke it, so it reads as the
      // company, as a woken turn in Grasp does (workspace.ts
      // `answersAlone`). Its first turn there asks nothing the Brain holds,
      // so the woken turn's history carries none of her own.
      await chatAgentReadsBrain();
      const ann = await teamsMember(
        idp,
        says("Hi."),
        says("Noted."),
        says("Noted.")
      );
      const depot = `d${unique()}`;
      const [own, ownWord, file, company] = [
        markerWord(),
        markerWord(),
        markerWord(),
        markerWord(),
      ];
      await addSource(env, {
        source: { producer: "upload", id: crypto.randomUUID() },
        change: crypto.randomUUID(),
        text: `Depot ${depot} keeps Ann's own note ${own}`,
        readers: { kind: "owner", personId: ann.userId },
      });
      const ownStatement = `Depot ${depot} keeps Ann's own memory ${ownWord}`;
      await rememberAs(env, ann.userId, {
        change: crypto.randomUUID(),
        about: { kind: "customer", names: [`Depot ${depot}`] },
        type: "fact",
        statement: ownStatement,
        quote: ownStatement,
      });
      await saveInstructions(
        ann.api,
        { scope: "person", personId: ann.userId },
        `Call me ${file}.`
      );
      const skill = `depot-${unique()}`;
      await ann.api.skills.save(
        `---\nname: ${skill}\ndescription: Look up a depot\n---\n\nThe steps.\n`
      );
      await brainOf(inJurisdiction(env, env.BRAIN_STORE)).addSource({
        source: `upload:${crypto.randomUUID()}`,
        change: crypto.randomUUID(),
        text: `Depot ${depot} for everyone: ${company}`,
        access: { kind: "audience", group: "company" },
      });
      const question = `What about depot ${depot}?`;
      const annsWorkspace = workspace(env, personalWorkspaceId(ann.userId));
      /** What reached the model of each of hers for what `ask` asked. */
      const sentFor = async (ask: () => Promise<unknown>) => {
        const before = ann.provider.requests.length;
        await ask();
        const sent = JSON.stringify(
          ann.provider.requests.slice(before).map(({ body }) => body)
        );
        return {
          answered: ann.provider.requests.length > before,
          own: sent.includes(own),
          ownMemory: sent.includes(ownWord),
          file: sent.includes(file),
          ownSkill: sent.includes(`- ${skill} (person`),
          company: sent.includes(company),
        };
      };
      await post(messageFrom(ann.teams, { text: "Hi." }));
      // Her direct message in Teams, which no list in Grasp shows.
      const [direct] = await chatIdsOf(annsWorkspace, ann.userId, "teams");
      if (direct === undefined) {
        throw new TypeError("Expected her direct message's chat");
      }

      const woken = await sentFor(
        async () =>
          await annsWorkspace.askUnattended(direct.id, {
            text: question,
            model: testModel,
          })
      );
      const asked = await sentFor(
        async () => await post(messageFrom(ann.teams, { text: question }))
      );

      expect({ woken, asked }).toStrictEqual({
        woken: {
          answered: true,
          own: false,
          ownMemory: false,
          file: false,
          ownSkill: false,
          company: true,
        },
        asked: {
          answered: true,
          own: true,
          ownMemory: true,
          file: true,
          ownSkill: true,
          company: true,
        },
      });
    });

    it("counts the memories a person's Teams direct message handed over as theirs used, and none a group chat of theirs handed over", async () => {
      // A memory a recall as the person hands over is one they used
      // (workspace.ts `memory_uses`, by its `brain-memory:` pin), which
      // ranks it for them alone: only where the answer reaches them alone,
      // their direct message now too (GRA-1821). A group chat recalls as
      // the company (`brain-company-memory:`), which counts no use.
      await chatAgentReadsBrain();
      const ann = await teamsMember(idp, says("Noted."), says("Noted."));
      const ben = await memberAnsweredBy(idp, ann.provider);
      const [inGroup, inDirect] = [`d${unique()}`, `d${unique()}`];
      /** One memory everyone may read about `depot`: its id and statement. */
      const companyMemory = async (depot: string) => {
        const statement = `Depot ${depot} opens at ${markerWord()}`;
        const { memories } = await brainOf(
          inJurisdiction(env, env.BRAIN_STORE)
        ).addMemories({
          change: crypto.randomUUID(),
          access: { kind: "audience", group: "company" },
          entities: [{ key: "c", kind: "customer", names: [`Depot ${depot}`] }],
          memories: [
            {
              about: "c",
              type: "fact",
              statement,
              speaker: { kind: "system" },
              basis: { kind: "writer", writer: "crm" },
            },
          ],
        });
        const [memory] = memories;
        if (memory === undefined) {
          throw new TypeError("Expected the memory added");
        }
        return { memory, statement };
      };
      const ownStatement = `Depot ${inDirect} keeps Ann's own memory ${markerWord()}`;
      const { memory: own } = await rememberAs(env, ann.userId, {
        change: crypto.randomUUID(),
        about: { kind: "customer", names: [`Depot ${inDirect}`] },
        type: "fact",
        statement: ownStatement,
        quote: ownStatement,
      });
      const groupMemory = await companyMemory(inGroup);
      const { memory: directCompany } = await companyMemory(inDirect);
      const groupCompany = groupMemory.memory;
      const withBen = newGroup();
      await onGroupRoster(withBen, [
        { person: ann.teams },
        { person: ben.teams },
      ]);
      const annsWorkspace = workspace(env, personalWorkspaceId(ann.userId));
      /** Whether each memory counts as used by Ann now. */
      const used = async () => {
        const uses = await annsWorkspace.memoriesUsed(Date.now());
        const ids = new Set(uses.map(({ memory }) => memory));
        return {
          groupCompany: ids.has(groupCompany),
          directCompany: ids.has(directCompany),
          own: ids.has(own),
        };
      };

      const beforeGroup = ann.provider.requests.length;
      await post(mentionIn(ann.teams, withBen, `What about depot ${inGroup}?`));
      // Handed over as the company reads it: what the group turn sent.
      const groupRecalled = JSON.stringify(
        ann.provider.requests.slice(beforeGroup).map(({ body }) => body)
      ).includes(groupMemory.statement);
      const afterGroup = await used();
      await post(
        messageFrom(ann.teams, { text: `What about depot ${inDirect}?` })
      );
      const { directCompany: company, own: ownUsed } = await used();

      expect({
        groupRecalled,
        afterGroup,
        afterDirect: { company, own: ownUsed },
      }).toStrictEqual({
        groupRecalled: true,
        afterGroup: { groupCompany: false, directCompany: false, own: false },
        afterDirect: { company: true, own: true },
      });
    });

    it("keeps what a person says in their Teams direct message in their own store alone: never in the shared store, never for another reader", async () => {
      // The agent remembers in a direct message as in the person's own
      // chat in Grasp (GRA-1920): their word, in their own store, which
      // nobody else reads, a team-mate in their own direct message
      // included.
      await chatAgentReadsBrain();
      const depot = `d${unique()}`;
      const word = markerWord();
      const statement = `Depot ${depot} opens at ${word}`;
      const ann = await teamsMember(
        idp,
        toolStep("remember", {
          about: { kind: "customer", name: `Depot ${depot}` },
          type: "fact",
          statement,
          quote: statement,
        }),
        says(JSON.stringify({ theirs: true })),
        says("Noted."),
        says("I don't know.")
      );
      const ben = await memberAnsweredBy(idp, ann.provider);
      const team = `team:${await newTeam(ann.userId, ben.userId)}`;
      await post(
        messageFrom(ann.teams, { text: `${statement}, for the record.` })
      );
      const own = personalBrainOf(
        inJurisdiction(env, env.BRAIN_STORE),
        ann.userId
      );
      const annReads = { person: ann.userId, groups: [] };
      const { entities: ownEntities } = await own.findEntities({
        reader: annReads,
        name: `Depot ${depot}`,
      });
      const ownKept = await Promise.all(
        ownEntities.map(async ({ id }) => {
          const { memories } = await own.readMemories({
            entity: id,
            reader: annReads,
          });
          return memories.map((memory) => memory.statement);
        })
      );
      /**
       * Whether the shared store gives `person`, in the team and the
       * company, anything holding the marker or naming the depot: what
       * other tests keep there may answer too, so never a count.
       */
      const sharedGives = async (person: string) => {
        const reader = { person, groups: [team, "company"] };
        const { items, memories } = await sharedStore().recall({
          question: `${word} depot ${depot}`,
          reader,
          budget: { tokens: recallBudgetMax },
        });
        const { entities } = await sharedStore().findEntities({
          reader,
          name: `Depot ${depot}`,
        });
        const given = JSON.stringify([...items, ...memories, ...entities]);
        return given.includes(word) || given.includes(depot);
      };
      const before = ann.provider.requests.length;
      await post(
        messageFrom(ben.teams, { text: `When does depot ${depot} open?` })
      );
      const toBen = ann.provider.requests.slice(before);

      expect({
        ownKept: ownKept.flat(),
        sharedGives: {
          ann: await sharedGives(ann.userId),
          ben: await sharedGives(ben.userId),
        },
        benAnswered: toBen.length > 0,
        benGotIt: JSON.stringify(toBen.map(({ body }) => body)).includes(word),
      }).toStrictEqual({
        ownKept: [statement],
        sharedGives: { ann: false, ben: false },
        benAnswered: true,
        benGotIt: false,
      });
    });

    // Last: it empties the shared store, as a loss of its storage would.
    it("gives away nothing of a company's export once it is restored into an empty store, memories and entities among it (GRA-1840)", async () => {
      await answeringProvider(() => {});
      const [admin, { userId: outsider }, { userId: insider }] =
        await Promise.all([
          signedInWithRole(idp, "admin"),
          signedInWithRole(idp, "user"),
          signedInWithRole(idp, "user"),
        ]);
      const secretTeam = await newTeam(insider);
      const ownTeam = await newTeam(outsider, insider);
      const sharedWord = `s${unique()}`;
      const markers = {
        "a team's source the outsider isn't in": markerWord(),
        "a team's memory the outsider isn't in": markerWord(),
        "a memory drawn from that team's source": markerWord(),
      };
      const {
        "a team's source the outsider isn't in": sourceMarker,
        "a team's memory the outsider isn't in": memoryMarker,
        "a memory drawn from that team's source": drawnMarker,
      } = markers;
      const secret = `team:${secretTeam}`;
      const own = `team:${ownTeam}`;
      const teamSource = await add(
        `Board minutes ${sharedWord} ${sourceMarker}`,
        {
          kind: "team",
          teamId: secretTeam,
        }
      );
      // The store's key of it, as core names a source to the Brain.
      const key = `${teamSource.producer}:${teamSource.id}`;
      const marked = (marker: string) => ({
        key: "c",
        kind: "customer" as const,
        names: [`${sharedWord} ${marker}`],
        identifiers: [{ type: "ref" as const, value: `ref:${marker}` }],
      });
      await sharedStore().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: secret },
        entities: [marked(memoryMarker)],
        memories: [
          {
            about: "c",
            attribute: "status",
            value: memoryMarker,
            type: "fact",
            statement: `${sharedWord} ${memoryMarker}`,
            speaker: { kind: "system" },
            basis: { kind: "writer", writer: insider },
          },
        ],
      });
      // Readable by a team the outsider is in, but drawn from a source of
      // a team they aren't: theirs neither.
      const drawn = await sharedStore().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: own },
        entities: [marked(drawnMarker)],
        memories: [
          {
            about: "c",
            type: "fact",
            statement: `${sharedWord} ${drawnMarker}`,
            speaker: { kind: "system" },
            basis: {
              kind: "source",
              source: key,
              version: 1,
              quote: sharedWord,
            },
          },
        ],
        extracted: { source: key, version: 1 },
      });
      const { id = "" } = await adminRequest(
        admin.session,
        brainExportsPath,
        {}
      );
      const exported = await tickedPast(
        admin.session,
        `${brainExportsPath}?id=${id}`,
        "writing"
      );

      // The shared store's storage lost, its bucket kept: as it was
      // before anything was added.
      await restoreStore(emptyStore);
      const started = await adminRequest(admin.session, brainRestorePath, {
        exportId: id,
      });
      const restored = await tickedPast(
        admin.session,
        `${brainRestorePath}?id=${id}`,
        "running"
      );
      // What the export held came back, for whoever may read it.
      const insiders = await sharedStore().readMemories({
        entity: drawn.entities.c ?? "",
        reader: { person: insider, groups: [own, secret] },
      });

      const findings = await findingsOf(
        "the outsider, after a restore of an export",
        {
          personId: outsider,
          reader: { person: outsider, groups: [own] },
          personal: true,
          sharedWord,
          markers: Object.values(markers),
          hiddenVersions: everyVersionOf(teamSource),
          hiddenInstructionFiles: [],
          instructionGroups: ["company"],
        },
        markers
      );
      const carried = await Promise.all(Object.values(markers).map(carrying));

      expect({
        exported,
        started: started.state,
        restored,
        insiders: insiders.memories.map(({ statement }) => statement),
        findings,
        prompted: carried.flat(),
      }).toStrictEqual({
        exported: "done",
        started: "running",
        restored: "done",
        insiders: [`${sharedWord} ${drawnMarker}`],
        findings: [],
        prompted: [],
      });
    });

    /**
     * Out of use (GRA-1915): a memory whose source's current version no
     * longer says its quote is out, and must reach no reader as current
     * through any surface, while its control, a memory the same version
     * still says, does (brain-next-out-reads.ts). A reader of a team's
     * source reads alike in a world with what they may not read (a team's
     * memories of the same source, or its version) and in its twin
     * without, the two written on one clock.
     */
    const outNames = [
      "out",
      "keep",
      "hidden out",
      "hidden keep",
      "rival",
      "out contact",
      "keep contact",
      "reached by out contact",
      "reached by keep contact",
    ];

    /** The memories a reader of the team may read, as a rich world plants them. */
    const visibleNames = [
      "out",
      "keep",
      "rival",
      "out contact",
      "keep contact",
      "reached by out contact",
      "reached by keep contact",
    ];

    /** A reader in a team, someone in that team and a hidden one, and how the Brain reads each. */
    const outReaders = async () => {
      const [{ userId: reader }, { userId: both }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const team = await newTeam(reader, both);
      const hiddenTeam = await newTeam(both);
      return {
        reader,
        both,
        team,
        hiddenTeam,
        teamReaders: { kind: "team", teamId: team } satisfies SourceReaders,
        readerReads: { person: reader, groups: [`team:${team}`, "company"] },
        bothReads: {
          person: both,
          groups: [`team:${team}`, `team:${hiddenTeam}`, "company"],
        },
      };
    };

    type OutReaders = Awaited<ReturnType<typeof outReaders>>;

    /** A world on a new source of a team's, and its twin, on one clock. */
    const worldAndTwin = () =>
      [
        newWorld("shared", newSource(), outNames),
        newWorld("shared", newSource(), outNames),
      ] as const;

    /** Adds `text` as `world`'s next version. */
    const version = async (
      world: OutWorld,
      text: string,
      readers: SourceReaders
    ) => {
      await add(text, readers, world.source);
    };

    /**
     * What `readers.reader` and the one in both teams read of `world` and
     * of `twin`, `versions` versions each: where each marker is current,
     * where the out one shows at all, and how the reader's reads differ
     * from the twin's.
     */
    const outcomeOf = async (
      readers: OutReaders,
      world: OutWorld,
      twin: OutWorld,
      versions: number
    ) => {
      const ours = await outReadsOf(
        readers.reader,
        readers.readerReads,
        world,
        versions
      );
      const theirs = await outReadsOf(
        readers.reader,
        readers.readerReads,
        twin,
        versions
      );
      const both = await outReadsOf(
        readers.both,
        readers.bothReads,
        world,
        versions
      );
      const marked = (name: string) => world.markers[name] ?? "";
      // The memories planted that state a marker of their own.
      const planted = Object.keys(world.memories).filter(
        (name) => name in world.markers
      );
      return {
        reader: {
          current: Object.fromEntries(
            visibleNames
              .filter((name) => planted.includes(name))
              .map((name) => [name, currentIn(ours, marked(name))])
          ),
          hidden: ["hidden out", "hidden keep"].flatMap((name) =>
            shownIn(ours, marked(name))
          ),
          unlikeTwin: await unlikeTwin(world, ours, twin, theirs),
        },
        both: Object.fromEntries(
          planted.map((name) => [name, currentIn(both, marked(name))])
        ),
        history: shownIn(ours, marked("out")),
        // What recall itself groups as contested, beside the page's.
        contestedInRecall: contestedInRecall(ours),
      };
    };

    /** Where a memory that is out shows to a reader of it: as history alone. */
    const historySurfaces = ["memories", "the Brain page's memories"];

    /**
     * The first version of each world for the team, saying both quotes,
     * and its memories, each in an add of its own, so a page or a card
     * orders them by when each was learned alone: the out one and its
     * control, and in a world with `hidden` a hidden team's two, with
     * `rich` a rival of the out one's one-value status in a writer's word
     * (which stays current), two contact relations, one out for good
     * (its quote no later version says) and one kept,
     * and a fact of each contact, which a reader reaches only along its
     * relation. Step by step, each step for every world before the next, so
     * the worlds' events come in the same order.
     */
    const plantFirst = async (
      readers: OutReaders,
      worlds: readonly { world: OutWorld; hidden: boolean }[],
      { rich = false }: { rich?: boolean } = {}
    ) => {
      const group = `team:${readers.team}`;
      const hiddenGroup = `team:${readers.hiddenTeam}`;
      const steps: ((world: OutWorld, hidden: boolean) => Promise<void>)[] = [
        async (world) => {
          await version(
            world,
            textHolding(world.depot, "out", "keep", "gone"),
            readers.teamReaders
          );
        },
        async (world) => {
          await remember(world, group, 1, {
            out: rich ? { quote: "out", attribute: "status" } : "out",
          });
        },
        async (world) => {
          await remember(world, group, 1, { keep: "keep" });
        },
        async (world, hidden) => {
          if (hidden) {
            await remember(world, hiddenGroup, 1, { "hidden out": "out" });
          }
        },
        async (world, hidden) => {
          if (hidden) {
            await remember(world, hiddenGroup, 1, { "hidden keep": "keep" });
          }
        },
        async (world) => {
          if (rich) {
            await remember(world, group, 1, {
              rival: { attribute: "status" },
            });
          }
        },
        async (world) => {
          if (rich) {
            await remember(world, group, 1, {
              "out contact": { quote: "gone", contact: "p1" },
            });
          }
        },
        async (world) => {
          if (rich) {
            await remember(world, group, 1, {
              "keep contact": { quote: "keep", contact: "p2" },
            });
          }
        },
        async (world) => {
          if (rich) {
            await remember(world, group, 1, {
              "reached by out contact": { quote: "keep", about: "p1" },
            });
            await remember(world, group, 1, {
              "reached by keep contact": { quote: "keep", about: "p2" },
            });
          }
        },
      ];
      for (const write of steps) {
        for (const { world, hidden } of worlds) {
          // oxlint-disable-next-line no-await-in-loop -- a step at a time, every world in it
          await write(world, hidden);
        }
      }
    };

    /** Each world's second version, at step 10: the out quote dropped. */
    const dropOut = async (readers: OutReaders, ...worlds: OutWorld[]) => {
      for (const world of worlds) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await version(
          world,
          textHolding(world.depot, "keep"),
          readers.teamReaders
        );
      }
    };

    /** Each world's first two versions and its memories (`plantFirst`, `dropOut`). */
    const outWorldOf = async (
      readers: OutReaders,
      worlds: readonly { world: OutWorld; hidden: boolean }[],
      options: { rich?: boolean } = {}
    ) => {
      await plantFirst(readers, worlds, options);
      await dropOut(readers, ...worlds.map(({ world }) => world));
    };

    /**
     * Two worlds whose memories are drawn from their first version once
     * the second is current, step by step: the out one and its control,
     * and the first world's hidden two.
     */
    const lateWorlds = async (
      readers: OutReaders,
      world: OutWorld,
      twin: OutWorld
    ) => {
      const group = `team:${readers.team}`;
      const hiddenGroup = `team:${readers.hiddenTeam}`;
      for (const each of [world, twin]) {
        // oxlint-disable-next-line no-await-in-loop -- a step at a time
        await version(
          each,
          textHolding(each.depot, "out", "keep"),
          readers.teamReaders
        );
      }
      await dropOut(readers, world, twin);
      for (const each of [world, twin]) {
        // oxlint-disable-next-line no-await-in-loop -- a step at a time
        await remember(each, group, 1, { out: "out" });
      }
      for (const each of [world, twin]) {
        // oxlint-disable-next-line no-await-in-loop -- a step at a time
        await remember(each, group, 1, { keep: "keep" });
      }
      await remember(world, hiddenGroup, 1, { "hidden out": "out" });
      await remember(world, hiddenGroup, 1, { "hidden keep": "keep" });
    };

    /** What every case expects once its memory is out: nothing current of it, its control current everywhere. */
    const outcomeOnceOut = {
      reader: {
        current: { out: [], keep: memorySurfaces },
        hidden: [],
        unlikeTwin: [],
      },
      both: {
        out: [],
        keep: memorySurfaces,
        "hidden out": [],
        "hidden keep": memorySurfaces,
      },
      history: historySurfaces,
      contestedInRecall: [],
    };

    it("gives no reader a memory current once its source's current version drops its quote, not as a contested value or a relation either, and every reader it again once a later one says it, whatever they may not read", async () => {
      const readers = await outReaders();
      const [world, twin] = worldAndTwin();
      await plantFirst(
        readers,
        [
          { world, hidden: true },
          { world: twin, hidden: false },
        ],
        { rich: true }
      );
      // Before: the out one's status contests its rival's.
      const before = await outReadsOf(
        readers.reader,
        readers.readerReads,
        world,
        1
      );
      await dropOut(readers, world, twin);
      const once = await outcomeOf(readers, world, twin, 2);
      for (const each of [world, twin]) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await version(
          each,
          textHolding(each.depot, "out", "keep"),
          readers.teamReaders
        );
      }
      const again = await outcomeOf(readers, world, twin, 3);
      // What the whole company may read, through an App's read too.
      const company = newWorld("shared", newSource(), outNames);
      const everyone: SourceReaders = { kind: "everyone" };
      await version(
        company,
        textHolding(company.depot, "out", "keep"),
        everyone
      );
      await remember(company, "company", 1, { out: "out" });
      await remember(company, "company", 1, { keep: "keep" });
      await version(company, textHolding(company.depot, "keep"), everyone);
      const companyReads = await outReadsOf(
        readers.reader,
        readers.readerReads,
        company,
        2
      );
      const marked = (name: string) => world.markers[name] ?? "";
      // Where a fact of a person reached along a current relation shows:
      // what recall finds by walking from the customer it names.
      const walkSurfaces = memorySurfaces.filter(
        (name) =>
          name.startsWith("recall") || name === "the Brain page's search"
      );
      // Where a current memory shows when it contests another, besides.
      const contestedToo = [
        ...memorySurfaces.slice(0, -1),
        "contested",
        ...memorySurfaces.slice(-1),
      ];

      expect({
        contestedBefore: ["out", "rival"].map((name) =>
          currentIn({ contested: before.contested }, marked(name))
        ),
        company: ["out", "keep"].map((name) =>
          currentIn(companyReads, company.markers[name] ?? "")
        ),
        once,
        again,
      }).toStrictEqual({
        contestedBefore: [["contested"], ["contested"]],
        company: [[], companyMemorySurfaces],
        once: {
          ...outcomeOnceOut,
          reader: {
            ...outcomeOnceOut.reader,
            current: {
              out: [],
              keep: memorySurfaces,
              rival: memorySurfaces,
              "out contact": [],
              "keep contact": memorySurfaces,
              "reached by out contact": [],
              "reached by keep contact": walkSurfaces,
            },
          },
          both: {
            ...outcomeOnceOut.both,
            rival: memorySurfaces,
            "out contact": [],
            "keep contact": memorySurfaces,
            "reached by out contact": [],
            "reached by keep contact": walkSurfaces,
          },
        },
        again: {
          reader: {
            current: {
              out: contestedToo,
              keep: memorySurfaces,
              rival: contestedToo,
              "out contact": [],
              "keep contact": memorySurfaces,
              "reached by out contact": [],
              "reached by keep contact": walkSurfaces,
            },
            hidden: [],
            unlikeTwin: [],
          },
          both: {
            out: contestedToo,
            keep: memorySurfaces,
            "hidden out": memorySurfaces,
            "hidden keep": memorySurfaces,
            rival: contestedToo,
            "out contact": [],
            "keep contact": memorySurfaces,
            "reached by out contact": [],
            "reached by keep contact": walkSurfaces,
          },
          // Current again, and so where every current memory shows.
          history: contestedToo,
          // Said again, the out memory contests its rival once more.
          contestedInRecall: [
            { attribute: "status", memories: ["out", "rival"] },
          ],
        },
      });
    });

    it("gives a reader nothing of a source whose current version they may not read, alike whether that version drops a quote, and its readers the memory out", async () => {
      const readers = await outReaders();
      const [world, twin] = worldAndTwin();
      const hiddenReaders: SourceReaders = {
        kind: "team",
        teamId: readers.hiddenTeam,
      };
      await plantFirst(readers, [
        { world, hidden: false },
        { world: twin, hidden: false },
      ]);
      // The current version, for a team the reader isn't in: the world's
      // drops the out quote, the twin's says it still.
      await version(world, textHolding(world.depot, "keep"), hiddenReaders);
      await version(
        twin,
        textHolding(twin.depot, "out", "keep"),
        hiddenReaders
      );
      const readerReads = async (each: OutWorld) =>
        await outReadsOf(readers.reader, readers.readerReads, each, 2);
      const bothReads = async (each: OutWorld) =>
        await outReadsOf(readers.both, readers.bothReads, each, 2);
      const [ours, theirs] = [
        await readerReads(world),
        await readerReads(twin),
      ];
      const [bothOurs, bothTheirs] = [
        await bothReads(world),
        await bothReads(twin),
      ];
      // Said again for the reader's team: theirs again, and current.
      await version(
        world,
        textHolding(world.depot, "out", "keep"),
        readers.teamReaders
      );
      const said = await readerReads(world);

      expect({
        nothing: ["out", "keep"].flatMap((name) =>
          shownIn(ours, world.markers[name] ?? "")
        ),
        unlikeTwin: await unlikeTwin(world, ours, twin, theirs),
        both: {
          world: currentIn(bothOurs, world.markers.out ?? ""),
          twin: currentIn(bothTheirs, twin.markers.out ?? ""),
          keep: currentIn(bothOurs, world.markers.keep ?? ""),
        },
        said: currentIn(said, world.markers.out ?? ""),
      }).toStrictEqual({
        nothing: [],
        unlikeTwin: [],
        both: { world: [], twin: memorySurfaces, keep: memorySurfaces },
        said: memorySurfaces,
      });
    });

    it("gives a person no memory of their own store current once their source's current version drops its quote, and nobody else any of it", async () => {
      const [{ userId: holder }, { userId: other }] = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      const world = newWorld("own", newSource(), outNames, holder);
      const theirs: SourceReaders = { kind: "owner", personId: holder };
      await version(world, textHolding(world.depot, "out", "keep"), theirs);
      await remember(world, "", 1, { out: "out" });
      await remember(world, "", 1, { keep: "keep" });
      await version(world, textHolding(world.depot, "keep"), theirs);
      const marked = (name: string) => world.markers[name] ?? "";
      const own = await outReadsOf(
        holder,
        { person: holder, groups: [] },
        world,
        2
      );
      const others = await outReadsOf(
        other,
        { person: other, groups: [] },
        world,
        2
      );

      expect({
        out: currentIn(own, marked("out")),
        keep: currentIn(own, marked("keep")),
        history: shownIn(own, marked("out")),
        others: ["out", "keep"].flatMap((name) =>
          shownIn(others, marked(name))
        ),
      }).toStrictEqual({
        out: [],
        keep: ownMemorySurfaces,
        history: historySurfaces,
        others: [],
      });
    });

    it("sends the model no memory out of use in what a person's chat recalls before a question, and the memory its version still says", async () => {
      // What the turn sends the model, through a Teams direct message:
      // not the chat's stored copy of it, which keeps what a turn handed
      // over while it was current, as it keeps what was narrowed since.
      await chatAgentReadsBrain();
      const ann = await teamsMember(idp, says("Noted."));
      const team = await newTeam(ann.userId);
      const world = newWorld("shared", newSource(), outNames);
      const teamReaders: SourceReaders = { kind: "team", teamId: team };
      await version(
        world,
        textHolding(world.depot, "out", "keep"),
        teamReaders
      );
      await remember(world, `team:${team}`, 1, { out: "out" });
      await remember(world, `team:${team}`, 1, { keep: "keep" });
      await version(world, textHolding(world.depot, "keep"), teamReaders);
      const before = ann.provider.requests.length;
      await post(
        messageFrom(ann.teams, { text: `What about depot ${world.depot}?` })
      );
      const sent = JSON.stringify(
        ann.provider.requests.slice(before).map(({ body }) => body)
      );

      expect({
        answered: ann.provider.requests.length > before,
        out: sent.includes(world.markers.out ?? ""),
        keep: sent.includes(world.markers.keep ?? ""),
      }).toStrictEqual({ answered: true, out: false, keep: true });
    });

    it("judges a late memory on an earlier version as it is added, for every reader alike, and confirms it as a memory nobody holds", async () => {
      const readers = await outReaders();
      const [world, twin] = worldAndTwin();
      await lateWorlds(readers, world, twin);
      const outcome = await outcomeOf(readers, world, twin, 2);
      // Last: a correction adds a memory of the reader's own.
      const writes = await writesOf(readers.reader, world, ["out", "keep"]);

      expect({
        outcome,
        out: writes.out,
        keep: writes.keep,
      }).toStrictEqual({
        outcome: outcomeOnceOut,
        // Confirmed as nobody's memory. A correction takes any memory the
        // reader may read, an ended one included (`correctAs`), so it
        // answers for the out one as for a current one: it tells them
        // nothing a read doesn't.
        out: {
          confirm: writes["nobody's"]?.confirm,
          correct: "corrected",
        },
        keep: { confirm: "done", correct: "corrected" },
      });
    });

    it("orders memories learned together alike, whatever a hidden memory of their source adds", async () => {
      const readers = await outReaders();
      const world = newWorld("shared", newSource(), outNames);
      await version(
        world,
        textHolding(world.depot, "out", "keep"),
        readers.teamReaders
      );
      // Learned in one add, as an extraction's are: one learning time, so
      // what orders them after it decides, and ties break by their own ids,
      // which a twin can't match. So the same world, before and after.
      await remember(world, `team:${readers.team}`, 1, {
        out: "out",
        keep: "keep",
      });
      const readAll = async () =>
        await outReadsOf(readers.reader, readers.readerReads, world, 1);
      const before = await readAll();
      await remember(world, `team:${readers.hiddenTeam}`, 1, {
        "hidden out": "out",
      });
      const after = await readAll();

      expect(
        Object.keys(before).filter(
          (surface) => textOf(before[surface]) !== textOf(after[surface])
        )
      ).toStrictEqual([]);
    });

    it("gives no reader a memory current once the catch-up judges what an older release's version and late memory left, an unfinished pass's included, and every reader alike before", async () => {
      const readers = await outReaders();
      const group = `team:${readers.team}`;
      const hiddenGroup = `team:${readers.hiddenTeam}`;
      const [versionWorld, versionTwin] = worldAndTwin();
      const [lateWorld, lateTwin] = worldAndTwin();
      const [passWorld, passTwin] = worldAndTwin();
      // An older release's version: the second, on the twins.
      await outWorldOf(readers, [
        { world: versionWorld, hidden: true },
        { world: versionTwin, hidden: false },
      ]);
      for (const each of [versionWorld, versionTwin]) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await asIfOlderVersion(each, 1);
      }
      // An older release's late memories on the first version.
      await lateWorlds(readers, lateWorld, lateTwin);
      for (const each of [lateWorld, lateTwin]) {
        for (const name of Object.keys(each.memories)) {
          // oxlint-disable-next-line no-await-in-loop -- one memory at a time
          await asIfOlderLate(each, name);
        }
      }
      // A pass under way past the second version's first memory, then an
      // older release's late memory on the first: behind the pass's place.
      const pass = [passWorld, passTwin];
      const eachOf = async (write: (world: OutWorld) => Promise<void>) => {
        for (const world of pass) {
          // oxlint-disable-next-line no-await-in-loop -- a step at a time
          await write(world);
        }
      };
      await eachOf(async (each) => {
        await version(
          each,
          textHolding(each.depot, "out", "keep"),
          readers.teamReaders
        );
      });
      await eachOf(async (each) => {
        await remember(each, group, 1, { keep: "keep" });
      });
      await eachOf(async (each) => {
        await version(
          each,
          `${textHolding(each.depot, "out", "keep")} Revised.`,
          readers.teamReaders
        );
      });
      await eachOf(async (each) => {
        await remember(each, group, 2, { "keep on the second": "keep" });
      });
      await eachOf(async (each) => {
        await remember(each, group, 2, { "keep after": "keep" });
      });
      await eachOf(async (each) => {
        await version(
          each,
          textHolding(each.depot, "keep"),
          readers.teamReaders
        );
        await midPass(each, "keep on the second", 2);
      });
      await eachOf(async (each) => {
        await remember(each, group, 1, { out: "out" });
        await asIfOlderLate(each, "out");
      });
      await remember(passWorld, hiddenGroup, 1, { "hidden out": "out" });
      await remember(passWorld, hiddenGroup, 1, { "hidden keep": "keep" });
      await asIfOlderLate(passWorld, "hidden out");
      await asIfOlderLate(passWorld, "hidden keep");
      const cases = {
        "an older release's version": [versionWorld, versionTwin, 2],
        "an older release's late memory": [lateWorld, lateTwin, 2],
        "a late memory behind an unfinished pass": [passWorld, passTwin, 3],
      } as const;
      const outcomes = async () => {
        const read: Record<string, Awaited<ReturnType<typeof outcomeOf>>> = {};
        for (const [name, [world, twin, versions]] of Object.entries(cases)) {
          // oxlint-disable-next-line no-await-in-loop -- one case at a time
          read[name] = await outcomeOf(readers, world, twin, versions);
        }
        return read;
      };
      const before = await outcomes();
      const ticks = await caughtUp(
        ...Object.values(cases).flatMap(([w, t]) => [w, t])
      );
      const after = await outcomes();

      expect({
        // Until its source is judged, a memory out reads current for
        // every reader alike: the twin rule holds, nothing more.
        before: Object.fromEntries(
          Object.entries(before).map(([name, outcome]) => [
            name,
            outcome.reader.unlikeTwin,
          ])
        ),
        caughtUp: ticks > 0,
        after,
      }).toStrictEqual({
        before: Object.fromEntries(
          Object.keys(cases).map((name) => [name, []])
        ),
        caughtUp: true,
        after: Object.fromEntries(
          Object.keys(cases).map((name) => [name, outcomeOnceOut])
        ),
      });
    });

    it("judges again after new word rules, a judged source and one part-way through a pass both, and after `memories` is made anew, for every reader alike", async () => {
      const readers = await outReaders();
      const [world, twin] = worldAndTwin();
      const [passWorld, passTwin] = worldAndTwin();
      for (const [one, other] of [
        [world, twin],
        [passWorld, passTwin],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one pair at a time
        await outWorldOf(readers, [
          { world: one, hidden: true },
          { world: other, hidden: false },
        ]);
      }
      for (const each of [passWorld, passTwin]) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await midPass(each, "keep", 1);
      }
      // The judged pair's judging held, so what the new rules leave of it
      // shows before the catch-up judges it again.
      const hold = "leaks_test_holds_the_judged";
      await inStoreOf("brain", (sql) => {
        sql.exec(
          `CREATE TRIGGER ${hold} BEFORE UPDATE OF judged_row ON current_versions
          WHEN NEW.source IN ('${world.key}', '${twin.key}') AND NEW.judged_row IS NOT NULL
          BEGIN SELECT RAISE(ABORT, 'held by the test'); END`
        );
      });
      onTestFinished(async () => {
        await inStoreOf("brain", (sql) => {
          sql.exec(`DROP TRIGGER IF EXISTS ${hold}`);
        });
      });
      // A release with new word rules: the rebuild starts on the next tick.
      // The pass pair's outcome doesn't depend on its place being cleared
      // (its pass ends the same from where it was); brain-next's own test
      // holds that new rules start an unfinished pass over.
      await inStoreOf("brain", (sql) => {
        sql.exec(
          "UPDATE word_index SET version = 0, target = 0, cursor = 0, memory_cursor = 0 WHERE id = 1"
        );
      });
      let words = "rebuilding";
      for (let ticks = 0; ticks < 30 && words !== "current"; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick();
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        ({ words } = await sharedStore().workOverview());
      }
      // The rules are set again only once a rebuild is done (words.ts).
      const rebuilt = (await wordRulesOf()) > 0;
      // Judged by the rules before: no judgment counts, for anyone alike.
      const between = await outcomeOf(readers, world, twin, 2);
      await inStoreOf("brain", (sql) => {
        sql.exec(`DROP TRIGGER ${hold}`);
      });
      await caughtUp(world, twin, passWorld, passTwin);
      const rules = {
        judged: await outcomeOf(readers, world, twin, 2),
        pass: await outcomeOf(readers, passWorld, passTwin, 2),
      };
      // A migration that makes `memories` anew: the cascade takes every in
      // and out row, and the migration clears every `judged_row`.
      await inStoreOf("brain", (sql) => {
        sql.exec("DELETE FROM memory_ins");
        sql.exec("DELETE FROM memory_outs");
        sql.exec("DELETE FROM memory_judging_places");
        sql.exec("UPDATE current_versions SET judged_row = NULL");
      });
      await caughtUp(world, twin);
      const anew = await outcomeOf(readers, world, twin, 2);

      expect({
        words,
        rebuilt,
        between: {
          out: between.reader.current.out,
          unlikeTwin: between.reader.unlikeTwin,
        },
        rules,
        anew,
      }).toStrictEqual({
        words: "current",
        rebuilt: true,
        between: { out: memorySurfaces, unlikeTwin: [] },
        rules: { judged: outcomeOnceOut, pass: outcomeOnceOut },
        anew: outcomeOnceOut,
      });
    });

    it("forgets the source the catch-up's turn and a pass hold once it is erased, or its upload removed, and judges the rest", async () => {
      const readers = await outReaders();
      const uploader = await signedInApi(idp, "user");
      await join(readers.team, uploader.userId);
      const [turnHeld, passHeld] = [
        newWorld("shared", newSource(), outNames),
        newWorld("shared", newSource(), outNames),
      ];
      const [rest, restTwin] = worldAndTwin();
      for (const each of [turnHeld, passHeld]) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await outWorldOf(readers, [{ world: each, hidden: false }]);
      }
      await outWorldOf(readers, [
        { world: rest, hidden: true },
        { world: restTwin, hidden: false },
      ]);
      // An upload of the team's, with memories on its first version.
      const uploadDepot = outWord("d");
      const { source: uploaded } = await uploader.api.brainSources.upload(
        transcriptOf(textHolding(uploadDepot, "out", "keep")),
        readers.teamReaders,
        crypto.randomUUID()
      );
      const upload = {
        ...newWorld("shared", uploaded, outNames),
        depot: uploadDepot,
      };
      await remember(upload, `team:${readers.team}`, 1, { out: "out" });
      await remember(upload, `team:${readers.team}`, 1, { keep: "keep" });
      await uploader.api.brainSources.uploadVersion(
        uploaded.id,
        transcriptOf(textHolding(uploadDepot, "keep")),
        crypto.randomUUID()
      );
      for (const each of [turnHeld, passHeld, upload, rest, restTwin]) {
        // oxlint-disable-next-line no-await-in-loop -- one world at a time
        await midPass(each, "out", 1);
      }
      await inStoreOf("brain", (sql) => {
        sql.exec(
          `INSERT INTO memory_judging (id, through, turn) VALUES (1, 0, ?1)
          ON CONFLICT (id) DO UPDATE SET turn = ?1`,
          turnHeld.key
        );
      });
      await eraseSource(env, {
        source: turnHeld.source,
        readers: readers.teamReaders,
        reason: "deleted",
      });
      await eraseSource(env, {
        source: passHeld.source,
        readers: readers.teamReaders,
        reason: "deleted",
      });
      await uploader.api.brainSources.deleteUpload(uploaded.id);
      const turn = await inStoreOf(
        "brain",
        (sql) =>
          sql
            .exec<{ turn: string | null }>(
              "SELECT turn FROM memory_judging WHERE id = 1"
            )
            .one().turn
      );
      const held = {
        turn: await tablesHolding(turnHeld.key),
        pass: await tablesHolding(passHeld.key),
      };
      await caughtUp(rest, restTwin);
      const gone = async (world: OutWorld) => {
        const reads = await outReadsOf(
          readers.reader,
          readers.readerReads,
          world,
          2
        );
        return ["out", "keep"].flatMap((name) =>
          shownIn(reads, world.markers[name] ?? "")
        );
      };

      expect({
        turn,
        held,
        gone: {
          turn: await gone(turnHeld),
          pass: await gone(passHeld),
          upload: await gone(upload),
        },
        rest: await outcomeOf(readers, rest, restTwin, 2),
      }).toStrictEqual({
        turn: null,
        held: { turn: [], pass: [] },
        gone: { turn: [], pass: [], upload: [] },
        rest: outcomeOnceOut,
      });
    });

    it("never puts out a memory of a thread or of a source kept whole, whatever its later versions say", async () => {
      const readers = await outReaders();
      const group = `team:${readers.team}`;
      const thread = newWorld("shared", newSource(), outNames);
      for (const [step, held] of [
        [1, ["out", "keep"]],
        [10, ["keep"]],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one message at a time
        await sharedStore().addSource({
          source: thread.key,
          change: crypto.randomUUID(),
          text: textHolding(thread.depot, ...held),
          access: { kind: "audience", group },
          thread: true,
        });
        if (step === 1) {
          // oxlint-disable-next-line no-await-in-loop -- once, on the first
          await remember(thread, group, 1, { out: "out" });
          // oxlint-disable-next-line no-await-in-loop -- once, on the first
          await remember(thread, group, 1, { keep: "keep" });
        }
      }
      const threadReads = await outReadsOf(
        readers.reader,
        readers.readerReads,
        thread,
        2
      );
      // A person's instruction file: kept whole, in their own store.
      const whole = newWorld(
        "own",
        { producer: "upload", id: crypto.randomUUID() },
        outNames,
        readers.reader
      );
      whole.key = `instructions:person:${readers.reader}`;
      const file: InstructionFile = {
        scope: "person",
        personId: readers.reader,
      };
      await addInstructionFile(env, {
        file,
        change: crypto.randomUUID(),
        text: textHolding(whole.depot, "out", "keep"),
        after: 0,
      });
      await remember(whole, "", 1, { out: "out" });
      await remember(whole, "", 1, { keep: "keep" });
      await addInstructionFile(env, {
        file,
        change: crypto.randomUUID(),
        text: textHolding(whole.depot, "keep"),
        after: 1,
      });
      // Core names no source of a memory that rests on an instruction
      // file (core never draws one), so it is read where it is kept.
      const wholeReader = { person: readers.reader, groups: [] };
      const wholeReads = {
        "the store's card": await ownStoreOf(readers.reader).readCard({
          entity: whole.entity,
          reader: wholeReader,
        }),
        "the store's memories": await ownStoreOf(readers.reader).readMemories({
          entity: whole.entity,
          reader: wholeReader,
        }),
      };
      expect({
        thread: currentIn(threadReads, thread.markers.out ?? ""),
        whole: currentIn(wholeReads, whole.markers.out ?? ""),
        wholeKeep: currentIn(wholeReads, whole.markers.keep ?? ""),
      }).toStrictEqual({
        thread: memorySurfaces,
        whole: ["the store's card", "the store's memories"],
        wholeKeep: ["the store's card", "the store's memories"],
      });
    });

    it("gives every reader alike a restored memory out before and during the catch-up, tick by tick, and none of them it current once it is done", async () => {
      await answeringProvider(() => {});
      const admin = await signedInWithRole(idp, "admin");
      const readers = await outReaders();
      // Five sources in the catch-up's key order: two world and twin pairs
      // around a gate, whose judging the test holds, so the catch-up stops
      // at it on each tick until the hold is lifted.
      const [first, firstTwin, gate, last, lastTwin] = Array.from(
        { length: 5 },
        () => crypto.randomUUID()
      )
        .toSorted()
        .map((id) => newWorld("shared", { producer: "upload", id }, outNames));
      if (
        first === undefined ||
        firstTwin === undefined ||
        gate === undefined ||
        last === undefined ||
        lastTwin === undefined
      ) {
        throw new Error("Five worlds");
      }
      for (const worlds of [
        [
          { world: first, hidden: true },
          { world: firstTwin, hidden: false },
        ],
        [{ world: gate, hidden: false }],
        [
          { world: last, hidden: true },
          { world: lastTwin, hidden: false },
        ],
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one clock at a time
        await outWorldOf(readers, worlds);
      }
      const { id = "" } = await adminRequest(
        admin.session,
        brainExportsPath,
        {}
      );
      const exported = await tickedPast(
        admin.session,
        `${brainExportsPath}?id=${id}`,
        "writing"
      );
      // The shared store's storage lost, its bucket kept, and the export
      // restored: no source judged, no in or out row.
      await restoreStore(emptyStore);
      await adminRequest(admin.session, brainRestorePath, { exportId: id });
      const restored = await tickedPast(
        admin.session,
        `${brainRestorePath}?id=${id}`,
        "running"
      );
      const hold = "leaks_test_holds_the_gate";
      await inStoreOf("brain", (sql) => {
        sql.exec(
          `CREATE TRIGGER ${hold} BEFORE UPDATE OF judged_row ON current_versions
          WHEN NEW.source = '${gate.key}' AND NEW.judged_row IS NOT NULL
          BEGIN SELECT RAISE(ABORT, 'held by the test'); END`
        );
      });
      // Gone whatever ends the test: a hold left would stop the shared
      // store's catch-up for every test after.
      onTestFinished(async () => {
        await inStoreOf("brain", (sql) => {
          sql.exec(`DROP TRIGGER IF EXISTS ${hold}`);
        });
      });
      const pairs = {
        first: [first, firstTwin],
        last: [last, lastTwin],
      } as const;
      /** Each pair's twin differences and whether each of its worlds is judged, as the reader reads now. */
      const state = async () => {
        const read: Record<string, unknown> = {};
        for (const [name, [world, twin]] of Object.entries(pairs)) {
          // oxlint-disable-next-line no-await-in-loop -- one pair at a time
          const outcome = await outcomeOf(readers, world, twin, 2);
          read[name] = {
            // oxlint-disable-next-line no-await-in-loop -- one pair at a time
            judged: await judged(world, twin),
            unlikeTwin: outcome.reader.unlikeTwin,
            out: outcome.reader.current.out,
          };
        }
        return read;
      };
      const before = await state();
      await tick();
      const firstTick = await state();
      await tick();
      const secondTick = await state();
      await inStoreOf("brain", (sql) => {
        sql.exec(`DROP TRIGGER ${hold}`);
      });
      await tick();
      const after = {
        first: await outcomeOf(readers, first, firstTwin, 2),
        last: await outcomeOf(readers, last, lastTwin, 2),
        gate: await judged(gate),
      };
      const pending = {
        judged: [false, false],
        unlikeTwin: [],
        out: memorySurfaces,
      };
      const done = { judged: [true, true], unlikeTwin: [], out: [] };

      expect({
        exported,
        restored,
        before,
        firstTick,
        secondTick,
        after,
      }).toStrictEqual({
        exported: "done",
        restored: "done",
        // Restored, nothing judged: every reader reads the out memories
        // current alike (the stated time, GRA-1915).
        before: { first: pending, last: pending },
        // The keys before the gate judged; the gate held.
        firstTick: { first: done, last: pending },
        // The keys after it, then the gate again.
        secondTick: { first: done, last: done },
        after: {
          first: outcomeOnceOut,
          last: outcomeOnceOut,
          gate: [true],
        },
      });
    });
  }
);
