import { accessAfter } from "@grasp-os/shared/access-choices";
import type { Access, Answer } from "@grasp-os/shared/access-choices";
import type {
  DataModelRule,
  DataModelTable,
} from "@grasp-os/shared/data-model";
import type { Json } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// The Data view's answers to who can see and change a table's records
// (@grasp-os/shared/access-choices), held to what the App's store
// enforces: a member's change is accepted or refused exactly as the
// answer says, from the review's two ways past it: who sees only their
// own and everyone changes (the store doesn't read the read mode for a
// write, and a record's first revision is 1, so any member could change
// any record by its ID); and widening who sees, which dropped the read
// rules writes took with it.

const idp = mockIdp();

/** The deals table as the Data view reads it: a title and an assignee. */
const deals = (
  read: DataModelTable["access"]["read"],
  write: DataModelTable["access"]["write"],
  rows: { read?: DataModelRule[]; write?: DataModelRule[] } = {}
): DataModelTable => ({
  id: "deals",
  name: "deals",
  fields: [
    {
      id: "f1",
      name: "title",
      type: { kind: "text", trim: false, min: null, max: null },
      required: true,
      code: "v.string()",
      nullable: false,
      defaultCode: null,
    },
    {
      id: "f2",
      name: "assignee",
      type: { kind: "person" },
      required: false,
      code: "v.person()",
      nullable: false,
      defaultCode: null,
    },
  ],
  indexes: [],
  searchIndex: null,
  sensitive: false,
  access: {
    read,
    write,
    rows: { read: rows.read ?? [], write: rows.write ?? [] },
  },
});

