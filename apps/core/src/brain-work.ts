import { actorOf } from "@grasp-os/shared/audit";
import { brainErrors } from "@grasp-os/shared/brain";
import type {
  Source,
  Statement,
  StatementKind,
  Team,
  Workspace,
} from "@grasp-os/shared/brain";
import { minTeamShown } from "@grasp-os/shared/onboarding";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { isoWeekOf } from "@grasp-os/shared/work-knowledge";
import type {
  KnownAbout,
  KnownSentence,
  RestsOn,
  WorkKnowledge,
} from "@grasp-os/shared/work-knowledge";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { onboardingStore } from "./onboarding/store.ts";

// What Grasp knows about a piece of work, for its Knowledge tab
// (GRA-1253): the brain's own sentences about it, each with what it rests
// on and its ISO week, how sure Grasp is, and asking to hear more people
// about it in Stephen's next interviews. Threat model in
// packages/shared/src/work-knowledge.ts, each held by
// apps/core/test/work-knowledge.test.ts. A piece of work is the brain's
// workflow, as the onboarding drew it, or a candidate the brain was given.
// Everything is read from the brain as `brain.read` gives it to the same
// person: nothing here reads more than they may.

/** The part of the story each of a drawing's one-line answers tells. */
const answerAbout = {
  decides: "rule",
  ask: "rule",
  next: "handover",
  right: "goal",
  ai: "wish",
  own: "tool",
} as const satisfies Record<string, KnownAbout>;

/** What a source says a sentence rests on. */
const restsOnOf = (source: Source | undefined): RestsOn => {
  if (source === undefined) {
    return "said";
  }
  if (source.kind === "interview" || source.kind === "chat") {
    return "said";
  }
  if (source.kind === "runLog") {
    return "done";
  }
  return source.connection === "pulse" || source.connection === "signIn"
    ? "seen"
    : "written";
};

/** How many people of `team` hold `role`, as its newest count says; 0 when it doesn't. */
const holdersOf = (team: Team, role: string): number =>
  team.counts.at(-1)?.roles?.find((each) => each.name === role)?.people ?? 0;

/**
 * Who said a sentence, as the company may read it: their role in their
 * team where five or more of the team hold it, else the team; nothing
 * until five or more told about the work, or where no team is known.
 */
const byOf = (
  heard: boolean,
  team: Team | undefined,
  role?: string
): KnownSentence["by"] => {
  if (!heard || team === undefined) {
    return null;
  }
  const named =
    role !== undefined && role !== "" && holdersOf(team, role) >= minTeamShown;
  return { team: team.name, role: named ? role : null };
};

/** The sentences of a statement the brain holds about the work. */
const statementSentence = (
  ws: Workspace,
  statement: Statement,
  heard: boolean
): KnownSentence => {
  const source = ws.sources.find(({ id }) => id === statement.sourceId);
  const team = ws.teams.find(({ id }) => id === statement.teamIds[0]);
  const kind: StatementKind = statement.kind;
  return {
    id: statement.id,
    about: kind,
    text: statement.text,
    restsOn: restsOnOf(source),
    week: isoWeekOf(source?.date ?? ""),
    by: byOf(heard, team, source?.who),
  };
};

type Drawing = NonNullable<Workspace["workflows"][number]["drawings"]>[number];

/** The sentences of a drawing: how the work goes today, and its one-line answers. */
const drawingSentences = (
  drawing: Drawing,
  team: Team | undefined,
  heard: boolean
): KnownSentence[] => {
  const week = isoWeekOf(drawing.date);
  const by = byOf(heard, team);
  const sentence = (
    id: string,
    about: KnownAbout,
    text: string,
    restsOn: RestsOn = "said"
  ): KnownSentence[] =>
    text.trim() === "" ? [] : [{ id, about, text, restsOn, week, by }];
  return [
    ...sentence(`${drawing.id}:starts`, "today", drawing.starts),
    ...drawing.steps.flatMap((step, index) =>
      sentence(
        `${drawing.id}:step:${index}`,
        "today",
        step.text,
        step.documented ? "written" : "said"
      )
    ),
    ...drawing.waits.flatMap((wait, index) =>
      sentence(`${drawing.id}:wait:${index}`, "timeSink", wait)
    ),
    ...(
      [
        ["decides", answerAbout.decides, drawing.decides],
        ["ask", answerAbout.ask, drawing.ask],
        ["next", answerAbout.next, drawing.next],
        ["right", answerAbout.right, drawing.right],
        ["ai", answerAbout.ai, drawing.ai],
        ["own", answerAbout.own, drawing.own],
      ] as const
    ).flatMap(([field, about, text]) =>
      sentence(`${drawing.id}:${field}`, about, text)
    ),
  ];
};

