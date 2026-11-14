import type { FunctionResult } from "@grasp-os/shared/functions";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { builtins, fingerprintOf, thisRelease } from "../src/builtins.ts";
import { mockIdp } from "./idp.ts";
import { calledAs } from "./sealed-apps.ts";
import { signedInApi, unique } from "./sign-in.ts";

// The example Apps (apps/core/blueprints/): the kanban board, the CRM,
// the approval flow and the dashboard, which the builder agent reads to
// learn how an App is written. Each is created from its blueprint as a
// builder creates it, made current, and used through its functions as its
// pages call them. What would make one a bad example, tried below: a card
// that doesn't move or lands out of order; a contact search that misses;
// a deal's stage that doesn't count; a request decided by whoever asked
// it, or by someone who isn't an approver, or seen by someone else; and
// monthly totals that drift from the sales recorded.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const call = async (
  person: Person,
  app: AppId,
  name: string,
  kind: "query" | "mutation",
  input: unknown = {}
): Promise<FunctionResult> =>
  await calledAs(await person.api.whoami(), app, { name, kind }, input);

/** What a call answered; a refusal fails the test, saying why. */
const valueOf = (result: FunctionResult): unknown => {
  if (!result.ok) {
    throw new Error(`Refused: ${result.error.code} ${result.error.message}`);
  }
  return result.value;
};

const codeOf = (result: FunctionResult): string =>
  result.ok ? "ok" : result.error.code;

/** An App `admin` created from the example `blueprint`, made current. */
const exampleOf = async (admin: Person, blueprint: string): Promise<AppId> => {
  await builtins(env).ensureInstalled(await fingerprintOf(thisRelease));
  const made = await admin.api.apps.blueprints.create(blueprint, {
    name: `${blueprint} ${unique()}`,
  });
  await admin.api.versions.rollback({ kind: "app", id: made.app.id }, 1);
  return appIdSchema.parse(made.app.id);
};

/** Someone signed in as a user, with `role` in `app`. */
const memberOf = async (
  admin: Person,
  app: AppId,
  role: "user" | "builder"
): Promise<Person> => {
  const person = await signedInApi(idp, "user");
  await admin.api.apps.members.add(app, {
    type: "person",
    id: person.userId,
    role,
  });
  return person;
};

const record = z.looseObject({ _id: z.string() });
const page = <T extends z.ZodType>(item: T) =>
  z.looseObject({ items: z.array(item) });

const firstPage = { pageSize: 50, cursor: null };

