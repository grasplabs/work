/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import { isRetryableCode } from "@grasp-os/shared/operations";
import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceVersion } from "@grasp-os/shared/workflow-resources";
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
  workflowVersions,
} from "../src/workflow-resources.ts";
import { racingDb } from "./apps.ts";
import { artifactKey } from "./sealed-apps.ts";
import { outcome, refusal, unique } from "./sign-in.ts";

// Compiling JSON workflows into SDK TypeScript and sealed JavaScript
// (workflow-builds.ts, @grasp-os/open-workflow's generate.ts), from the
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
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A grasp-open-workflow/1 definition of `name` running `tasks`. */
const definitionOf = (
  name: string,
  tasks: unknown[],
  { version = "1.0.0", more = {} }: { version?: string; more?: object } = {}
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version,
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {
            greeting: {
              schema: { type: "string", maxLength: 200 },
              label: "Greeting",
              default: "Hello",
              sensitive: false,
            },
            token: {
              schema: { type: "string", maxLength: 64 },
              label: "Token",
              default: "none",
              sensitive: true,
            },
          },
          bindings: {},
        },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
    ...more,
  });

/** A new workflow of `by`'s, with `definition`'s name, published once. */
const published = async (by: Acting, definition: (name: string) => string) => {
  const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
  const version = await publishWorkflowVersion(env, by, workflow.id, {
    definition: definition(workflow.name),
    basedOn: null,
  });
  return { workflow, version };
};

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
  version.build.executable ? version.build.hash : "";

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

