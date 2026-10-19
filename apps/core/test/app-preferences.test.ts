import { v } from "@grasp-os/sdk";
import { contractFingerprint, preferenceOperations } from "@grasp-os/sdk/host";
import type { PreferenceOperationName } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { OperationResult } from "@grasp-os/shared/operations";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { sealRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { commitFiles, setCurrentVersion } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { appMembers } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { preferencesWatch } from "../src/store-host.ts";
import { mockIdp } from "./idp.ts";
import { appWith, failure, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";

// An App's preferences (spec 10.7.7, app-preferences.ts): `preferences.get`
// and `preferences.update`, answered by core for the signed-in person from
// the App's own store, through the same call path as any function a
// screen calls. Then the ways a caller could reach someone else's, write
// what the App didn't declare, lose an update, or keep reading once their
// access is gone; and a screen following them live.

const idp = mockIdp();

/**
 * An App declaring `preferences`, with no tables unless `withNotes`: a
 * notes table whose title is `title` (a string unless given).
 */
const filesWith = (
  preferences: string,
  {
    withNotes = false,
    title = "v.string()",
  }: { withNotes?: boolean; title?: string } = {}
): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema(${withNotes ? `{ notes: defineTable({ title: ${title} }) }` : "{}"});
`,
  "app.ts": `import { app, v } from "@grasp-os/sdk";
import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: ${withNotes ? '{ notes: { read: "owner", write: "owner" } }' : "{}"} },
  operations: {},
  screens: [{ name: "desk", path: "/", source: "screens/desk.tsx" }],
  ${preferences === "" ? "" : `preferences: ${preferences},`}
  uses: [],
});
`,
  "screens/desk.tsx": `export default function Desk() {
  return <main>Desk</main>;
}
`,
});

const declared = `v.object({
    compact: v.boolean().default(false),
    theme: v.enum(["light", "dark"]).default("light"),
  })`;

/** The preferences declared, with a page size of at most `max`. */
const withPageSize = (max: number): string => `v.object({
    compact: v.boolean().default(false),
    theme: v.enum(["light", "dark"]).default("light"),
    pageSize: v.number().integer().min(10).max(${max}).default(25),
  })`;

type Sealed = Fixture & { release: Release };

/** The App sealed and current, with `files`. */
const sealedDesk = async (
  files: Record<string, string> = filesWith(declared),
  by?: Identity
): Promise<Sealed> => {
  const fixture = await appWith(files, "Desk", by);
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release };
};

/** Shares the App with `by`, as one of its users. */
const share = async ({ app, owner }: Sealed, by: Identity): Promise<void> => {
  await drizzle(env.DB).insert(appMembers).values({
    appId: app,
    memberType: "person",
    memberId: by.userId,
    role: "user",
    addedBy: owner.userId,
    addedAt: new Date(),
  });
};

/** The reference to `name` of `release`'s preferences, as `#grasp` has it. */
const referenceTo = async (release: Release, name: PreferenceOperationName) => {
  if (release.app.preferences === null) {
    throw new Error("The App declares no preferences");
  }
  const operation = preferenceOperations(release.app.preferences)[name];
  return {
    resourceId: release.manifest.resourceId,
    resourceVersion: release.manifest.resourceVersion,
    contractId: operation.path,
    fingerprint: await contractFingerprint(operation),
    kind: operation.kind,
  };
};

/** What `by` gets calling the reference with `input`, as a screen calls it. */
const callWith = async (
  { app }: Sealed,
  by: Pick<Identity, "userId" | "role" | "teams">,
  reference: unknown,
  input: unknown,
  idempotencyKey?: string
): Promise<OperationResult> => {
  const answered = await callAppFunction(
    env,
    by,
    app,
    JSON.stringify({
      reference,
      input,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    })
  );
  return answered.result;
};

/** `by`'s preferences of `desk`. */
const get = async (
  desk: Sealed,
  by: Pick<Identity, "userId" | "role" | "teams">
): Promise<OperationResult> =>
  await callWith(desk, by, await referenceTo(desk.release, "get"), {});

