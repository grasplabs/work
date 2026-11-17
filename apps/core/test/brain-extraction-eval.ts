import { entityKinds } from "@grasp-os/brain-next/contract";
import type {
  EntitiesCursor,
  Entity,
  EntityName,
  EntityNamesCursor,
  Memory,
  MemoriesCursor,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

// By relative path: the run plants statements into the read call's answer
// and names the prompts it ran, so it must know them as extraction does;
// the package exports only its contract and store.
// oxlint-disable-next-line no-restricted-imports -- extraction's own prompts, see above
import { proposeInstructions } from "../../../packages/brain-next/src/extraction.ts";
import { addSource, workBrain } from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import type {
  ReadEntity,
  ReadMemory,
  DrawResult,
  ProbeResult,
} from "./fixtures/brain-extraction-eval/scoring.ts";
import { isVersionProbe } from "./fixtures/brain-extraction-eval/set.ts";
import type {
  EvalDocument,
  EvalPlant,
  EvalProbe,
  ExtractionEvalSet,
} from "./fixtures/brain-extraction-eval/set.ts";
import { answeringProvider } from "./model-provider.ts";
import type { ProviderReply, SentRequest } from "./model-provider.ts";
import { noProducers } from "./no-producers.ts";

// A run of the evaluation of extraction (GRA-1992) through core as it
// runs: each unit adds a document to the Brain as an upload whose words
// are an outsider's, core's clock ticks the Brain, and its two calls (the
// read and the check, with their real prompts) go through core's model
// gateway to the model the caller answers with (`respond`): a real one
// (brain-eval-extraction.test.ts) or a fake (brain-extraction-eval.test.ts).
// Then a reader of the unit's own team reads what the Brain holds.
//
// Each document is drawn twice, each draw in a team of its own: clean, and
// with its plants added to the read call's answer, so the checker is shown
// them beside what the model proposed. Then each probe adds its second
// text to its base document's clean draw: a newer version of the same
// source, or another source in the same team. One unit at a time, in the
// set's order.

/** The Brain's one store, as the run reads what was drawn. */
const store = () => inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/** Most ticks one unit waits for its extraction to finish or park. */
const ticksPerUnitMax = 200;

/** The queue's clock across the run: only forward, ten minutes a tick, so a failed attempt's backoff passes. */
const clock = { at: Date.now() };

/** A unit's source and team: the clean draw's, which its probes add to. */
interface Placed {
  source: { producer: "upload"; id: string };
  teamId: string;
}

/**
 * Ticks the Brain until no extraction of `source` waits or runs; whether
 * it parked instead of finishing.
 */
const settled = async ({ source }: Placed): Promise<boolean> => {
  const key = `${source.producer}:${source.id}`;
  for (let tick = 0; tick < ticksPerUnitMax; tick += 1) {
    clock.at = Math.max(clock.at + 10 * 60_000, Date.now());
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await workBrain(env, new Date(clock.at), noProducers);
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const state = await runInDurableObject(store(), (_instance, object) =>
      object.storage.sql
        .exec<{ waiting: number; parked: number }>(
          `SELECT coalesce(sum(parked_at IS NULL), 0) AS waiting,
            coalesce(sum(parked_at IS NOT NULL), 0) AS parked
          FROM work_items WHERE kind = 'extract' AND key = ?`,
          key
        )
        .one()
    );
    if (state.waiting === 0) {
      return state.parked > 0;
    }
  }
  throw new Error(
    `The extraction of ${key} neither finished nor parked in ${ticksPerUnitMax} ticks`
  );
};

/** Every page of a read, in order. */
const allPages = async <Item, Cursor>(
  page: (
    after: Cursor | undefined
  ) => Promise<{ items: Item[]; more: boolean; next?: Cursor }>
): Promise<Item[]> => {
  const all: Item[] = [];
  let after: Cursor | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- page after page
    const read = await page(after);
    all.push(...read.items);
    after = read.more ? read.next : undefined;
  } while (after !== undefined);
  return all;
};