describe("the example Apps", { timeout: 60_000 }, () => {
  it("move a card along the kanban board, to the bottom of each column", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await exampleOf(admin, "kanban-board");
    const add = async (title: string) =>
      z
        .string()
        .parse(
          valueOf(await call(admin, app, "cards.add", "mutation", { title }))
        );
    const column = async (name: string) =>
      z
        .array(record.extend({ title: z.string() }))
        .parse(
          valueOf(
            await call(admin, app, "cards.list", "query", { column: name })
          )
        );

    const first = await add("Write the brief");
    await add("Book the room");
    await add("Send invites");
    valueOf(
      await call(admin, app, "cards.move", "mutation", {
        id: first,
        column: "doing",
      })
    );
    const doing = await column("doing");
    valueOf(
      await call(admin, app, "cards.move", "mutation", {
        id: first,
        column: "done",
      })
    );

    expect({
      todo: await column("todo"),
      doing,
      done: await column("done"),
    }).toMatchObject({
      todo: [{ title: "Book the room" }, { title: "Send invites" }],
      doing: [{ title: "Write the brief" }],
      done: [{ title: "Write the brief" }],
    });
  });

  it("refuse a card into a full kanban column, added or moved there", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await exampleOf(admin, "kanban-board");
    const cardsPerColumn = 100;
    const add = async (title: string) =>
      await call(admin, app, "cards.add", "mutation", { title });
    const ids: string[] = [];
    for (let card = 1; card <= cardsPerColumn; card += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one card after another, in order
      ids.push(z.string().parse(valueOf(await add(`Card ${card}`))));
    }
    const refusedAdd = await add("One too many");
    const [first] = ids;
    valueOf(
      await call(admin, app, "cards.move", "mutation", {
        id: first,
        column: "doing",
      })
    );
    valueOf(await add("Takes its place"));
    const refusedMove = await call(admin, app, "cards.move", "mutation", {
      id: first,
      column: "todo",
    });

    expect({
      add: codeOf(refusedAdd),
      move: codeOf(refusedMove),
    }).toStrictEqual({ add: "cards.column_full", move: "cards.column_full" });
  });

  it("find a CRM contact by name or company, and count its deals by stage", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await exampleOf(admin, "crm");
    const contact = z.string().parse(
      valueOf(
        await call(admin, app, "contacts.add", "mutation", {
          name: "Ada Lovelace",
          company: "Analytical Engines",
          email: "ada@example.com",
        })
      )
    );
    valueOf(
      await call(admin, app, "contacts.add", "mutation", {
        name: "Charles Babbage",
        company: "Difference Engines",
      })
    );
    const deal = z.string().parse(
      valueOf(
        await call(admin, app, "deals.add", "mutation", {
          contact,
          title: "Annual licence",
          amount: 1250.5,
        })
      )
    );
    valueOf(
      await call(admin, app, "deals.add", "mutation", {
        contact,
        title: "Support",
        amount: 300,
      })
    );
    const deals = page(record.extend({ value: z.unknown() })).parse(
      valueOf(
        await call(admin, app, "deals.forContact", "query", {
          contact,
          pagination: firstPage,
        })
      )
    );
    const licence = deals.items.find(({ _id }) => _id === deal);
    valueOf(
      await call(admin, app, "deals.setStage", "mutation", {
        id: deal,
        stage: "won",
      })
    );
    const names = async (search: string) =>
      page(z.looseObject({ name: z.string() }))
        .parse(
          valueOf(
            await call(admin, app, "contacts.list", "query", {
              search,
              pagination: firstPage,
            })
          )
        )
        .items.map(({ name }) => name);

    expect({
      all: await names(""),
      byCompany: await names("analyt"),
      value: licence?.value,
      pipeline: valueOf(await call(admin, app, "deals.pipeline", "query")),
    }).toStrictEqual({
      all: ["Ada Lovelace", "Charles Babbage"],
      byCompany: ["Ada Lovelace"],
      value: { currency: "EUR", minorUnits: 125_050 },
      pipeline: [
        { stage: "lead", deals: 1 },
        { stage: "won", deals: 1 },
      ],
    });
  });

  it("let only another approver decide a request, which only its asker and approvers see", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await exampleOf(admin, "approvals");
    const asker = await memberOf(admin, app, "user");
    const colleague = await memberOf(admin, app, "user");
    const pending = async (person: Person) =>
      page(record.extend({ title: z.string() })).parse(
        valueOf(
          await call(person, app, "requests.list", "query", {
            status: "pending",
            pagination: firstPage,
          })
        )
      ).items;

    const id = z.string().parse(
      valueOf(
        await call(asker, app, "requests.submit", "mutation", {
          title: "A second screen",
          details: "For the reviews.",
          amount: 240,
        })
      )
    );
    const seen = {
      asker: await pending(asker),
      colleague: await pending(colleague),
      approver: await pending(admin),
    };
    const decide = async (person: Person) =>
      await call(person, app, "requests.decide", "mutation", {
        id,
        outcome: "approved",
        note: "Go ahead.",
      });
    const refused = {
      byAsker: codeOf(await decide(asker)),
      byColleague: codeOf(await decide(colleague)),
    };
    valueOf(await decide(admin));

    expect({
      seen,
      refused,
      decided: valueOf(
        await call(asker, app, "requests.list", "query", {
          status: "approved",
          pagination: firstPage,
        })
      ),
    }).toMatchObject({
      seen: {
        asker: [{ _id: id }],
        colleague: [],
        approver: [{ _id: id }],
      },
      refused: {
        byAsker: "requests.not_approver",
        byColleague: "requests.not_approver",
      },
      decided: {
        items: [
          {
            _id: id,
            status: "approved",
            amount: { currency: "EUR", minorUnits: 24_000 },
            decision: { note: "Go ahead." },
          },
        ],
      },
    });
  });

  it("refuse an approver deciding their own request, and let its asker withdraw it", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await exampleOf(admin, "approvals");
    const id = z.string().parse(
      valueOf(
        await call(admin, app, "requests.submit", "mutation", {
          title: "Conference ticket",
          details: "",
          amount: 600,
        })
      )
    );
    const own = await call(admin, app, "requests.decide", "mutation", {
      id,
      outcome: "approved",
      note: "",
    });
    const withdrawn = await call(admin, app, "requests.withdraw", "mutation", {
      id,
    });
    expect({ own: codeOf(own), withdrawn: codeOf(withdrawn) }).toStrictEqual({
      own: "requests.own",
      withdrawn: "ok",
    });
  });

  it("keep the dashboard's monthly totals as sales are recorded and removed", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await exampleOf(admin, "dashboard");
    const sell = async (customer: string, amount: number, closedAt: string) =>
      z.string().parse(
        valueOf(
          await call(admin, app, "sales.record", "mutation", {
            customer,
            amount,
            closedAt: Date.parse(closedAt),
          })
        )
      );
    // A year and more back, before a gap of months with no sales, and
    // one closed in a month still to come: neither is in the year shown.
    await sell("Umbrella", 400, "2025-10-15T00:00:00Z");
    await sell("Acme", 1000, "2026-09-03T00:00:00Z");
    await sell("Globex", 250.25, "2026-10-01T00:00:00Z");
    await sell("Hooli", 75, "2026-12-01T00:00:00Z");
    const removed = await sell("Initech", 99, "2026-10-31T00:00:00Z");
    valueOf(
      await call(admin, app, "sales.remove", "mutation", {
        id: removed,
      })
    );
    const latest = page(z.looseObject({ customer: z.string() })).parse(
      valueOf(
        await call(admin, app, "sales.list", "query", { pagination: firstPage })
      )
    );

    expect({
      latest: latest.items.map(({ customer }) => customer),
      months: valueOf(
        await call(admin, app, "months.lastYear", "query", {
          through: "2026-10",
        })
      ),
    }).toMatchObject({
      latest: ["Hooli", "Globex", "Acme", "Umbrella"],
      months: [
        {
          month: "2026-09",
          sales: 1,
          revenue: { currency: "EUR", minorUnits: 100_000 },
        },
        {
          month: "2026-10",
          sales: 1,
          revenue: { currency: "EUR", minorUnits: 25_025 },
        },
      ],
    });
  });
});