/**
 * What `ws`, the brain as one person reads it, knows about the piece of
 * work `id`; undefined when it knows of no such piece of work.
 */
export const knowledgeOf = (
  ws: Workspace,
  id: string,
  { canAskMore, moreAsked }: { canAskMore: boolean; moreAsked: boolean }
): WorkKnowledge | undefined => {
  const workflow = ws.workflows.find((each) => each.id === id);
  const candidate = ws.candidates.find((each) => each.id === id);
  if (workflow === undefined && candidate === undefined) {
    return undefined;
  }
  const drawing = workflow?.drawings?.at(-1);
  const team = ws.teams.find(({ id: teamId }) => teamId === workflow?.teamId);
  const statements = ws.statements.filter(
    (statement) => statement.candidateId === id
  );
  // Enough people told about it: its newest drawing rests on five or
  // more, or five or more conversations said what the brain holds of it.
  const conversations = new Set(
    statements
      .filter(
        ({ sourceId }) =>
          restsOnOf(
            ws.sources.find(({ id: source }) => source === sourceId)
          ) === "said"
      )
      .map(({ sourceId }) => sourceId)
  );
  const heard =
    Math.max(drawing?.people ?? 0, conversations.size) >= minTeamShown;
  return {
    id,
    name: workflow?.name ?? candidate?.name ?? id,
    sentences: [
      ...(drawing === undefined ? [] : drawingSentences(drawing, team, heard)),
      ...statements.map((statement) => statementSentence(ws, statement, heard)),
    ],
    confidence: heard ? "heard" : "waiting",
    canAskMore: canAskMore && !heard,
    moreAsked: moreAsked && !heard,
  };
};

/** The piece of work's ID, as a call names it. */
const workIdSchema = z.string().min(1).max(200);

/**
 * What Grasp knows about piece of work `id`, for `person` (`brain.work`),
 * from the brain as `read` gives it to them (`brain.read`'s own read).
 */
export const workKnowledge = async (
  env: Env,
  person: Identity,
  id: unknown,
  read: () => Promise<Workspace>
): Promise<WorkKnowledge> => {
  const work = brainErrors.parse("brain.invalid", workIdSchema, id);
  const [ws, asked] = await Promise.all([
    read(),
    onboardingStore(env).moreVoicesAsked(),
  ]);
  const known = knowledgeOf(ws, work, {
    canAskMore: isAdmin(person.role),
    moreAsked: asked.includes(work),
  });
  if (known === undefined) {
    throw brainErrors.create("brain.work_not_found");
  }
  return known;
};

/**
 * Asks to hear more people about piece of work `id` in Stephen's next
 * interviews: for the company's admins, whose the onboarding is. Audited
 * as `brain.work.more_voices_asked`, naming the piece of work alone.
 */
export const askMorePeople = async (
  env: Env,
  person: Identity,
  id: unknown,
  read: () => Promise<Workspace>
): Promise<WorkKnowledge> => {
  if (!isAdmin(person.role)) {
    throw roleErrors.create("role.forbidden");
  }
  const work = brainErrors.parse("brain.invalid", workIdSchema, id);
  // Only a piece of work the brain shows this admin.
  await workKnowledge(env, person, work, read);
  const asked = await onboardingStore(env).askMoreVoices(work);
  if (asked === null) {
    throw brainErrors.create("brain.work_not_found");
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, {
      actor: actorOf(person),
      action: "brain.work.more_voices_asked",
      target: { type: "brain", id: work },
      detail: {},
    }),
  ]);
  return await workKnowledge(env, person, work, read);
};
