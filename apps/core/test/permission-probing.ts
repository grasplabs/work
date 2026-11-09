/**
 * The permission probes' harness (GRA-731), shared by the files that ask
 * them: the company they are asked in, the stand-in model that tries every
 * read it can, and how a probe is asked through `Workspace.ask` and through
 * the Teams door. Each file makes its own IdP and door (`mockIdp()`,
 * `watched()`), which register its hooks, and its own company with
 * `companyOnce`.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { doorClock } from "../src/channels/door.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { model } from "./agent-chat.ts";
import {
  grantCollection,
  setUpBrainCompany,
  workspaceOf,
} from "./brain-harness.ts";
import type { BrainCompany } from "./brain-harness.ts";
import {
  codeStep,
  modelStrings,
  resultsSinceQuestion,
  says,
  transcriptOf,
} from "./brain-stub-model.ts";
import {
  brainCollections,
  brainDocuments,
  brainMemorySecrets,
} from "./fixtures/brain-corpus.ts";
import type { BrainPersona } from "./fixtures/brain-corpus.ts";
import {
  isDocument,
  memoryOwnerOf,
  permissionProbes,
  unreadableTo,
} from "./fixtures/permission-probes.ts";
import type {
  PermissionProbe,
  ProbeTactic,
  ProbeTarget,
} from "./fixtures/permission-probes.ts";
import { mockIdp } from "./idp.ts";
import type { Idp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import type { SentRequest } from "./model-provider.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { auditedDuring, outcome, signedInApi } from "./sign-in.ts";
import {
  messageFrom,
  onRoster,
  post,
  reached,
  teamsPerson,
  watched,
} from "./teams-door.ts";
import type { TeamsPerson } from "./teams-door.ts";

/** Every probe runs a turn or two: a file of them takes a while. */
export const probeTime = { timeout: 600_000 };

/** What the stand-in answers once its reads came back. */
export const refusal = "I can't share that with you.";

/** Strings a target holds that its reader alone may see. */
export const secretsOf = (target: ProbeTarget): readonly string[] => {
  if (isDocument(target)) {
    const document = brainDocuments[target];
    return "canary" in document
      ? [document.canary, ...document.restricted]
      : [];
  }
  const owner = memoryOwnerOf(target);
  return owner === null ? [] : brainMemorySecrets[owner];
};

/** What must not reach a model or the answer for `asker`, whatever they ask. */
const forbiddenFor = (asker: BrainPersona): string[] =>
  unreadableTo[asker].flatMap(secretsOf);

/**
 * The colleague HR's sick notes name, whom no question names: never named
 * to someone who may not read them.
 */
export const colleaguesInHrNotes = ["Karin Aydin"];

/**
 * Code that tries every read a chat's agent has for `queries` and `ids`.
 * It hands back what each read returned and nothing it was asked with, so
 * what reaches the model past its own code is what the reads let through.
 */
const probingCode = (
  queries: readonly string[],
  ids: readonly string[]
): string => `export default async (self, env) => {
  const seen = [];
  const attempt = async (run) => {
    try {
      seen.push(JSON.stringify(await run()));
    } catch (error) {
      seen.push("refused: " + String(error?.message ?? error));
    }
  };
  await attempt(() => env.knowledge.catalog());
  for (const query of ${JSON.stringify(queries)}) {
    await attempt(async () => {
      const { hits } = await env.knowledge.search(query, { limit: 10 });
      const reads = [];
      for (const hit of hits) {
        reads.push(await env.knowledge.read(hit.documentId, { section: hit.section }));
      }
      return { hits, reads };
    });
    await attempt(async () => (await env.knowledge.recall({ query })).items);
  }
  for (const id of ${JSON.stringify(ids)}) {
    await attempt(() => env.knowledge.read(id));
  }
  return seen.join("\\n");
};`;

interface Probing {
  queries: readonly string[];
  ids: readonly string[];
}

/**
 * The model behind every Workspace in a file's company: for the probing
 * under way, it runs the probing code once, then refuses.
 */
const prober = async () => {
  let current: Probing = { queries: [], ids: [] };
  const provider = await answeringProvider((requests) => {
    const body = requests.at(-1)?.body;
    const input = modelStrings(body).join("\n");
    return resultsSinceQuestion(body).length === 0
      ? codeStep(probingCode(current.queries, current.ids), input)
      : says(refusal, input);
  });
  return {
    provider,
    probing: (next: Probing) => {
      current = next;
    },
  };
};

/**
 * What reached the model from request `from` on, as one text: the system
 * prompt, what the person said and what tools returned, never the
 * model's own code or words.
 */
export const sentSince = (requests: readonly SentRequest[], from: number) =>
  requests
    .slice(from)
    .flatMap(({ body }) => transcriptOf(body))
    .filter(({ by }) => by !== "model")
    .map(({ text }) => text)
    .join("\n");

/** Which of `forbidden` is in `text`. */
export const leaksIn = (text: string, forbidden: readonly string[]): string[] =>
  forbidden.filter((secret) => text.includes(secret));

