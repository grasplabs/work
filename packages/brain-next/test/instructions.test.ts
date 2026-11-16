// An instruction file's add over an expected current version (contract.ts
// `NewInstructions.after`), through the store's own methods. What it
// holds: a writer that saw one version never writes over another (a late
// add after a newer one, an add over a retirement it didn't see); a retry
// of a change that landed still answers its version and writes nothing;
// and with no expected version, an add writes whatever is current.
import { staleVersion } from "@grasp-os/brain-next/contract";
import type { Access, Reader } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { BrainStore } from "../src/store.ts";

/** A store, as its namespace gives it. */
type Store = DurableObjectStub<BrainStore>;

const shared = (): Store => env.BRAIN_STORE.getByName("brain");

const everyone = "company";
const readers: Access = { kind: "audience", group: everyone };
const reader: Reader = { person: "reader", groups: [everyone] };

/** A new instruction file's key. */
const newSource = (): string => `instructions:test:${crypto.randomUUID()}`;

/** Adds `text` as `change` of `source`, over `after` when given, or why it was refused. */
const add = async (
  source: string,
  change: string,
  text: string,
  after?: number | null,
  access: Access = readers
): Promise<number | string> => {
  try {
    const { version } = await shared().addInstructions({
      source,
      change,
      text,
      access,
      ...(after === undefined ? {} : { after }),
    });
    return version;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** The current version of `source` and its text, as `reader` reads it. */
const currentOf = async (source: string) => {
  const [current] = await shared().readCurrent({ sources: [source], reader });
  return current === undefined ? null : [current.version, current.text];
};

describe("an add over an expected current version", () => {
  it("writes in order, each over the version it saw", async () => {
    const source = newSource();
    expect({
      first: await add(source, "a", "First", null),
      second: await add(source, "b", "Second", 1),
      current: await currentOf(source),
    }).toStrictEqual({ first: 1, second: 2, current: [2, "Second"] });
  });

  it("refuses an add over a version that is no longer current, writing nothing", async () => {
    const source = newSource();
    await add(source, "a", "First", null);
    await add(source, "b", "Second", 1);
    expect({
      late: await add(source, "c", "Late", 1),
      // None expected, but one is there.
      overNone: await add(source, "d", "Fresh", null),
      current: await currentOf(source),
    }).toStrictEqual({
      late: staleVersion,
      overNone: staleVersion,
      current: [2, "Second"],
    });
  });

  it("answers a retried change with the version it made, after a newer one landed, writing nothing", async () => {
    const source = newSource();
    await add(source, "a", "First", null);
    await add(source, "b", "Second", 1);
    expect({
      retried: await add(source, "a", "First", null),
      current: await currentOf(source),
    }).toStrictEqual({ retried: 1, current: [2, "Second"] });
  });

  it("refuses retiring a version that moved on, so what landed meanwhile stays", async () => {
    const source = newSource();
    await add(source, "a", "First", null);
    await add(source, "b", "Second", 1);
    const retired: Access = { kind: "audience", group: "retired" };
    expect({
      retiringFirst: await add(source, "r", "First", 1, retired),
      current: await currentOf(source),
      retiringSecond: await add(source, "s", "Second", 2, retired),
      afterRetiring: await currentOf(source),
    }).toStrictEqual({
      retiringFirst: staleVersion,
      current: [2, "Second"],
      retiringSecond: 3,
      // Readable by no one in the company now.
      afterRetiring: null,
    });
  });

  it("makes a new version of the current text over an expected version, so a writer that read before it is refused", async () => {
    const source = newSource();
    await add(source, "a", "First", null);
    expect({
      // The current text again, over the version it read: a new version.
      same: await add(source, "b", "First", 1),
      // Another writer that read version 1 before that landed.
      late: await add(source, "c", "Late", 1),
      current: await currentOf(source),
      // Expecting nothing, the current text makes no new version.
      unchecked: await add(source, "d", "First"),
    }).toStrictEqual({
      same: 2,
      late: staleVersion,
      current: [2, "First"],
      unchecked: 2,
    });
  });

  it("writes over whatever is current when it expects nothing", async () => {
    const source = newSource();
    await add(source, "a", "First", null);
    expect({
      unchecked: await add(source, "b", "Second"),
      current: await currentOf(source),
    }).toStrictEqual({ unchecked: 2, current: [2, "Second"] });
  });

  it("answers which version a change made, a number alone, and nothing to a reader who may not read it", async () => {
    const source = newSource();
    await add(source, "a", "First", null);
    await add(source, "b", "Second", 1);
    const look = async (change: string, as: Reader = reader) =>
      await shared().changeVersion({ source, change, reader: as });
    expect({
      first: await look("a"),
      second: await look("b"),
      unmade: await look("c"),
      // Not among its readers: as if it made none.
      outsider: await look("a", { person: "outsider", groups: [] }),
    }).toStrictEqual({ first: 1, second: 2, unmade: null, outsider: null });
  });
});
