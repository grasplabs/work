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
import type { SourceReader } from "@grasp-os/shared/source-readers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { appFor } from "../src/apps.ts";
import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { memberOf } from "../src/auth/identity.ts";
import { handOverProducers } from "../src/brain-hand-overs.ts";
import {
  addInstructionFile,
  addSource,
  brainStaffReport,
  changeSourceReaders,
  eraseSource,
  erasePerson,
  publishAs,
  readSourceVersionAs,
  recallAs,
  rememberAs,
  versionRefSchema,
  workBrain,
} from "../src/brain-next.ts";
import type { InstructionFile, SourceRef } from "../src/brain-next.ts";
import { selectSkillsFor } from "../src/brain-skills.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import {
  answerCaptureIdOf,
  captureIdOf,
} from "../src/connection-capture-key.ts";
import { captureRead, captureRunRead } from "../src/connection-capture.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { instructionFilesFor } from "../src/instruction-files.ts";
import { codeStep, says, toolStep } from "./agent-chat.ts";
import { published } from "./apps.ts";
import { chooseAudience } from "./brain-audiences.ts";
import {
  markerWord,
  surfaces,
  readingSurfaces,
  reading,
  recallSurfaces,
  findingsOf,
  ownStoreOf,
  settledOwnStores,
  join,
  leave,
  newTeam,
  everyVersionOf,
  sharedStore,
  newSource,
  add,
  answerOf,
  textsFor,
  chatAgentReadsBrainOnce,
} from "./brain-next-leaks-harness.ts";
import type { Finding } from "./brain-next-leaks-harness.ts";
import { brainModules } from "./brain-next-modules.ts";
import { brainSurfaces, membersOf, textOf } from "./brain-next-surfaces.ts";
import type { Probing } from "./brain-next-surfaces.ts";
import { chatIdsOf, codeStepTrace } from "./code-step-trace.ts";
import { mockIdp } from "./idp.ts";
import type { Claims } from "./idp.ts";
import { saveInstructions } from "./instruction-saves.ts";
import { answeringProvider, testModel } from "./model-provider.ts";
import { noProducers } from "./no-producers.ts";
import { carrying } from "./platform-providers.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";
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

/** The account `claims` signed in with, as a reader list names it. */
const accountOf = (claims: Claims): SourceReader => ({
  kind: "account",
  provider: "microsoft",
  tenant: acmeTenant,
  account: String(claims.oid),
});

/** Grants the chat agent the Brain permission, once for the file. */
const chatAgentReadsBrain = chatAgentReadsBrainOnce(idp);

teamsWatched();

/** A chat's agent acting for `personId`. */
const agentFor = (personId: string) =>
  authoritySchema.parse({
    subject: { type: "agent", agentId: `agent-${unique()}` },
    onBehalfOf: personId,
    mode: "interactive",
  });

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

/** Adds `text` as a version of `source` (a new one by default). */
/** What the holder's producers planted in the reader passes' world. */
interface HoldersProduced {
  ownUploadMarker: string;
  captureMarker: string;
  toolkitCaptureMarker: string;
  runCaptureMarker: string;
  runMarker: string;
  askedMarker: string;
  answerMarker: string;
  ownUpload: SourceRef;
  captureId: SourceRef;
  toolkitCaptureId: SourceRef;
  runCaptureId: SourceRef;
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
    "what the holder's run fetched through a toolkit": world.runCaptureMarker,
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
      world.runCaptureId,
      world.runSource,
      world.turnSource,
    ],
  };
};

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

