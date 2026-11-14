import { actorOf } from "@grasp-os/shared/audit";
import type {
  BrainContestedPage,
  BrainCorrected,
  BrainCorrection,
  BrainEntityKind,
  BrainEntityListed,
  BrainEntityPage,
  BrainEntityRef,
  BrainMemoriesApi,
  BrainMemoryAttribute,
  BrainMemoryOutcome,
  BrainMemoryPage,
  BrainMemoryPageNext,
  BrainMemoryPlace,
  BrainMemoryShown,
  BrainStoreCursor,
} from "@grasp-os/shared/brain-memories";

import { confirmFor, correctFor, forgetFor } from "./brain-memories.ts";
import type { MemoryCaller } from "./brain-memories.ts";
import { contestedAs, entitiesAs, memoriesAs } from "./brain-next.ts";
import type { StoredEntity, StoredMemory, StorePlace } from "./brain-next.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// A person's memories over `/rpc` (`session.brainMemories`): the chat's
// notice undoes one the agent saved for them (`forget`), and the Brain's
// Memories page (GRA-1746) lists the entities they may see, what the
// Brain remembers about one, history included, and the facts sources
// disagree on, and takes their confirmation or correction. Each call acts
// as the signed-in person, from what they may read alone (brain-next.ts,
// brain-memories.ts): what they may not read answers as what doesn't
// exist. Reads aren't audited per read, as the Sources page's aren't; a
// confirmation and a correction are (brain-memories.ts). Like the rest of
// the workspace it refuses a Grasp staff session.

/** The fields of the Brain's cursors that hold a moment. */
const momentFields = new Set(["at", "learned", "learnedAt"]);

/** A field of a store's cursor as the page holds it: a moment as ISO 8601. */
const fieldOut = (value: unknown): string | boolean | null => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === "string" || typeof value === "boolean" ? value : null;
};

/** A store's cursor as the page holds it (`fieldOut`). */
const cursorOut = (cursor: object): BrainStoreCursor =>
  Object.fromEntries(
    Object.entries(cursor).map(([field, value]: [string, unknown]) => [
      field,
      fieldOut(value),
    ])
  );

/**
 * A cursor as the page sent it back, its moments as dates again, for the
 * Brain's own schema to check (brain-next.ts): anything else as it came,
 * refused there.
 */
const cursorIn = (cursor: unknown): unknown =>
  typeof cursor === "object" && cursor !== null && !Array.isArray(cursor)
    ? Object.fromEntries(
        Object.entries(cursor).map(([field, value]: [string, unknown]) => [
          field,
          momentFields.has(field) && typeof value === "string"
            ? new Date(value)
            : value,
        ])
      )
    : cursor;

/**
 * Where a listing goes on, as the page sent it back, for brain-next.ts to
 * check: null and absent are its start.
 */
const placeIn = (
  next: BrainMemoryPageNext | null | undefined
): Record<string, unknown> => {
  if (next === undefined || next === null) {
    return {};
  }
  if (typeof next !== "object" || next.after === undefined) {
    return { from: next };
  }
  return { from: { ...next, after: cursorIn(next.after) } };
};

const placeOut = (
  place: StorePlace<object> | null
): BrainMemoryPageNext | null =>
  place === null
    ? null
    : {
        store: place.store,
        ...(place.after === undefined ? {} : { after: cursorOut(place.after) }),
      };

/** An attribute as the page names it: the Brain's own, which shared's list names (brain-next.ts holds them equal). */
const attributeOut = (attribute: string): BrainMemoryAttribute =>
  // SAFETY: the Brain files a memory only under an attribute of its own
  // list, and brain-next.ts holds shared's list equal to it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  attribute as BrainMemoryAttribute;

const entityOut = ({
  store,
  id,
  kind,
  name,
  unreadable,
}: StoredEntity): BrainEntityListed => ({
  entity: { store, id },
  kind,
  name,
  unreadable,
});

const memoryOut = (person: string, memory: StoredMemory): BrainMemoryShown => ({
  store: memory.store,
  id: memory.id,
  about: memory.about,
  // The Brain's attributes, which the shared list names (brain-memories.ts).
  attribute: memory.attribute === null ? null : attributeOut(memory.attribute),
  object: memory.object,
  value: memory.value,
  type: memory.type,
  statement: memory.statement,
  quote: memory.quote,
  source: memory.source,
  yours: memory.writer === person,
  learnedAt: memory.learnedAt.toISOString(),
  endedAt: memory.endedAt?.toISOString() ?? null,
  confirmed:
    memory.confirmed === null
      ? null
      : {
          at: memory.confirmed.at.toISOString(),
          byYou: memory.confirmed.by === person,
        },
  contested: memory.contested,
});

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

  /** `act` as the signed-in person, a caller of brain-memories.ts. */
  async #asCaller<T>(act: (caller: MemoryCaller) => Promise<T>): Promise<T> {
    return await withPerson(
      this.#check,
      async (person) =>
        await act({ person: person.userId, actor: actorOf(person) })
    );
  }

  async forget(memory: string): Promise<BrainMemoryOutcome> {
    return await this.#asCaller(
      async (caller) => await forgetFor(this.#env, caller, memory)
    );
  }

  async entities(
    kind: BrainEntityKind,
    next?: BrainMemoryPageNext | null
  ): Promise<BrainEntityPage> {
    return await withPerson(this.#check, async (person) => {
      const page = await entitiesAs(this.#env, person.userId, {
        kind,
        ...placeIn(next),
      });
      return { entities: page.items.map(entityOut), next: placeOut(page.next) };
    });
  }

  async memories(
    entity: BrainEntityRef,
    next?: BrainStoreCursor | null
  ): Promise<BrainMemoryPage> {
    return await withPerson(this.#check, async (person) => {
      const page = await memoriesAs(this.#env, person.userId, {
        entity,
        ...(next === undefined || next === null
          ? {}
          : { after: cursorIn(next) }),
      });
      return {
        entity: page.entity === null ? null : entityOut(page.entity),
        memories: page.memories.map((each) => memoryOut(person.userId, each)),
        next: page.next === null ? null : cursorOut(page.next),
      };
    });
  }

  async contested(
    next?: BrainMemoryPageNext | null
  ): Promise<BrainContestedPage> {
    return await withPerson(this.#check, async (person) => {
      const page = await contestedAs(this.#env, person.userId, placeIn(next));
      return {
        facts: page.items.map(({ about, attribute, sides, more }) => ({
          about: entityOut(about),
          attribute: attributeOut(attribute),
          sides: sides.map((each) => memoryOut(person.userId, each)),
          more,
        })),
        next: placeOut(page.next),
      };
    });
  }

  async confirm(memory: BrainMemoryPlace): Promise<BrainMemoryOutcome> {
    return await this.#asCaller(
      async (caller) => await confirmFor(this.#env, caller, memory)
    );
  }

  async correct(correction: BrainCorrection): Promise<BrainCorrected> {
    return await this.#asCaller(async (caller) => {
      const saved = await correctFor(this.#env, caller, correction);
      return saved === null
        ? null
        : { memory: saved.memory, entity: saved.entity };
    });
  }
}
