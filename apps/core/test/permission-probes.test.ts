import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { channelText } from "../src/channels/stephen-rules.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { model, pointAtGateway } from "./agent-chat.ts";
import { answeringGateway } from "./ai-gateway.ts";
import type { GatewayRequest } from "./ai-gateway.ts";
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
  peopleMatters,
  permissionProbes,
  unreadableTo,
} from "./fixtures/permission-probes.ts";
import type {
  PermissionProbe,
  ProbeTarget,
} from "./fixtures/permission-probes.ts";
import { mockIdp } from "./idp.ts";
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

// Who may see what (GRA-731): the 150 permission probes
// (fixtures/permission-probes.ts) in the Brain baseline's company, each
// asked as one person about what another may see, through `Workspace.ask`
// and once more through the Teams door, as the Brain baseline's security
// gate checks a trial: nothing its asker may not read reaches a model or
// the answer. The model is a stand-in that tries every read it can (the
// catalog, searches for the target's own words and code, the target's
// document by its ID, recall), so a probe passes on the platform's
// permissions alone; controls show the same reads do reach what the asker
// may read. Someone removed and a guest get one line, and nothing is read.
// People matters (sickness, harassment, a conflict) go to a person: the
// rule is in what the model is told in a chat app, and what HR keeps about
// a colleague never reaches it. Whether a real model follows the rule is
// the eval's (GRA-739), not a stub's.

const idp = mockIdp();

watched();

/** Every probe runs a turn or two: the whole file takes minutes. */
const probeTime = { timeout: 600_000 };

/** What the stand-in answers once its reads came back. */
const refusal = "I can't share that with you.";

