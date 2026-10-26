import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import type { FunctionAnswer } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { appFor, setCurrentVersion } from "../src/apps.ts";
import { createCollection } from "../src/knowledge/collection-rules.ts";
import { saveDocument } from "../src/knowledge/person-writes.ts";
import {
  grantPermission,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { knowledgeFingerprintOf } from "../src/resource-knowledge.ts";
import { isRestricted } from "../src/restricted.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// An App's skills (GRA-310): `skillsSelect` and `skillsRead` operations of
// a knowledge resource, served by the Brain's one selection and pinned
// read, under the same grants as the App's recall (brain-app-recall.test.ts;
// the threat model is on the issue). How it can fail, and what each test
// holds it to:
// 1. Apps start with no Brain: collection grants and an approved binding
//    alone select and read nothing.
// 2. A selection or read reaches past the binding: a skill in a collection
//    the App was granted for something else is weighed or read.
// 3. A skill is selected for a capability the App doesn't hold.
// 4. A team's skill, "accepted" by its own members, is weighed or read as a
//    vetted one (only team collections can be sensitive, so none of a
//    sensitive collection's skills is ever handed over).
// 5. A retained binding keeps selecting after the Brain's grant is gone.
// 6. Adding the skill operations to the contract breaks the approval of
//    every App that doesn't use them.

/** An App whose actions select a skill and read a pinned one. */
const skillsFiles = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string() }),
});
`,
  "operations/skills.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const how = resource.knowledge("how", {
  operations: ["skillsSelect", "skillsRead"],
  collections: ["company", "secret"],
});

/** The skill selected for a task, or why none, and its text at the pin. */
export const pick = action({
  args: { type: v.string().min(1) },
  returns: v.object({ picked: v.string(), text: v.string().nullable() }),
  uses: [how],
  handler: async (ctx, args) => {
    const selection = await ctx.resources.how.skillsSelect({ task: { type: args.type } });
    if (selection.result.kind === "none") {
      return { picked: selection.result.reason, text: null };
    }
    const read = await ctx.resources.how.skillsRead({
      documentId: selection.result.skill.documentId,
      version: selection.result.skill.version,
    });
    return { picked: selection.result.skill.name, text: read.text };
  },
});

/** A skill at a version, by its ID. */
export const open = action({
  args: { documentId: v.string().min(1), version: v.number() },
  returns: v.string(),
  uses: [how],
  handler: async (ctx, args) => {
    const read = await ctx.resources.how.skillsRead(args);
    return read.skill.name;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { how, open, pick } from "./operations/skills.ts";
import schema from "./schema.ts";

export default app({
  name: "How",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { skills: { pick, open } },
  internalOperations: {},
  screens: [],
  uses: [how],
});
`,
});

type Sealed = Fixture & { release: Release };

type Admin = Awaited<ReturnType<typeof person>>;

/** A permission of the App, asked for by its owner and granted. */
const granted = async (
  sealed: Sealed,
  admin: Admin,
  object: { type: "collection"; collectionId: string } | { type: "platform" },
  binding: string
): Promise<string> => {
  const requested = await requestPermission(
    env,
    sealed.owner,
    {
      subject: { type: "app", appId: sealed.app },
      object,
      actions: [object.type === "platform" ? "brain" : "read"],
      binding,
    },
    {
      app: async (app, role) => await appFor(env, sealed.owner, app, role),
      resource: async () =>
        await Promise.reject(
          new Error("No independent resource is named here")
        ),
    }
  );
  await grantPermission(env, admin, requested.id, {
    version: sealed.release.manifest.resourceVersion,
  });
  return requested.id;
};

/** A `SKILL.md` named `name`, with `manifest` in its frontmatter. */
const skillText = (name: string, manifest: string): string =>
  `---\nname: ${name}\ndescription: Handles ${name}.\n${manifest}\n---\n\n# ${name}\n\nCheck the order first.\n`;

