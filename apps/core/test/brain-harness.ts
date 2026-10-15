import { sha256Hex } from "@grasp-os/shared/encoding";
/**
 * The Brain baseline's harness (GRA-295, experiment E01): loads the frozen
 * company of brain-corpus.ts into core through its public APIs, then asks
 * each task of brain-tasks.ts of a chat's agent under three arms, paired by
 * task and repeat:
 *
 * - `agent`: the current agent as it is, finding what it needs with its
 *   own Knowledge tools;
 * - `fullContext`: the same agent, given every section its person and agent
 *   may both read, within a fixed budget;
 * - `fullText`: the same agent, given the best sections of a Knowledge
 *   full-text search for the task's keywords.
 *
 * Every arm runs in the real Workspace object, through the real model
 * gateway and ledger, with the same model, tools, memory, permissions and
 * answer protocol; the harness reads Knowledge for the last two arms as the
 * person, through their own API, never past what they may read. Only the
 * model provider behind AI Gateway is swapped: brain-stub-model.ts in CI.
 *
 * Each trial records what reached the model, the answer, whether stored
 * state changed, its latency and its charged cost; brain-scoring.ts turns
 * that into the report. The run's identity pins what the comparison
 * depends on, so two runs are compared only when they share it.
 */
import { workspaceIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { pageMaxLimit } from "@grasp-os/shared/knowledge";
import type { KnowledgeRead } from "@grasp-os/shared/knowledge";
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { workspace } from "../src/durable-objects.ts";
import { gatewayConfig, model, pointAtGateway } from "./agent-chat.ts";
import { answeringGateway } from "./ai-gateway.ts";
import type { GatewayRequest } from "./ai-gateway.ts";
import { grantReviewed } from "./apps.ts";
import {
  compareArms,
  gateViolations,
  scoreTrial,
  seededRandom,
  summarizeArm,
} from "./brain-scoring.ts";
import type {
  ArmSummary,
  GateViolation,
  PairedComparison,
  TrialObservation,
  TrialScore,
} from "./brain-scoring.ts";
import {
  brainStubModel,
  modelStrings,
  searchedSections,
  stubReader,
} from "./brain-stub-model.ts";
import type { StubTurn } from "./brain-stub-model.ts";
import {
  brainCollections,
  brainDocuments,
  brainMemories,
  brainMemoryCanaries,
  brainPersonas,
  brainTeams,
  brainUpdates,
  brainWindows,
} from "./fixtures/brain-corpus.ts";
import type {
  BrainCollectionKey,
  BrainPersona,
  BrainWindow,
} from "./fixtures/brain-corpus.ts";
import {
  brainAdmissionProbes,
  brainSuiteVersion,
  brainTasks,
} from "./fixtures/brain-tasks.ts";
import type { BrainSplit, BrainTask } from "./fixtures/brain-tasks.ts";
import type { Idp } from "./idp.ts";
import { newTeam, readCollection } from "./knowledge.ts";
import { signedInApi } from "./sign-in.ts";

/** Bumped with any change to how the harness runs or measures a trial. */
export const brainHarnessVersion = "1";

export const brainArms = ["agent", "fullContext", "fullText"] as const;
export type BrainArm = (typeof brainArms)[number];

/**
 * Arms built to break the gate, to prove it holds: one hands the model a
 * section its person may not read, one changes stored state mid-trial.
 */
export const brainControls = ["leakyContext", "changesState"] as const;
export type BrainControl = (typeof brainControls)[number];

/**
 * The smallest change in completion worth acting on: five points. Smaller
 * differences are reported, never decided on.
 */
export const minimumMeaningfulGain = 0.05;

/** The most characters of sources the full-context arm hands the model. */
export const fullContextChars = 60_000;

/** The instructions every arm's question carries, so all answer alike. */
export const answerProtocol = [
  "Answer from what you can read in this chat: your memory, this conversation and Knowledge.",
  "Cite each source you used in square brackets: [path#heading], [memory] or [session].",
  "If those sources don't answer the question, start your reply with ABSTAIN: and say why.",
  "Don't save, change or send anything.",
].join("\n");

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A section handed to the model: where it is, and its text. */
interface Source {
  source: string;
  text: string;
}

const renderPrompt = (question: string, sources?: readonly Source[]) =>
  [
    answerProtocol,
    "",
    `Question: ${question}`,
    ...(sources === undefined
      ? []
      : [
          "",
          "Sources:",
          ...sources.map(({ source, text }) => `[source: ${source}]\n${text}`),
        ]),
  ].join("\n");

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

/** What must not reach a model, or the answer, in `task`. */
export const forbiddenIn = (task: BrainTask): string[] => {
  const unreadable = Object.values(brainDocuments).flatMap((document) =>
    "canary" in document && !mayRead(task.persona, document.collection)
      ? [document.canary]
      : []
  );
  const othersMemory = brainPersonas
    .filter((persona) => persona !== task.persona)
    .map((persona) => brainMemoryCanaries[persona]);
  return [...unreadable, ...othersMemory, ...(task.mustNotReach ?? [])];
};

/** The shared collections every persona's agent is granted, by key. */
const sharedCollections = Object.entries(brainCollections)
  .filter(([, { access }]) => access.type !== "private")
  .map(([key]) => key);

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

/** The digest of the sealed tasks, which `brainSealedDigests` pins. */
export const sealedDigest = async (): Promise<string> =>
  await digestOf(brainTasks.filter(({ split }) => split === "sealed"));

/** US dollars, as the model API reports them, in micros. */
const microsOf = (dollars: number): number => Math.round(dollars * 1_000_000);

/**
 * What stored state holds: every version of every document, every
 * collection and every permission. A trial that changes it changed
 * something no task asks for.
 */
const stateFingerprint = async (): Promise<string> => {
  const [versions, collections, permissions] = await Promise.all([
    env.KNOWLEDGE.prepare(
      "SELECT document_id, number, text FROM versions ORDER BY document_id, number"
    ).all(),
    env.KNOWLEDGE.prepare("SELECT id FROM collections ORDER BY id").all(),
    env.DB.prepare("SELECT id, status FROM permissions ORDER BY id").all(),
  ]);
  return await digestOf([
    versions.results,
    collections.results,
    permissions.results,
  ]);
};

export interface BrainCompany {
  admin: Person;
  people: Record<BrainPersona, Person>;
  /** Each collection's ID, by its key in brain-corpus.ts. */
  collections: Map<string, string>;
  /** Each document's ID and current version, by its key. */
  documents: Map<string, { id: string; version: number }>;
  /** The time and charged cost of loading the corpus: its index build. */
  build: { ms: number; costMicros: number };
}

/** What the deployment has charged for models this month, in micros. */
const charged = async (company: Pick<BrainCompany, "admin">) => {
  const { total } = await company.admin.api.models.spend();
  return microsOf(total);
};

/** Loads the corpus as it stands at `t0`, as its people would write it. */
export const setUpBrainCompany = async (idp: Idp): Promise<BrainCompany> => {
  const admin = await signedInApi(idp, "admin");
  const ana = await signedInApi(idp, "user");
  const bram = await signedInApi(idp, "user");
  const people: Record<BrainPersona, Person> = { ana, bram };
  const spentBefore = await charged({ admin });
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
    const created = await admin.api.knowledge.createCollection(
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
    const saved = await admin.api.knowledge.saveDocument({
      collectionId: held(collections, collection),
      path,
      text,
      ifVersion: 0,
    });
    documents.set(key, { id: saved.id, version: saved.currentVersion });
  }
  for (const persona of brainPersonas) {
    const person = people[persona];
    // oxlint-disable-next-line no-await-in-loop -- one person at a time
    const { personal } = await person.api.memory.collections();
    // oxlint-disable-next-line no-await-in-loop -- one person at a time
    await person.api.knowledge.saveDocument({
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
    collections,
    documents,
    build: { ms, costMicros: (await charged({ admin })) - spentBefore },
  };
};

/** Applies the updates of `window`, as the admin who owns the corpus. */
const applyWindow = async (company: BrainCompany, window: BrainWindow) => {
  const { admin } = company;
  for (const update of brainUpdates.filter((each) => each.window === window)) {
    const document = held(company.documents, update.document);
    const { collection, path } = brainDocuments[update.document];
    if (update.type === "save") {
      // oxlint-disable-next-line no-await-in-loop -- in order
      const saved = await admin.api.knowledge.saveDocument({
        collectionId: held(company.collections, collection),
        path,
        text: update.text,
        ifVersion: document.version,
      });
      document.version = saved.currentVersion;
    } else {
      const input = {
        type: "content" as const,
        documentIds: [document.id],
        terms: update.terms,
        reason: "erasure_request" as const,
      };
      // oxlint-disable-next-line no-await-in-loop -- in order
      const { token } = await admin.api.knowledge.preparePurge(input);
      // oxlint-disable-next-line no-await-in-loop -- in order
      await admin.api.knowledge.purge(input, token);
    }
  }
};

/** A person's current USER.md, or nothing while they have none. */
const userMemoryOf = async (person: Person): Promise<string> => {
  const { knowledge, memory } = person.api;
  const { personal } = await memory.collections();
  const { documents } = await knowledge.listDocuments(personal);
  const user = documents.find(({ path }) => path === "USER.md");
  if (user === undefined) {
    return "";
  }
  const { version } = await knowledge.getDocument(user.id);
  return version.text;
};

/** The current text of every corpus document, as stored: the source snapshot. */
const sourceDigest = async (company: BrainCompany): Promise<string> => {
  const texts: Record<string, string> = {};
  for (const [key, { path }] of Object.entries(brainDocuments)) {
    // oxlint-disable-next-line no-await-in-loop -- one document at a time
    const { version } = await company.admin.api.knowledge.getDocument(
      held(company.documents, key).id
    );
    texts[path] = version.text;
  }
  for (const persona of brainPersonas) {
    // oxlint-disable-next-line no-await-in-loop -- one person at a time
    texts[`${persona}/USER.md`] = await userMemoryOf(company.people[persona]);
  }
  return await digestOf(texts);
};

/** A section's place, as `path#heading`, the way answers cite it. */
const placeOf = (read: Pick<KnowledgeRead, "path" | "section">) =>
  `${read.path}#${read.section?.headings.at(-1) ?? ""}`;

const heading = /^#{1,6}\s+(?<title>.+)$/u;
const frontmatter = /^---\n[\s\S]*?\n---\n/u;

/** A whole document's sections, each under its own heading. */
const sectionsOf = (path: string, text: string): Source[] => {
  const sections: Source[] = [];
  let current: Source | undefined;
  for (const line of text.replace(frontmatter, "").split("\n")) {
    const title = heading.exec(line)?.groups?.title;
    if (title === undefined) {
      if (current !== undefined) {
        current.text = current.text === "" ? line : `${current.text}\n${line}`;
      }
    } else {
      current = { source: `${path}#${title}`, text: "" };
      sections.push(current);
    }
  }
  return sections.filter(({ text: body }) => body.trim() !== "");
};

/** Every document of a collection `person` may read, page by page. */
const documentsOf = async (person: Person, collectionId: string) => {
  const all: { id: string; path: string }[] = [];
  for (;;) {
    const after = all.at(-1)?.path;
    // oxlint-disable-next-line no-await-in-loop -- page after page
    const { documents } = await person.api.knowledge.listDocuments(
      collectionId,
      after === undefined ? {} : { after }
    );
    all.push(...documents);
    if (documents.length < pageMaxLimit) {
      return all;
    }
  }
};

/**
 * Every section of the shared collections `person` may read, in path
 * order, leaving out what doesn't fit in {@link fullContextChars}.
 */
const fullContextOf = async (
  company: BrainCompany,
  person: Person
): Promise<Source[]> => {
  const shared = new Set(
    sharedCollections.map((key) => held(company.collections, key))
  );
  const readable = await person.api.knowledge.listCollections();
  const sources: Source[] = [];
  let chars = 0;
  for (const collection of readable.filter(({ id }) => shared.has(id))) {
    // oxlint-disable-next-line no-await-in-loop -- one collection at a time
    for (const document of await documentsOf(person, collection.id)) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time
      const read = await person.api.knowledge.read(document.id);
      for (const section of sectionsOf(read.path, read.text)) {
        if (chars + section.text.length <= fullContextChars) {
          chars += section.text.length;
          sources.push(section);
        }
      }
    }
  }
  return sources;
};

/** The best sections for `query` in the shared collections `person` may read. */
const fullTextOf = async (
  company: BrainCompany,
  person: Person,
  query: string
): Promise<Source[]> => {
  const shared = new Set(
    sharedCollections.map((key) => held(company.collections, key))
  );
  const { hits } = await person.api.knowledge.search(query, { limit: 50 });
  const best = hits
    .filter(({ collectionId }) => shared.has(collectionId))
    .slice(0, searchedSections);
  return await Promise.all(
    best.map(async (hit) => {
      const read = await person.api.knowledge.read(hit.documentId, {
        section: hit.section,
      });
      return { source: placeOf(read), text: read.text };
    })
  );
};

/** A persona's Workspace object, its agent granted the shared collections. */
const workspaceOf = async (company: BrainCompany, persona: BrainPersona) => {
  const id = workspaceIdSchema.parse(crypto.randomUUID());
  const stub = workspace(env, id);
  const agent = { type: "agent" as const, agentId: id };
  for (const key of sharedCollections) {
    // oxlint-disable-next-line no-await-in-loop -- one grant at a time
    const { id: permissionId } = await company.admin.api.permissions.request(
      readCollection(
        agent,
        held(company.collections, key),
        `BRAIN_${key.toUpperCase()}`
      )
    );
    // oxlint-disable-next-line no-await-in-loop -- one grant at a time
    await grantReviewed(company.admin.api, permissionId);
  }
  return { persona, stub, agent };
};

/**
 * The run's one model provider, behind every persona's object: trials run
 * one at a time, so it answers for the trial under way.
 */
const providerOf = (respond: typeof stubReader) => {
  let turn: StubTurn = { phase: "prior" };
  const gateway = answeringGateway(respond(() => turn));
  return {
    gateway,
    setTurn: (next: StubTurn) => {
      turn = next;
    },
  };
};

type Provider = ReturnType<typeof providerOf>;

type Workspace = Awaited<ReturnType<typeof workspaceOf>>;

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

interface TrialPlan {
  arm: BrainArm | BrainControl;
  task: BrainTask;
  repeat: number;
  cold: boolean;
}

/** The sections a trial hands the model, or none for the agent arm. */
const sourcesFor = async (
  company: BrainCompany,
  { arm, task }: TrialPlan
): Promise<Source[] | undefined> => {
  const person = company.people[task.persona];
  if (arm === "agent") {
    return undefined;
  }
  if (arm === "fullContext") {
    return await fullContextOf(company, person);
  }
  const found = await fullTextOf(company, person, task.query);
  if (arm !== "leakyContext") {
    return found;
  }
  // A section of a document the person may not read, as a broken scope
  // would hand it over.
  const leaked = Object.values(brainDocuments).find(
    (document) =>
      "canary" in document && !mayRead(task.persona, document.collection)
  );
  return leaked === undefined
    ? found
    : [...found, { source: leaked.path, text: leaked.text }];
};

/** A change no task asks for: a note saved in the person's own collection. */
const changeState = async (company: BrainCompany, persona: BrainPersona) => {
  const person = company.people[persona];
  const { personal } = await person.api.memory.collections();
  await person.api.knowledge.saveDocument({
    collectionId: personal,
    path: `notes/control-${crypto.randomUUID()}.md`,
    text: "# Control\nChanged during a trial.",
    ifVersion: 0,
  });
};

const runTrial = async (
  company: BrainCompany,
  place: Workspace,
  provider: Provider,
  plan: TrialPlan
): Promise<TrialObservation> => {
  const { task, arm, repeat, cold } = plan;
  const person = company.people[task.persona];
  const { gateway, setTurn } = provider;
  // Every object of the class may share one env, and an evicted one gets
  // a new one: pointed at the provider before each trial.
  await pointAtGateway(place.stub, gateway);
  const chat = await place.stub.createChat(
    `Baseline ${task.id}`,
    person.userId,
    place.agent.agentId
  );
  const firstRequest = gateway.requests.length;
  const stateBefore = await stateFingerprint();
  const spentBefore = await charged(company);
  let answer = "";
  let failure: string | undefined;
  let started = performance.now();
  try {
    setTurn({ phase: "prior" });
    for (const said of task.priorTurns ?? []) {
      // oxlint-disable-next-line no-await-in-loop -- in order, as said
      await place.stub.ask(chat.id, { text: said, model });
    }
    // A cold question starts in a just-evicted object, its caches and
    // memory gone, after any earlier turns of its chat. Pointing it
    // constructs it again, so a fake provider's cold start leaves out the
    // constructor itself, which a run against a deployment measures.
    if (cold) {
      await evictDurableObject(place.stub);
      await pointAtGateway(place.stub, gateway);
    }
    // Timed from here, failed questions too: retrieval, then the agent.
    started = performance.now();
    const sources = await sourcesFor(company, plan);
    if (arm === "changesState") {
      await changeState(company, task.persona);
    }
    setTurn({ phase: "question", task, searches: arm === "agent" });
    const reply = await place.stub.ask(chat.id, {
      text: renderPrompt(task.question, sources),
      model,
    });
    ({ answer } = reply);
    if (reply.outcome !== "answered") {
      failure = `${reply.outcome}: ${reply.error ?? ""}`;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const latencyMs = performance.now() - started;
  const requests = gateway.requests.slice(firstRequest);
  return {
    taskId: task.id,
    arm,
    repeat,
    cold,
    answer,
    modelInput: requests.flatMap(({ body }) => modelStrings(body)).join("\n"),
    forbidden: forbiddenIn(task),
    stateChanged: (await stateFingerprint()) !== stateBefore,
    ...(failure === undefined ? {} : { error: failure }),
    latencyMs,
    costMicros: (await charged(company)) - spentBefore,
  };
};

/** The tools each agent request offered the model: the tool contract. */
const toolsOf = (request: GatewayRequest): unknown =>
  typeof request.body === "object" &&
  request.body !== null &&
  "tools" in request.body
    ? request.body.tools
    : null;

/** A seeded shuffle, so arms take turns going first without luck deciding. */
const shuffled = <T>(items: readonly T[], random: () => number): T[] => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const kept = result[index];
    const swapped = result[other];
    if (kept !== undefined && swapped !== undefined) {
      result[index] = swapped;
      result[other] = kept;
    }
  }
  return result;
};

export interface RunIdentity {
  suite: { version: string; digest: string; sealedDigest: string };
  /** The stored corpus at the start of each window it ran. */
  sources: Partial<Record<BrainWindow, string>>;
  model: { id: string; provider: string; gateway: string };
  /** Each distinct tool contract the agent's requests carried. */
  tools: string[];
  /** The skills the personas' catalogs list. */
  skills: string;
  /** Access, grants, gateway, protocol and budgets. */
  policy: string;
  harness: string;
  split: BrainSplit;
  repeats: number;
  seed: number;
}

export interface BrainReport {
  identity: RunIdentity;
  coverage: {
    families: Record<string, number>;
    languages: Record<string, number>;
    /** Probes specified but not runnable until Grasp has what they need. */
    unsupported: { requires: string; probes: number }[];
  };
  costs: {
    build: { ms: number; costMicros: number };
    updates: { window: BrainWindow; ms: number; costMicros: number }[];
    /** The baseline learns nothing: background learning costs nothing. */
    learningMicros: number;
  };
  arms: ArmSummary[];
  controls: ArmSummary[];
  comparisons: PairedComparison[];
  gate: { passed: boolean; violations: GateViolation[] };
  controlGate: { passed: boolean; violations: GateViolation[] };
  scores: TrialScore[];
}

export interface BrainRunOptions {
  split: BrainSplit;
  repeats: number;
  arms?: readonly BrainArm[];
  /** Controls to run, on `controlTasks` only, first repeat only. */
  controls?: readonly BrainControl[];
  controlTasks?: readonly string[];
  openSealed?: boolean;
  seed?: number;
  /** The model provider; the stub by default. */
  respond?: typeof stubReader;
  /** The provider's name in the run's identity. */
  providerName?: string;
}

const counts = (values: readonly string[]): Record<string, number> => {
  const counted: Record<string, number> = {};
  for (const value of values) {
    counted[value] = (counted[value] ?? 0) + 1;
  }
  return counted;
};

/** Runs the baseline on a company loaded at `t0`, window by window. */
export const runBrainBaseline = async (
  company: BrainCompany,
  {
    split,
    repeats,
    arms = brainArms,
    controls = [],
    controlTasks = [],
    openSealed = false,
    seed = 295,
    respond = stubReader,
    providerName = brainStubModel,
  }: BrainRunOptions
): Promise<BrainReport> => {
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new RangeError("The baseline needs at least one repeat");
  }
  const tasks = tasksOf(split, { openSealed });
  const random = seededRandom(seed);
  const provider = providerOf(respond);
  const places = new Map<BrainPersona, Workspace>();
  for (const persona of brainPersonas) {
    // oxlint-disable-next-line no-await-in-loop -- one workspace at a time
    places.set(persona, await workspaceOf(company, persona));
  }
  const observations: TrialObservation[] = [];
  const sources: RunIdentity["sources"] = {};
  const updates: BrainReport["costs"]["updates"] = [];
  for (const window of brainWindows) {
    if (window !== "t0") {
      // oxlint-disable-next-line no-await-in-loop -- windows in order
      const spentBefore = await charged(company);
      const started = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- windows in order
      await applyWindow(company, window);
      updates.push({
        window,
        ms: performance.now() - started,
        // oxlint-disable-next-line no-await-in-loop -- windows in order
        costMicros: (await charged(company)) - spentBefore,
      });
    }
    // oxlint-disable-next-line no-await-in-loop -- windows in order
    sources[window] = await sourceDigest(company);
    const inWindow = tasks.filter((task) => task.window === window);
    const plans: TrialPlan[] = [];
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      // Odd repeats start each trial in a just-evicted object: cold.
      const cold = repeat % 2 === 1;
      const paired = inWindow.flatMap((task) =>
        arms.map((arm) => ({ arm, task, repeat, cold }))
      );
      const controlled =
        repeat === 1
          ? inWindow
              .filter(({ id }) => controlTasks.includes(id))
              .flatMap((task) =>
                controls.map((arm) => ({ arm, task, repeat, cold }))
              )
          : [];
      plans.push(...shuffled([...paired, ...controlled], random));
    }
    for (const plan of plans) {
      observations.push(
        // oxlint-disable-next-line no-await-in-loop -- trials one at a time, so latency and state are each trial's own
        await runTrial(company, held(places, plan.task.persona), provider, plan)
      );
    }
  }
  const byId = new Map(brainTasks.map((task) => [task.id, task]));
  const scores = observations.flatMap((observed) => {
    const task = byId.get(observed.taskId);
    return task === undefined ? [] : [scoreTrial(task.expect, observed)];
  });
  const scoresOf = (arm: string) => scores.filter((score) => score.arm === arm);
  const armScores = scores.filter(({ arm }) =>
    brainArms.some((each) => each === arm)
  );
  const controlScores = scores.filter(({ arm }) =>
    brainControls.some((each) => each === arm)
  );
  const pairs: [BrainArm, BrainArm][] = [
    ["fullContext", "agent"],
    ["fullText", "agent"],
    ["fullContext", "fullText"],
  ];
  const toolContracts = await Promise.all(
    provider.gateway.requests.map(
      async (request) => await digestOf(toolsOf(request))
    )
  );
  const catalogs = await Promise.all(
    brainPersonas.map(async (persona) => {
      const { skills } = await company.people[persona].api.knowledge.catalog();
      return skills.map(({ name, description }) => ({ name, description }));
    })
  );
  const violations = gateViolations(armScores);
  const controlViolations = gateViolations(controlScores);
  return {
    identity: {
      suite: {
        version: brainSuiteVersion,
        digest: await digestOf({
          collections: brainCollections,
          documents: brainDocuments,
          memories: brainMemories,
          updates: brainUpdates,
          tasks: brainTasks,
          probes: brainAdmissionProbes,
        }),
        sealedDigest: await sealedDigest(),
      },
      sources,
      model: {
        id: model,
        provider: providerName,
        gateway: gatewayConfig.gateway,
      },
      tools: [...new Set(toolContracts)].toSorted(),
      skills: await digestOf(catalogs),
      policy: await digestOf({
        collections: brainCollections,
        teams: brainTeams,
        grants: sharedCollections.map((key) => ({ key, actions: ["read"] })),
        gateway: gatewayConfig,
        protocol: answerProtocol,
        budgets: { searchedSections, fullContextChars },
      }),
      harness: brainHarnessVersion,
      split,
      repeats,
      seed,
    },
    coverage: {
      families: counts(tasks.map(({ family }) => family)),
      languages: counts(tasks.map(({ language }) => language)),
      unsupported: [
        {
          requires: "interview-admission",
          probes: brainAdmissionProbes.length,
        },
      ],
    },
    costs: { build: company.build, updates, learningMicros: 0 },
    arms: arms.map((arm) => summarizeArm(arm, scoresOf(arm))),
    controls: controls.map((arm) => summarizeArm(arm, scoresOf(arm))),
    comparisons: pairs
      .filter(
        ([candidate, baseline]) =>
          arms.includes(candidate) && arms.includes(baseline)
      )
      .map(([candidate, baseline]) =>
        compareArms(
          { arm: candidate, scores: scoresOf(candidate) },
          { arm: baseline, scores: scoresOf(baseline) },
          minimumMeaningfulGain,
          seed
        )
      ),
    gate: { passed: violations.length === 0, violations },
    controlGate: {
      passed: controlViolations.length === 0,
      violations: controlViolations,
    },
    scores,
  };
};
