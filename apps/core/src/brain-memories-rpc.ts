import { actorOf } from "@grasp-os/shared/audit";
import type {
  BrainMemoriesApi,
  BrainMemoryOutcome,
} from "@grasp-os/shared/brain-memories";

import { forgetFor } from "./brain-memories.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The memories the agent saved for a person in their own chats, over
// `/rpc` (`session.brainMemories`): the chat's notice undoes one here.
// Each call acts as the signed-in person, in their own word, on their own
// store alone (brain-memories.ts): a memory of anyone else's answers
// `nothing`, as one that doesn't exist; one they undid before, `done`. Like the
// rest of the workspace it refuses a Grasp staff session.

export class BrainMemoriesRpc
  extends CoreRpcTarget
  implements BrainMemoriesApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async forget(memory: string): Promise<BrainMemoryOutcome> {
    return await withPerson(
      this.#check,
      async (person) =>
        await forgetFor(
          this.#env,
          {
            person: person.userId,
            actor: actorOf(person),
            word: { kind: "own" },
            personal: true,
          },
          memory
        )
    );
  }
}