/**
 * The door's limit is per sender (src/channels/door.ts): one message
 * every three seconds once ten went at once. Each message comes a little
 * later than the last by the door's own clock (`doorClock`), so a
 * person's sixty probes in a row are each taken, without waiting for
 * them. Only the door's clock moves: the real one also dates the grant
 * core signs for each model call, which connect checks by its own. The
 * files that share a worker share this module (and so `doorAhead`),
 * which only ever moves on, as the door's buckets remember the last.
 */
let doorAhead = 0;
export const later = () => {
  doorAhead += 3100;
};

/**
 * Runs the door's clock `doorAhead` ahead in each of a describe's tests:
 * the mock IdP restores every mock after each test.
 */
export const doorClockRunsAhead = () => {
  beforeEach(() => {
    vi.spyOn(doorClock, "now").mockImplementation(() => Date.now() + doorAhead);
  });
};

export interface Company {
  brain: BrainCompany;
  model: Awaited<ReturnType<typeof prober>>;
  /** Each persona's own Workspace and agent, granted the shared collections. */
  places: Record<BrainPersona, Awaited<ReturnType<typeof workspaceOf>>>;
  /** Each persona on Teams. */
  teams: Record<BrainPersona, TeamsPerson>;
  /** Each persona's USER.md, by its document ID. */
  memories: Record<BrainPersona, string>;
  removed: Awaited<ReturnType<typeof signedInApi>>;
  removedOnTeams: TeamsPerson;
  guestOnTeams: TeamsPerson;
}

const memoryIdOf = async (
  person: Awaited<ReturnType<typeof signedInApi>>
): Promise<string> => {
  const { personal } = await person.api.memory.collections();
  const { documents } = await person.api.knowledge.listDocuments(personal, {});
  const memory = documents.find(({ path }) => path === "USER.md");
  if (memory === undefined) {
    throw new Error("Expected the persona's USER.md");
  }
  return memory.id;
};

const teamsOf = (person: Awaited<ReturnType<typeof signedInApi>>) => {
  const { oid } = person.person;
  if (typeof oid !== "string") {
    throw new TypeError("Expected an Entra object id");
  }
  return teamsPerson(oid);
};

/**
 * A test file's one company, shared by its tests: storage lasts the whole
 * file, and each file starts empty, so each file makes its own.
 */
export const companyOnce = (idp: Idp): (() => Promise<Company>) => {
  let company: Promise<Company> | undefined;
  return async () => {
    company ??= (async () => {
      const brain = await setUpBrainCompany(idp);
      const stand = await prober();
      const places = {
        ana: await workspaceOf(brain, "ana"),
        bram: await workspaceOf(brain, "bram"),
      };
      // Stephen, as the door's chats run him, granted what each persona's
      // own agent is: the collections that aren't private.
      for (const [key, { access }] of Object.entries(brainCollections)) {
        if (access.type !== "private") {
          // oxlint-disable-next-line no-await-in-loop -- one grant at a time
          await grantCollection(
            brain,
            { type: "agent", agentId: chatAgentId },
            key
          );
        }
      }
      const removed = await signedInApi(idp, "user");
      await brain.admin.api.members.remove(removed.userId);
      const guestOnTeams = teamsPerson();
      await onRoster(guestOnTeams, { userRole: "guest", tenantId: acmeTenant });
      return {
        brain,
        model: stand,
        places,
        teams: {
          ana: teamsOf(brain.people.ana),
          bram: teamsOf(brain.people.bram),
        },
        memories: {
          ana: await memoryIdOf(brain.people.ana),
          bram: await memoryIdOf(brain.people.bram),
        },
        removed,
        removedOnTeams: teamsOf(removed),
        guestOnTeams,
      };
    })();
    return await company;
  };
};

/** What the probing for `target` tries: its own words and code, and its document. */
const probingFor = (target: ProbeTarget, { brain, memories }: Company) => {
  if (isDocument(target)) {
    return {
      queries: [...secretsOf(target), brainDocuments[target].path],
      ids: [brain.documents.get(target)?.id ?? ""],
    };
  }
  const owner = memoryOwnerOf(target);
  return {
    queries: secretsOf(target),
    ids: owner === null ? [] : [memories[owner]],
  };
};

/** Who `asker` is on Teams. */
const onTeams = (asker: PermissionProbe["asker"], place: Company) => {
  if (asker === "removed") {
    return place.removedOnTeams;
  }
  return asker === "guest" ? place.guestOnTeams : place.teams[asker];
};

/** How many activities the door sent `person` so far. */
export const sentCount = async (person: TeamsPerson): Promise<number> => {
  const { activities } = await reached(person.conversation);
  return activities.length;
};

/** What one probe came to, as the gate reads it. */
export interface ProbeOutcome {
  id: string;
  /** What its asker may not see that reached a model or the answer. */
  leaked: string[];
  /** Whether anything was read, for those who are refused. */
  read?: boolean;
  /** The line or answer someone refused got. */
  refusedWith?: string;
  /** For a member: whether the probe was asked, and its answer came back. */
  answered?: boolean;
}