/**
 * The How App, sealed, current and bound: a company skills collection
 * everyone reads and an admin owns, a sensitive collection of a team its
 * owner is in, and a third the App may read too, under a grant of its own
 * that this binding doesn't name. Each holds skills.
 */
const skillsApp = async () => {
  const fixture = await appWith(skillsFiles(), "How");
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  const sealed: Sealed = { ...fixture, release };
  const admin = await person("admin");
  const team = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Payroll', 'organization', ?)"
    ).bind(team, Date.now()),
    ...[sealed.owner, admin].map((member) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, member.userId, Date.now())
    ),
  ]);
  const teamAdmin = { ...admin, teams: [{ id: team, name: "Payroll" }] };
  const company = await createCollection(env, admin, {
    name: "Company skills",
    access: "everyone",
  });
  const secret = await createCollection(env, teamAdmin, {
    name: "Secret skills",
    access: "teams",
    teams: [team],
    sensitive: true,
  });
  const elsewhere = await createCollection(env, admin, {
    name: "Elsewhere",
    access: "everyone",
  });
  const saved: Record<string, string> = {};
  for (const [collectionId, name, manifest] of [
    [company.id, "refunds", "tasks: [refund]\nrequires: [platform:brain]"],
    [
      company.id,
      "payouts",
      "tasks: [payout]\nrequires: [connection:mail.send]",
    ],
    [secret.id, "salaries", "tasks: [salary]"],
    [elsewhere.id, "travel", "tasks: [travel]"],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one document at a time
    const document = await saveDocument(env, teamAdmin, {
      collectionId,
      path: `${name}/SKILL.md`,
      text: skillText(name, manifest),
      ifVersion: 0,
    });
    saved[name] = document.id;
  }
  const collections = {
    company: await granted(
      sealed,
      admin,
      { type: "collection", collectionId: company.id },
      "COMPANY"
    ),
    secret: await granted(
      sealed,
      admin,
      { type: "collection", collectionId: secret.id },
      "SECRET"
    ),
  };
  await granted(
    sealed,
    admin,
    { type: "collection", collectionId: elsewhere.id },
    "ELSEWHERE"
  );
  await approveResourceBinding(env, admin, {
    app: sealed.app,
    alias: "how",
    target: { kind: "knowledge", collections },
    reviewed: { version: 1 },
  });
  return {
    sealed,
    admin,
    saved,
    grantBrain: async () =>
      await granted(sealed, admin, { type: "platform" }, "BRAIN"),
    ids: { company: company.id, secret: secret.id },
  };
};

/** Calls `skills.<name>` of the App as its owner: the whole answer. */
const called = async (
  { app, owner, release }: Sealed,
  name: "pick" | "open",
  input: Record<string, Json>
): Promise<FunctionAnswer> => {
  const contractId = `skills.${name}`;
  const operation = release.app.operations[contractId];
  if (operation === undefined) {
    throw new Error(`No ${contractId}`);
  }
  return await callAppFunction(
    env,
    owner,
    app,
    JSON.stringify({
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId,
        fingerprint: release.fingerprints[contractId] ?? "",
        kind: operation.kind,
      },
      input,
    })
  );
};

const pickedSchema = z.strictObject({
  picked: z.string(),
  text: z.string().nullable(),
});

/** What a pick answered: the skill or why none, and whether its text came, or its error's code. */
const pickOf = (result: OperationResult): Json => {
  if (!result.ok) {
    return { failed: result.error.code };
  }
  const { picked, text } = pickedSchema.parse(result.value);
  return { picked, read: text?.includes("Check the order first") ?? false };
};

/** What an open answered: the skill's name, or its error's code. */
const openOf = (result: OperationResult): Json =>
  result.ok ? z.string().parse(result.value) : { failed: result.error.code };

/** Signing people in, sealing and granting can be slow on CI. */
const setUpTime = { timeout: 60_000 };

