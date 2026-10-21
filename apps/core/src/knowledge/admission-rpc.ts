import type {
  AdmissionApi,
  AdmissionTopic,
  AdmissionTopicState,
  TopicInput,
  TopicRetire,
} from "@grasp-os/shared/admission";

import { CoreRpcTarget } from "../rpc-target.ts";
import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { listTopics, retireTopic, saveTopic } from "./admission-records.ts";

/** Knowledge admission's topics over `/rpc`, for admins. */
export class AdmissionRpc extends CoreRpcTarget implements AdmissionApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async topics(): Promise<AdmissionTopicState[]> {
    return await withPerson(
      this.#check,
      async (person) => await listTopics(this.#env, person)
    );
  }

  async saveTopic(input: TopicInput): Promise<AdmissionTopic> {
    return await withPerson(
      this.#check,
      async (person) => await saveTopic(this.#env, person, input)
    );
  }

  async retireTopic(input: TopicRetire): Promise<AdmissionTopic> {
    return await withPerson(
      this.#check,
      async (person) => await retireTopic(this.#env, person, input)
    );
  }
}
