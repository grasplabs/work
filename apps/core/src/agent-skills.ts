import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { auditedCall, chatAuthority, requireOpenRun } from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { forSandbox } from "./bindings.ts";
import { readSkillFor, selectSkillsFor } from "./brain-skills.ts";
import type { SkillCardAt, SkillsReach, SkillVersion } from "./brain-skills.ts";

// Skills for a chat's code (GRA-1826, GRA-1754): `await
// env.skills.select({ task })` and `await env.skills.read({ skill })`,
// from the Brain (brain-skills.ts), as the chat's agent acting for its
// person. Grasp's and the company's skills are guidance every member may
// read, as the company's instruction file, so every chat gets this API, a
// shared one too, with no grant; and none grants one: what the code does
// after reading a skill is checked against the agent's own grants. The
// person's own skills come only in their own chat (`personal`), where the
// answer reaches them alone; a shared chat's API never reads their store.
// Agents only read: writing, sharing and approving a skill are a person's,
// on their own session (skill-shares.ts). Each call is audited and shown
// in the chat, by count or version, never a skill's text.

/** A skills API's scope: the chat's, and whether it reaches its person alone. */
type SkillsScope = AgentScope & SkillsReach;

/** Skills, as a chat's code reads them. */
export class SkillsApi extends WorkerEntrypoint<Env, SkillsScope> {
  /** The skills that apply to a task, best first, each at its version. */
  async select(input: unknown): Promise<{ skills: SkillCardAt[] }> {
    return await this.#call(
      "skills.select",
      async (authority) => ({
        skills: await selectSkillsFor(this.env, authority, this.#reach, input),
      }),
      ({ skills }) => ({ skills: skills.length })
    );
  }

  /** A skill at exactly the version listed or selected, whole. */
  async read(input: unknown): Promise<SkillVersion> {
    return await this.#call(
      "skills.read",
      async (authority) =>
        await readSkillFor(this.env, authority, this.#reach, input),
      ({ version }) => ({ version })
    );
  }

  /** Whether the person's own skills come too. */
  get #reach(): SkillsReach {
    return { personal: this.ctx.props.personal };
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
  personal ? `"grasp" | "company" | "person"` : `"grasp" | "company"`;

/** What each scope means, as the model reads it. */
const scopesDoc = (personal: boolean): string =>
  personal
    ? "`grasp`: Grasp's own; `company`: the company's; `person`: your person's own, for their chats alone."
    : "`grasp`: Grasp's own; `company`: the company's.";

/** The types `env.skills` names. */
const skillsTypes = (
  personal: boolean
): string => `/** A skill: how something is done here, at one version. Keep it for the whole task, and read that version. */
interface Skill {
  /** ${scopesDoc(personal)} */
  scope: ${scopesOf(personal)};
  name: string;
  version: number;
  /** When to use it. */
  description: string;
}`;

/** What the model reads of `env.skills`. */
const skillsDeclaration = (
  personal: boolean
): string => `/** How things are done here: Grasp's skills, the company's${personal ? " and your person's own" : ""}. A skill is guidance for a task; it grants no access. */
skills: {
  /** The skills that apply to a task, in your words, best first, a few at most; none when none shares the task's words: then go without, never with a skill that only seems close. */
  select(input: { task: string }): Promise<{ skills: Skill[] }>;
  /** A skill at exactly the version listed or selected: its whole SKILL.md. */
  read(input: { skill: { scope: ${scopesOf(personal)}; name: string; version: number } }): Promise<{ scope: ${scopesOf(personal)}; name: string; version: number; text: string }>;
};`;

const summary =
  "How things are done here: find the skills for a task and read one before you start. Guidance only: a skill grants no access.";

/** `env.skills` in a person's own chat: their own skills come too. */
export const skillsApi: AgentApi = {
  name: "skills",
  summary,
  types: skillsTypes(true),
  declaration: skillsDeclaration(true),
  // Not in a turn nobody asked for (`unattended`), as the turn's list.
  stub: (scope) =>
    exports.SkillsApi({
      props: { ...scope, personal: scope.unattended !== true },
    }),
};

/** `env.skills` in a chat others share: Grasp's and the company's alone. */
export const sharedSkillsApi: AgentApi = {
  name: "skills",
  summary,
  types: skillsTypes(false),
  declaration: skillsDeclaration(false),
  stub: (scope) => exports.SkillsApi({ props: { ...scope, personal: false } }),
};
