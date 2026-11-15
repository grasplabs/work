/**
 * The Brain corpus's company (GRA-295): loads the frozen company of
 * brain-corpus.ts into core through its public APIs, for experiment E02;
 * the suite's tasks and digests; and what a run is charged. The baseline
 * that asked its tasks of a chat's agent reading Knowledge (experiment
 * E01), and the permission probes asked of that agent (GRA-731), went with
 * that reach (GRA-1735).
 */
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { purgedMarker } from "@grasp-os/shared/knowledge";
import { z } from "zod";

import { usageRecorded } from "../src/model-usage.ts";
import { searchedSections, transcriptOf } from "./brain-stub-model.ts";
import type { StubTurn, TranscriptPart } from "./brain-stub-model.ts";
import {
  brainCollections,
  brainDocuments,
  brainMemories,
  brainMemorySecrets,
  brainPersonas,
  brainTeams,
  brainUpdates,
} from "./fixtures/brain-corpus.ts";
import type {
  BrainCollectionKey,
  BrainPersona,
  BrainUpdate,
  BrainWindow,
} from "./fixtures/brain-corpus.ts";
import { brainAdmissionProbes, brainTasks } from "./fixtures/brain-tasks.ts";
import type { BrainSplit, BrainTask } from "./fixtures/brain-tasks.ts";
import type { Idp } from "./idp.ts";
import { saveInstructions } from "./instruction-saves.ts";
import {
  newTeam,
  ownCollectionOf,
  seed as seedKnowledge,
} from "./knowledge.ts";
import type { ProviderReply, SentRequest } from "./model-provider.ts";
import { spentMicros } from "./model-usage.ts";
import { signedInApi } from "./sign-in.ts";

/**
 * The smallest change in completion worth acting on: five points. Smaller
 * differences are reported, never decided on.
 */
export const minimumMeaningfulGain = 0.05;

/** The most characters of sources the full-context arm hands the model. */
export const fullContextChars = 60_000;

/**
 * The instructions every arm answers by, so all answer alike: the
 * company's instruction file, in every chat's system prompt, never in
 * the question. The person's message is what they typed, as in the
 * product, so whatever the platform reads from it (a recall's query)
 * reads only that.
 */
export const answerProtocol = [
  "Answer from what you can read in this chat: your memory, this conversation and Knowledge.",
  "Cite each source you used in square brackets: [path#heading], [memory] or [session].",
  "Start your reply with a line ANSWER: followed by only the answer's values (names, numbers, dates, codes), in the order the question asks for them, separated by semicolons; explain after it.",
  "Give each value on its own, without words around it: for a shift from 05:15 to 13:15, ANSWER: 05:15; 13:15.",
  "If those sources don't answer the question, start your reply with ABSTAIN: instead and say why.",
  "Don't save, change or send anything.",
].join("\n");

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** Whether `persona` may read `collection`, as the corpus declares it. */
const mayRead = (persona: BrainPersona, collection: BrainCollectionKey) => {
  const { access } = brainCollections[collection];
  if (access.type === "everyone") {
    return true;
  }
  if (access.type === "private") {
    return false;
  }
  const members: readonly BrainPersona[] = brainTeams[access.team];
  return members.includes(persona);
};

/** What must not reach a model, or the answer, anywhere in `task`. */
export const forbiddenIn = (task: BrainTask): string[] => {
  const unreadable = Object.values(brainDocuments).flatMap((document) =>
    "canary" in document && !mayRead(task.persona, document.collection)
      ? [document.canary, ...document.restricted]
      : []
  );
  const othersMemory = brainPersonas
    .filter((persona) => persona !== task.persona)
    .flatMap((persona) => brainMemorySecrets[persona]);
  return [...unreadable, ...othersMemory, ...(task.mustNotReach ?? [])];
};

/** `map`'s value for `key`, which the harness put there itself. */
const held = <K, V>(map: ReadonlyMap<K, V>, key: K): V => {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`The Brain harness holds nothing for ${String(key)}`);
  }
  return value;
};

const asJson = (value: unknown): Json => z.json().parse(value);

const digestOf = async (value: unknown): Promise<string> =>
  await sha256Hex(canonicalJson(asJson(value)));

