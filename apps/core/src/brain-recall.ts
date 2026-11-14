import type {
  BrainCard,
  BrainEntity,
  BrainMemory,
  BrainPack,
  BrainSkill,
  BrainSkillText,
} from "@grasp-os/runtime/app";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { functionErrors } from "@grasp-os/shared/functions";
import type { PermissionId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import { skillErrors } from "@grasp-os/shared/skills";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { appendAuditEvent } from "./audit-outbox.ts";
import { storedTeamsOf } from "./brain-grant-teams.ts";
import {
  codeRecallOf,
  companyCardAs,
  companyEntitiesAs,
  isCodeEntitiesRequest,
  recallPassagesAs,
  skillVersionRefOf,
} from "./brain-next.ts";
import type {
  CardMemory,
  CodeEntitiesOperation,
  CompanyCard,
  SkillAt,
  SkillVersionRef,
  SourceVersionRef,
} from "./brain-next.ts";
import { skillReadSchema, skillsSelectSchema } from "./brain-pack.ts";
import { readSkillFor, selectSkillsFor } from "./brain-skills.ts";
import type { HeldNow, SkillsReach } from "./brain-skills.ts";
import { permissions } from "./db/core/schema.ts";
import { authorize } from "./permissions.ts";
import { heldNothing } from "./skill-needs.ts";

// The Brain's recall for code: an App's action (resource-brain.ts), a
// workflow's step (workflows/brain-calls.ts) and a chat's code
// (agent-brain.ts) all come here, with the same request and the same pack
// (`BrainRecall`, `BrainPack` in @grasp-os/runtime). The threat model is
// on GRA-1731. In order:
//
// - The request is untrusted: checked first, strictly, with the Brain's
//   own limits (`codeRecallOf`), so it can't name a reader, groups or a
//   vector, and refused in the function host's fixed words
//   (`permission.invalid_args`).
// - The caller's grant: the App, run or agent must hold the permission to
//   read the Brain it names, active, now, as `authorize` checks every
//   grant (the person still a member; a chat's own permission only in
//   that chat). Filtering a pack afterwards would make `notFound` and
//   `truncated` untrue, so nothing is: whom it reads as is the scope.
// - Whom it reads as. An App's or a workflow's recall reads what everyone
//   in the company may read (`company`), as no person. An App's grant may
//   name teams too (GRA-1842, threat model on the issue): it then also
//   reads, of those, the teams the person it acts for is in now, never
//   wider than the grant nor than them. What the App keeps of that is
//   held to the same teams for everyone it is shared with: each team any
//   of its grants names is one of its sources (app-provenance.ts), so it
//   is shared with, and answers, only someone in all of them. What a run
//   is handed may end up anywhere a member reads (a run's state, a
//   decision, an App a run writes to), so a workflow's grant names no
//   team (permissions.ts), and its recall holds nothing any member
//   couldn't read at the source, whoever called. A chat's code (and its
//   `searchBrain` tool) reads as the person the chat is for, their teams
//   alone (`personal: false`), only in their own chat in Grasp in a turn
//   they started (`RecallCaller.reach`), where what it gets stays theirs;
//   anywhere else (a chat app's direct message, which the app keeps too;
//   a turn a schedule or an event woke) as the company alone, as the
//   recall before the question reads there (GRA-1820, turn-recall.ts).
//   The person is always the one the call acts for
//   (`onBehalfOf`, set by core from the session or the run, never by the
//   code), and must still be a member; the Brain filters inside its own
//   search, so a pack never holds more than that reader may read, and
//   never what only a person may read (GRA-1762).
// - Nothing of the question or the pack is in a refusal, a log line or
//   the audit event, which is kept, answered or refused, before the call
//   returns. What is refused before a call gets here (an App's operation
//   it didn't declare, a declaration or a workflow's alias with no
//   binding an admin approved) is the function host's and the run's own
//   refusal, recorded as theirs, not as a recall.

/** Who recalls, as core resolved them, never as the code says. */
export interface RecallCaller {
  readonly authority: Authority;
  /** Where it works: a chat's own permission holds only in that chat. */
  readonly context: WorkContext;
  /**
   * Its permission to read the Brain (`{ type: "platform" }`, `brain`):
   * null when it holds none, and the recall is refused (and audited).
   */
  readonly permissionId: PermissionId | null;
  /**
   * For a chat's code and its `searchBrain` alone: `teams` reads its
   * person's teams and the company, only in their own chat in Grasp in a
   * turn they started (agent-brain.ts); absent, it reads the company
   * alone, wherever else it is called. Set by core from where the call is
   * made, never by the code. An App's and a workflow's reach is their
   * grant's (`recallFor`), whatever this says.
   */
  readonly reach?: "teams";
  /** How the audit log names it. */
  readonly actor: AuditActor;
  /** What the audit event is about: the App, the run or the chat. */
  readonly target?: AuditEntry["target"];
  /**
   * What the caller keeps of the pack before it gets it: a run's pins, a
   * chat's reads. Run before the recall is audited as answered, so a pack
   * that couldn't be kept is audited as refused, and nobody gets it.
   */
  readonly keep?: (pack: BrainPack) => Promise<void>;
}

/** Whether `input` is a recall as code asks for one (`BrainRecall`). */
export const isBrainRecall = (input: unknown): boolean =>
  codeRecallOf(input) !== undefined;

/**
 * The teams App grant `permissionId` reaches (`teams` on its row), none
 * when it names none. A stored value that isn't a list of team IDs is
 * refused (`permission.denied`), never read as more nor as less (threat
 * model on GRA-1842, item 7). Set as the grant is asked for and never
 * changed, so reading it after `authorize` reads what was authorized.
 */
const grantTeamsOf = async (
  env: Env,
  permissionId: PermissionId
): Promise<readonly string[]> => {
  const row = await drizzle(env.DB)
    .select({ teams: permissions.teams })
    .from(permissions)
    .where(eq(permissions.id, permissionId))
    .get();
  const teams = storedTeamsOf(row?.teams ?? null);
  if (teams === undefined) {
    throw permissionErrors.create("permission.denied", { action: "brain" });
  }
  return teams;
};

/** `error` in the function host's words, which carry nothing of the call. */
const inHostWords = (error: unknown): unknown => {
  if (isExpectedError(error) && error.code === "permission.person_inactive") {
    return functionErrors.create("permission.unavailable");
  }
  return error;
};

/**
 * A pack of what `caller`'s person may read for `input`'s question, within
 * its budget, as of its moment when given. Refused as
 * `permission.invalid_args` when `input` isn't a request, as
 * `permission.denied` without the grant, and as `permission.unavailable`
 * once the person is no longer a member (a visitor never was). Audited,
 * answered or refused, before it returns.
 */
export const recallFor = async (
  env: Env,
  caller: RecallCaller,
  input: unknown
): Promise<BrainPack> => {
  const audit = async (detail: Record<string, string | number | boolean>) => {
    // Straight to the log, as a read is (`appendAuditEvent`): a recall
    // the log can't take is answered nothing.
    await appendAuditEvent(env, {
      actor: caller.actor,
      action: "brain.recall",
      ...(caller.target === undefined ? {} : { target: caller.target }),
      detail: { onBehalfOf: caller.authority.onBehalfOf, ...detail },
    });
  };
  try {
    const recall = codeRecallOf(input);
    if (recall === undefined) {
      throw functionErrors.create("permission.invalid_args");
    }
    if (caller.permissionId === null) {
      throw permissionErrors.create("permission.denied", { action: "brain" });
    }
    await authorize(
      env,
      caller.authority,
      { type: "platform" },
      "brain",
      caller.permissionId,
      caller.context
    );
    // An App's as the company and, of its grant's teams, the person's; a
    // workflow's as the company alone; a chat's code as its person's
    // teams in their own chat (`reach`), and as the company alone
    // anywhere else; never what only a person may read. Nothing code
    // sends can change it.
    // Passages alone (GRA-1742): the pack code gets is the SDK's
    // `BrainPack`, which holds no memory, so none takes its budget or a
    // word from `notFound`, and no entity reaches code.
    const { subject } = caller.authority;
    const recalled = await recallPassagesAs(env, caller.authority.onBehalfOf, {
      ...recall,
      personal: false,
      company: subject.type !== "agent" || caller.reach !== "teams",
      teams:
        subject.type === "app"
          ? await grantTeamsOf(env, caller.permissionId)
          : [],
    });
    // A capture is one person's own, kept only in their own store (core's
    // addSource refuses it anywhere else), which this recall never reads:
    // none can be here. Narrowed for the SDK's type, never thrown over.
    const pack: BrainPack = {
      ...recalled,
      items: recalled.items.flatMap((item) => {
        const { producer, id } = item.source;
        return producer === "capture"
          ? []
          : [{ ...item, source: { producer, id } }];
      }),
    };
    await caller.keep?.(pack);
    await audit({ items: pack.items.length, truncated: pack.truncated });
    return pack;
  } catch (error) {
    const refused = inHostWords(error);
    await audit({
      refused: isExpectedError(refused) ? refused.code : "internal.unexpected",
    });
    throw refused;
  }
};

/** What code asks of the Brain's skills: `ctx.brain.skills.<operation>`. */
export type SkillsOperation = "skills.select" | "skills.read";

/** `error` in the function host's words, a skill's refusals among them. */
const inHostSkillWords = (error: unknown): unknown => {
  const code = skillErrors.codeOf(error);
  if (code === "skills.invalid") {
    return functionErrors.create("permission.invalid_args");
  }
  if (code === "skills.not_found") {
    return functionErrors.create("permission.item_not_found");
  }
  return inHostWords(error);
};

/**
 * How far code's skills go: Grasp's and the company's alone. Never a
 * person's own, which only ever reach that person's own chat, and never a
 * team's (GRA-1844: decided for now; whether an App whose Brain grant is
 * scoped to teams gets their skills is GRA-1844's follow-up with #2234).
 * Code's input is refused for naming any other scope before this is asked
 * (`skillReadSchema`, `grasp` and `company` alone).
 */
const codeSkills: SkillsReach = "company";

/**
 * What code holds of what a skill may need (skill-needs.ts): nothing. No
 * App or workflow has a truthful set of connections and tools to meet a
 * skill's needs against yet, so a skill that declares any is never
 * listed, selected or read from code: it is as if it weren't there.
 */
const codeHolds: HeldNow = async () => await Promise.resolve(heldNothing);

/**
 * `skill` as code may be handed it: Grasp's or the company's. A person's
 * own or a team's is never asked for (`codeSkills`); one coming back
 * anyway fails the call, never passed on.
 */
const forCode = <Skill extends { scope: SkillAt["scope"] }>(
  skill: Skill
): Skill & { scope: "grasp" | "company" } => {
  const { scope } = skill;
  if (scope !== "grasp" && scope !== "company") {
    throw new Error("A person's own or a team's skill reached code");
  }
  return { ...skill, scope };
};

/** Who reads the Brain's skills: a recall's caller, with its own pins. */
export interface SkillsCaller extends Omit<RecallCaller, "keep"> {
  /**
   * What the caller keeps of the skills it is handed, before it gets them:
   * a run's pins, as a recall's (`recordRunVersions`). Run before the call
   * is audited as answered, so skills that couldn't be kept are audited as
   * refused, and nobody gets them.
   */
  readonly keep?: (versions: readonly SkillVersionRef[]) => Promise<void>;
}

/**
 * The Brain's skills for an App's action or a workflow's step (GRA-1830):
 * `skills.select` the skills for `input.task`, `skills.read` one at the
 * version a selection gave, the same a chat's code selects and reads for
 * the same person (brain-skills.ts), at the company's reach and holding no
 * needs (`codeSkills`, `codeHolds`): never the person's own, never a
 * team's, never one that declares what it needs. Checked, kept and audited as a recall
 * is (`recallFor`, the threat model on GRA-1830): the input first, then
 * the caller's grant to read the Brain, now, and the person it acts for
 * still a member. Refused as `permission.invalid_args` for input that
 * isn't a task or a skill, `permission.item_not_found` for a skill there
 * isn't at that version, `permission.denied` without the grant and
 * `permission.unavailable` once the person is no longer a member. Each
 * skill handed over, a selection's or a read's, is kept by the caller
 * first (`keep`), so a run checks it again before anything leaves it.
 * Audited, answered or refused, before it returns: how many skills, or
 * which version, never the task, a name or a text.
 */
export const skillsCallFor = async (
  env: Env,
  caller: SkillsCaller,
  operation: SkillsOperation,
  input: unknown
): Promise<{ skills: readonly BrainSkill[] } | BrainSkillText> => {
  const audit = async (detail: Record<string, string | number | boolean>) => {
    await appendAuditEvent(env, {
      actor: caller.actor,
      action: `brain.${operation}`,
      ...(caller.target === undefined ? {} : { target: caller.target }),
      detail: { onBehalfOf: caller.authority.onBehalfOf, ...detail },
    });
  };
  try {
    // The input first, as a recall's: a caller with no grant and bad
    // input is refused alike by both.
    const request =
      operation === "skills.select" ? skillsSelectSchema : skillReadSchema;
    if (!request.safeParse(input).success) {
      throw functionErrors.create("permission.invalid_args");
    }
    if (caller.permissionId === null) {
      throw permissionErrors.create("permission.denied", { action: "brain" });
    }
    await authorize(
      env,
      caller.authority,
      { type: "platform" },
      "brain",
      caller.permissionId,
      caller.context
    );
    if (operation === "skills.select") {
      const skills = await selectSkillsFor(
        env,
        caller.authority,
        codeSkills,
        codeHolds,
        input
      );
      const handed = skills.map((skill) => forCode(skill));
      await caller.keep?.(handed.map((skill) => skillVersionRefOf(skill)));
      await audit({ skills: handed.length });
      return { skills: handed };
    }
    const read = await readSkillFor(
      env,
      caller.authority,
      codeSkills,
      codeHolds,
      input
    );
    const handed = forCode(read);
    await caller.keep?.([skillVersionRefOf(handed)]);
    await audit({ scope: handed.scope, version: handed.version });
    return handed;
  } catch (error) {
    const refused = inHostSkillWords(error);
    await audit({
      refused: isExpectedError(refused) ? refused.code : "internal.unexpected",
    });
    throw refused;
  }
};

// The Brain's entities for code (GRA-1837, threat model on the issue): an
// App's action (resource-brain.ts) and a workflow's step
// (workflows/brain-calls.ts) read an entity's card and find entities, as
// the company alone (brain-next.ts), whatever teams their grant names. In
// order, as a recall's:
//
// - The request first, strictly (`isCodeEntitiesRequest`): it can't name
//   a reader.
// - The caller's grant to read the Brain, now (`authorize`).
// - Audited once, before it answers, with ids and counts alone: never a
//   name, a statement or a cursor. An entity the company may not see is
//   answered as one nobody holds.

/** What code asks of the Brain's entities: `ctx.brain.entities.<name>`. */
export type EntitiesOperation = CodeEntitiesOperation;

/**
 * Whether `input` is a request code may make of `operation`, as
 * `entitiesCallFor` takes it: what a workflow's test run checks before it
 * answers from its fixtures.
 */
export const isEntitiesRequest = (
  operation: EntitiesOperation,
  input: unknown
): boolean => isCodeEntitiesRequest(operation, input);

/** Who reads the Brain's entities: a recall's caller, keeping what a card rests on. */
export interface EntitiesCaller extends Omit<RecallCaller, "keep" | "reach"> {
  /**
   * What the caller keeps of the versions a card's memories rest on,
   * before it gets them: a run's pins, as a recall's.
   */
  readonly keep?: (versions: readonly SourceVersionRef[]) => Promise<void>;
}

/** An id as the audit log may name it: a well-formed one, never what code sent instead. */
const idOf = (value: unknown): string | null => {
  const id = z.uuid().safeParse(value);
  return id.success ? id.data : null;
};

/** The entity `input` asks for, as the audit log may name it. */
const askedEntityOf = (input: unknown): string | null =>
  idOf(
    typeof input === "object" && input !== null
      ? Reflect.get(input, "entity")
      : undefined
  );

/** `error` in the function host's words: a request the Brain refused as one it isn't. */
const inHostEntityWords = (error: unknown): unknown =>
  isExpectedError(error) && error.code === "brain.request_invalid"
    ? functionErrors.create("permission.invalid_args")
    : inHostWords(error);

/** A memory as code is handed it (`BrainMemory`): what it says, never who wrote or confirmed it. */
const codeMemoryOf = (memory: CardMemory) =>
  ({
    id: memory.id,
    attribute: memory.attribute,
    value: memory.value,
    statement: memory.statement,
    learnedAt: memory.learnedAt.toISOString(),
    confirmed: memory.confirmed !== null,
    contested: memory.contested,
  }) satisfies BrainMemory;

/** A card as code is handed it (`BrainCard`), as JSON. */
const codeCardOf = (card: CompanyCard) =>
  ({
    entity: card.entity,
    attributes: card.attributes.map(({ attribute, memories, contested }) => ({
      attribute,
      memories: memories.map((memory) => codeMemoryOf(memory)),
      contested,
    })),
    relations: card.relations.map(({ attribute, side, other, memory }) => ({
      attribute,
      side,
      other,
      memory: codeMemoryOf(memory),
    })),
    notes: card.notes.map((memory) => codeMemoryOf(memory)),
    next: card.next,
  }) satisfies BrainCard;

/** The versions the memories of `card` rest on, each once. */
const versionsOf = (card: CompanyCard): SourceVersionRef[] => {
  const all = [
    ...card.attributes.flatMap(({ memories }) => memories),
    ...card.relations.map(({ memory }) => memory),
    ...card.notes,
  ];
  const seen = new Map<string, SourceVersionRef>();
  for (const { source } of all) {
    if (source !== null) {
      seen.set(JSON.stringify([source.source, source.version]), source);
    }
  }
  return [...seen.values()];
};

/** The memories on `card`, counted. */
const memoriesOn = (card: CompanyCard): number =>
  card.attributes.reduce(
    (count, { memories }) => count + memories.length,
    card.relations.length + card.notes.length
  );

/** Reads `operation` for `caller`, checked already: what it answers code, and what its audit says. */
const readFor = async (
  env: Env,
  caller: EntitiesCaller,
  operation: EntitiesOperation,
  input: unknown
): Promise<{
  answer: Json;
  detail: Record<string, string | number | boolean | null>;
}> => {
  const person = caller.authority.onBehalfOf;
  if (operation === "entities.get") {
    const card = await companyCardAs(env, person, input);
    if (card === null) {
      return { answer: null, detail: { found: false, memories: 0 } };
    }
    // Pinned with the run before it gets them, as a recall's pack is.
    await caller.keep?.(versionsOf(card));
    return {
      answer: codeCardOf(card),
      detail: { found: true, memories: memoriesOn(card) },
    };
  }
  const page = await companyEntitiesAs(env, person, input);
  return {
    answer: {
      entities: page.entities.map(
        ({ id, kind, name }) => ({ id, kind, name }) satisfies BrainEntity
      ),
      next: page.next,
    },
    detail: { entities: page.entities.length },
  };
};

/**
 * The Brain's entities for an App's action or a workflow's step (above):
 * `entities.get` a page of an entity's card and `entities.find` a page of
 * entities, as the company may read them. Refused as
 * `permission.invalid_args` for input that isn't a request,
 * `permission.denied` without the grant to read the Brain, and
 * `permission.unavailable` once the person is no longer a member.
 * Audited once, before it answers.
 */
export const entitiesCallFor = async (
  env: Env,
  caller: EntitiesCaller,
  operation: EntitiesOperation,
  input: unknown
): Promise<Json> => {
  const asked: Record<string, string | null> =
    operation === "entities.get" ? { entity: askedEntityOf(input) } : {};
  const audit = async (
    detail: Record<string, string | number | boolean | null>
  ): Promise<void> => {
    await appendAuditEvent(env, {
      actor: caller.actor,
      action: `brain.${operation}`,
      ...(caller.target === undefined ? {} : { target: caller.target }),
      detail: { onBehalfOf: caller.authority.onBehalfOf, ...asked, ...detail },
    });
  };
  let read: Awaited<ReturnType<typeof readFor>>;
  try {
    // The input first, as a recall's: a caller with no grant and bad
    // input is refused alike by both.
    if (!isCodeEntitiesRequest(operation, input)) {
      throw functionErrors.create("permission.invalid_args");
    }
    if (caller.permissionId === null) {
      throw permissionErrors.create("permission.denied", { action: "brain" });
    }
    await authorize(
      env,
      caller.authority,
      { type: "platform" },
      "brain",
      caller.permissionId,
      caller.context
    );
    read = await readFor(env, caller, operation, input);
  } catch (error) {
    const refused = inHostEntityWords(error);
    await audit({
      refused: isExpectedError(refused) ? refused.code : "internal.unexpected",
    });
    throw refused;
  }
  await audit(read.detail);
  return read.answer;
};