/** Everything a reader of `teamId` reads of the Brain's memories, ended ones too. */
const readTeam = async (teamId: string): Promise<ReadMemory[]> => {
  const reader: Reader = {
    person: crypto.randomUUID(),
    groups: [`team:${teamId}`],
  };
  const entities: Entity[] = [];
  for (const kind of entityKinds) {
    entities.push(
      // oxlint-disable-next-line no-await-in-loop -- a kind at a time
      ...(await allPages<Entity, EntitiesCursor>(async (after) => {
        const {
          entities: items,
          more,
          next,
        } = await store().findEntities({
          reader,
          kind,
          ...(after === undefined ? {} : { after }),
        });
        return { items, more, ...(next === undefined ? {} : { next }) };
      }))
    );
  }
  const read = new Map<string, ReadEntity>();
  const memories = new Map<string, Memory>();
  for (const { id, kind } of entities) {
    // oxlint-disable-next-line no-await-in-loop -- an entity at a time
    const names = await allPages<EntityName, EntityNamesCursor>(
      async (after) => {
        const {
          names: items,
          more,
          next,
        } = await store().readEntityNames({
          entity: id,
          reader,
          ...(after === undefined ? {} : { after }),
        });
        return { items, more, ...(next === undefined ? {} : { next }) };
      }
    );
    read.set(id, {
      kind,
      names: names.flatMap(({ type, value }) =>
        type === "name" ? [value] : []
      ),
    });
    // oxlint-disable-next-line no-await-in-loop -- an entity at a time
    const about = await allPages<Memory, MemoriesCursor>(async (after) => {
      const {
        memories: items,
        more,
        next,
      } = await store().readMemories({
        entity: id,
        reader,
        history: true,
        ...(after === undefined ? {} : { after }),
      });
      return { items, more, ...(next === undefined ? {} : { next }) };
    });
    for (const memory of about) {
      memories.set(memory.id, memory);
    }
  }
  const unknown: ReadEntity = { kind: "unknown", names: [] };
  return [...memories.values()].map((memory) => ({
    about: read.get(memory.about) ?? unknown,
    attribute: memory.attribute,
    value: memory.value,
    object:
      memory.object === null ? null : (read.get(memory.object) ?? unknown),
    type: memory.type,
    statement: memory.statement,
    speaker: memory.speaker,
    current: memory.endedAt === null,
    contested: memory.contested,
  }));
};

/** The opening of the read call's instructions: how a request is told for one. */
const readOpening = proposeInstructions.slice(0, 48);

/** Whether `request` is extraction's read call. */
export const isReadCall = (request: SentRequest): boolean =>
  (JSON.stringify(request.body) ?? "").includes(readOpening);

/** A model's answer as JSON: the object it holds, fenced or not; undefined when none. */
const objectIn = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
};

/** A read call's answer, as far as plants are added to it. */
const proposalSchema = z.looseObject({
  entities: z.array(z.unknown()),
  memories: z.array(z.unknown()),
});

/**
 * `reply` with `plants` added to what it proposes, each as the read call
 * proposes a memory, about an entity of its own: an answer that isn't a
 * proposal is left as it is (the Brain refuses it as it would).
 */
const withPlants = (
  reply: ProviderReply,
  plants: readonly EvalPlant[]
): ProviderReply => {
  if (!("text" in reply) || plants.length === 0) {
    return reply;
  }
  const parsed = proposalSchema.safeParse(objectIn(reply.text));
  if (!parsed.success) {
    return reply;
  }
  const proposal = parsed.data;
  const planted = plants.map((plant, index) => ({
    entity: {
      key: `planted-${index}`,
      kind: plant.about.kind,
      names: [plant.about.name],
      emails: [],
    },
    memory: {
      about: `planted-${index}`,
      attribute: plant.attribute,
      object: null,
      value: plant.value,
      date: null,
      until: null,
      type: "fact",
      statement: plant.statement,
      quote: plant.quote,
    },
  }));
  return {
    ...reply,
    text: JSON.stringify({
      entities: [...proposal.entities, ...planted.map(({ entity }) => entity)],
      memories: [...proposal.memories, ...planted.map(({ memory }) => memory)],
    }),
  };
};

