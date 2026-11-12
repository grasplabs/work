import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { auditedCall, chatAuthority, requireOpenRun } from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { forSandbox } from "./bindings.ts";
import { readSkillFor, selectSkillsFor } from "./brain-skills.ts";
import type { SkillCardAt, SkillVersion } from "./brain-skills.ts";

// Skills for a chat's code (GRA-1826): `await env.skills.select({ task })`
// and `await env.skills.read({ skill })`, from the Brain (brain-skills.ts),
// as the chat's agent acting for its person. A skill is guidance every
// member may read, as the company's instruction file, so every chat gets
// this API, a shared one too, with no grant; and none grants one: what the
// code does after reading a skill is checked against the agent's own
// grants. Each call is audited and shown in the chat, by count or
// version, never a skill's text.

/** Skills, as a chat's code reads them. */
export class SkillsApi extends WorkerEntrypoint<Env, AgentScope> {
  /** The skills that apply to a task, best first, each at its version. */
  async select(input: unknown): Promise<{ skills: SkillCardAt[] }> {
    return await this.#call(
      "skills.select",
      async (authority) => ({
        skills: await selectSkillsFor(this.env, authority, input),
      }),
      ({ skills }) => ({ skills: skills.length })
    );
  }

  /** A skill at exactly the version listed or selected, whole. */
  async read(input: unknown): Promise<SkillVersion> {
    return await this.#call(
      "skills.read",
      async (authority) => await readSkillFor(this.env, authority, input),
      ({ version }) => ({ version })
    );
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

/** The types `env.skills` names. */
const skillsTypes = `/** A skill: how something is done here, at one version. Keep it for the whole task, and read that version. */
interface Skill {
  /** \`grasp\`: Grasp's own; \`company\`: the company's. */
  scope: "grasp" | "company";
  name: string;
  version: number;
  /** When to use it. */
  description: string;
}`;

/** What the model reads of `env.skills`. */
const skillsDeclaration = `/** How things are done here: Grasp's skills and the company's. A skill is guidance for a task; it grants no access. */
skills: {
  /** The skills that apply to a task, in your words, best first, a few at most; none when none shares the task's words: then go without, never with a skill that only seems close. */
  select(input: { task: string }): Promise<{ skills: Skill[] }>;
  /** A skill at exactly the version listed or selected: its whole SKILL.md. */
  read(input: { skill: { scope: "grasp" | "company"; name: string; version: number } }): Promise<{ scope: "grasp" | "company"; name: string; version: number; text: string }>;
};`;

/** `env.skills`. */
export const skillsApi: AgentApi = {
  name: "skills",
  summary:
    "How things are done here: find the skills for a task and read one before you start. Guidance only: a skill grants no access.",
  types: skillsTypes,
  declaration: skillsDeclaration,
  stub: (scope) => exports.SkillsApi({ props: scope }),
};