describe(
  "the new Brain leaks nothing to a reader without access",
  { timeout: 120_000 },
  () => {
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
      const [holderApi, { userId: outsider, person: outsiderPerson }] =
        await Promise.all([
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
        "the holder's interview": markerWord(),
        "a source narrowed away from the outsider": markerWord(),
        "a source narrowed to the holder alone": markerWord(),
        "the holder's instruction file": markerWord(),
        "another agent's instruction file": markerWord(),
        "an App's instruction file the outsider doesn't build": markerWord(),
        "an App's instruction file the outsider uses": markerWord(),
        "the holder's own agent's instruction file": markerWord(),
        "the holder's upload for only them": markerWord(),
        "an upload for a team the outsider isn't in": markerWord(),
        "what the holder's agent fetched through a connection": markerWord(),
        "what the holder's agent fetched through a toolkit": markerWord(),
        "what the holder's run fetched through a toolkit": markerWord(),
        "what a trigger's run fetched through the holder's toolkit":
          markerWord(),
        "what an agent read through a shared connection for a team the outsider isn't in":
          markerWord(),
        "the holder's own skill": markerWord(),
        "a team's skill the outsider isn't in": markerWord(),
        "a file the source shares with the holder, by their account":
          markerWord(),
        "a file the source shared with the outsider, then with the holder alone":
          markerWord(),
        "a file native sync copied from the holder's drive for them alone":
          markerWord(),
        "a file native sync copied for the outsider too, then erased as gone at the source":
          markerWord(),
        "the holder's run": markerWord(),
        "a question in the holder's chat": markerWord(),
        "an answer in the holder's chat": markerWord(),
        "a memory the holder shared with a team the outsider isn't in":
          markerWord(),
      };
      // What every member may read, and nobody outside the company.
      const companyMarkers = {
        "an upload for everyone": markerWord(),
        "a team's claim from the interviews": markerWord(),
        "a team's drawing from the interviews": markerWord(),
        "the company's opinion from the interviews": markerWord(),
        "the company's vision from the kickoff": markerWord(),
        "the company's teams from its staff list": markerWord(),
      };
      const {
        "an upload for everyone": everyoneUploadMarker,
        "a team's claim from the interviews": claimMarker,
        "a team's drawing from the interviews": drawingMarker,
        "the company's opinion from the interviews": opinionMarker,
        "the company's vision from the kickoff": kickoffMarker,
        "the company's teams from its staff list": rosterMarker,
      } = companyMarkers;
      const {
        "the holder's own source": ownerMarker,
        "a team's source the outsider isn't in": teamMarker,
        "a source nobody is known to read": noneMarker,
        "the holder's interview": interviewMarker,
        "a source narrowed away from the outsider": narrowedMarker,
        "a source narrowed to the holder alone": toHolderMarker,
        "the holder's instruction file": holderFileMarker,
        "another agent's instruction file": agentFileMarker,
        "an App's instruction file the outsider doesn't build": appFileMarker,
        "an App's instruction file the outsider uses": usedAppFileMarker,
        "the holder's own agent's instruction file": ownAgentFileMarker,
        "the holder's upload for only them": ownUploadMarker,
        "an upload for a team the outsider isn't in": teamUploadMarker,
        "what the holder's agent fetched through a connection": captureMarker,
        "what the holder's agent fetched through a toolkit":
          toolkitCaptureMarker,
        "what the holder's run fetched through a toolkit": runCaptureMarker,
        "what a trigger's run fetched through the holder's toolkit":
          triggerCaptureMarker,
        "what an agent read through a shared connection for a team the outsider isn't in":
          sharedReadMarker,
        "the holder's own skill": holderSkillMarker,
        "a team's skill the outsider isn't in": teamSkillMarker,
        "a file the source shares with the holder, by their account":
          readersMarker,
        "a file the source shared with the outsider, then with the holder alone":
          staleReadersMarker,
        "a file native sync copied from the holder's drive for them alone":
          syncMarker,
        "a file native sync copied for the outsider too, then erased as gone at the source":
          goneSyncMarker,
        "the holder's run": runMarker,
        "a question in the holder's chat": askedMarker,
        "an answer in the holder's chat": answerMarker,
        "a memory the holder shared with a team the outsider isn't in":
          sharedMemoryMarker,
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
      // An agent of the holder's own, told something only they wrote:
      // saved on their session, so core keeps it in their own store.
      const holdersOwnAgent = await holderApi.api.connections.makeOwnAgent({
        name: `Own ${unique()}`,
        face: "pen",
        job: "",
        modelRole: null,
      });
      await saveInstructions(
        holderApi.api,
        { scope: "agent", agentId: holdersOwnAgent.id },
        `Instructions ${sharedWord} ${ownAgentFileMarker}`
      );
      const hiddenOwnAgents = [
        { agentId: holdersOwnAgent.id, ownerId: holder },
      ];
      const instructionMarkers = [
        holderFileMarker,
        agentFileMarker,
        appFileMarker,
        usedAppFileMarker,
        ownAgentFileMarker,
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
        "the holder's own agent's instruction file": ownAgentFileMarker,
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
      // Read in the holder's chat through their own toolkit connection, a
      // read of the company's records, whose server names no item: its
      // whole answer one source, keyed by the call (connection-capture.ts,
      // GRA-1845), theirs alone, its connection's ID holding a marker too.
      const toolkitConnection = `connection-${toolkitCaptureMarker}`;
      await connectDb()
        .prepare(
          "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tools, created_at, updated_at) VALUES (?, 'mail', 'personal', ?, 'active', 'composio', 'https://mail.test/mcp', ?, ?, ?)"
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
      // Read by a workflow run the holder started, through their own
      // toolkit connection (GRA-1828, connection-capture.ts
      // `captureRunRead`): kept as their agent's read is, theirs alone, its
      // connection's ID holding a marker too. Its twin, the same read by a
      // run a trigger started, acts as the workflow itself and is kept for
      // nobody, the holder included.
      const runConnection = `connection-${runCaptureMarker}`;
      await connectDb()
        .prepare(
          "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tools, created_at, updated_at) VALUES (?, 'mail', 'personal', ?, 'active', 'composio', 'https://mail.test/mcp', ?, ?, ?)"
        )
        .bind(
          runConnection,
          holder,
          JSON.stringify([{ name: "mail.search", read: true }]),
          readAtNow,
          readAtNow
        )
        .run();
      const runRead = async (
        marker: string,
        invoker: "person" | "trigger"
      ): Promise<void> => {
        await captureRunRead(
          env,
          {
            run: {
              runId: crypto.randomUUID(),
              principal: holder,
              invoker: {
                type: invoker,
                id: invoker === "person" ? holder : crypto.randomUUID(),
                appVersion: null,
              },
            },
            sensitive: false,
            // As a step's attempt that has a minute left.
            deadline: Date.now() + 60_000,
          },
          runConnection,
          "mail.search",
          { query: `orders ${marker}` },
          {
            result: {
              output: JSON.stringify(`Supplier orders ${sharedWord} ${marker}`),
              provenance: ["mail/mail.search"],
              keep: true,
            },
            readAt: new Date(readAtNow),
          }
        );
      };
      await runRead(runCaptureMarker, "person");
      await runRead(triggerCaptureMarker, "trigger");
      const runCaptureId: SourceRef = {
        producer: "capture",
        id: await answerCaptureIdOf(runConnection, holder, "mail.search", {
          query: `orders ${runCaptureMarker}`,
        }),
      };
      // Read through a shared connection an admin opened in the Brain to a
      // team the outsider isn't in (GRA-1831): readable by that team, as
      // core's records say at each read, its connection's ID holding a
      // marker too.
      const sharedConnection = `connection-${sharedReadMarker}`;
      await connectDb()
        .prepare(
          "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'hubspot', 'shared', NULL, 'active', 'composio', 'hubspot', ?, ?)"
        )
        .bind(sharedConnection, readAtNow, readAtNow)
        .run();
      const sharingAdmin = await signedInApi(idp, "admin");
      await chooseAudience(sharingAdmin.api, sharedConnection, {
        kind: "team",
        teamId: secretTeam,
      });
      const sharedReadId = await add(
        `Deal pipeline ${sharedWord} ${sharedReadMarker}`,
        { kind: "connection", connectionId: sharedConnection },
        {
          producer: "connected",
          id: `${sharedConnection}/${crypto.randomUUID()}`,
        }
      );
      // Readers copied from where a file lives (GRA-1761): the holder by
      // the account they sign in with, beside a link and a group, which
      // reach nobody. Its twin, the stale list: first shared with the
      // outsider too, then with the holder alone; its only version is the
      // first, which the outsider was among the readers of.
      const readersId = await add(
        `Lease terms ${sharedWord} ${readersMarker}`,
        {
          kind: "readers",
          readers: [
            accountOf(holderApi.person),
            { kind: "link" },
            {
              kind: "group",
              provider: "microsoft",
              tenant: acmeTenant,
              group: `group-${readersMarker}`,
            },
          ],
        }
      );
      const staleReadersId = await add(
        `Lease draft ${sharedWord} ${staleReadersMarker}`,
        {
          kind: "readers",
          readers: [accountOf(outsiderPerson), accountOf(holderApi.person)],
        }
      );
      await changeSourceReaders(env, {
        source: staleReadersId,
        change: crypto.randomUUID(),
        readers: { kind: "readers", readers: [accountOf(holderApi.person)] },
      });
      // A file native sync copied from the holder's own drive (GRA-1758),
      // only theirs to read at the source: in their own store, in their
      // connection's group (brain-sync.ts). Its twin: copied while the
      // source shared it with the outsider too, then erased when it went
      // away there, as the sync takes out everything that did.
      const syncConnection = `connection-${syncMarker}`;
      const syncId: SourceRef = {
        producer: "sync",
        id: `${syncConnection}/1/${unique()}`,
      };
      await addSource(env, {
        source: syncId,
        change: crypto.randomUUID(),
        text: `Supplier contract ${sharedWord} ${syncMarker}`,
        readers: { kind: "owner", personId: holder },
        group: { producer: "sync", id: syncConnection },
      });
      ownerIds.push(syncId);
      const goneSyncId = await add(
        `Supplier offer ${sharedWord} ${goneSyncMarker}`,
        {
          kind: "readers",
          readers: [accountOf(outsiderPerson), accountOf(holderApi.person)],
        },
        { producer: "sync", id: `${syncConnection}/1/${unique()}` }
      );
      await eraseSource(env, {
        source: goneSyncId,
        readers: { kind: "none" },
        reason: "deleted",
      });
      const teamSource = `Board minutes ${sharedWord} ${teamMarker}`;
      const teamId = await add(teamSource, {
        kind: "team",
        teamId: secretTeam,
      });
      const noneId = await add(`Unfiled note ${sharedWord} ${noneMarker}`, {
        kind: "none",
      });
      // A claim of how a staff-list team works, from its interviews, from
      // the first person who told it (GRA-1741, GRA-1987): every member
      // reads it as themselves (GRA-1748), nobody outside the company, and
      // never code (GRA-1946). That one person told it changes nothing
      // here: the Brain holds and reads it alike (team-work.test.ts makes
      // one through the onboarding).
      const claimText = `Team claim ${sharedWord} ${claimMarker}`;
      const claimId = await add(
        claimText,
        { kind: "members" },
        { producer: "claim", id: crypto.randomUUID() }
      );
      // A drawing of a staff-list team's piece of work, from what its
      // people told in their interviews (GRA-1748): read as a claim is.
      const drawingText = `Team drawing ${sharedWord} ${drawingMarker}`;
      const drawingId = await add(
        drawingText,
        { kind: "members" },
        { producer: "drawing", id: crypto.randomUUID() }
      );
      // An opinion of the company's, from what five or more across it left
      // only counted anonymously (GRA-1987): read as a claim is. Through a
      // real hand-over in brain-next-opinions.test.ts.
      const opinionText = `Company opinion ${sharedWord} ${opinionMarker}`;
      const opinionId = await add(
        opinionText,
        { kind: "members" },
        { producer: "opinion", id: crypto.randomUUID() }
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
      // The company's teams, as the onboarding hands its confirmed staff
      // list over: every member's, without the shared word.
      const rosterSource = await add(
        `The company's teams ${rosterMarker}`,
        { kind: "everyone" },
        { producer: "roster", id: crypto.randomUUID() }
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
          // The turn, by its words: what else they may read comes by meaning.
          const found = items.find(
            ({ source, found: way }) =>
              source.producer === "chat" && way !== "meaning"
          );
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
      // A memory of the holder's own, which they share with their team
      // (GRA-1815): a new memory in the shared store, its entity's name and
      // its statement marked, readable by that team alone. After the chat's
      // turn, so no recall of it prompts a model while planting.
      // Two more in that team, so it is large enough to share with.
      const fillers = await Promise.all([
        signedInWithRole(idp, "user"),
        signedInWithRole(idp, "user"),
      ]);
      for (const { userId } of fillers) {
        // oxlint-disable-next-line no-await-in-loop -- one member at a time
        await join(secretTeam, userId);
      }
      const sharedName = `Account ${sharedMemoryMarker}`;
      const sharedStatement = `${sharedWord} ${sharedMemoryMarker} renews`;
      const kept = await rememberAs(env, holder, {
        change: crypto.randomUUID(),
        about: { kind: "customer", names: [sharedName] },
        type: "fact",
        statement: sharedStatement,
        quote: sharedStatement,
      });
      const sharedMemory = await publishAs(env, holder, {
        memory: { entity: kept.entity, memory: kept.memory },
        shown: {
          about: sharedName,
          attribute: null,
          type: "fact",
          value: null,
          statement: sharedStatement,
          validFrom: null,
          validUntil: null,
        },
        audience: { team: secretTeam },
        change: crypto.randomUUID(),
      });
      /** Whether `personId`'s recall gives the shared memory, as their teams. */
      const findsShared = async (personId: string): Promise<boolean> => {
        const { memories } = await recallAs(env, personId, {
          personal: false,
          question: sharedMemoryMarker,
          budget: { tokens: recallBudgetMax },
        });
        return memories.some(
          ({ memory, statement }) =>
            memory === sharedMemory?.memory && statement === sharedStatement
        );
      };

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
      // And what their run read, by its own key; never its twin's.
      /** Whether the holder's own recall finds `marker` in `source`'s text. */
      const holderFinds = async (marker: string, source?: SourceRef) => {
        const { items } = await recallAs(env, holder, {
          personal: true,
          question: `orders ${marker}`,
          budget: { tokens: recallBudgetMax },
        });
        return items.some(
          ({ source: found, text }) =>
            (source === undefined || found.id === source.id) &&
            text.includes(marker)
        );
      };
      const holderFindsRunCapture = await holderFinds(
        runCaptureMarker,
        runCaptureId
      );
      const holderFindsTriggerCapture = await holderFinds(triggerCaptureMarker);
      // And by the ID the hidden copies share: their own chunk, as exact.
      const { items: cappedItems } = await recallAs(env, outsider, {
        personal: true,
        question: capId,
        budget: { tokens: recallBudgetMax },
      });
      // By meaning, whatever else they may read: never a hidden copy.
      const cappedFinds = cappedItems.flatMap(({ text, found }) =>
        found === "meaning" && !text.includes(capId) ? [] : [{ text, found }]
      );

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
          narrowedMarker,
          captureMarker,
          toolkitCaptureMarker,
          runCaptureMarker,
          sharedReadMarker,
          readersMarker,
          staleReadersMarker,
          syncMarker,
          goneSyncMarker,
          toHolderMarker,
          ...instructionMarkers,
          ownUploadMarker,
          teamUploadMarker,
          holderSkillMarker,
          teamSkillMarker,
          runMarker,
          askedMarker,
          answerMarker,
          sharedMemoryMarker,
        ],
        hiddenVersions: everyVersionOf(
          ...ownerIds,
          teamId,
          noneId,
          narrowedId,
          ownUpload,
          teamUpload,
          captureId,
          toolkitCaptureId,
          runCaptureId,
          sharedReadId,
          readersId,
          staleReadersId,
          goneSyncId,
          runSource,
          turnSource
        ),
        hiddenUploads: [ownUpload.id, teamUpload.id],
        hiddenInstructionFiles: [holderFile, agentFile, appFile, usedAppFile],
        hiddenOwnAgents,
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
        connected: {
          marker:
            "what an agent read through a shared connection for a team the outsider isn't in",
          source: sharedReadId,
          reader: holder,
        },
        sync: {
          marker:
            "a file native sync copied from the holder's drive for them alone",
          source: syncId,
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
          marker: "a team's claim from the interviews",
          source: claimId,
          reader: outsider,
        },
        drawing: {
          marker: "a team's drawing from the interviews",
          source: drawingId,
          reader: outsider,
        },
        opinion: {
          marker: "the company's opinion from the interviews",
          source: opinionId,
          reader: outsider,
        },
        kickoff: {
          marker: "the company's vision from the kickoff",
          source: kickoffSource,
          reader: outsider,
        },
        roster: {
          marker: "the company's teams from its staff list",
          source: rosterSource,
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

      // Their own stores embedded and asleep before any pass, so no tick
      // of theirs, on its own alarm, runs while one asks (`settledOwnStores`).
      await settledOwnStores([holder, outsider]);

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
        claimText,
        drawingMarker,
        drawingText,
        opinionMarker,
        opinionText,
        narrowedMarker,
        captureMarker,
        captureId,
        toolkitCaptureMarker,
        toolkitCaptureId,
        runCaptureMarker,
        runCaptureId,
        triggerCaptureMarker,
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
        sharedMemoryMarker,
        readersMarker,
        staleReadersMarker,
        readersId,
        staleReadersId,
        instructionMarkers,
        inRecall,
        instructionGroups,
        ownerIds,
        teamId,
        noneId,
        claimId,
        drawingId,
        opinionId,
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
          outsiderFinds: outsiderFinds.toSorted(),
          holderFindsCapture,
          holderFindsToolkitCapture,
          holderFindsRunCapture,
          holderFindsTriggerCapture,
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
          sharedFinds: {
            holder: await findsShared(holder),
            outsider: await findsShared(outsider),
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
        claimText,
        drawingText,
        opinionText,
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
        // A member, so the team's claim and drawing from the interviews
        // too (GRA-1748), and the company's opinions (GRA-1987).
        outsiderFinds: [
          handbook,
          claimText,
          drawingText,
          opinionText,
        ].toSorted(),
        holderFindsCapture: true,
        holderFindsToolkitCapture: true,
        holderFindsRunCapture: true,
        holderFindsTriggerCapture: false,
        cappedFinds: [{ text: capped, found: "exact" }],
        teamSkillSelected: {
          byTheHolder: [`${secretTeam}:${teamSkillMarker}`],
          byTheOutsider: [],
        },
        holderAppFile: true,
        outsiderOpens: "opens it",
        sharedFinds: { holder: true, outsider: false },
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
              // A non-member holds no group, those instruction files are
              // written for (the company's) included.
              instructionGroups: [],
              // Every company marker stays forbidden (`forbidden`), the
              // opinion's too; the fixture's own text holds the Brain's
              // most a value may (500 characters), which the opinion's
              // marker would pass once every producer has one.
              markers: [
                ...asOutsider.markers,
                world.everyoneUploadMarker,
                world.claimMarker,
                world.drawingMarker,
              ],
              hiddenVersions: [
                ...asOutsider.hiddenVersions,
                ...everyVersionOf(
                  world.everyoneUpload,
                  world.claimId,
                  world.drawingId,
                  world.opinionId
                ),
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
        "a memory the holder shared with a team the outsider isn't in":
          _joinedShared,
        "what an agent read through a shared connection for a team the outsider isn't in":
          _joinedSharedRead,
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
            world.narrowedMarker,
            world.captureMarker,
            world.toolkitCaptureMarker,
            world.runCaptureMarker,
            world.triggerCaptureMarker,
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
            world.narrowedId,
            world.ownUpload,
            world.captureId,
            world.toolkitCaptureId,
            world.runCaptureId,
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
            world.drawingMarker,
            world.opinionMarker,
            world.narrowedMarker,
            world.sharedMemoryMarker,
            world.readersMarker,
            ...holdersOwnProduced(world).markers,
          ],
          hiddenVersions: everyVersionOf(
            ...world.ownerIds,
            world.teamId,
            world.noneId,
            world.claimId,
            world.drawingId,
            world.opinionId,
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
          "a memory shared with a team, though the holder is in the team":
            world.sharedMemoryMarker,
          "a source nobody is known to read": world.noneMarker,
          "a team's claim from the interviews, which code never gets":
            world.claimMarker,
          "a team's drawing from the interviews, which code never gets":
            world.drawingMarker,
          "the company's opinion from the interviews, which code never gets":
            world.opinionMarker,
          "a source narrowed away from the outsider": world.narrowedMarker,
          "a file the source shares with the holder, which code never reads by their account":
            world.readersMarker,
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
            world.drawingMarker,
            world.opinionMarker,
            world.narrowedMarker,
            world.sharedMemoryMarker,
            world.readersMarker,
            ...holdersOwnProduced(world).markers,
          ],
          hiddenVersions: everyVersionOf(
            ...world.ownerIds,
            world.teamId,
            world.noneId,
            world.claimId,
            world.drawingId,
            world.opinionId,
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
          "a memory shared with a team the grant doesn't name, though the holder is in it":
            world.sharedMemoryMarker,
          "a source nobody is known to read": world.noneMarker,
          "a team's claim from the interviews, which code never gets":
            world.claimMarker,
          "a team's drawing from the interviews, which code never gets":
            world.drawingMarker,
          "the company's opinion from the interviews, which code never gets":
            world.opinionMarker,
          "a source narrowed away from the outsider": world.narrowedMarker,
          "a file the source shares with the holder, which code never reads by their account":
            world.readersMarker,
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
            world.readersMarker,
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
          "a file the source shares with the holder, which an App never reads by their account":
            world.readersMarker,
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
        "a memory the holder shared with a team the outsider isn't in":
          _teamShared,
        "what an agent read through a shared connection for a team the outsider isn't in":
          _teamSharedRead,
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
            world.narrowedMarker,
            world.toHolderMarker,
            ...world.instructionMarkers,
            ...holdersOwnProduced(world).markers,
          ],
          hiddenVersions: everyVersionOf(
            ...world.ownerIds,
            world.noneId,
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
            world.narrowedMarker,
            world.toHolderMarker,
            ...world.instructionMarkers,
            ...holdersOwnProduced(world).markers,
            world.teamUploadMarker,
            world.sharedMemoryMarker,
            world.readersMarker,
            world.staleReadersMarker,
          ],
          hiddenVersions: everyVersionOf(
            ...world.ownerIds,
            world.teamId,
            world.noneId,
            world.narrowedId,
            ...holdersOwnProduced(world).sources,
            world.teamUpload,
            world.readersId,
            world.staleReadersId
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
  }
);