describe("JSON workflow builds", () => {
  it("seals SDK TypeScript that runs each task in the definition's order, and exports it", async () => {
    const by = await builder();
    const tasks = [
      { greet: { set: { status: "${ $params.greeting }" } } },
      { pause: { wait: "PT1H" } },
      { finish: { set: { status: "done" } } },
    ];
    let definition = "";
    const { workflow, version } = await published(by, (name) => {
      definition = definitionOf(name, tasks);
      return definition;
    });
    expect(identityOf(version)).toMatch(/^[0-9a-f]{64}$/u);
    const { files } = await workflowSource(env, by, workflow.id, 1);
    const source = files[generatedPath] ?? "";
    // Real statements, one per task, in order: not the definition handed
    // to an interpreter.
    const places = [
      'flow.set("greet"',
      'flow.wait("pause", 3600000)',
      'flow.set("finish"',
    ].map((statement) => source.indexOf(statement));
    expect({
      definition: files["workflow.json"],
      inOrder: places.every(
        (place, index) => place > 0 && place > (places[index - 1] ?? 0)
      ),
      // The SDK alone, and every expression by its number, never its source.
      imports: [
        ...new Set(
          [...source.matchAll(importPattern)].map(
            (match) => match.groups?.module
          )
        ),
      ],
      evaluates: source.includes("await task.evaluate(0)"),
      holdsSource: source.includes("$params"),
    }).toStrictEqual({
      definition,
      inOrder: true,
      imports: ["@grasp-os/sdk/open-workflow"],
      evaluates: true,
      holdsSource: false,
    });
    // What runs is sealed with it: the compiled module and the SDK too.
    const artifacts = await sealedArtifacts(workflow.id, 1);
    expect(artifacts.map(({ path }) => path)).toStrictEqual(
      expect.arrayContaining([
        "source/workflow.json",
        generatedPath,
        "modules/app~.grasp~workflow.js",
        "tasks.json",
        "source-map.json",
        "sdk/@grasp-os~sdk~open-workflow.js",
      ])
    );
  });

  it("writes the definition's text into the code only as literals", async () => {
    const by = await builder();
    const hostile = [
      '"); globalThis.escaped = true; ("',
      `\`\${globalThis}\` */ // \\ ${lineSeparators} </script>`,
      "${ looks like an expression, but isn't one }x",
    ];
    const { workflow, version } = await published(by, (name) =>
      definitionOf(name, [
        {
          finish: {
            set: {
              status: "done",
              [hostile[0] ?? ""]: hostile,
              toString: { "*/": [hostile[1] ?? "", 1.5, -2, null, true] },
            },
          },
        },
      ])
    );
    const { files } = await workflowSource(env, by, workflow.id, 1);
    const source = files[generatedPath] ?? "";
    expect({
      // It type-checked and compiled: nothing in it broke out of a literal.
      executable: version.build.executable,
      literals: hostile.every((text) => source.includes(JSON.stringify(text))),
      // Every key is a computed property: a key such as `toString` can't
      // mean anything but a key.
      computedKeys: source.includes('["toString"]:'),
      evaluates: source.includes("evaluate("),
    }).toStrictEqual({
      executable: true,
      literals: true,
      computedKeys: true,
      evaluates: false,
    });
  });

  it("gives definitions that lower to the same program one executable identity", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
    const publish = async (
      version: string,
      basedOn: number | null,
      tasks: unknown[]
    ) =>
      await publishWorkflowVersion(env, by, workflow.id, {
        definition: definitionOf(workflow.name, tasks, { version }),
        basedOn,
      });
    const first = await publish("1.0.0", null, [
      { finish: { set: { status: "${ $params.greeting }" } } },
    ]);
    // Labels and layout change no program.
    const relabelled = await publish("1.0.1", 1, [
      {
        finish: {
          set: { status: "${ $params.greeting }" },
          metadata: {
            grasp: { label: "Finish up", position: { x: 40, y: 80 } },
          },
        },
      },
    ]);
    const changed = await publish("1.0.2", 2, [
      { finish: { set: { status: "${ $params.greeting | ascii_upcase }" } } },
    ]);
    expect(identityOf(first)).not.toBe("");
    expect(identityOf(relabelled)).toBe(identityOf(first));
    expect(identityOf(changed)).not.toBe(identityOf(first));
    // Each is still its own version, its manifest its own.
    expect(relabelled.manifestHash).not.toBe(first.manifestHash);
  });

  it("publishes what the generator doesn't lower without a build, naming each construct", async () => {
    const by = await builder();
    const { workflow, version } = await published(by, (name) =>
      definitionOf(
        name,
        [
          {
            // A nested list's timeout would bound more than one attempt.
            check: {
              do: [{ inner: { set: { status: "checking" } } }],
              timeout: { after: { seconds: 5 } },
              then: "finish",
            },
          },
          {
            // A reusable retry policy's conditions had no error in scope.
            guard: {
              try: [{ attempt: { set: { status: "trying" } } }],
              catch: { retry: "transient" },
            },
          },
          { finish: { set: { status: "done" } } },
        ],
        {
          more: {
            timeout: { after: { minutes: 5 } },
            use: {
              retries: {
                transient: {
                  when: "${ true }",
                  limit: { attempt: { count: 2 } },
                },
              },
            },
          },
        }
      )
    );
    expect(version.build.executable).toBeFalsy();
    expect(
      version.build.executable ? [] : version.build.unsupported
    ).toStrictEqual([
      { pointer: "/timeout", taskId: null, feature: "timeout" },
      {
        pointer: "/do/0/check/timeout",
        taskId: "check",
        feature: "timeout:do",
      },
      {
        pointer: "/do/1/guard/catch/retry",
        taskId: "guard",
        feature: "use.retries:when",
      },
    ]);
    // Nothing generated, nothing sealed: the export is the definition alone.
    const { files } = await workflowSource(env, by, workflow.id, 1);
    expect(Object.keys(files)).toStrictEqual(["workflow.json"]);
    await expect(sealedArtifacts(workflow.id, 1)).resolves.toStrictEqual([]);
  });

  it("refuses a build whose sealed bytes changed in storage", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done" } } }])
    );
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
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done" } } }])
    );
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
    const { workflow, version } = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done" } } }])
    );
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
      tasks: 1,
    });
  });

  it("keeps a version's build through the release retention sweep", async () => {
    const by = await builder();
    const { workflow } = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done" } } }])
    );
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
    expect(files[generatedPath]).toContain('flow.set("finish"');
  });

  it("doesn't lower a task with more expressions than core evaluates in one", async () => {
    const by = await builder();
    const wide = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `field${index}`,
        "${ $params.greeting }",
      ])
    );
    const { version } = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { status: "done", ...wide } } }])
    );
    expect(
      version.build.executable ? [] : version.build.unsupported
    ).toStrictEqual([
      {
        pointer: "/do/0/finish/set",
        taskId: "finish",
        feature: "set:expressions",
      },
    ]);
  });

  it("lowers nothing at a pointer too long to seal, and names where", async () => {
    const by = await builder();
    const key = "k".repeat(2100);
    const { workflow, version } = await published(by, (name) =>
      definitionOf(name, [{ finish: { set: { [key]: "${ . }" } } }])
    );
    // Listed again from its stored manifest: nothing of it is corrupt.
    const [listed] = await workflowVersions(env, by, workflow.id);
    expect({
      published: version.build,
      listed: listed?.build,
    }).toStrictEqual({
      published: {
        executable: false,
        unsupported: [
          {
            pointer: "/do/0/finish/set",
            taskId: "finish",
            feature: "pointer:too_long",
          },
        ],
      },
      listed: version.build,
    });
  });

  it("refuses an expression that reads a sensitive parameter, or all of them", async () => {
    const by = await builder();
    const problemsOf = async (status: string) => {
      const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
      const error = await refusal(
        publishWorkflowVersion(env, by, workflow.id, {
          definition: definitionOf(workflow.name, [
            { finish: { set: { status } } },
          ]),
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
    const expected = {
      code: "workflow.definition_invalid",
      details: {
        problems: [
          {
            code: "expression.sensitive_param",
            pointer: "/do/0/finish/set/status",
          },
        ],
      },
    };
    await expect(problemsOf("${ $params.token }")).resolves.toMatchObject(
      expected
    );
    await expect(
      problemsOf('${ $params["to" + "ken"] }')
    ).resolves.toMatchObject(expected);
    // Text that only looks like a read reads nothing.
    const quoted = await createWorkflowResource(env, by, `w-${unique()}`);
    await expect(
      publishWorkflowVersion(env, by, quoted.id, {
        definition: definitionOf(quoted.name, [
          { finish: { set: { status: '${ "$params.token" }' } } },
        ]),
        basedOn: null,
      })
    ).resolves.toMatchObject({ version: 1 });
  });

  it("refuses a publication whose build outlasts the build wait, or dies, as one to try again", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
    const request = (version: string) => ({
      definition: definitionOf(
        workflow.name,
        [{ finish: { set: { status: `late ${unique()}` } } }],
        { version }
      ),
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
      publishWorkflowVersion(hung, by, workflow.id, request("1.0.0"))
    );
    const killed = await outcome(
      publishWorkflowVersion(died, by, workflow.id, request("1.0.0"))
    );
    const saved = await publishWorkflowVersion(
      env,
      by,
      workflow.id,
      request("1.0.0")
    );
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
      targets: ["open-workflow"],
      bothReached: true,
      retryable: true,
      published: 1,
    });
  });

  it("never caches a build the sandbox host stopped: one to try again, never a failed build", async () => {
    const by = await builder();
    const workflow = await createWorkflowResource(env, by, `w-${unique()}`);
    const request = {
      definition: definitionOf(workflow.name, [
        { finish: { set: { status: `stopped ${unique()}` } } },
      ]),
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
    expect({ stopped, executable: saved.build.executable }).toStrictEqual({
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
          definition: definitionOf(
            workflow.name,
            [{ finish: { set: { status: "winner" } } }],
            { version: "1.0.1" }
          ),
          basedOn: null,
        });
      }, /insert into "workflow_resource_versions"/iu),
    };
    const lost = await outcome(
      publishWorkflowVersion(raced, by, workflow.id, {
        definition: definitionOf(workflow.name, [
          { finish: { set: { status: "loser" } } },
        ]),
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
              definition: definitionOf(workflow.name, [
                { finish: { set: { status: "failing" } } },
              ]),
              basedOn: null,
            }
          )
        );
      }, /insert into "workflow_resource_versions"/iu),
    };
    const saved = await outcome(
      publishWorkflowVersion(raced, by, workflow.id, {
        definition: definitionOf(
          workflow.name,
          [{ finish: { set: { status: "healthy" } } }],
          { version: "1.0.1" }
        ),
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
        definition: definitionOf(workflow.name, [
          { finish: { set: { status: "first" } } },
        ]),
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
        definition: definitionOf(workflow.name, [
          { finish: { set: { status: "first" } } },
        ]),
        basedOn: null,
      })
    );
    // The number goes to another publication, of other content.
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: definitionOf(
        workflow.name,
        [{ finish: { set: { status: "second" } } }],
        { version: "1.0.1" }
      ),
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