/** `by` changing their preferences of `desk` from `expectedRevision`. */
const update = async (
  desk: Sealed,
  by: Pick<Identity, "userId" | "role" | "teams">,
  expectedRevision: number,
  patch: unknown,
  idempotencyKey?: string
): Promise<OperationResult> =>
  await callWith(
    desk,
    by,
    await referenceTo(desk.release, "update"),
    { expectedRevision, patch },
    idempotencyKey
  );

/** The value of a call that succeeded; fails the test otherwise. */
const valueOf = (result: OperationResult): unknown => {
  if (!result.ok) {
    throw new Error(`The call failed: ${result.error.code}`);
  }
  return result.value;
};

/**
 * Plants `chosen` as `personId`'s stored preferences of `desk`, past every
 * check: a document that no longer fits, as no seal can leave one now.
 */
const planted = async (
  desk: Sealed,
  personId: string,
  chosen: Record<string, unknown>,
  revision = 1
): Promise<void> => {
  const storeId = storeIdSchema.parse(desk.release.store?.storeId);
  await runInDurableObject(
    inJurisdiction(env, env.DATA_STORES).getByName(storeId),
    (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO sdk_preferences (person_id, revision, value_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (person_id) DO UPDATE SET revision = excluded.revision, value_json = excluded.value_json",
        personId,
        revision,
        JSON.stringify(chosen),
        Date.now()
      );
    }
  );
};

/** `ok`, or the code the call failed with. */
const codeOf = (result: OperationResult): string =>
  result.ok ? "ok" : result.error.code;

const pushWait = { timeout: 30_000, interval: 50 };

