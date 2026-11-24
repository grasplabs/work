import { connectionOwnersMax } from "@grasp-os/shared/connect";
import { log } from "@grasp-os/shared/log";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { connectionGrants } from "./agent-connections.ts";
import { auditedCall, chatAuthority, requireOpenRun } from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { forSandbox } from "./bindings.ts";
import {
  readSkillFor,
  selectSkillsFor,
  skillsReachOf,
} from "./brain-skills.ts";
import type {
  HeldNow,
  SkillCard,
  SkillsReach,
  SkillVersion,
} from "./brain-skills.ts";
import { heldNothing } from "./skill-needs.ts";
import type { HeldCapabilities } from "./skill-needs.ts";

// Skills for a chat's code (GRA-1826, GRA-1754, GRA-1844): `await
// env.skills.select({ task })` and `await env.skills.read({ skill })`,
// from the Brain (brain-skills.ts), as the chat's agent acting for its
// person. Skills are guidance, so every chat gets this API, a shared one
// too, with no grant; and none grants one: what the code does after
// reading a skill is checked against the agent's own grants. How far it
// reads (`SkillsReach`): the person's own skills only in their own chat,
// where the answer reaches them alone; their teams' in their own
// conversation; a shared chat's API reads Grasp's and the company's
// alone. A skill that needs a connection or a tool the chat's agent
// doesn't hold now (`heldBy`) is never listed, selected or read. Agents
// only read: writing, sharing and approving a skill are a person's, on
// their own session (skill-shares.ts). Each call is audited and shown in
// the chat, by count or version, never a skill's text.

/**
 * What the chat's agent holds now, as a skill's needs are met against it
 * (skill-needs.ts): the providers of the active connections its
 * permissions here cover, and the actions those permissions give on them.
 * Holds nothing when that can't be read (connect out of reach): a skill
 * that needs anything is then left out, never given.
 */
export const heldBy = async (
  env: Env,
  scope: Omit<AgentScope, "runId">
): Promise<HeldCapabilities> => {
  try {
    const grants = await connectionGrants(env, scope);
    const ids = [
      ...new Set(grants.map(({ connection }) => connection.connectionId)),
    ];
    const active = new Map<string, string>();
    for (let at = 0; at < ids.length; at += connectionOwnersMax) {
      // oxlint-disable-next-line no-await-in-loop -- a few batches, in order
      const owners = await env.CONNECT.connectionOwners(
        ids.slice(at, at + connectionOwnersMax)
      );
      for (const { id, provider, status } of owners) {
        if (status === "active") {
          active.set(id, provider);
        }
      }
    }
    const held = grants.filter(({ connection }) =>
      active.has(connection.connectionId)
    );
    return {
      connections: new Set(
        held.flatMap(({ connection }) => {
          const provider = active.get(connection.connectionId);
          return provider === undefined ? [] : [provider];
        })
      ),
      tools: new Set(held.flatMap(({ actions }) => actions)),
    };
  } catch (error) {
    log.warn("skills.held_unavailable", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return heldNothing;
  }
};

/**
 * What a chat at `reach` holds: nothing where others share it (it has no
 * connections), else what its agent holds now (`heldBy`), asked when needed.
 */
export const heldIn =
  (env: Env, scope: Omit<AgentScope, "runId">, reach: SkillsReach): HeldNow =>
  async () =>
    reach === "company" ? heldNothing : await heldBy(env, scope);

/** A skills API's scope: the chat's, and how far its skills go. */
type SkillsScope = AgentScope & { reach: SkillsReach };

/** Skills, as a chat's code reads them. */
export class SkillsApi extends WorkerEntrypoint<Env, SkillsScope> {
  /** The skills that apply to a task, best first, each at its version. */
  async select(input: unknown): Promise<{ skills: SkillCard[] }> {
    return await this.#call(
      "skills.select",
      async (authority) => ({
        skills: await selectSkillsFor(
          this.env,
          authority,
          this.ctx.props.reach,
          this.#held,
          input
        ),
      }),
      ({ skills }) => ({ skills: skills.length })
    );
  }

  /** A skill at exactly the version listed or selected, whole. */
  async read(input: unknown): Promise<SkillVersion> {
    return await this.#call(
      "skills.read",
      async (authority) =>
        await readSkillFor(
          this.env,
          authority,
          this.ctx.props.reach,
          this.#held,
          input
        ),
      ({ version }) => ({ version })
    );
  }

  /** What the chat's agent holds, asked only when a skill needs anything. */
  get #held(): HeldNow {
    return heldIn(this.env, this.ctx.props, this.ctx.props.reach);
  }

  /** One call, as the chat's agent, audited however it ends. */
  async #call<T>(
    method: string,
    run: (authority: ReturnType<typeof chatAuthority>) => Promise<T>,
    detailOf: (result: T) => Record<string, number>
  ): Promise<T> {
    const scope = this.ctx.props;
    try {
      await requireOpenRun(this.env, scope, method);
      return await auditedCall(
        this.env,
        scope,
        { method, detailOf },
        async () => await run(chatAuthority(scope))
      );
    } catch (error) {
      throw forSandbox(error);
    }
  }
}

