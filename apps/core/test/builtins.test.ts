import { sha256Hex } from "@grasp-os/shared/encoding";
import { routerSecretHeader } from "@grasp-os/shared/router";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  installShippedSkills,
  readSkillFor,
  skillsFor,
} from "../src/brain-skills.ts";
import { blueprintsDigestText } from "../src/builtin-digest.ts";
import {
  builtins,
  builtinsInstaller,
  builtinsRetryMs,
  fingerprintOf,
  installBuiltins,
  loadBuiltinRelease,
  thisRelease,
} from "../src/builtins.ts";
import worker from "../src/index.ts";
import { releaseContracts } from "../src/release-contracts.ts";
import { shippedSkills } from "../src/shipped-skills.ts";
import type { ShippedSkill } from "../src/shipped-skills.ts";
import { actingFor } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, signedInWithRole, unique } from "./sign-in.ts";
import { holdsNothing } from "./stored-skills.ts";

// What ships with the release, installed once per release on the first
// request (src/builtins.ts). These tests start from the ways that can
// fail: a failed start is never tried again, or tried on every request; an
// isolate of another release counts the object's install as its own; a
// request starts another install once the isolate's is done; an unchanged
// release writes again; callers arriving together each install, and write
// twice or refuse each other; and a partial install is recorded as done,
// stranding what failed. That the first request starts it, every file's
// setup checks (builtins-first.ts). What an install writes is watched
// through Grasp's skills in the Brain (src/brain-skills.ts).
//
// The tests of a file share their storage, the singleton's included, so
// each test that needs an install forgets the last one first.

const idp = mockIdp();

/** This release's fingerprint, as an isolate of it works it out. */
const thisFingerprint = async (): Promise<string> =>
  await fingerprintOf(thisRelease);

/** A chat's agent acting for a member, who reads Grasp's skills. */
const reader = async () => {
  const { userId } = await signedInWithRole(idp, "user");
  return actingFor({ type: "agent", agentId: `agent-${unique()}` }, userId);
};

/** Each of Grasp's skills' current text in the Brain, by name. */
const storedSkills = async (): Promise<Record<string, string>> => {
  const agent = await reader();
  const listed = await skillsFor(env, agent, "teams", holdsNothing);
  const grasp = listed.filter(({ scope }) => scope === "grasp");
  return Object.fromEntries(
    await Promise.all(
      grasp.map(async (skill) => {
        const { text } = await readSkillFor(env, agent, "teams", holdsNothing, {
          skill,
        });
        return [skill.name, text] as const;
      })
    )
  );
};

/** This release's skills, by name. */
const releaseSkills = (skills: readonly ShippedSkill[] = shippedSkills) =>
  Object.fromEntries(skills.map(({ name, text }) => [name, text]));

/** This release's skills, with those named `names` changed: another release. */
const otherRelease = (...names: string[]): ShippedSkill[] =>
  shippedSkills.map(({ name, text }) => ({
    name,
    text: names.includes(name) ? `${text}\nFrom another release.\n` : text,
  }));

/** The first `count` Grasp skills' names. */
const firstNames = (count: number): string[] => {
  const names = shippedSkills.slice(0, count).map(({ name }) => name);
  if (names.length < count) {
    throw new Error(`This release ships fewer than ${count} Grasp skills`);
  }
  return names;
};

/**
 * The singleton, reached without `getByName`, which the first test
 * counts the calls of.
 */
const singleton = () => env.BUILTINS.get(env.BUILTINS.idFromName("builtins"));

/** What the singleton stored as installed. */
const installed = async (): Promise<unknown> =>
  await runInDurableObject(
    singleton(),
    async (_instance, state) => await state.storage.get("installed")
  );

/**
 * Makes the singleton forget what it installed, and the skills named
 * `names` another release's text, so the next install has them to write.
 */
const forgetInstall = async (...names: string[]): Promise<void> => {
  await installShippedSkills(env, otherRelease(...names));
  await runInDurableObject(singleton(), async (_instance, state) => {
    await state.storage.delete("installed");
  });
};

