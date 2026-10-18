import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { builtins, fingerprintOf, release } from "../src/builtins.ts";
import { mockIdp } from "./idp.ts";
import { calledAs } from "./sealed-apps.ts";
import { signedInApi, unique } from "./sign-in.ts";

// The workflow map, the built-in App (apps/core/blueprints/workflow-map/):
// its teams and workflows in the App's own store, drawn, designed beside
// the version last drawn, and linked to an App workflow, every version
// kept. What can go wrong, tried below: someone who isn't one of the
// App's builders changing the map, or someone the App isn't shared with
// reading it; a save setting what only the map sets (the version last
// drawn, the link) or dropping it; a linked workflow drawn again; edits
// written over someone else's, or a version lost; a team that isn't one;
// and a list or a read past what a query may answer.

const idp = mockIdp();

const workflowMap = "workflow-map";

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** What `person` gets calling the map's `path` (a `kind`) with `input`. */
const call = async (
  person: Person,
  app: AppId,
  path: string,
  kind: "query" | "mutation" | "action",
  input: unknown = {}
): Promise<OperationResult> =>
  await calledAs(
    await person.api.whoami(),
    app,
    { contractId: path, kind },
    input
  );

/** What a call answered; a refusal fails the test, saying why. */
const valueOf = (result: OperationResult): unknown => {
  if (!result.ok) {
    throw new Error(`Refused: ${result.error.code} ${result.error.message}`);
  }
  return result.value;
};

/** Why a call was refused, or `ok`. */
const codeOf = (result: OperationResult): string =>
  result.ok ? "ok" : result.error.code;

const observed = (value: number) => ({ value, basis: "observed" });
const estimated = (value: number) => ({ value, basis: "estimated" });

const numbers = (frequency: number, minutes: number, people: number) => ({
  frequency: { value: frequency, basis: "estimated" },
  minutes: { value: minutes, basis: "estimated" },
  people: { value: people, basis: "estimated" },
});

/** A drawn workflow, as the map's screen saves it. */
const drawn = {
  title: "Pay supplier invoices",
  state: "drawn",
  team: null,
  steps: [
    {
      name: "Match the invoice",
      who: "Controller",
      handover: true,
      numbers: numbers(30, 10, 2),
    },
  ],
  parameters: [{ name: "Approval limit", value: "5000" }],
  gain: null,
  notes: "Pay what we owe.",
};

const designedSteps = [
  {
    name: "Match the invoice",
    handover: false,
    kind: "automated",
    numbers: numbers(30, 1, 1),
  },
];

const savedSchema = z.object({ id: z.string(), version: z.number() });

const workflowSchema = z
  .object({
    _rev: z.number(),
    version: z.number(),
    title: z.string(),
    state: z.string(),
    team: z.string().nullable(),
    steps: z.array(z.unknown()),
    gain: z.object({ hoursPerWeek: z.number() }).nullable(),
    drawnVersion: z.number().nullable(),
    app: z.object({ appId: z.string(), workflowId: z.string() }).nullable(),
    notes: z.string(),
  })
  .loose();

const openedSchema = z
  .object({ current: workflowSchema, drawn: workflowSchema.nullable() })
  .nullable();

const pageSchema = z.object({
  items: z.array(z.looseObject({ id: z.string(), version: z.number() })),
});

/** An admin's App created from the workflow map. */
const mapOf = async (admin: Person): Promise<AppId> => {
  await builtins(env).ensureInstalled(await fingerprintOf(release));
  const made = await admin.api.apps.blueprints.create(workflowMap, {
    name: `Our map ${unique()}`,
  });
  await admin.api.apps.versions.setCurrent(made.app.id, 1);
  return appIdSchema.parse(made.app.id);
};

/** A workflow and the version of it last drawn, as `person` opens it. */
const opened = async (person: Person, app: AppId, id: string) =>
  openedSchema.parse(
    valueOf(await call(person, app, "map.open", "query", { id }))
  );

