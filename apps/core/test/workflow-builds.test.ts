/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceVersion } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { Acting } from "../src/auth/identity.ts";
import { sweepReleases } from "../src/release-retention.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  workflowSource,
} from "../src/workflow-resources.ts";
import { artifactKey } from "./sealed-apps.ts";
import { outcome, unique } from "./sign-in.ts";

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
      'flow.task("greet"',
      'flow.wait("pause", 3600000)',
      'flow.task("finish"',
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
    // A transition, as the profile writes it.
    const check: unknown = JSON.parse(
      '{"check":{"set":{"status":"checking"},"then":"finish"}}'
    );
    const { workflow, version } = await published(by, (name) =>
      definitionOf(
        name,
        [
          check,
          {
            stop: {
              raise: {
                error: {
                  type: "urn:grasp:error:test.stopped",
                  status: 400,
                  title: "Stopped.",
                },
              },
            },
          },
          { finish: { set: { status: "done" } } },
        ],
        {
          more: {
            output: {
              schema: objectSchema({ status: { type: "string" } }),
              as: "${ . }",
            },
          },
        }
      )
    );
    expect(version.build.executable).toBeFalsy();
    expect(
      version.build.executable ? [] : version.build.unsupported
    ).toStrictEqual([
      { pointer: "/output/as", taskId: null, feature: "output.as" },
      { pointer: "/do/0/check/then", taskId: "check", feature: "then" },
      { pointer: "/do/1/stop", taskId: "stop", feature: "raise" },
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
    expect(files[generatedPath]).toContain('flow.task("finish"');
  });
});