/** How many skills the installs of `events` wrote. */
const skillsWritten = (
  events: { action: string; detail: Record<string, unknown> }[]
): number[] =>
  events
    .filter(({ action }) => action === "brain.skills.installed")
    .map(({ detail }) => Number(detail.changed));

/**
 * `run` with the Brain failing the first write of Grasp's skill `name`,
 * as when it is out of reach for a moment.
 */
const withBrainFailingOnce = async <T>(
  name: string,
  run: () => Promise<T>
): Promise<T> => {
  const source = `skill:grasp:${name}`;
  const store = env.BRAIN_STORE;
  const real = store.getByName.bind(store);
  let failed = false;
  const spied = vi.spyOn(store, "getByName").mockImplementation((id) => {
    const stub = real(id);
    const addInstructions = async (
      added: Parameters<typeof stub.addInstructions>[0]
    ) => {
      if (added.source === source && !failed) {
        failed = true;
        throw new Error("The Brain is out of reach");
      }
      return await stub.addInstructions(added);
    };
    return new Proxy(stub, {
      get: (target, property): unknown =>
        property === "addInstructions"
          ? addInstructions
          : Reflect.get(target, property),
    });
  });
  try {
    return await run();
  } finally {
    spied.mockRestore();
  }
};

/** A request that passed the router's check, handled to the end. */
const request = async (): Promise<void> => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://core/health", {
      headers: { [routerSecretHeader]: env.ROUTER_SECRET },
    }),
    env,
    ctx
  );
  expect(response.status).toBe(200);
  await waitOnExecutionContext(ctx);
};

/** An isolate's installer started as a request would, run to the end. */
const started = async (
  install: ReturnType<typeof builtinsInstaller>
): Promise<void> => {
  const ctx = createExecutionContext();
  install(env, ctx);
  await waitOnExecutionContext(ctx);
};