/** The scopes a skills API lists, as its declaration types them. */
const scopesOf = (personal: boolean): string =>
  personal ? `"grasp" | "company" | "team" | "person"` : `"grasp" | "company"`;

/** What each scope means, as the model reads it. */
const scopesDoc = (personal: boolean): string =>
  personal
    ? "`grasp`: Grasp's own; `company`: the company's; `team`: one of your person's teams' (`team` is its ID); `person`: your person's own, for their chats alone."
    : "`grasp`: Grasp's own; `company`: the company's.";

/** A skill's team, as its declaration types it: a team's skill names it. */
const teamOf = (personal: boolean): string =>
  personal
    ? "\n  /** A team's skill only: the team's ID, which a read names. */\n  team?: string;\n  /** A team's skill only: the team's name. */\n  teamName?: string;"
    : "";

/** The types `env.skills` names. */
const skillsTypes = (
  personal: boolean
): string => `/** A skill: how something is done here, at one version. Keep it for the whole task, and read that version. */
interface Skill {
  /** ${scopesDoc(personal)} */
  scope: ${scopesOf(personal)};${teamOf(personal)}
  name: string;
  version: number;
  /** When to use it. */
  description: string;
}`;

/** What the model reads of `env.skills`. */
const skillsDeclaration = (
  personal: boolean
): string => `/** How things are done here: Grasp's skills, the company's${personal ? ", your person's teams' and your person's own" : ""}. A skill is guidance for a task; it grants no access. */
skills: {
  /** The skills that apply to a task, in your words, best first, a few at most; none when none shares the task's words: then go without, never with a skill that only seems close. */
  select(input: { task: string }): Promise<{ skills: Skill[] }>;
  /** A skill at exactly the version listed or selected: its whole SKILL.md. */
  read(input: { skill: { scope: ${scopesOf(personal)};${personal ? " team?: string;" : ""} name: string; version: number } }): Promise<{ scope: ${scopesOf(personal)};${personal ? " team?: string;" : ""} name: string; version: number; text: string }>;
};`;

const summary =
  "How things are done here: find the skills for a task and read one before you start. Guidance only: a skill grants no access.";

/**
 * `env.skills` in a person's own chat: their teams' skills too, and their
 * own in a turn they asked for there (`skillsReachOf`).
 */
export const skillsApi: AgentApi = {
  name: "skills",
  summary,
  types: skillsTypes(true),
  declaration: skillsDeclaration(true),
  stub: (scope) =>
    exports.SkillsApi({
      props: { ...scope, reach: skillsReachOf(scope, false) },
    }),
};

/** `env.skills` in a chat others share: Grasp's and the company's alone. */
export const sharedSkillsApi: AgentApi = {
  name: "skills",
  summary,
  types: skillsTypes(false),
  declaration: skillsDeclaration(false),
  stub: (scope) =>
    exports.SkillsApi({
      props: { ...scope, reach: skillsReachOf(scope, true) },
    }),
};