describe("an App's skills", setUpTime, () => {
  it("selects and reads nothing without the Brain's permission, and only its bound collections' skills, for capabilities it holds, with it", async () => {
    const { sealed, saved, grantBrain } = await skillsApp();
    const without = await called(sealed, "pick", { type: "refund" });
    await grantBrain();
    const refund = await called(sealed, "pick", { type: "refund" });
    const payout = await called(sealed, "pick", { type: "payout" });
    const travel = await called(sealed, "pick", { type: "travel" });
    const openTravel = await called(sealed, "open", {
      documentId: saved.travel ?? "",
      version: 1,
    });
    const openRefunds = await called(sealed, "open", {
      documentId: saved.refunds ?? "",
      version: 1,
    });

    expect({
      without: pickOf(without.result),
      refund: pickOf(refund.result),
      // It needs a connection the App wasn't granted.
      payout: pickOf(payout.result),
      // The App may read its collection, but not through this binding.
      travel: pickOf(travel.result),
      openTravel: openOf(openTravel.result),
      openRefunds: openOf(openRefunds.result),
    }).toStrictEqual({
      without: { failed: "resource.unavailable" },
      refund: { picked: "refunds", read: true },
      payout: { picked: "no_match", read: false },
      travel: { picked: "no_match", read: false },
      openTravel: { failed: "resource.item_not_found" },
      openRefunds: "refunds",
    });
  });

  it("never selects or reads a team's skill, whatever its status says, and so nothing of a sensitive team collection", async () => {
    const { sealed, saved, grantBrain } = await skillsApp();
    await grantBrain();
    const authority = {
      subject: { type: "app" as const, appId: sealed.app },
      onBehalfOf: sealed.owner.userId,
      mode: "interactive" as const,
      appVersion: 1,
    };
    const context = { type: "app" as const, appId: sealed.app };
    const salary = await called(sealed, "pick", { type: "salary" });
    const opened = await called(sealed, "open", {
      documentId: saved.salaries ?? "",
      version: 1,
    });

    expect({
      // Its members write it: none of its skills is vouched for, so none
      // is weighed, and a pinned read of one isn't found.
      salary: pickOf(salary.result),
      opened: openOf(opened.result),
      restricted: await isRestricted(env, authority, context),
    }).toStrictEqual({
      salary: { picked: "no_match", read: false },
      opened: { failed: "resource.item_not_found" },
      restricted: false,
    });
  });

  it("stops selecting once the Brain's permission is revoked, through the same binding", async () => {
    const { sealed, admin, grantBrain } = await skillsApp();
    const brain = await grantBrain();
    const before = await called(sealed, "pick", { type: "refund" });
    await revokePermission(env, admin, brain);
    const after = await called(sealed, "pick", { type: "refund" });

    expect({
      before: pickOf(before.result),
      after: pickOf(after.result),
    }).toStrictEqual({
      before: { picked: "refunds", read: true },
      after: { failed: "resource.unavailable" },
    });
  });

  it("keeps the fingerprint of an App that declares no skill operation as it was approved, and changes only theirs that do", async () => {
    // The knowledge contract's fingerprint before the skill operations,
    // which every knowledge approval until then holds.
    const approvedBefore =
      "d2f36f61d3234407ab3e46b7445410ad4cab0a6dbd71d984859bcbeb684265dd";

    expect({
      search: await knowledgeFingerprintOf(["search"]),
      readAndRecall: await knowledgeFingerprintOf(["read", "recall"]),
      all: await knowledgeFingerprintOf(["search", "read", "recall"]),
      skills:
        (await knowledgeFingerprintOf(["recall", "skillsSelect"])) ===
        approvedBefore,
      inAnyOrder:
        (await knowledgeFingerprintOf(["skillsRead", "skillsSelect"])) ===
        (await knowledgeFingerprintOf(["skillsSelect", "skillsRead"])),
    }).toStrictEqual({
      search: approvedBefore,
      readAndRecall: approvedBefore,
      all: approvedBefore,
      skills: false,
      inAnyOrder: true,
    });
  });
});