describe("the built-ins", () => {
  it("are installed after a failed start by the first request a minute later, not before, and then asked for no more", async () => {
    const changed = otherRelease(...firstNames(1));
    await forgetInstall(...firstNames(1));
    const install = builtinsInstaller();
    const calls = vi
      .spyOn(env.BUILTINS, "getByName")
      .mockImplementationOnce(() => {
        throw new Error("Durable Objects unavailable");
      });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await started(install);
      // Not tried again before the minute is up.
      await started(install);
      expect([
        calls.mock.calls.length,
        await installed(),
        await storedSkills(),
      ]).toStrictEqual([1, undefined, releaseSkills(changed)]);

      vi.setSystemTime(Date.now() + builtinsRetryMs);
      await started(install);
      // Done: the isolate asks no more.
      vi.setSystemTime(Date.now() + builtinsRetryMs);
      await started(install);
      expect([calls.mock.calls.length, await storedSkills()]).toStrictEqual([
        2,
        releaseSkills(),
      ]);
    } finally {
      vi.useRealTimers();
      calls.mockRestore();
    }
    await expect(installed()).resolves.toBe(await thisFingerprint());
  });

  it("aren't done for an isolate of another release, which asks again a minute later", async () => {
    await forgetInstall(...firstNames(1));
    const install = builtinsInstaller({
      ...thisRelease,
      skills: otherRelease(...firstNames(1)),
    });
    const calls = vi.spyOn(env.BUILTINS, "getByName");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // The object installs its own release, which isn't this isolate's.
      await started(install);
      await started(install);
      expect([calls.mock.calls.length, await storedSkills()]).toStrictEqual([
        1,
        releaseSkills(),
      ]);
      vi.setSystemTime(Date.now() + builtinsRetryMs);
      await started(install);
      expect(calls).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      calls.mockRestore();
    }
  });

  it("are fingerprinted by the blueprints the install writes, which an isolate never has to load", async () => {
    const { blueprints } = await loadBuiltinRelease();
    expect([
      blueprints.length > 0,
      await sha256Hex(blueprintsDigestText(blueprints)),
    ]).toStrictEqual([true, thisRelease.blueprintsDigest]);
  });

  it("aren't asked for by a request once the isolate's install is done", async () => {
    const calls = vi.spyOn(env.BUILTINS, "getByName");
    try {
      await request();
      expect(calls).not.toHaveBeenCalled();
    } finally {
      calls.mockRestore();
    }
  });

  it("write nothing when the release is installed already", async () => {
    await forgetInstall(...firstNames(1));
    await expect(
      builtins(env).ensureInstalled(await thisFingerprint())
    ).resolves.toBeTruthy();

    const events = await auditedDuring(async () => {
      await expect(
        builtins(env).ensureInstalled(await thisFingerprint())
      ).resolves.toBeTruthy();
    });
    expect(skillsWritten(events)).toStrictEqual([]);
    await expect(storedSkills()).resolves.toStrictEqual(releaseSkills());
  });

  it("are installed once for callers arriving together, who all see it done", async () => {
    await forgetInstall(...firstNames(1));

    const events = await auditedDuring(async () => {
      await expect(
        Promise.all([
          builtins(env).ensureInstalled(await thisFingerprint()),
          builtins(env).ensureInstalled(await thisFingerprint()),
          builtins(env).ensureInstalled(await thisFingerprint()),
        ])
      ).resolves.toStrictEqual([true, true, true]);
    });
    // One install, writing the one skill another release had changed.
    expect(skillsWritten(events)).toStrictEqual([1]);
    await expect(storedSkills()).resolves.toStrictEqual(releaseSkills());
  });

  it("aren't recorded as installed after a partial install, and the next install writes only what's missing", async () => {
    const names = firstNames(2);
    await forgetInstall(...names);

    const [first = ""] = names;
    const partial = await withBrainFailingOnce(
      first,
      async () =>
        await runInDurableObject(
          builtins(env),
          async (_instance, state) =>
            await installBuiltins(
              env,
              state.storage,
              await loadBuiltinRelease()
            )
        )
    );
    // The first skill failed and the second was written, but nothing is
    // recorded as installed.
    const afterPartial = await storedSkills();
    expect([
      partial,
      await installed(),
      ...names.map((name) => afterPartial[name] === releaseSkills()[name]),
    ]).toStrictEqual([false, undefined, false, true]);

    const events = await auditedDuring(async () => {
      await expect(
        builtins(env).ensureInstalled(await thisFingerprint())
      ).resolves.toBeTruthy();
    });
    expect(skillsWritten(events)).toStrictEqual([1]);
    await expect(storedSkills()).resolves.toStrictEqual(releaseSkills());
    await expect(installed()).resolves.toStrictEqual(expect.any(String));
  });

  it("install every contract the release ships with connect not there, as core boots on plain workerd", async () => {
    await forgetInstall();
    // Connect not up yet, or, as in core's on-prem smoke run, not there:
    // anything asked of it fails.
    const connectless: Env = {
      ...env,
      CONNECT: new Proxy(env.CONNECT, {
        get: () => {
          throw new Error("Connect isn't there");
        },
      }),
    };
    const logged = vi.spyOn(console, "error").mockReturnValue();
    let complete: boolean;
    let failures: string[];
    try {
      complete = await runInDurableObject(
        builtins(env),
        async (_instance, state) =>
          await installBuiltins(
            connectless,
            state.storage,
            await loadBuiltinRelease()
          )
      );
      // Read before the spy is restored, which forgets its calls.
      failures = logged.mock.calls
        .flat()
        .map((entry) => JSON.stringify(entry))
        .filter((entry) => entry.includes("builtins.contract_failed"));
    } finally {
      logged.mockRestore();
    }
    const stored = await env.DB.prepare(
      `SELECT key FROM workflow_catalog_contracts WHERE key IN (${releaseContracts.map(() => "?").join(", ")}) ORDER BY key`
    )
      .bind(...releaseContracts.map(({ key }) => key))
      .all<{ key: string }>();

    expect({
      complete,
      failures,
      stored: stored.results.map(({ key }) => key),
    }).toStrictEqual({
      complete: true,
      failures: [],
      stored: releaseContracts.map(({ key }) => key).toSorted(),
    });
  });
});