/**
 * The digest of the whole suite, which `brainSuiteDigests` pins: the
 * corpus, its audiences and secrets, the tasks and probes, the answer
 * protocol and the retrieval budgets.
 */
export const suiteDigest = async (): Promise<string> =>
  await digestOf({
    collections: brainCollections,
    teams: brainTeams,
    documents: brainDocuments,
    memories: brainMemories,
    memorySecrets: brainMemorySecrets,
    updates: brainUpdates,
    tasks: brainTasks,
    probes: brainAdmissionProbes,
    protocol: answerProtocol,
    budgets: { searchedSections, fullContextChars },
  });

/**
 * The digest of the sealed tasks and the documents they ask about, which
 * `brainSealedDigests` pins. Sealed means unchangeable within a version,
 * not unseen: the cases are in the repository for anyone to read.
 */
export const sealedDigest = async (): Promise<string> => {
  const sealed = brainTasks.filter(({ split }) => split === "sealed");
  const keys = new Set<string>(sealed.flatMap(({ documents }) => documents));
  return await digestOf({
    tasks: sealed,
    // The documents their answers come from, and every change to them.
    documents: Object.entries(brainDocuments).filter(([key]) => keys.has(key)),
    updates: brainUpdates.filter(({ document }) => keys.has(document)),
  });
};

export interface BrainCompany {
  admin: Person;
  people: Record<BrainPersona, Person>;
  /** Each team's ID, by its key in brain-corpus.ts. */
  teams: Map<string, string>;
  /** Each collection's ID, by its key in brain-corpus.ts. */
  collections: Map<string, string>;
  /** Each document's ID and current version, by its key. */
  documents: Map<string, { id: string; version: number }>;
  /** The time and charged cost of loading the corpus: its index build. */
  build: { ms: number; costMicros: number };
  /**
   * Collections beyond the frozen shared ones that each persona's agent is
   * granted, by key in `collections`: the scale run's distractor teams
   * (brain-scale.ts). The retrieval arms read them as the person, too.
   */
  granted?: readonly string[];
}

/**
 * The month the run's model calls count in, whatever the clock says: a
 * run across midnight at a month's end still reads one total.
 */
export const brainBudgetMonth = "2400-01";

/**
 * What the run's model calls cost, in micros, once the gateway's records
 * of them, written in the background after each answer
 * (src/model-usage.ts, `usageRecorded`), are written.
 */
export const charged = async (): Promise<number> => {
  await usageRecorded();
  return await spentMicros(brainBudgetMonth);
};

/** Loads the corpus as it stands at `t0`, as its people would write it. */
export const setUpBrainCompany = async (idp: Idp): Promise<BrainCompany> => {
  const admin = await signedInApi(idp, "admin");
  const ana = await signedInApi(idp, "user");
  const bram = await signedInApi(idp, "user");
  const people: Record<BrainPersona, Person> = { ana, bram };
  const spentBefore = await charged();
  const started = performance.now();
  const teams = new Map<string, string>();
  for (const [team, members] of Object.entries(brainTeams)) {
    teams.set(
      team,
      // oxlint-disable-next-line no-await-in-loop -- one team at a time
      await newTeam(
        admin,
        members.map((persona) => ({ userId: people[persona].userId }))
      )
    );
  }
  const collections = new Map<string, string>();
  for (const [key, { name, description, access }] of Object.entries(
    brainCollections
  )) {
    // oxlint-disable-next-line no-await-in-loop -- one collection at a time
    const created = await seedKnowledge(admin.api).createCollection(
      access.type === "team"
        ? {
            name,
            description,
            access: "teams",
            teams: [held(teams, access.team)],
          }
        : {
            name,
            description,
            access: access.type === "everyone" ? "everyone" : "me",
          }
    );
    collections.set(key, created.id);
  }
  const documents = new Map<string, { id: string; version: number }>();
  for (const [key, { collection, path, text }] of Object.entries(
    brainDocuments
  )) {
    // oxlint-disable-next-line no-await-in-loop -- saves in order
    const saved = await seedKnowledge(admin.api).saveDocument({
      collectionId: held(collections, collection),
      path,
      text,
      ifVersion: 0,
    });
    documents.set(key, { id: saved.id, version: saved.currentVersion });
  }
  // The answer protocol, as the company's instructions every chat starts
  // with.
  await saveInstructions(
    admin.api,
    { scope: "company", name: "instructions" },
    answerProtocol
  );
  for (const persona of brainPersonas) {
    const person = people[persona];
    // Their own instruction file, which their chats start with; and the
    // same text as a USER.md in their Personal collection, the private
    // document the permission probes read (permission-probing.ts).
    // oxlint-disable-next-line no-await-in-loop -- one person at a time
    await saveInstructions(
      person.api,
      { scope: "person", personId: person.userId },
      brainMemories[persona]
    );
    // oxlint-disable-next-line no-await-in-loop -- one person at a time
    const personal = await ownCollectionOf(person);
    // oxlint-disable-next-line no-await-in-loop -- one person at a time
    await seedKnowledge(person.api).saveDocument({
      collectionId: personal,
      path: "USER.md",
      text: brainMemories[persona],
      ifVersion: 0,
    });
  }
  const ms = performance.now() - started;
  return {
    admin,
    people,
    teams,
    collections,
    documents,
    build: { ms, costMicros: (await charged()) - spentBefore },
  };
};