/** Asks `probe` through `Workspace.ask`, as its asker. */
export const askedInWorkspace = async (
  probe: PermissionProbe,
  place: Company
): Promise<ProbeOutcome> => {
  const { model: stand, brain } = place;
  stand.probing(probingFor(probe.target, place));
  const from = stand.provider.requests.length;
  if (probe.asker === "removed" || probe.asker === "guest") {
    const { stub } = place.places.ana;
    let refusedWith = "";
    const events = await auditedDuring(async () => {
      refusedWith = await outcome(
        (async () => {
          const chat = await stub.createChat(
            probe.id,
            place.removed.userId,
            place.places.ana.agent.agentId
          );
          await stub.ask(chat.id, { text: probe.question, model });
        })()
      );
    });
    return {
      id: probe.id,
      leaked: [],
      read:
        stand.provider.requests.length > from ||
        events.some(({ action }) => action.startsWith("knowledge.")),
      refusedWith,
    };
  }
  const { stub, agent } = place.places[probe.asker];
  const chat = await stub.createChat(
    probe.id,
    brain.people[probe.asker].userId,
    agent.agentId
  );
  const answer = await stub.ask(chat.id, { text: probe.question, model });
  const text = `${sentSince(stand.provider.requests, from)}\n${answer.outcome === "answered" ? answer.answer : ""}`;
  return {
    id: probe.id,
    leaked: leaksIn(text, forbiddenFor(probe.asker)),
    answered:
      stand.provider.requests.length > from && answer.outcome === "answered",
  };
};

/** What the door sent `person` since `before`, as one text. */
export const postedTo = async (person: TeamsPerson, before: number) => {
  const { activities } = await reached(person.conversation);
  return activities
    .slice(before)
    .map((activity) => JSON.stringify(activity))
    .join("\n");
};

/** Asks `probe` on Teams, through the door. */
export const askedThroughDoor = async (
  probe: PermissionProbe,
  place: Company
): Promise<ProbeOutcome> => {
  const { model: stand } = place;
  stand.probing(probingFor(probe.target, place));
  const from = stand.provider.requests.length;
  const person = onTeams(probe.asker, place);
  const before = await sentCount(person);
  later();
  const events = await auditedDuring(async () => {
    await post(
      messageFrom(person, {
        text: probe.question,
        locale: probe.language,
      })
    );
  });
  const posted = await postedTo(person, before);
  if (probe.asker === "removed" || probe.asker === "guest") {
    const { activities } = await reached(person.conversation);
    const lines = activities
      .slice(before)
      .filter(({ type }) => type === "message");
    return {
      id: probe.id,
      leaked: [],
      read:
        stand.provider.requests.length > from ||
        events.some(({ action }) => action.startsWith("knowledge.")),
      refusedWith: `${lines.length} line${lines.length === 1 ? "" : "s"}`,
    };
  }
  const text = `${sentSince(stand.provider.requests, from)}\n${posted}`;
  return {
    id: probe.id,
    leaked: leaksIn(text, forbiddenFor(probe.asker)),
    answered: stand.provider.requests.length > from && posted.includes(refusal),
  };
};

export const memberProbes = permissionProbes.filter(
  ({ asker }) => asker === "ana" || asker === "bram"
);
export const outsiderProbes = permissionProbes.filter(
  ({ asker }) => asker === "removed" || asker === "guest"
);

/**
 * A member's probes put one way (`tactic`): 25 or 35 of `memberProbes`,
 * one file's worth, so the files run apart and each stays short.
 */
export const probesOf = (asker: BrainPersona, tactic: ProbeTactic) =>
  memberProbes.filter(
    (probe) => probe.asker === asker && probe.tactic === tactic
  );

const channels = {
  workspace: { name: "Workspace.ask", asked: askedInWorkspace },
  teams: { name: "the Teams door", asked: askedThroughDoor },
} as const;

/**
 * A test file's probes: each of `asker`'s probes put with `tactic`, asked
 * through `channel` in the file's own company, one test each. A probe
 * passes when it was asked, its answer came back, and nothing its asker
 * may not read (no canary, fact or colleague's memory) reached a model or
 * the answer.
 */
export const probedThrough = (
  channel: keyof typeof channels,
  asker: BrainPersona,
  tactic: ProbeTactic
) => {
  const idp = mockIdp();
  watched();
  const setUp = companyOnce(idp);
  const { name, asked } = channels[channel];
  describe(`the permission probes through ${name}`, probeTime, () => {
    if (channel === "teams") {
      doorClockRunsAhead();
    }
    it.each(probesOf(asker, tactic))(
      "$id shows its asker nothing they may not read",
      async (probe) => {
        const place = await setUp();
        expect(await asked(probe, place)).toStrictEqual({
          id: probe.id,
          leaked: [],
          answered: true,
        });
      }
    );
  });
};
