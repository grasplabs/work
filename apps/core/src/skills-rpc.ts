import type {
  ListedSkill,
  SkillAudienceAsked,
  SkillShare,
  SkillsApi,
  SkillsOverview,
  SkillText,
} from "@grasp-os/shared/skills";

import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  acceptSkillProposal,
  dismissSkillProposal,
} from "./skill-proposals.ts";
import {
  approveShare,
  declineShare,
  readSkill,
  removeOwnSkill,
  retireSkill,
  saveOwnSkill,
  shareOwnSkill,
  skillsOverview,
  waitingShares,
} from "./skill-shares.ts";

// Skills over `/rpc` (`session.skills`), for a member on their own
// session; like the rest of the workspace it refuses a Grasp staff session
// (session-check.ts `fullAccess`). Who they are comes from the session,
// never from what they send; skill-shares.ts holds every rule, admins'
// included. No agent reaches this: agents only read skills
// (agent-skills.ts).

export class SkillsRpc extends CoreRpcTarget implements SkillsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async overview(): Promise<SkillsOverview> {
    return await withPerson(
      this.#check,
      async (person) => await skillsOverview(this.#env, person)
    );
  }

  async read(scope: "own" | "company", name: string): Promise<SkillText> {
    return await withPerson(
      this.#check,
      async (person) => await readSkill(this.#env, person, scope, name)
    );
  }

  async save(text: string): Promise<ListedSkill> {
    return await withPerson(
      this.#check,
      async (person) => await saveOwnSkill(this.#env, person, text)
    );
  }

  async remove(name: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await removeOwnSkill(this.#env, person, name);
    });
  }

  async acceptProposal(
    workflow: string,
    version: number
  ): Promise<ListedSkill> {
    return await withPerson(
      this.#check,
      async (person) =>
        await acceptSkillProposal(this.#env, person, workflow, version)
    );
  }

  async dismissProposal(workflow: string, version: number): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await dismissSkillProposal(this.#env, person, workflow, version);
    });
  }

  async share(
    name: string,
    version: number,
    audience: SkillAudienceAsked
  ): Promise<SkillShare> {
    return await withPerson(
      this.#check,
      async (person) =>
        await shareOwnSkill(this.#env, person, name, version, audience)
    );
  }

  async approve(id: string): Promise<SkillShare> {
    return await withPerson(
      this.#check,
      async (person) => await approveShare(this.#env, person, id)
    );
  }

  async decline(id: string): Promise<SkillShare> {
    return await withPerson(
      this.#check,
      async (person) => await declineShare(this.#env, person, id)
    );
  }

  async retire(name: string, audience: SkillAudienceAsked): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await retireSkill(this.#env, person, name, audience);
    });
  }

  /** The shares that wait for an admin, for the waiting feed (waiting-rpc.ts). */
  async waiting(): Promise<SkillShare[]> {
    return await withPerson(
      this.#check,
      async (person) => await waitingShares(this.#env, person)
    );
  }
}
