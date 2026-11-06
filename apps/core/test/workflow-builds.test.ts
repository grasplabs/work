import { isRetryableCode } from "@grasp-os/shared/operations";
import type { Role } from "@grasp-os/shared/roles";
import type { WorkflowResourceVersion } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { Acting } from "../src/auth/identity.ts";
import { sweepReleases } from "../src/release-retention.ts";
import { sandboxCpuHeader } from "../src/sandbox-headers.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  workflowSource,
} from "../src/workflow-resources.ts";
import { racingDb } from "./apps.ts";
import { artifactKey } from "./sealed-apps.ts";
import { outcome, refusal, unique } from "./sign-in.ts";

// Compiling JSON workflows into SDK TypeScript and sealed JavaScript
// (workflow-builds.ts, @grasp-os/workflow-schema's generate.ts), from the
// threat model: definition text never becomes code, the code imports the
// SDK alone, the same program always has the same identity, a build is
// what its version names or nothing, and what the generator doesn't lower
// is said, never approximated.

/** A builder of the organization, as their session has them. */
const builder = async (role: Role = "builder"): Promise<Acting> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return { userId, role, teams: [], staff: false };
};

const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/**
 * A grasp-workflow/1 definition running `steps`, ending with `status`: a
 * plain parameter `greeting` and a sensitive one, `token`.
 */
const definitionOf = (status: unknown, steps: unknown[] = []): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectSchema({ who: { type: "string" } }),
    output: {
      schema: objectSchema({ status: { type: "string" } }),
      value: { status },
    },
    params: {
      greeting: {
        kind: "text",
        label: "Greeting",
        default: "Hello",
        sensitive: false,
      },
      token: { kind: "text", label: "Token" },
    },
    steps,
  });

/** A new workflow of `by`'s, published once from `definition`. */
const published = async (by: Acting, definition: string) => {
  const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
  const version = await publishWorkflowVersion(env, by, workflow.id, {
    definition,
    basedOn: null,
  });
  return { workflow, version };
};

/** A step `finish` that ends at once, titled `title` if given. */
const finish = (title?: string) => ({
  id: "finish",
  ...(title === undefined ? {} : { title }),
  type: "raise",
  if: { $expr: 'input.who === ""' },
  error: { type: "urn:grasp:error:nameless", status: 422 },
});

/** A publication refused for `code`, at the output's status. */
const refused = (code: string) => ({
  code: "workflow.definition_invalid",
  details: {
    problems: [{ code, pointer: "/output/value/status/$expr" }],
  },
});

const versionManifest = z.object({
  build: z.object({
    artifacts: z
      .array(
        z.object({ path: z.string(), sha256: z.string(), bytes: z.number() })
      )
      .optional(),
  }),
});

/** The artifacts version `version` of workflow `id` seals, as stored. */
const sealedArtifacts = async (id: string, version: number) => {
  const row = await env.DB.prepare(
    "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = ?"
  )
    .bind(id, version)
    .first<{ manifest: string }>();
  const { build } = versionManifest.parse(JSON.parse(row?.manifest ?? "{}"));
  return build.artifacts ?? [];
};

const generatedPath = ".grasp/workflow.ts";

/** The modules generated code imports. */
const importPattern = /from "(?<module>[^"]+)"/gu;

/** A version's executable identity; empty for one that isn't executable. */
const identityOf = (version: WorkflowResourceVersion): string =>
  version.build.hash;

/** U+2028 and U+2029, which end a line in source but not in a string. */
const lineSeparators = String.fromCodePoint(0x20_28, 0x20_29);

/**
 * Core, with the compiler's isolate as it is when a build takes too long,
 * or its CPU runs out (`build`): the outside system here. Each target core
 * asks it to build goes to `targets`.
 */
const compilerThat = (build: () => Promise<never>, targets: string[]): Env => {
  const compiler = {
    getEntrypoint: () => ({
      build: async (target: string) => {
        targets.push(target);
        return await build();
      },
    }),
  };
  // SAFETY: only what the compiler's start reads of a Loader.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const loader = { get: () => compiler, load: () => compiler } as never;
  return { ...env, BUILD_WAIT_MS: "50", LOADER: loader };
};

/**
 * Core, with the type checker's isolate answering as `check` does: the
 * outside system here, as in `compilerThat`.
 */
const checkerThat = (check: () => Promise<unknown>): Env => {
  const checker = { getEntrypoint: () => ({ check }) };
  // SAFETY: only what the type checker's start reads of a Loader.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const loader = { get: () => checker, load: () => checker } as never;
  return { ...env, BUILD_WAIT_MS: "50", LOADER: loader };
};