describe("an App's preferences", { timeout: 120_000 }, () => {
  it("answer the defaults at revision 0 until the person writes, even for an App with no tables", async () => {
    const desk = await sealedDesk();
    // A store was bound for them, though the App declares no tables.
    expect(desk.release.store).not.toBeNull();
    expect(valueOf(await get(desk, desk.owner))).toStrictEqual({
      compact: false,
      theme: "light",
      _rev: 0,
    });
  });

  it("write a patch: untouched fields stay, the first write is revision 1, and a no-op keeps the revision", async () => {
    const desk = await sealedDesk();
    expect(
      valueOf(await update(desk, desk.owner, 0, { compact: true }))
    ).toStrictEqual({ compact: true, theme: "light", _rev: 1 });
    expect(
      valueOf(await update(desk, desk.owner, 1, { theme: "dark" }))
    ).toStrictEqual({ compact: true, theme: "dark", _rev: 2 });
    // The same values again, and an empty patch: nothing is written.
    expect(
      valueOf(await update(desk, desk.owner, 2, { compact: true }))
    ).toStrictEqual({ compact: true, theme: "dark", _rev: 2 });
    expect(valueOf(await update(desk, desk.owner, 2, {}))).toStrictEqual({
      compact: true,
      theme: "dark",
      _rev: 2,
    });
    expect(valueOf(await get(desk, desk.owner))).toStrictEqual({
      compact: true,
      theme: "dark",
      _rev: 2,
    });
  });

  it("refuse a stale revision, and let exactly one of two racing updates commit", async () => {
    const desk = await sealedDesk();
    await update(desk, desk.owner, 0, { compact: true });
    expect(codeOf(await update(desk, desk.owner, 0, { theme: "dark" }))).toBe(
      "data.conflict"
    );
    const raced = await Promise.all([
      update(desk, desk.owner, 1, { theme: "dark" }),
      update(desk, desk.owner, 1, { compact: false }),
    ]);
    expect(raced.map(codeOf).toSorted()).toStrictEqual(["data.conflict", "ok"]);
    expect(valueOf(await get(desk, desk.owner))).toMatchObject({ _rev: 2 });
  });

  it("refuse what the App didn't declare: an unknown key, a wrong value, a person named in the call", async () => {
    const desk = await sealedDesk();
    const other = await person("builder");
    for (const patch of [
      { dark: true },
      { theme: "blue" },
      { compact: "yes" },
      { compact: null },
      // Own keys, as JSON makes them: never the prototype's.
      JSON.parse('{"__proto__": {"compact": true}}'),
      JSON.parse('{"constructor": {"prototype": {"compact": true}}}'),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      expect(codeOf(await update(desk, desk.owner, 0, patch))).toBe(
        "contract.invalid_args"
      );
    }
    expect(
      codeOf(
        await callWith(
          desk,
          desk.owner,
          await referenceTo(desk.release, "get"),
          {
            personId: other.userId,
          }
        )
      )
    ).toBe("contract.invalid_args");
    expect(
      codeOf(
        await callWith(
          desk,
          desk.owner,
          await referenceTo(desk.release, "update"),
          { expectedRevision: 0, patch: {}, personId: other.userId }
        )
      )
    ).toBe("contract.invalid_args");
    expect(valueOf(await get(desk, desk.owner))).toMatchObject({ _rev: 0 });
  });

  it("are each person's own: another's writes never show, and an admin reads only their own", async () => {
    const desk = await sealedDesk();
    const colleague = await person("user");
    const admin = await person("admin");
    await share(desk, colleague);
    await update(desk, desk.owner, 0, { compact: true, theme: "dark" });
    expect(valueOf(await get(desk, colleague))).toStrictEqual({
      compact: false,
      theme: "light",
      _rev: 0,
    });
    expect(valueOf(await get(desk, admin))).toStrictEqual({
      compact: false,
      theme: "light",
      _rev: 0,
    });
    // The colleague's first write is their revision 1, not the owner's 2.
    expect(
      valueOf(await update(desk, colleague, 0, { theme: "dark" }))
    ).toStrictEqual({ compact: false, theme: "dark", _rev: 1 });
    expect(valueOf(await get(desk, desk.owner))).toStrictEqual({
      compact: true,
      theme: "dark",
      _rev: 1,
    });
  });

  it("tell a live read only of its own person's writes", async () => {
    const desk = await sealedDesk();
    const colleague = await person("user");
    await share(desk, colleague);
    const storeId = storeIdSchema.parse(desk.release.store?.storeId);
    const store = inJurisdiction(env, env.DATA_STORES).getByName(storeId);
    // A watch of the owner's preferences, as their screen's live read
    // keeps one.
    const told: string[][] = [];
    await store.watch(
      storeId,
      desk.owner.userId,
      { [preferencesWatch(desk.owner.userId)]: 0 },
      (tables: string[]) => {
        told.push(tables);
      }
    );
    await update(desk, colleague, 0, { compact: true });
    await update(desk, colleague, 1, { theme: "dark" });
    // Told in order: by the time the owner's own write is told, any telling
    // of the colleague's writes would have come before it.
    await update(desk, desk.owner, 0, { theme: "dark" });
    await vi.waitFor(() => {
      expect(told).toHaveLength(1);
    }, pushWait);
    expect(told).toStrictEqual([[preferencesWatch(desk.owner.userId)]]);
  });

  it("resolve only references the App's current release generates", async () => {
    const desk = await sealedDesk();
    const getReference = await referenceTo(desk.release, "get");
    expect(
      codeOf(
        await callWith(
          desk,
          desk.owner,
          { ...getReference, fingerprint: "0".repeat(64) },
          {}
        )
      )
    ).toBe("version.mismatch");
    expect(
      codeOf(
        await callWith(
          desk,
          desk.owner,
          { ...getReference, kind: "mutation" },
          {}
        )
      )
    ).toBe("operation.kind_mismatch");
    expect(
      codeOf(
        await callWith(
          desk,
          desk.owner,
          { ...getReference, contractId: "preferences.reset" },
          {}
        )
      )
    ).toBe("operation.not_found");
    // Another App's reference, of the same preferences, names nothing here.
    const other = await sealedDesk();
    expect(
      codeOf(
        await callWith(
          desk,
          desk.owner,
          await referenceTo(other.release, "get"),
          {}
        )
      )
    ).toBe("version.mismatch");
    // An App that declares none has none.
    const plain = await sealedDesk(filesWith("", { withNotes: true }));
    expect(
      codeOf(
        await callWith(
          plain,
          plain.owner,
          { ...getReference, resourceId: plain.app },
          {}
        )
      )
    ).toBe("operation.not_found");
  });

  it("read and write nothing for someone who lost access, or once the release is revoked", async () => {
    const desk = await sealedDesk();
    const colleague = await person("user");
    await share(desk, colleague);
    expect(codeOf(await get(desk, colleague))).toBe("ok");
    await drizzle(env.DB)
      .delete(appMembers)
      .where(
        and(
          eq(appMembers.appId, desk.app),
          eq(appMembers.memberId, colleague.userId)
        )
      );
    expect(codeOf(await get(desk, colleague))).toBe("app.not_found");
    expect(codeOf(await update(desk, colleague, 0, { compact: true }))).toBe(
      "app.not_found"
    );
    const admin = await person("admin");
    await revokeRelease(env, admin, { app: desk.app, version: 1 }, "Leaks");
    expect(codeOf(await update(desk, desk.owner, 0, { compact: true }))).toBe(
      "version.revoked"
    );
    expect(codeOf(await get(desk, desk.owner))).toBe("version.revoked");
  });

  it("pass the caller's own check and the deadline as late as they can, so access lost mid-call reads and writes nothing", async () => {
    const desk = await sealedDesk();
    const request = JSON.stringify({
      reference: await referenceTo(desk.release, "update"),
      input: { expectedRevision: 0, patch: { compact: true } },
    });
    // An agent's permission revoked once the call began, say.
    const lost = await callAppFunction(
      env,
      desk.owner,
      desk.app,
      request,
      Date.now() + 60_000,
      async () => {
        await Promise.reject(new Error("Permission revoked"));
      }
    );
    expect(lost.result.ok).toBeFalsy();
    const late = await callAppFunction(
      env,
      desk.owner,
      desk.app,
      request,
      Date.now() - 1
    );
    expect(codeOf(late.result)).toBe("operation.deadline_exceeded");
    // Still allowed when it read, no longer when it would write: nothing
    // is written.
    let checks = 0;
    const lostBeforeWrite = await callAppFunction(
      env,
      desk.owner,
      desk.app,
      request,
      Date.now() + 60_000,
      async () => {
        checks += 1;
        if (checks > 1) {
          await Promise.reject(new Error("Permission revoked"));
        }
      }
    );
    expect({ ok: lostBeforeWrite.result.ok, checks }).toStrictEqual({
      ok: false,
      checks: 2,
    });
    expect(valueOf(await get(desk, desk.owner))).toMatchObject({ _rev: 0 });
  });

  it("answer a resend of a write whose answer was lost from its key, and refuse the key for another change", async () => {
    const desk = await sealedDesk();
    const key = crypto.randomUUID();
    const first = valueOf(
      await update(desk, desk.owner, 0, { compact: true }, key)
    );
    // The answer was lost; the client sends the same save again, and gets
    // the committed answer, not a conflict with itself.
    const resent = valueOf(
      await update(desk, desk.owner, 0, { compact: true }, key)
    );
    expect({ first, resent }).toStrictEqual({
      first: { compact: true, theme: "light", _rev: 1 },
      resent: { compact: true, theme: "light", _rev: 1 },
    });
    // The same key for a different change, from either revision; and a
    // key that isn't one.
    expect([
      codeOf(await update(desk, desk.owner, 0, { theme: "dark" }, key)),
      codeOf(await update(desk, desk.owner, 1, { theme: "dark" }, key)),
      codeOf(await update(desk, desk.owner, 1, {}, "not\u0001ascii")),
    ]).toStrictEqual([
      "submission.key_conflict",
      "submission.key_conflict",
      "submission.key_invalid",
    ]);
    // A new key is a new change, from the revision it read.
    expect(
      valueOf(
        await update(
          desk,
          desk.owner,
          1,
          { theme: "dark" },
          crypto.randomUUID()
        )
      )
    ).toStrictEqual({ compact: true, theme: "dark", _rev: 2 });
  });

  it("refuse a resend under another release, whose answer would have another shape", async () => {
    const desk = await sealedDesk();
    const key = crypto.randomUUID();
    await update(desk, desk.owner, 0, { compact: true }, key);
    // A version that adds a field: the first save's answer lacks it.
    await commitFiles(
      env,
      desk.owner,
      desk.app,
      filesWith(`v.object({
    compact: v.boolean().default(false),
    theme: v.enum(["light", "dark"]).default("light"),
    pageSize: v.number().integer().min(10).max(100).default(25),
  })`),
      "Page size"
    );
    const second = { ...desk, release: await seal(desk, 2) };
    await setCurrentVersion(env, desk.owner, desk.app, 2);
    expect(
      codeOf(await update(second, desk.owner, 0, { compact: true }, key))
    ).toBe("submission.key_conflict");
    expect(valueOf(await get(second, desk.owner))).toStrictEqual({
      compact: true,
      theme: "light",
      pageSize: 25,
      _rev: 1,
    });
  });

  it("give an App with preferences and no tables its store only at seal", async () => {
    const fixture = await appWith(filesWith(declared), "Desk");
    await expect(
      failure(
        async () =>
          await sealRelease(env, {
            app: fixture.app,
            version: 1,
            by: fixture.owner,
          })
      )
    ).resolves.toBe("version.store_unbound");
    const release = await seal(fixture);
    expect(release.store?.storeId).toBe(fixture.store);
  });

  it("store only what the person chose: a later default reaches them, and a field a version removes is kept until they write", async () => {
    const desk = await sealedDesk();
    await update(desk, desk.owner, 0, { compact: true });
    /** Seals the App's next version with `preferences`, and runs it. */
    const versionWith = async (version: number, preferences: string) => {
      await commitFiles(
        env,
        desk.owner,
        desk.app,
        filesWith(preferences),
        `v${version}`
      );
      const release = await seal(desk, version);
      await setCurrentVersion(env, desk.owner, desk.app, version);
      return { ...desk, release };
    };
    // Version 2 adds a field and changes a default the person never chose:
    // both reach them, with nothing rewritten.
    const second = await versionWith(
      2,
      `v.object({
    compact: v.boolean().default(false),
    theme: v.enum(["light", "dark"]).default("dark"),
    pageSize: v.number().integer().min(10).max(100).default(25),
  })`
    );
    expect(valueOf(await get(second, desk.owner))).toStrictEqual({
      compact: true,
      theme: "dark",
      pageSize: 25,
      _rev: 1,
    });
    await update(second, desk.owner, 1, { pageSize: 50 });
    // Version 3 removes `pageSize`: the person still reads and writes.
    const third = await versionWith(3, declared);
    expect(valueOf(await get(third, desk.owner))).toStrictEqual({
      compact: true,
      theme: "light",
      _rev: 2,
    });
    // Back on version 2 before they write again, the page size they chose
    // is there again: reading rewrote nothing.
    await setCurrentVersion(env, desk.owner, desk.app, 2);
    expect(valueOf(await get(second, desk.owner))).toMatchObject({
      pageSize: 50,
      _rev: 2,
    });
    // A write on version 3 drops what it no longer declares, so the
    // document never grows with what earlier versions declared.
    await setCurrentVersion(env, desk.owner, desk.app, 3);
    expect(
      valueOf(await update(third, desk.owner, 2, { compact: false }))
    ).toStrictEqual({ compact: false, theme: "light", _rev: 3 });
    await setCurrentVersion(env, desk.owner, desk.app, 2);
    expect(valueOf(await get(second, desk.owner))).toStrictEqual({
      compact: false,
      theme: "dark",
      pageSize: 25,
      _rev: 3,
    });
  });

  it("leave nothing in the store's preferences contract from a seal that failed", async () => {
    const desk = await sealedDesk(filesWith(declared, { withNotes: true }));
    /** Seals the App's next `version` with `preferences` and `title`. */
    const sealing = async (
      version: number,
      preferences: string,
      title?: string
    ): Promise<string> => {
      await commitFiles(
        env,
        desk.owner,
        desk.app,
        filesWith(preferences, {
          withNotes: true,
          ...(title === undefined ? {} : { title }),
        }),
        `v${version}`
      );
      return await failure(async () => await seal(desk, version));
    };
    expect([
      // A new preference, in a version whose table change needs a
      // migration: the seal fails after its preferences were checked.
      await sealing(2, withPageSize(100), "v.number()"),
      // So the builder can still give it another shape.
      await sealing(3, withPageSize(50)),
      await sealing(4, withPageSize(100)),
    ]).toStrictEqual([
      "migration.required",
      "ok",
      "migration.preference_changed",
    ]);
  });

  it("apply a sealed version's preferences again when it is sealed again, so a lost apply heals", async () => {
    const desk = await sealedDesk();
    const storeId = storeIdSchema.parse(desk.release.store?.storeId);
    // The apply after the seal was lost, as if the store were unreachable.
    await runInDurableObject(
      inJurisdiction(env, env.DATA_STORES).getByName(storeId),
      (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE sdk_store SET preferences_contract = NULL"
        );
      }
    );
    // Sealing the version again applies them again.
    await seal(desk);
    await commitFiles(
      env,
      desk.owner,
      desk.app,
      filesWith(`v.object({
    compact: v.boolean().default(false),
    theme: v.enum(["light"]).default("light"),
  })`),
      "Light only"
    );
    await expect(failure(async () => await seal(desk, 2))).resolves.toBe(
      "migration.preference_changed"
    );
  });

  it("serve a release's preferences only while the store's contract holds them, taking them at the first call if it lost them", async () => {
    const desk = await sealedDesk();
    /** Sets the store's preferences contract, as if another release had. */
    const contractIs = async (contract: unknown): Promise<void> => {
      const storeId = storeIdSchema.parse(desk.release.store?.storeId);
      await runInDurableObject(
        inJurisdiction(env, env.DATA_STORES).getByName(storeId),
        (_instance, state) => {
          state.storage.sql.exec(
            "UPDATE sdk_store SET preferences_contract = ?",
            contract === null ? null : JSON.stringify(contract)
          );
        }
      );
    };
    // Another release, racing this one's seal, made the store's contract
    // hold a narrower theme: this release serves no preference call.
    await contractIs({
      theme: v.enum(["light"]).default("light").descriptor,
    });
    expect([
      codeOf(await get(desk, desk.owner)),
      codeOf(await update(desk, desk.owner, 0, { compact: true })),
    ]).toStrictEqual([
      "migration.preference_changed",
      "migration.preference_changed",
    ]);
    // The contract lost (its apply after the seal never landed): the first
    // call puts this release's preferences back, so a narrowing seal is
    // refused again.
    await contractIs(null);
    expect(codeOf(await get(desk, desk.owner))).toBe("ok");
    await commitFiles(
      env,
      desk.owner,
      desk.app,
      filesWith(`v.object({
    compact: v.boolean().default(false),
    theme: v.enum(["light"]).default("light"),
  })`),
      "Light only"
    );
    await expect(failure(async () => await seal(desk, 2))).resolves.toBe(
      "migration.preference_changed"
    );
  });

  it("refuse a stored value that no longer fits, rewriting nothing, until a patch replaces it", async () => {
    const desk = await sealedDesk();
    await planted(desk, desk.owner.userId, { theme: "blue" });
    expect(codeOf(await get(desk, desk.owner))).toBe(
      "data.incompatible_record"
    );
    expect(codeOf(await update(desk, desk.owner, 1, { compact: true }))).toBe(
      "data.incompatible_record"
    );
    // A patch that replaces the value that no longer fits is taken.
    expect(
      valueOf(await update(desk, desk.owner, 1, { theme: "light" }))
    ).toStrictEqual({ compact: false, theme: "light", _rev: 2 });
  });

  it("refuse at seal a version that changes a preference people may have chosen, and keep running the one before", async () => {
    const desk = await sealedDesk();
    await update(desk, desk.owner, 0, { theme: "dark" });
    /** What sealing the App's next `version` with `preferences` does. */
    const sealing = async (version: number, preferences: string) => {
      await commitFiles(
        env,
        desk.owner,
        desk.app,
        filesWith(preferences),
        `v${version}`
      );
      try {
        await seal(desk, version);
        return "sealed";
      } catch (error) {
        const { code, details } = z
          .object({
            code: z.string(),
            details: z
              .object({
                changes: z.array(z.object({ preference: z.string() })),
              })
              .optional(),
          })
          .parse(error);
        return `${code}: ${(details?.changes ?? []).map(({ preference }) => preference).join(", ")}`;
      }
    };
    expect([
      // Narrowed: people's "dark" would no longer fit.
      await sealing(
        2,
        `v.object({
    compact: v.boolean().default(false),
    theme: v.enum(["light"]).default("light"),
  })`
      ),
      // Widened: "blue" stored under it wouldn't fit version 1 after a
      // rollback.
      await sealing(
        3,
        `v.object({
    compact: v.boolean().default(false),
    theme: v.enum(["light", "dark", "blue"]).default("light"),
  })`
      ),
      // Removed: kept by the store, so it comes back only as it was.
      await sealing(4, "v.object({ compact: v.boolean().default(false) })"),
      await sealing(
        5,
        `v.object({
    compact: v.boolean().default(false),
    theme: v.enum(["light"]).default("light"),
  })`
      ),
      // As it was, with another default: taken.
      await sealing(
        6,
        `v.object({
    compact: v.boolean().default(false),
    theme: v.enum(["light", "dark"]).default("dark"),
  })`
      ),
    ]).toStrictEqual([
      "migration.preference_changed: theme",
      "migration.preference_changed: theme",
      "sealed",
      "migration.preference_changed: theme",
      "sealed",
    ]);
    // Refused seals changed nothing: version 1 runs, and reads as before.
    expect(valueOf(await get(desk, desk.owner))).toStrictEqual({
      compact: false,
      theme: "dark",
      _rev: 1,
    });
  });
});

