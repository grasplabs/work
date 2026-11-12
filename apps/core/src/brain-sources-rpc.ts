import { brainSearchBudget } from "@grasp-os/shared/brain-sources";
import type {
  BrainSearchPack,
  BrainSourceListed,
  BrainSourcePage,
  BrainSourceRef,
  BrainSourcesAfter,
  BrainSourcesApi,
  BrainSourceText,
  BrainSourceVersionPage,
} from "@grasp-os/shared/brain-sources";
import { z } from "zod";

import {
  listSourcesAs,
  listVersionsAs,
  readSourceVersionAs,
  recallAs,
} from "./brain-next.ts";
import type { ListedSource, SourceRef } from "./brain-next.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The Brain's sources over `/rpc` (`session.brainSources`), for anyone
// signed in who is a member: each call is the Brain's own as that person
// (brain-next.ts), which reads them with the teams core counts them in
// now and answers only from what they may read. Search is `recallAs`
// with a fixed budget, its pack handed on as it is: the page ranks
// nothing of its own. Like the rest of the workspace it refuses a Grasp
// staff session (session-check.ts `fullAccess`). Nothing here is audited
// per read, as `recallAs` isn't: what a source is and who may read it
// are the Brain's, and brain-next.ts checks every source and version it
// is given with its own rules.

/** Where a page starts, as the page sends back what `list` answered. */
const afterSchema = z.strictObject({
  addedAt: z.iso.datetime(),
  source: z.strictObject({ producer: z.string(), id: z.string() }),
});

/** `input` as `schema` reads it, or an error naming what was wrong. */
const checked = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Refused: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

/**
 * `source` as core's Brain takes it: its own rules check the producer and
 * the id (brain-next.ts), so a value the page shouldn't send is refused
 * there.
 */
const refOf = (source: unknown): SourceRef =>
  // SAFETY: brain-next.ts checks every source it is given against its
  // own schema before naming anything for the Brain.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  source as SourceRef;

const listedOf = ({
  source,
  version,
  addedAt,
  firstLine,
  personal,
  versions,
}: ListedSource): BrainSourceListed => ({
  source,
  version,
  addedAt: addedAt.toISOString(),
  firstLine,
  personal,
  versions,
});

export class BrainSourcesRpc extends CoreRpcTarget implements BrainSourcesApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(after?: BrainSourcesAfter): Promise<BrainSourcePage> {
    return await withPerson(this.#check, async (person) => {
      const from =
        after === undefined ? undefined : checked(afterSchema, after);
      const { sources, next } = await listSourcesAs(
        this.#env,
        person.userId,
        from === undefined
          ? {}
          : {
              after: {
                addedAt: new Date(from.addedAt),
                source: refOf(from.source),
              },
            }
      );
      return {
        sources: sources.map(listedOf),
        next:
          next === null
            ? null
            : { addedAt: next.addedAt.toISOString(), source: next.source },
      };
    });
  }

  async versions(
    source: BrainSourceRef,
    before?: number
  ): Promise<BrainSourceVersionPage> {
    return await withPerson(this.#check, async (person) => {
      const page = await listVersionsAs(this.#env, person.userId, {
        source: refOf(source),
        ...(before === undefined ? {} : { before }),
      });
      return {
        versions: page.versions.map(({ version, addedAt }) => ({
          version,
          addedAt: addedAt.toISOString(),
        })),
        before: page.before,
      };
    });
  }

  async read(
    source: BrainSourceRef,
    version: number
  ): Promise<BrainSourceText | null> {
    return await withPerson(this.#check, async (person) => {
      const read = await readSourceVersionAs(this.#env, person.userId, {
        source: refOf(source),
        version,
      });
      return read === null
        ? null
        : {
            source: read.source,
            version: read.version,
            addedAt: read.addedAt.toISOString(),
            text: read.text,
          };
    });
  }

  async search(question: string): Promise<BrainSearchPack> {
    return await withPerson(
      this.#check,
      async (person) =>
        await recallAs(this.#env, person.userId, {
          question: checked(z.string(), question),
          budget: { tokens: brainSearchBudget },
        })
    );
  }
}