/** The App's files, its deals table's access `access`. */
const filesWith = (access: Access): TestApp =>
  testApp(
    {
      name: "Deals",
      tables: {
        deals: {
          fields: { title: "v.string()", assignee: "v.person().optional()" },
          access,
        },
      },
    },
    {
      "server/deals.ts": `import { mutation } from "@server/_generated/server";
import { v } from "@grasp-os/runtime";

export const add = mutation({
  args: { title: v.string(), assignee: v.person().optional() },
  returns: v.id("deals"),
  handler: async (ctx, args) => await ctx.db.insert("deals", args),
});

// By ID and its first revision alone: what a person who can't read the
// record would try.
export const rename = mutation({
  args: { id: v.id("deals"), title: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("deals", args.id, { title: args.title });
    return null;
  },
});
`,
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Deals() {
  return <p>Deals</p>;
}

export const Route = createFileRoute("/")({ component: Deals });
`,
    }
  );

type Person = Awaited<ReturnType<typeof signedInApi>> & { role: Role };

/** A builder's Deals App, released with `access`, and two of its members. */
const dealsApp = async (access: Access) => {
  const builder = await signedInApi(idp, "builder");
  const { id: app } = await builder.api.apps.create({ name: "Deals" });
  await release(builder, app, filesWith(access));
  const members = await Promise.all(
    [0, 1].map(async (): Promise<Person> => {
      const member = {
        ...(await signedInApi(idp, "user")),
        role: "user" as const,
      };
      await builder.api.apps.members.add(app, {
        type: "person",
        id: member.userId,
        role: "user",
      });
      return member;
    })
  );
  return { builder, app, members };
};

/** What `path` answered `by`, or the code it was refused with. */
const call = async (
  app: string,
  by: Person,
  path: string,
  input: Json
): Promise<{ ok: true; value: unknown } | { ok: false; code: string }> => {
  const answer = await callAppFunction(
    env,
    { userId: by.userId, role: by.role, teams: [] },
    app,
    JSON.stringify({
      reference: { name: path, kind: "mutation" },
      args: input,
    }),
    Date.now() + 30_000
  );
  return answer.result.ok
    ? { ok: true, value: answer.result.value }
    : { ok: false, code: answer.result.error.code };
};

/** The ID `add` answered. */
const idOf = (answer: Awaited<ReturnType<typeof call>>): string => {
  if (!answer.ok || typeof answer.value !== "string") {
    throw new TypeError("Expected the deal's ID");
  }
  return answer.value;
};

describe("who can see and change records, as the store holds them", () => {
  it("lets only the person who added a deal change it when only they see it, even with everyone asked for", async () => {
    const answers: { read: Answer; write: Answer } = {
      read: { kind: "added" },
      write: { kind: "everyone" },
    };
    const { app, members } = await dealsApp(
      accessAfter(deals("appMembers", "appMembers"), answers)
    );
    const [adder, other] = members;
    if (adder === undefined || other === undefined) {
      throw new TypeError("Expected two members");
    }
    const id = idOf(await call(app, adder, "deals.add", { title: "Deal" }));

    const byOther = await call(app, other, "deals.rename", {
      id,
      title: "Taken",
    });
    const byAdder = await call(app, adder, "deals.rename", {
      id,
      title: "Mine",
    });
    expect({ byOther: byOther.ok, byAdder: byAdder.ok }).toStrictEqual({
      byOther: false,
      byAdder: true,
    });
  });

  it("is what the store needs: with only the write mode, any member changes a deal they can't see", async () => {
    // What the page saved before: who sees, the adder; who changes, everyone.
    const { app, members } = await dealsApp({
      read: "owner",
      write: "appMembers",
    });
    const [adder, other] = members;
    if (adder === undefined || other === undefined) {
      throw new TypeError("Expected two members");
    }
    const id = idOf(await call(app, adder, "deals.add", { title: "Deal" }));
    const byOther = await call(app, other, "deals.rename", {
      id,
      title: "Taken",
    });
    expect(byOther.ok).toBeTruthy();
  });

  it("keeps who changes a deal as it was when who sees it widens", async () => {
    // Writes take the read rules: only the assignee changes a deal.
    const assigned = deals("appMembers", "appMembers", {
      read: [{ kind: "person", field: "assignee" }],
    });
    const { builder, app, members } = await dealsApp(accessAfter(assigned, {}));
    const [assignee, other] = members;
    if (assignee === undefined || other === undefined) {
      throw new TypeError("Expected two members");
    }
    const id = idOf(
      await call(app, assignee, "deals.add", {
        title: "Deal",
        assignee: assignee.userId,
      })
    );
    // Everyone sees deals now; who changes them stays the assignee.
    await release(
      builder,
      app,
      filesWith(accessAfter(assigned, { read: { kind: "everyone" } }))
    );

    const byOther = await call(app, other, "deals.rename", {
      id,
      title: "Taken",
    });
    const byAssignee = await call(app, assignee, "deals.rename", {
      id,
      title: "Mine",
    });
    expect({ byOther: byOther.ok, byAssignee: byAssignee.ok }).toStrictEqual({
      byOther: false,
      byAssignee: true,
    });
  });

  it("lets nobody change a deal, rather than more people, when the assignee-and-adder rule can't be kept as who sees widens", async () => {
    // A deal changed only by its assignee who also added it.
    const both = deals("appMembers", "appMembers", {
      read: [{ kind: "person", field: "assignee" }],
      write: [{ kind: "owner" }],
    });
    const { builder, app, members } = await dealsApp(accessAfter(both, {}));
    const [assignee, other] = members;
    if (assignee === undefined || other === undefined) {
      throw new TypeError("Expected two members");
    }
    const id = idOf(
      await call(app, assignee, "deals.add", {
        title: "Deal",
        assignee: assignee.userId,
      })
    );
    await release(
      builder,
      app,
      filesWith(accessAfter(both, { read: { kind: "everyone" } }))
    );

    const byOther = await call(app, other, "deals.rename", {
      id,
      title: "Taken",
    });
    const byAssignee = await call(app, assignee, "deals.rename", {
      id,
      title: "Mine",
    });
    expect({ byOther: byOther.ok, byAssignee: byAssignee.ok }).toStrictEqual({
      byOther: false,
      byAssignee: false,
    });
  });
});
