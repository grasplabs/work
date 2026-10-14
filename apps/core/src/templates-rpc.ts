import type {
  PublishedTemplate,
  TemplatePublication,
  TemplatesApi,
} from "@grasp-os/shared/resource-bindings";

import { listTemplates, publishTemplate } from "./resource-templates.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/** A signed-in person's `templates`, validated and checked on every call. */
export class TemplatesRpc extends CoreRpcTarget implements TemplatesApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async publish(publication: TemplatePublication): Promise<PublishedTemplate> {
    return await withPerson(
      this.#check,
      async (person) => await publishTemplate(this.#env, person, publication)
    );
  }

  async list(): Promise<PublishedTemplate[]> {
    return await withPerson(
      this.#check,
      async (person) => await listTemplates(this.#env, person)
    );
  }
}
