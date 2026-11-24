import type {
  InstructionFileRef,
  InstructionFileText,
  InstructionsApi,
} from "@grasp-os/shared/instruction-files";

import {
  instructionFileToEdit,
  saveInstructionFile,
} from "./instruction-files.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Instruction files over `/rpc` (`session.instructions`), for the pages
// where people edit them. Each call passes the session's own `Identity`
// to instruction-files.ts, whose rule decides what they may read and
// write, with their role and membership read from core's records then.
// Like the rest of the workspace it refuses a Grasp staff session
// (session-check.ts `fullAccess`).

export class InstructionsRpc extends CoreRpcTarget implements InstructionsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async read(file: InstructionFileRef): Promise<InstructionFileText | null> {
    return await withPerson(
      this.#check,
      async (person) => await instructionFileToEdit(this.#env, person, file)
    );
  }

  async save(saved: {
    file: InstructionFileRef;
    change: string;
    text: string;
    after: number;
  }): Promise<{ version: number }> {
    return await withPerson(this.#check, async (person) => {
      const { version } = await saveInstructionFile(this.#env, person, saved);
      return { version };
    });
  }
}