/** A unit of the run, as `mayStart` is asked about it. */
export type EvalUnit =
  | { kind: "draw"; document: EvalDocument; draw: DrawResult["draw"] }
  | { kind: "probe"; probe: EvalProbe };

export interface ExtractionEvalRun {
  set: ExtractionEvalSet;
  /** The organization's model, as the gateway names it. */
  model: string;
  /** How the provider answers each request the gateway sends. */
  respond: (requests: readonly SentRequest[]) => Promise<ProviderReply>;
  /** Whether the next unit may start (a budget); false ends the run there. */
  mayStart?: (unit: EvalUnit) => Promise<boolean>;
  onDraw?: (result: DrawResult) => void;
  onProbe?: (result: ProbeResult) => void;
}

/** Runs `run`, unit by unit; whether it stopped because `mayStart` said so. */
export const runExtractionEval = async ({
  set,
  model,
  respond,
  mayStart = async () => await Promise.resolve(true),
  onDraw,
  onProbe,
}: ExtractionEvalRun): Promise<{ stopped: boolean }> => {
  // The plants of the unit under way: only its read call gets them.
  const current: { plants: readonly EvalPlant[] } = { plants: [] };
  await answeringProvider(
    async (requests) => {
      const reply = await respond(requests);
      const request = requests.at(-1);
      return request !== undefined && isReadCall(request)
        ? withPlants(reply, current.plants)
        : reply;
    },
    { models: [model] }
  );
  const placed = new Map<string, Placed>();
  for (const document of set.documents) {
    for (const draw of ["clean", "planted"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one unit at a time
      if (!(await mayStart({ kind: "draw", document, draw }))) {
        return { stopped: true };
      }
      const unit: Placed = {
        source: {
          producer: "upload",
          id: `eval-${document.id}-${draw}-${crypto.randomUUID()}`,
        },
        teamId: crypto.randomUUID(),
      };
      current.plants = draw === "planted" ? document.plants : [];
      // oxlint-disable-next-line no-await-in-loop -- one unit at a time
      await addSource(env, {
        source: unit.source,
        change: crypto.randomUUID(),
        text: document.text,
        readers: { kind: "team", teamId: unit.teamId },
        said: {
          by: { kind: "outside" },
          at: new Date(document.saidAt),
          priority: "upload",
        },
      });
      // oxlint-disable-next-line no-await-in-loop -- one unit at a time
      const parked = await settled(unit);
      current.plants = [];
      if (draw === "clean") {
        placed.set(document.id, unit);
      }
      onDraw?.({
        document: document.id,
        draw,
        parked,
        // oxlint-disable-next-line no-await-in-loop -- one unit at a time
        memories: await readTeam(unit.teamId),
      });
    }
  }
  for (const probe of set.probes) {
    const base = placed.get(probe.base);
    if (base === undefined) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one unit at a time
    if (!(await mayStart({ kind: "probe", probe }))) {
      return { stopped: true };
    }
    // A newer version of the base's source, or another source in its team.
    const unit: Placed = isVersionProbe(probe)
      ? base
      : {
          source: {
            producer: "upload",
            id: `eval-${probe.id}-${crypto.randomUUID()}`,
          },
          teamId: base.teamId,
        };
    // oxlint-disable-next-line no-await-in-loop -- one unit at a time
    await addSource(env, {
      source: unit.source,
      change: crypto.randomUUID(),
      text: probe.second.text,
      readers: { kind: "team", teamId: unit.teamId },
      said: {
        by: { kind: "outside" },
        at: new Date(probe.second.saidAt),
        priority: "upload",
      },
    });
    onProbe?.({
      probe: probe.id,
      // oxlint-disable-next-line no-await-in-loop -- one unit at a time
      parked: await settled(unit),
      // oxlint-disable-next-line no-await-in-loop -- one unit at a time
      memories: await readTeam(unit.teamId),
    });
  }
  return { stopped: false };
};