/** Strings a target holds that its reader alone may see. */
const secretsOf = (target: ProbeTarget): readonly string[] => {
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
const colleaguesInHrNotes = ["Karin Aydin"];

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
 * The model behind every Workspace in the file: for the probing under way,
 * it runs the probing code once, then refuses.
 */
const prober = () => {
  let current: Probing = { queries: [], ids: [] };
  const gateway = answeringGateway((requests) => {
    const body = requests.at(-1)?.body;
    const input = modelStrings(body).join("\n");
    return resultsSinceQuestion(body).length === 0
      ? codeStep(probingCode(current.queries, current.ids), input)
      : says(refusal, input);
  });
  return {
    gateway,
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
const sentSince = (requests: readonly GatewayRequest[], from: number) =>
  requests
    .slice(from)
    .flatMap(({ body }) => transcriptOf(body))
    .filter(({ by }) => by !== "model")
    .map(({ text }) => text)
    .join("\n");

/** Which of `forbidden` is in `text`. */
const leaksIn = (text: string, forbidden: readonly string[]): string[] =>
  forbidden.filter((secret) => text.includes(secret));

/**
 * The door's limit is per sender: each message a little later than the
 * last, so a person's sixty probes in a row are each taken. The whole
 * clock moves (`Date` and `Date.now`), so what Teams signs and what the
 * door checks agree.
 */
let clockAhead = 0;
const later = () => {
  clockAhead += 3100;
  vi.setSystemTime(Date.now() + 3100);
};

/**
 * Runs the clock `clockAhead` ahead in each of a describe's tests, still
 * running: the mock IdP restores every mock after each test.
 */
const clockRunsAhead = () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + clockAhead);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
};

interface Company {
  brain: BrainCompany;
  model: ReturnType<typeof prober>;
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

let company: Promise<Company> | undefined;

/** The file's one company, shared by its tests: storage lasts the whole file. */
const setUp = async (): Promise<Company> => {
  company ??= (async () => {
    const brain = await setUpBrainCompany(idp);
    const stand = prober();
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
    for (const persona of ["ana", "bram"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one object at a time
      await pointAtGateway(places[persona].stub, stand.gateway);
      // oxlint-disable-next-line no-await-in-loop -- one object at a time
      await pointAtGateway(
        workspace(env, personalWorkspaceId(brain.people[persona].userId)),
        stand.gateway
      );
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
const sentCount = async (person: TeamsPerson): Promise<number> => {
  const { activities } = await reached(person.conversation);
  return activities.length;
};

/** What one probe came to, as the gate reads it. */
interface ProbeOutcome {
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
const askedInWorkspace = async (
  probe: PermissionProbe,
  place: Company
): Promise<ProbeOutcome> => {
  const { model: stand, brain } = place;
  stand.probing(probingFor(probe.target, place));
  const from = stand.gateway.requests.length;
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
        stand.gateway.requests.length > from ||
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
  const text = `${sentSince(stand.gateway.requests, from)}\n${answer.outcome === "answered" ? answer.answer : ""}`;
  return {
    id: probe.id,
    leaked: leaksIn(text, forbiddenFor(probe.asker)),
    answered:
      stand.gateway.requests.length > from && answer.outcome === "answered",
  };
};

/** What the door sent `person` since `before`, as one text. */
const postedTo = async (person: TeamsPerson, before: number) => {
  const { activities } = await reached(person.conversation);
  return activities
    .slice(before)
    .map((activity) => JSON.stringify(activity))
    .join("\n");
};

/** Asks `probe` on Teams, through the door. */
const askedThroughDoor = async (
  probe: PermissionProbe,
  place: Company
): Promise<ProbeOutcome> => {
  const { model: stand } = place;
  stand.probing(probingFor(probe.target, place));
  const from = stand.gateway.requests.length;
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
        stand.gateway.requests.length > from ||
        events.some(({ action }) => action.startsWith("knowledge.")),
      refusedWith: `${lines.length} line${lines.length === 1 ? "" : "s"}`,
    };
  }
  const text = `${sentSince(stand.gateway.requests, from)}\n${posted}`;
  return {
    id: probe.id,
    leaked: leaksIn(text, forbiddenFor(probe.asker)),
    answered: stand.gateway.requests.length > from && posted.includes(refusal),
  };
};

const memberProbes = permissionProbes.filter(
  ({ asker }) => asker === "ana" || asker === "bram"
);
const outsiderProbes = permissionProbes.filter(
  ({ asker }) => asker === "removed" || asker === "guest"
);

describe("the permission probes", probeTime, () => {
  clockRunsAhead();

  it("are 150, guests and removed people among them, each asking as one person about what another may see", () => {
    expect({
      probes: permissionProbes.length,
      unique: new Set(permissionProbes.map(({ id }) => id)).size,
      askers: [...new Set(permissionProbes.map(({ asker }) => asker))],
      // Every probe's target is one its asker may not see.
      foreign: permissionProbes.every(
        ({ asker, target }) =>
          asker === "removed" ||
          asker === "guest" ||
          unreadableTo[asker].includes(target)
      ),
    }).toStrictEqual({
      probes: 150,
      unique: 150,
      askers: ["ana", "bram", "removed", "guest"],
      foreign: true,
    });
  });

  it("reach what their asker may read: the same reads would catch a leak", async () => {
    const place = await setUp();
    // Each target, asked by someone who may read it.
    const readers: [BrainPersona, ProbeTarget][] = [
      ["ana", "routePlans"],
      ["ana", "planningOfficeDays"],
      ["ana", "roster"],
      ["ana", "hubs"],
      ["bram", "budget"],
      ["bram", "tolls"],
      ["ana", "memory:ana"],
      ["bram", "memory:bram"],
    ];
    const reachedSecrets: string[] = [];
    for (const [asker, target] of readers) {
      // oxlint-disable-next-line no-await-in-loop -- one turn at a time
      const probed = await askedInWorkspace(
        {
          id: `control-${asker}-${target}`,
          asker,
          target,
          language: "en",
          tactic: "ask",
          question: "Tell me everything.",
        },
        place
      );
      const sent = sentSince(place.model.gateway.requests, 0);
      reachedSecrets.push(
        ...(secretsOf(target).every((secret) => sent.includes(secret))
          ? [target]
          : [`${target} not reached`])
      );
      expect(probed.leaked).toStrictEqual([]);
    }
    expect(reachedSecrets).toStrictEqual(readers.map(([, target]) => target));
  });

  it("show a member nothing they may not read through Workspace.ask: no canary, fact or colleague's memory reaches a model or the answer", async () => {
    const place = await setUp();
    const outcomes: ProbeOutcome[] = [];
    for (const probe of memberProbes) {
      // oxlint-disable-next-line no-await-in-loop -- one turn at a time
      outcomes.push(await askedInWorkspace(probe, place));
    }
    expect({
      asked: outcomes.length,
      unanswered: outcomes.filter(({ answered }) => answered !== true),
      leaks: outcomes.filter(({ leaked }) => leaked.length > 0),
    }).toStrictEqual({ asked: 120, unanswered: [], leaks: [] });
  });

  it("show a member nothing they may not read through the Teams door either", async () => {
    const place = await setUp();
    const outcomes: ProbeOutcome[] = [];
    for (const probe of memberProbes) {
      // oxlint-disable-next-line no-await-in-loop -- one message at a time
      outcomes.push(await askedThroughDoor(probe, place));
    }
    expect({
      asked: outcomes.length,
      unanswered: outcomes.filter(({ answered }) => answered !== true),
      leaks: outcomes.filter(({ leaked }) => leaked.length > 0),
    }).toStrictEqual({ asked: 120, unanswered: [], leaks: [] });
  });

  it("refuse someone removed in Workspace.ask, and give them and a guest one line through the door, with nothing read", async () => {
    const place = await setUp();
    const inWorkspace: ProbeOutcome[] = [];
    for (const probe of outsiderProbes.filter(
      ({ asker }) => asker === "removed"
    )) {
      // oxlint-disable-next-line no-await-in-loop -- one turn at a time
      inWorkspace.push(await askedInWorkspace(probe, place));
    }
    const throughDoor: ProbeOutcome[] = [];
    for (const probe of outsiderProbes) {
      // oxlint-disable-next-line no-await-in-loop -- one message at a time
      throughDoor.push(await askedThroughDoor(probe, place));
    }
    expect({
      inWorkspace: inWorkspace.map(({ read, refusedWith }) => ({
        read,
        refusedWith,
      })),
      throughDoor: throughDoor.map(({ read, refusedWith }) => ({
        read,
        refusedWith,
      })),
    }).toStrictEqual({
      inWorkspace: inWorkspace.map(() => ({
        read: false,
        refusedWith: "permission.person_inactive",
      })),
      throughDoor: throughDoor.map(() => ({
        read: false,
        refusedWith: "1 line",
      })),
    });
  });
});

describe("people matters", probeTime, () => {
  clockRunsAhead();

  it("go to a person: the rule is what Stephen is told on Teams, in every language, and no colleague HR keeps notes about reaches a model or the answer", async () => {
    const place = await setUp();
    const { text: rule } = await channelText();
    const outcomes: { id: string; told: boolean; leaked: string[] }[] = [];
    for (const matter of peopleMatters) {
      for (const asker of ["ana", "bram"] as const) {
        place.model.probing({
          queries: [matter.question, "sick leave", "complaint"],
          ids: [place.brain.documents.get("sickNotes")?.id ?? ""],
        });
        const from = place.model.gateway.requests.length;
        const person = place.teams[asker];
        // oxlint-disable-next-line no-await-in-loop -- one message at a time
        const before = await sentCount(person);
        later();
        // oxlint-disable-next-line no-await-in-loop -- one message at a time
        await post(
          messageFrom(person, {
            text: matter.question,
            locale: matter.language,
          })
        );
        const sent = sentSince(place.model.gateway.requests, from);
        // oxlint-disable-next-line no-await-in-loop -- one message at a time
        const posted = await postedTo(person, before);
        outcomes.push({
          id: `${asker}-${matter.id}`,
          told: sent.includes(rule) && sent.includes("always goes to a person"),
          leaked: leaksIn(`${sent}\n${posted}`, [
            ...colleaguesInHrNotes,
            ...secretsOf("sickNotes"),
          ]),
        });
      }
    }
    expect(
      outcomes.filter(({ told, leaked }) => !told || leaked.length > 0)
    ).toStrictEqual([]);
    expect(outcomes).toHaveLength(30);
  });
});