describe("JSON workflow builds", () => {
  it("seals SDK TypeScript that runs each step in the definition's order, and exports it", async () => {
    const by = await builder();
    const { workflow, version } = await published(
      by,
      definitionOf({ $expr: "params.greeting" }, [
        { id: "pause", type: "wait", for: "1 hour" },
        {
          id: "late",
          type: "raise",
          if: { $expr: 'input.who === ""' },
          error: { type: "urn:grasp:error:nameless", status: 422 },
        },
      ])
    );
    expect(identityOf(version)).toMatch(/^[0-9a-f]{64}$/u);
    const { files } = await workflowSource(env, by, workflow.id, 1);
    const source = files[generatedPath] ?? "";
    // Real statements, one per step, in order: not the definition handed
    // to an interpreter.
    const places = ['step.sleep("pause"', '"late"'].map((statement) =>
      source.indexOf(statement)
    );
    expect({
      inOrder: places.every(
        (place, index) => place > 0 && place > (places[index - 1] ?? 0)
      ),
      // The workflow SDK alone.
      imports: [
        ...new Set(
          [...source.matchAll(importPattern)].map(
            (match) => match.groups?.module
          )
        ),
      ],
    }).toStrictEqual({
      inOrder: true,
      imports: ["@grasp-os/sdk/workflow"],
    });
    // What runs is sealed with it: the compiled module and the SDK too.
    const artifacts = await sealedArtifacts(workflow.id, 1);
    expect(artifacts.map(({ path }) => path)).toStrictEqual(
      expect.arrayContaining([
        "source/workflow.json",
        generatedPath,
        "tasks.json",
        "source-map.json",
      ])
    );
  });

  it("writes the definition's text into the code only as literals", async () => {
    const by = await builder();
    const hostile = [
      '"); globalThis.escaped = true; ("',
      `\`\${globalThis}\` */ // \\ ${lineSeparators} </script>`,
      "{ $expr: looks like an expression, but isn't one }x",
    ];
    const { workflow, version } = await published(
      by,
      JSON.stringify({
        $schema: workflowSchemaUrl,
        output: {
          schema: objectSchema({
            status: { type: "string" },
            [hostile[0] ?? ""]: { type: "array", items: { type: "string" } },
          }),
          value: { status: "done", [hostile[0] ?? ""]: hostile },
        },
        steps: [],
      })
    );
    const { files } = await workflowSource(env, by, workflow.id, 1);
    const source = files[generatedPath] ?? "";
    expect({
      // It type-checked and compiled: nothing in it broke out of a literal.
      executable: version.build.hash !== undefined,
      literals: hostile.every((text) => source.includes(JSON.stringify(text))),
    }).toStrictEqual({ executable: true, literals: true });
  });

  it("gives definitions that lower to the same program one executable identity", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
    const publish = async (basedOn: number | null, steps: unknown[]) =>
      await publishWorkflowVersion(env, by, workflow.id, {
        definition: definitionOf({ $expr: "params.greeting" }, steps),
        basedOn,
      });
    const first = await publish(null, [finish()]);
    // A title changes no program.
    const relabelled = await publish(1, [finish("Finish up")]);
    const changed = await publish(2, [
      { ...finish(), if: { $expr: 'input.who === "nobody"' } },
    ]);
    expect(identityOf(first)).not.toBe("");
    expect(identityOf(relabelled)).toBe(identityOf(first));
    expect(identityOf(changed)).not.toBe(identityOf(first));
    // Each is still its own version, its manifest its own.
    expect(relabelled.manifestHash).not.toBe(first.manifestHash);
  });

  it("refuses a build whose sealed bytes changed in storage", async () => {
    const by = await builder();
    const { workflow } = await published(by, definitionOf("done"));
    const artifacts = await sealedArtifacts(workflow.id, 1);
    const generated = artifacts.find(({ path }) => path === generatedPath);
    await env.FILES.put(
      artifactKey(generated?.sha256 ?? ""),
      "export default null;"
    );
    await expect(
      outcome(workflowSource(env, by, workflow.id, 1))
    ).resolves.toBe("workflow.version_corrupt");
  });

  it("answers the next load of a build whose first load was cancelled mid-read", async () => {
    const by = await builder();
    const { workflow } = await published(by, definitionOf("done"));
    // R2 that never answers a read: as the first load's request was
    // cancelled while it read, which workerd never settles.
    const reading = Promise.withResolvers<boolean>();
    const stuck = new Proxy(env.FILES, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "get") {
          return async (): Promise<never> => {
            reading.resolve(true);
            return await Promise.withResolvers<never>().promise;
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const bounded = { ...env, WORKFLOW_BUILD_READ_MS: "50" };
    // Never awaited: it never answers.
    const cancelled = loadWorkflowBuild(
      { ...bounded, FILES: stuck },
      workflow.id,
      1
    );
    await reading.promise;

    const next = await Promise.race([
      loadWorkflowBuild(bounded, workflow.id, 1),
      scheduler.wait(5000).then(() => "still waiting" as const),
    ]);

    const artifacts = await sealedArtifacts(workflow.id, 1);
    const generated = artifacts.find(({ path }) => path === generatedPath);
    const sealed = await env.FILES.get(artifactKey(generated?.sha256 ?? ""));
    expect(next === "still waiting" ? next : next.source).toBe(
      await sealed?.text()
    );
    await expect(
      Promise.race([cancelled, Promise.resolve("never answers")])
    ).resolves.toBe("never answers");
  });

  it("verifies a build anew after a load of it failed, keeping no failure", async () => {
    const by = await builder();
    const { workflow, version } = await published(by, definitionOf("done"));
    const artifacts = await sealedArtifacts(workflow.id, 1);
    const generated = artifacts.find(({ path }) => path === generatedPath);
    const key = artifactKey(generated?.sha256 ?? "");
    const stored = await env.FILES.get(key);
    const text = (await stored?.text()) ?? "";
    await env.FILES.delete(key);
    const failed = await outcome(loadWorkflowBuild(env, workflow.id, 1));
    await env.FILES.put(key, text);

    const loaded = await loadWorkflowBuild(env, workflow.id, 1);

    expect({
      failed,
      hash: loaded.hash,
      source: loaded.source,
      modules: Object.keys(loaded.modules).length > 0,
      tasks: loaded.tasks.length,
    }).toStrictEqual({
      failed: "workflow.version_corrupt",
      hash: identityOf(version),
      source: text,
      modules: true,
      tasks: 0,
    });
  });

  it("keeps a version's build through the release retention sweep", async () => {
    const by = await builder();
    const { workflow } = await published(by, definitionOf("done"));
    const year = 365 * 86_400_000;
    // Well past every grace: a reservation no release keeps would go.
    await sweepReleases(env, new Date(Date.now() + year));
    await sweepReleases(env, new Date(Date.now() + 2 * year));
    const artifacts = await sealedArtifacts(workflow.id, 1);
    const heads = await Promise.all(
      artifacts.map(
        async ({ sha256 }) => await env.FILES.head(artifactKey(sha256))
      )
    );
    expect(heads.every((head) => head !== null)).toBeTruthy();
    const { files } = await workflowSource(env, by, workflow.id, 1);
    expect(files[generatedPath]).toContain("@grasp-os/sdk/workflow");
  });

  it("refuses an expression that reads a sensitive parameter, or all of them", async () => {
    const by = await builder();
    const problemsOf = async (status: string) => {
      const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
      const error = await refusal(
        publishWorkflowVersion(env, by, workflow.id, {
          definition: definitionOf({ $expr: status }),
          basedOn: null,
        })
      );
      return z
        .object({
          code: z.string(),
          details: z.object({
            problems: z.array(
              z.object({ code: z.string(), pointer: z.string() })
            ),
          }),
        })
        .parse(error);
    };
    await expect(problemsOf("params.token")).resolves.toMatchObject(
      refused("workflow.sensitive")
    );
    await expect(problemsOf('params["to" + "ken"]')).resolves.toMatchObject(
      refused("expression.computed-key")
    );
    // Text that only looks like a read reads nothing.
    const quoted = await createWorkflowResource(env, by, `w-${unique()}`);
    await expect(
      publishWorkflowVersion(env, by, quoted.id, {
        definition: definitionOf("params.token"),
        basedOn: null,
      })
    ).resolves.toMatchObject({ version: 1 });
  });

  it("refuses a publication whose build outlasts the build wait, or dies, as one to try again", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
    const request = () => ({
      definition: definitionOf(`late ${unique()}`),
      basedOn: null,
    });
    const hungTargets: string[] = [];
    const diedTargets: string[] = [];
    const hung = compilerThat(
      async () =>
        // oxlint-disable-next-line promise/avoid-new -- a build that never answers
        await new Promise<never>(() => {
          // Never answers.
        }),
      hungTargets
    );
    const died = compilerThat(async () => {
      await Promise.resolve();
      throw new Error("Worker exceeded CPU time limit.");
    }, diedTargets);
    const late = await outcome(
      publishWorkflowVersion(hung, by, workflow.id, request())
    );
    const killed = await outcome(
      publishWorkflowVersion(died, by, workflow.id, request())
    );
    const saved = await publishWorkflowVersion(env, by, workflow.id, request());
    expect({
      late,
      killed,
      // Each reached the compiler, as a JSON workflow's build.
      targets: [...new Set([...hungTargets, ...diedTargets])],
      bothReached: hungTargets.length > 0 && diedTargets.length > 0,
      retryable: isRetryableCode("workflow.build_slow"),
      published: saved.version,
    }).toStrictEqual({
      late: "workflow.build_slow",
      killed: "workflow.build_slow",
      targets: ["generated-workflow"],
      bothReached: true,
      retryable: true,
      published: 1,
    });
  });

  it("refuses a publication whose expression check outlasts the build wait, dies or crashes, as one to try again, and keeps none of it", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
    // A read the type check takes, unique so no earlier check answers it.
    const request = (name: string) => ({
      definition: definitionOf({ $expr: `input.who + '${name}'` }),
      basedOn: null,
    });
    const hung = checkerThat(
      async () =>
        // oxlint-disable-next-line promise/avoid-new -- a check that never answers
        await new Promise<never>(() => {
          // Never answers.
        })
    );
    const died = checkerThat(async () => {
      await Promise.resolve();
      throw new Error("Worker exceeded CPU time limit.");
    });
    // tsrs failing to run: the check as a whole refused (type-check.ts).
    const crashed = checkerThat(
      async () =>
        await Promise.resolve([
          { rule: "check", severity: "error", message: "tsrs crashed." },
        ])
    );
    const [lateName, killedName, crashedName] = [unique(), unique(), unique()];
    const late = await outcome(
      publishWorkflowVersion(hung, by, workflow.id, request(lateName))
    );
    const killed = await outcome(
      publishWorkflowVersion(died, by, workflow.id, request(killedName))
    );
    const crash = await outcome(
      publishWorkflowVersion(crashed, by, workflow.id, request(crashedName))
    );
    // The same expressions, checked again: nothing of the crash was kept.
    const saved = await publishWorkflowVersion(
      env,
      by,
      workflow.id,
      request(crashedName)
    );
    expect({ late, killed, crash, published: saved.version }).toStrictEqual({
      late: "workflow.build_slow",
      killed: "workflow.build_slow",
      crash: "workflow.build_slow",
      published: 1,
    });
  });

  it("never caches a build the sandbox host stopped: one to try again, never a failed build", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
    const request = {
      definition: definitionOf(`stopped ${unique()}`),
      basedOn: null,
    };
    // A sandbox host whose supervisor stops every call at its CPU bound.
    const stopping: Fetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const sent = new Request(input, init);
        const { pathname } = new URL(sent.url);
        if (pathname === "/session") {
          const [client, server] = Object.values(new WebSocketPair());
          server?.accept();
          setTimeout(() => {
            server?.close(1011, "Stopped");
          }, 10);
          return await Promise.resolve(
            new Response(null, {
              status: 101,
              webSocket: client ?? null,
              headers: {
                [sandboxCpuHeader]: sent.headers.get(sandboxCpuHeader) ?? "",
              },
            })
          );
        }
        if (pathname.startsWith("/verdict/")) {
          return Response.json({
            verdict: "cpu",
            message: "It ran out of CPU time.",
          });
        }
        return new Response(null, { status: 404 });
      },
      connect: () => {
        throw new Error("No sockets here");
      },
    };
    const stopped = await outcome(
      publishWorkflowVersion(
        { ...env, SANDBOX_HOST: stopping },
        by,
        workflow.id,
        request
      )
    );
    // The same module, built again: nothing of the stop was kept.
    const saved = await publishWorkflowVersion(env, by, workflow.id, request);
    expect({
      stopped,
      executable: saved.build.hash !== undefined,
    }).toStrictEqual({
      stopped: "workflow.build_slow",
      executable: true,
    });
  });

  it("gives back what a publication that lost its race reserved, but what the winner names", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
    const raced: Env = {
      ...env,
      DB: racingDb(async () => {
        await publishWorkflowVersion(env, by, workflow.id, {
          definition: definitionOf("winner"),
          basedOn: null,
        });
      }, /insert into "workflow_resource_versions"/iu),
    };
    const lost = await outcome(
      publishWorkflowVersion(raced, by, workflow.id, {
        definition: definitionOf("loser"),
        basedOn: null,
      })
    );
    const reserved = await env.DB.prepare(
      "SELECT sha256 FROM sdk_release_artifacts WHERE app_id = ? ORDER BY sha256"
    )
      .bind(workflow.id)
      .all<{ sha256: string }>();
    const named = await sealedArtifacts(workflow.id, 1);
    expect({
      lost,
      reserved: reserved.results.map(({ sha256 }) => sha256),
    }).toStrictEqual({
      lost: "workflow.version_conflict",
      reserved: [...new Set(named.map(({ sha256 }) => sha256))].toSorted(),
    });
  });

  it("gives back only its own reservations when its upload fails as another publication of the version goes on", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
    // Sealed artifacts fail to store for this publication alone.
    const failingFiles = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            if (args[0].startsWith(artifactKey(""))) {
              throw new Error("The bucket is unavailable");
            }
            return await target.put(...args);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...rest: unknown[]): unknown => Reflect.apply(value, target, rest)
          : value;
      },
    });
    const failure: { code: unknown } = { code: undefined };
    // The other publication of version 1 fails, and cleans up, just before
    // this one's row is written.
    const raced: Env = {
      ...env,
      DB: racingDb(async () => {
        failure.code = await outcome(
          publishWorkflowVersion(
            { ...env, FILES: failingFiles },
            by,
            workflow.id,
            {
              definition: definitionOf("failing"),
              basedOn: null,
            }
          )
        );
      }, /insert into "workflow_resource_versions"/iu),
    };
    const saved = await outcome(
      publishWorkflowVersion(raced, by, workflow.id, {
        definition: definitionOf("healthy"),
        basedOn: null,
      })
    );
    const reserved = await env.DB.prepare(
      "SELECT DISTINCT sha256 FROM sdk_release_artifacts WHERE app_id = ? ORDER BY sha256"
    )
      .bind(workflow.id)
      .all<{ sha256: string }>();
    const named = await sealedArtifacts(workflow.id, 1);
    expect({
      failed: failure.code === "ok",
      saved,
      reserved: reserved.results.map(({ sha256 }) => sha256),
    }).toStrictEqual({
      failed: false,
      saved: "ok",
      reserved: [...new Set(named.map(({ sha256 }) => sha256))].toSorted(),
    });
  });

  it("gives nothing back until every upload of a build has settled, one failing first", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
    const uploads = { failed: false, running: 0, runningAtEnd: -1 };
    // The first sealed artifact fails at once; the others take a while.
    const files = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            if (!args[0].startsWith(artifactKey(""))) {
              return await target.put(...args);
            }
            if (!uploads.failed) {
              uploads.failed = true;
              throw new Error("The bucket is unavailable");
            }
            uploads.running += 1;
            await scheduler.wait(300);
            const put = await target.put(...args);
            uploads.running -= 1;
            return put;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...rest: unknown[]): unknown => Reflect.apply(value, target, rest)
          : value;
      },
    });
    const failed = await outcome(
      publishWorkflowVersion({ ...env, FILES: files }, by, workflow.id, {
        definition: definitionOf("first"),
        basedOn: null,
      })
    );
    uploads.runningAtEnd = uploads.running;
    expect({
      failed: failed === "ok",
      runningAtEnd: uploads.runningAtEnd,
    }).toStrictEqual({ failed: false, runningAtEnd: 0 });
  });

  it("gives back what a publication reserved when storing its bytes fails, so only a saved version's stay reserved", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
    const failingFiles = new Proxy(env.FILES, {
      get: (target, property) => {
        // A sealed artifact's bytes alone fail to store; the build cache
        // stores as ever.
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            if (args[0].startsWith(artifactKey(""))) {
              throw new Error("The bucket is unavailable");
            }
            return await target.put(...args);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...rest: unknown[]): unknown => Reflect.apply(value, target, rest)
          : value;
      },
    });
    const failed = await outcome(
      publishWorkflowVersion({ ...env, FILES: failingFiles }, by, workflow.id, {
        definition: definitionOf("first"),
        basedOn: null,
      })
    );
    // The number goes to another publication, of other content.
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf("second"),
      basedOn: null,
    });
    const reserved = await env.DB.prepare(
      "SELECT sha256 FROM sdk_release_artifacts WHERE app_id = ? ORDER BY sha256"
    )
      .bind(workflow.id)
      .all<{ sha256: string }>();
    const named = await sealedArtifacts(workflow.id, 1);
    expect({
      failed: failed === "ok",
      reserved: reserved.results.map(({ sha256 }) => sha256),
    }).toStrictEqual({
      failed: false,
      reserved: [...new Set(named.map(({ sha256 }) => sha256))].toSorted(),
    });
  });
});