const pushSchema = z.object({
  revision: z.number(),
  result: z.union([
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
  ]),
});

/** A page's callback: what reached it. */
const pageFollower = () => {
  const received: z.infer<typeof pushSchema>[] = [];
  const callback = Object.assign(
    (push: unknown): void => {
      received.push(pushSchema.parse(push));
    },
    {
      [Symbol.dispose]: (): void => {
        // Let go of: nothing more arrives.
      },
    }
  );
  return { received, callback };
};

/** Someone signed in, and as core's own calls take them. */
const signedIn = async (role: Role) => {
  const session = await signedInApi(idp, role);
  const acting: Acting & Identity = {
    userId: session.userId,
    email: z.string().parse(session.person.email),
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return { ...session, acting };
};

/**
 * The Desk App sealed and current with its screen approved, opened by its
 * builder, and that screen following the builder's preferences, once the
 * first push came.
 */
const followingDesk = async () => {
  const admin = await signedIn("admin");
  const builder = await signedIn("builder");
  const desk = await sealedDesk(filesWith(declared), builder.acting);
  const review = await admin.api.screenTrust.review(desk.app);
  await admin.api.screenTrust.approve(desk.app, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  const bundle = await builder.api.screens.open(desk.app, "desk");
  await builder.api.screens.present(desk.app, bundle.lease);
  const follower = pageFollower();
  const subscription = await builder.api.screens.watchQuery(
    desk.app,
    bundle.lease,
    JSON.stringify({
      reference: await referenceTo(desk.release, "get"),
      input: {},
    }),
    follower.callback
  );
  const latest = () => {
    const last = follower.received.at(-1)?.result;
    return last?.ok === true ? last.value : undefined;
  };
  await vi.waitFor(
    () => {
      expect(latest()).toStrictEqual({
        compact: false,
        theme: "light",
        _rev: 0,
      });
    },
    { timeout: 30_000, interval: 50 }
  );
  return { admin, builder, desk, bundle, follower, subscription, latest };
};

/** What `person`'s screen gets calling `get` through core's function route. */
const routedGet = async (
  caller: Awaited<ReturnType<typeof signedIn>>,
  desk: Sealed,
  lease: string
): Promise<string> => {
  const response = await routed(`${appFunctionPath}/${desk.app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: caller.session,
      [screenPersonHeader]: caller.userId,
      [screenLeaseHeader]: lease,
    },
    body: JSON.stringify({
      reference: await referenceTo(desk.release, "get"),
      input: {},
    }),
  });
  const answer: unknown = await response.json();
  if (!response.ok) {
    return errorPayloadSchema.parse(answer).code;
  }
  const { result } = z
    .object({
      result: z.union([
        z.object({ ok: z.literal(true) }),
        z.object({
          ok: z.literal(false),
          error: z.object({ code: z.string() }),
        }),
      ]),
    })
    .parse(answer);
  return result.ok ? "ok" : result.error.code;
};

describe(
  "a screen following its person's preferences",
  { timeout: 120_000 },
  () => {
    it("shows each update they make, pushed to the same subscription", async () => {
      const { builder, desk, subscription, latest } = await followingDesk();
      await update(desk, builder.acting, 0, { compact: true });
      await vi.waitFor(() => {
        expect(latest()).toStrictEqual({
          compact: true,
          theme: "light",
          _rev: 1,
        });
      }, pushWait);
      await subscription.release();
    });

    it("hears nothing of anyone else's writes: no push, nothing read again", async () => {
      const { builder, desk, follower, subscription, latest } =
        await followingDesk();
      const colleague = await person("user");
      await share(desk, colleague);
      await update(desk, colleague, 0, { compact: true });
      await update(desk, colleague, 1, { theme: "dark" });
      // Their own write after: by the time its push arrives, any push the
      // colleague's writes made would have arrived before it.
      await update(desk, builder.acting, 0, { theme: "dark" });
      await vi.waitFor(() => {
        expect(latest()).toMatchObject({ theme: "dark", _rev: 1 });
      }, pushWait);
      expect(follower.received).toHaveLength(2);
      await subscription.release();
    });

    it("follows a refused read to its repair: once the person replaces a value that no longer fits, the screen gets the document", async () => {
      const admin = await signedIn("admin");
      const builder = await signedIn("builder");
      const desk = await sealedDesk(filesWith(declared), builder.acting);
      // What they stored no longer fits.
      await planted(desk, builder.userId, { theme: "blue" });
      const review = await admin.api.screenTrust.review(desk.app);
      await admin.api.screenTrust.approve(desk.app, {
        version: review.version,
        generation: review.generation,
        artifacts: builtArtifacts(review.screens),
      });
      const bundle = await builder.api.screens.open(desk.app, "desk");
      await builder.api.screens.present(desk.app, bundle.lease);
      const follower = pageFollower();
      const subscription = await builder.api.screens.watchQuery(
        desk.app,
        bundle.lease,
        JSON.stringify({
          reference: await referenceTo(desk.release, "get"),
          input: {},
        }),
        follower.callback
      );
      const last = () => follower.received.at(-1)?.result;
      await vi.waitFor(() => {
        const result = last();
        expect(result?.ok === false ? result.error.code : "none").toBe(
          "data.incompatible_record"
        );
      }, pushWait);
      // Repaired from elsewhere: the same subscription gets the document.
      await update(desk, builder.acting, 1, { theme: "light" });
      await vi.waitFor(() => {
        const result = last();
        expect(result?.ok === true ? result.value : undefined).toStrictEqual({
          compact: false,
          theme: "light",
          _rev: 2,
        });
      }, pushWait);
      await subscription.release();
    });

    it("stops at the screen's revocation: its calls, and its subscription's next push", async () => {
      const { admin, builder, desk, bundle, follower, subscription } =
        await followingDesk();
      await expect(routedGet(builder, desk, bundle.lease)).resolves.toBe("ok");
      await admin.api.screenTrust.revoke(desk.app, bundle.artifact);
      await expect(routedGet(builder, desk, bundle.lease)).resolves.toBe(
        "screen.revoked"
      );
      // Their write from elsewhere reaches the revoked screen as the
      // refusal, never as their preferences.
      await update(desk, builder.acting, 0, { compact: true });
      await vi.waitFor(() => {
        const last = follower.received.at(-1)?.result;
        expect(last?.ok === false ? last.error.code : "ok").toBe(
          "screen.revoked"
        );
      }, pushWait);
      expect(
        follower.received.some(
          ({ result }) =>
            result.ok && JSON.stringify(result.value).includes('"_rev":1')
        )
      ).toBeFalsy();
      await subscription.release();
    });
  }
);