/**
 * The text `update` saves over document `documentId`: its own, or, for a
 * removal, the text as it stands with its terms taken out. The term purge
 * went with the cutover (decision B): an admin edits a document instead.
 */
const textOfUpdate = async (
  admin: BrainCompany["admin"],
  documentId: string,
  update: BrainUpdate
): Promise<string> => {
  if (update.type === "save") {
    return update.text;
  }
  const { version } = await admin.api.knowledge.getDocument(documentId);
  let { text } = version;
  for (const term of update.terms) {
    text = text.replaceAll(term, purgedMarker);
  }
  return text;
};

/** Applies the updates of `window`, as the admin who owns the corpus. */
export const applyWindow = async (
  company: BrainCompany,
  window: BrainWindow
) => {
  const { admin } = company;
  for (const update of brainUpdates.filter((each) => each.window === window)) {
    const document = held(company.documents, update.document);
    const { collection, path } = brainDocuments[update.document];
    // oxlint-disable-next-line no-await-in-loop -- in order
    const text = await textOfUpdate(admin, document.id, update);
    // oxlint-disable-next-line no-await-in-loop -- in order
    const saved = await seedKnowledge(admin.api).saveDocument({
      collectionId: held(company.collections, collection),
      path,
      text,
      ifVersion: document.version,
    });
    document.version = saved.currentVersion;
  }
};

/** A model provider: what it answers each request with, in a turn. */
export type BrainProvider = (
  turn: () => StubTurn
) => (
  requests: readonly SentRequest[]
) => ProviderReply | Promise<ProviderReply>;

/** The model the organization chose and its chats ask: the tests' model, by default. */
export interface BrainModelSetup {
  model: string;
}

/** The tasks of `split`; the sealed split only when it is opened on purpose. */
export const tasksOf = (
  split: BrainSplit,
  { openSealed = false }: { openSealed?: boolean } = {}
): BrainTask[] => {
  if (split === "sealed" && !openSealed) {
    throw new Error(
      "The sealed split runs only in a final run that opens it on purpose"
    );
  }
  return brainTasks.filter((task) => task.split === split);
};

/**
 * Every request's parts, in order, each tool result backed by what the
 * reads of its call's step returned: those recorded between the request
 * that ran the step and the first request to carry its result back, when
 * that step ran that one call alone.
 */
export const transcriptWithReads = (
  requests: readonly SentRequest[],
  reads: readonly (readonly string[])[]
): TranscriptPart[] => {
  const backings = new Map<string, readonly string[]>();
  return requests.flatMap(({ body }, index) => {
    const parts = transcriptOf(body);
    const fresh = parts.filter(
      ({ by, call }) =>
        by === "tool" && call !== undefined && !backings.has(call)
    );
    // Several calls of one step share its reads, which the log can't tell
    // apart: none of them is backed, rather than one by another's read.
    for (const { call } of fresh) {
      if (call !== undefined) {
        backings.set(call, fresh.length === 1 ? (reads[index] ?? []) : []);
      }
    }
    return parts.map((part) =>
      part.by === "tool" && part.call !== undefined
        ? { ...part, backing: backings.get(part.call) ?? [] }
        : part
    );
  });
};