/** Saves `fields` as a new workflow (`id` null) or from `expectedRevision`. */
const save = async (
  person: Person,
  app: AppId,
  id: string | null,
  expectedRevision: number | null,
  fields: Record<string, unknown>
): Promise<OperationResult> =>
  await call(person, app, "map.save", "mutation", {
    id,
    expectedRevision,
    ...fields,
  });

/** Someone signed in with `role`, sharing `app` with its admin as `as`. */
const memberOf = async (
  admin: Person,
  app: AppId,
  role: "user" | "builder",
  as: "user" | "builder"
): Promise<Person> => {
  const person = await signedInApi(idp, role);
  await admin.api.apps.members.add(app, {
    type: "person",
    id: person.userId,
    role: as,
  });
  return person;
};

/** A step at its longest: each text field 200 characters. */
const longStep = (index: number) => ({
  name: `${index}`.padEnd(200, "n"),
  who: "w".repeat(200),
  tool: "t".repeat(200),
  handover: false,
});

describe("the workflow map", { timeout: 60_000 }, () => {
  it("keeps a workflow drawn, then designed beside the version last drawn, every version kept", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await mapOf(admin);
    const team = z.string().parse(
      valueOf(
        await call(admin, app, "teams.add", "mutation", {
          title: " Finance ",
        })
      )
    );
    const first = savedSchema.parse(
      valueOf(await save(admin, app, null, null, { ...drawn, team }))
    );
    const v1 = await opened(admin, app, first.id);
    // Drawn again: version 2, the one designing starts from.
    valueOf(
      await save(admin, app, first.id, v1?.current._rev ?? 0, {
        ...drawn,
        team,
        title: "Pay invoices",
      })
    );
    const v2 = await opened(admin, app, first.id);
    valueOf(
      await save(admin, app, first.id, v2?.current._rev ?? 0, {
        ...drawn,
        team,
        title: "Pay invoices",
        state: "designed",
        steps: designedSteps,
        gain: { hoursPerWeek: 9.5 },
      })
    );
    const v3 = await opened(admin, app, first.id);
    // Designed again, without its team: still beside version 2.
    valueOf(
      await save(admin, app, first.id, v3?.current._rev ?? 0, {
        ...drawn,
        title: "Pay invoices",
        state: "designed",
        steps: designedSteps,
        gain: { hoursPerWeek: 9.5 },
      })
    );
    const v4 = await opened(admin, app, first.id);
    const teams = z
      .array(z.looseObject({ _id: z.string(), title: z.string() }))
      .parse(valueOf(await call(admin, app, "teams.list", "query")));
    const listed = pageSchema.parse(
      valueOf(await call(admin, app, "map.list", "query", { pagination: {} }))
    );
    const firstVersion = workflowSchema.nullable().parse(
      valueOf(
        await call(admin, app, "map.version", "query", {
          id: first.id,
          version: 1,
        })
      )
    );

    expect({
      teams: teams.map(({ _id, title }) => ({ id: _id, title })),
      versions: [v1, v2, v3, v4].map((found) => ({
        version: found?.current.version,
        state: found?.current.state,
        team: found?.current.team,
        drawnVersion: found?.current.drawnVersion,
        beside: found?.drawn?.version ?? null,
        besideState: found?.drawn?.state ?? null,
      })),
      gain: v4?.current.gain,
      notes: v4?.current.notes,
      // Listed without its notes.
      listed: listed.items.map((item) => ({
        id: item.id,
        version: item.version,
        notes: "notes" in item,
      })),
      firstVersion: firstVersion && {
        version: firstVersion.version,
        title: firstVersion.title,
        state: firstVersion.state,
      },
    }).toStrictEqual({
      // Trimmed, as the schema keeps text.
      teams: [{ id: team, title: "Finance" }],
      versions: [
        {
          version: 1,
          state: "drawn",
          team,
          drawnVersion: null,
          beside: null,
          besideState: null,
        },
        {
          version: 2,
          state: "drawn",
          team,
          drawnVersion: null,
          beside: null,
          besideState: null,
        },
        {
          version: 3,
          state: "designed",
          team,
          drawnVersion: 2,
          beside: 2,
          besideState: "drawn",
        },
        {
          version: 4,
          state: "designed",
          team: null,
          drawnVersion: 2,
          beside: 2,
          besideState: "drawn",
        },
      ],
      gain: { hoursPerWeek: 9.5 },
      notes: "Pay what we owe.",
      listed: [{ id: first.id, version: 4, notes: false }],
      firstVersion: {
        version: 1,
        title: "Pay supplier invoices",
        state: "drawn",
      },
    });
  });

  it("sets the version last drawn and the link itself: a save can't set or drop either, and a linked workflow stays designed", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await mapOf(admin);
    const first = savedSchema.parse(
      valueOf(await save(admin, app, null, null, drawn))
    );
    const v1 = await opened(admin, app, first.id);
    const link = { appId: "app-1", workflowId: "pay" };
    const drawnLink = codeOf(
      await call(admin, app, "map.link", "mutation", {
        id: first.id,
        expectedRevision: v1?.current._rev,
        app: link,
      })
    );
    const designed = { ...drawn, state: "designed", steps: designedSteps };
    valueOf(await save(admin, app, first.id, v1?.current._rev ?? 0, designed));
    const v2 = await opened(admin, app, first.id);
    valueOf(
      await call(admin, app, "map.link", "mutation", {
        id: first.id,
        expectedRevision: v2?.current._rev,
        app: link,
      })
    );
    const v3 = await opened(admin, app, first.id);
    const revision = v3?.current._rev ?? 0;
    const sneaked = {
      byHandLink: codeOf(
        await save(admin, app, first.id, revision, {
          ...designed,
          app: { appId: "app-2", workflowId: "other" },
        })
      ),
      byHandDrawn: codeOf(
        await save(admin, app, first.id, revision, {
          ...designed,
          drawnVersion: 3,
        })
      ),
      drawnAgain: codeOf(await save(admin, app, first.id, revision, drawn)),
    };
    // Saved again as designed: the link and the version last drawn kept.
    valueOf(await save(admin, app, first.id, revision, designed));
    const v4 = await opened(admin, app, first.id);
    expect({
      drawnLink,
      sneaked,
      linked: [v3, v4].map((found) => ({
        version: found?.current.version,
        app: found?.current.app,
        drawnVersion: found?.current.drawnVersion,
      })),
    }).toStrictEqual({
      drawnLink: "map.not_designed",
      sneaked: {
        byHandLink: "contract.invalid_args",
        byHandDrawn: "contract.invalid_args",
        drawnAgain: "map.linked_drawn",
      },
      linked: [
        { version: 3, app: link, drawnVersion: 1 },
        { version: 4, app: link, drawnVersion: 1 },
      ],
    });
  });

  it("never writes over someone else's edits, nor loses a version", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await mapOf(admin);
    const designed = { ...drawn, state: "designed", steps: designedSteps };
    const first = savedSchema.parse(
      valueOf(await save(admin, app, null, null, drawn))
    );
    const v1 = await opened(admin, app, first.id);
    valueOf(await save(admin, app, first.id, v1?.current._rev ?? 0, designed));
    const v2 = await opened(admin, app, first.id);
    const read = v2?.current._rev ?? 0;
    // Someone else saves first.
    valueOf(
      await save(admin, app, first.id, read, { ...designed, title: "Theirs" })
    );
    const stale = {
      saved: codeOf(
        await save(admin, app, first.id, read, { ...designed, title: "Mine" })
      ),
      linked: codeOf(
        await call(admin, app, "map.link", "mutation", {
          id: first.id,
          expectedRevision: read,
          app: { appId: "app-1", workflowId: "pay" },
        })
      ),
    };
    const now = await opened(admin, app, first.id);
    const fourth = valueOf(
      await call(admin, app, "map.version", "query", {
        id: first.id,
        version: 4,
      })
    );
    expect({
      stale,
      now: {
        version: now?.current.version,
        title: now?.current.title,
        app: now?.current.app,
      },
      fourth,
    }).toStrictEqual({
      stale: { saved: "data.conflict", linked: "data.conflict" },
      now: { version: 3, title: "Theirs", app: null },
      // Neither refused write left a version behind.
      fourth: null,
    });
  });

  it("is read by everyone it is shared with, and changed by its builders alone", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await mapOf(admin);
    const first = savedSchema.parse(
      valueOf(await save(admin, app, null, null, drawn))
    );
    const drawnFirst = await opened(admin, app, first.id);
    valueOf(
      await save(admin, app, first.id, drawnFirst?.current._rev ?? 0, {
        ...drawn,
        state: "designed",
      })
    );
    const v1 = await opened(admin, app, first.id);
    const member = await memberOf(admin, app, "user", "user");
    const builder = await memberOf(admin, app, "builder", "builder");
    const outsider = await signedInApi(idp, "user");
    const by = async (
      person: Person,
      path: string,
      kind: "query" | "mutation" | "action",
      input: unknown = {}
    ) => codeOf(await call(person, app, path, kind, input));
    const writable = async (person: Person) =>
      valueOf(await call(person, app, "access.writable", "action"));

    expect({
      member: {
        list: await by(member, "map.list", "query", { pagination: {} }),
        open: await by(member, "map.open", "query", { id: first.id }),
        teams: await by(member, "teams.list", "query"),
        writable: await writable(member),
        save: codeOf(await save(member, app, null, null, drawn)),
        edit: codeOf(
          await save(member, app, first.id, v1?.current._rev ?? 0, drawn)
        ),
        team: await by(member, "teams.add", "mutation", { title: "Ops" }),
        link: await by(member, "map.link", "mutation", {
          id: first.id,
          expectedRevision: v1?.current._rev,
          app: { appId: "app-1", workflowId: "pay" },
        }),
      },
      builder: {
        writable: await writable(builder),
        save: codeOf(await save(builder, app, null, null, drawn)),
      },
      admin: await writable(admin),
      outsider: await by(outsider, "map.list", "query", { pagination: {} }),
      // Theirs, untouched.
      version: await opened(admin, app, first.id).then(
        (found) => found?.current.version
      ),
    }).toStrictEqual({
      member: {
        list: "ok",
        open: "ok",
        teams: "ok",
        writable: false,
        save: "data.write_denied",
        edit: "data.write_denied",
        team: "data.write_denied",
        link: "data.write_denied",
      },
      builder: { writable: true, save: "ok" },
      admin: true,
      outsider: "app.not_found",
      version: 2,
    });
  });

  it("holds no more teams than it lists", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await mapOf(admin);
    const add = async (title: string) =>
      codeOf(await call(admin, app, "teams.add", "mutation", { title }));
    for (let count = 0; count < 100; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one team at a time
      await add(`Team ${String(count).padStart(3, "0")}`);
    }
    const listed = z
      .array(z.unknown())
      .parse(valueOf(await call(admin, app, "teams.list", "query")));
    // Its title sorts first: listed, it would push out the last one.
    expect({ listed: listed.length, more: await add("AAA") }).toStrictEqual({
      listed: 100,
      more: "map.too_many_teams",
    });
  });

  it("takes no team that isn't one of its own, and designs nothing never drawn", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await mapOf(admin);
    const first = savedSchema.parse(
      valueOf(await save(admin, app, null, null, drawn))
    );
    expect({
      // A workflow's ID where a team's goes.
      notATeam: codeOf(
        await save(admin, app, null, null, { ...drawn, team: first.id })
      ),
      madeUp: codeOf(
        await save(admin, app, null, null, { ...drawn, team: "team-1" })
      ),
      designedFirst: codeOf(
        await save(admin, app, null, null, { ...drawn, state: "designed" })
      ),
    }).toStrictEqual({
      notATeam: "data.reference_invalid",
      madeUp: "contract.invalid_args",
      designedFirst: "map.not_drawn",
    });
  });

  it("works out each workflow's hours for another App: times × minutes × people over 60, one person where none is said, observed only when every number is", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await mapOf(admin);
    const saved = async (title: string, steps: unknown[]) =>
      savedSchema.parse(
        valueOf(await save(admin, app, null, null, { ...drawn, title, steps }))
      ).id;
    const mixed = await saved("Mixed", [
      {
        name: "One",
        handover: false,
        numbers: {
          frequency: estimated(30),
          minutes: observed(10),
          people: estimated(2),
        },
      },
      {
        name: "Two",
        handover: false,
        numbers: { frequency: observed(1), minutes: observed(30) },
      },
    ]);
    const seen = await saved("Seen", [
      {
        name: "One",
        handover: false,
        numbers: { frequency: observed(1), minutes: observed(30) },
      },
    ]);
    const none = await saved("None", [{ name: "One", handover: false }]);
    const absurd = await saved("Absurd", [
      {
        name: "One",
        handover: false,
        numbers: {
          frequency: estimated(10_000),
          minutes: estimated(10_000),
          people: estimated(10_000),
        },
      },
    ]);
    const page = z
      .object({
        items: z.array(
          z.looseObject({
            id: z.string(),
            current: z
              .object({
                hoursPerWeek: z.number(),
                basis: z.string(),
                minutesPerPass: z.number(),
              })
              .loose(),
          })
        ),
      })
      .parse(
        valueOf(
          await call(admin, app, "figures.list", "query", { pagination: {} })
        )
      );
    const of = (id: string) => {
      const found = page.items.find((item) => item.id === id)?.current;
      return (
        found && {
          hoursPerWeek: found.hoursPerWeek,
          basis: found.basis,
          minutesPerPass: found.minutesPerPass,
        }
      );
    };
    expect({
      mixed: of(mixed),
      seen: of(seen),
      none: of(none),
      absurd: of(absurd)?.hoursPerWeek,
    }).toStrictEqual({
      // 30 × 10 × 2 + 1 × 30 minutes: 10.5 hours; a pass, 20 + 30 minutes.
      mixed: { hoursPerWeek: 10.5, basis: "estimated", minutesPerPass: 50 },
      seen: { hoursPerWeek: 0.5, basis: "observed", minutesPerPass: 30 },
      none: { hoursPerWeek: 0, basis: "estimated", minutesPerPass: 0 },
      // Held to what the figures hold.
      absurd: 100_000,
    });
  });

  it("keeps a page of the list within what a query answers, however much its workflows hold", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await mapOf(admin);
    // Each field within its limit, all at their longest too much to list.
    const tooLarge = codeOf(
      await save(admin, app, null, null, {
        ...drawn,
        steps: Array.from({ length: 100 }, (_, index) => longStep(index)),
      })
    );
    // As much as one workflow may hold, eleven times over.
    const large = {
      ...drawn,
      steps: Array.from({ length: 30 }, (_, index) => longStep(index)),
      notes: "n".repeat(30_000),
    };
    const saveLarge = async (): Promise<void> => {
      valueOf(await save(admin, app, null, null, large));
    };
    for (let count = 0; count < 11; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one save at a time
      await saveLarge();
    }
    const page = pageSchema.parse(
      valueOf(
        await call(admin, app, "map.list", "query", {
          pagination: { pageSize: 50 },
        })
      )
    );
    expect({ tooLarge, page: page.items.length }).toStrictEqual({
      tooLarge: "map.too_large",
      page: 10,
    });
  });
});
