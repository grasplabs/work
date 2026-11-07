import type { AgentProposer } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import type { DependencyRequest } from "@grasp-os/shared/dependencies";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { NpmAdvisories } from "@grasp-os/shared/packages";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { buildPackages } from "../src/packages/build.ts";
import {
  chatPackageRequests,
  decideDependency,
  dependencyStatus,
} from "../src/packages/requests.ts";
import { rescanPackages } from "../src/packages/rescan.ts";
import { resolveDependencies } from "../src/packages/resolve.ts";
import { SandboxUnavailableError } from "../src/sandboxed.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  shareWorkflowResource,
  unshareWorkflowResource,
} from "../src/workflow-resources.ts";
import {
  advise,
  daysAgo,
  failure,
  manifestEntry,
  named,
  osvAnswers,
  plain,
  publish,
  reportToOsv,
  rescannedUntil,
} from "./npm.ts";
import { sandboxStopping } from "./sandbox-stopping.ts";
import { person } from "./sealed-apps.ts";
import { auditedDuring, outcome, unique } from "./sign-in.ts";

// npm packages, from the threat model on GRA-1636: the agent asks and
// never approves; only the App's or workflow's builder decides, in their
// own session, on exactly the graph they were shown; known malware is
// refused at every step; a lookalike name is shown to the builder; a
// build reaches only the lock's own packages, at its integrity, and
// nothing outside them; and the clock revokes what is later reported as
// malware and tells builders of new advisories. Each test is an attack
// or a failure, and each fails when its check is taken away.

/** A workflow of a new builder's: whose packages these tests ask for. */
const workflowOfBuilder = async () => {
  const builder = await person("builder");
  const workflow = await createWorkflowResource(env, builder, `p-${unique()}`);
  return { builder, workflow: workflow.id };
};

/** `by`'s request for workflow `workflow`'s `dependencies`. */
const asked = async (
  by: Acting,
  workflow: string,
  dependencies: Record<string, string>,
  entries?: string[]
): Promise<DependencyRequest> =>
  await resolveDependencies(env, by, {
    workflow,
    purpose: "Double the quarter's total.",
    dependencies: Object.entries(dependencies).map(([name, range]) => ({
      name,
      range,
    })),
    ...(entries === undefined ? {} : { entries }),
  });

/** `by`'s request taking `names` out of workflow `workflow`'s packages. */
const removing = async (
  by: Acting,
  workflow: string,
  names: string[]
): Promise<DependencyRequest> =>
  await resolveDependencies(env, by, {
    workflow,
    purpose: "No longer needed.",
    dependencies: [],
    remove: names,
  });

/** What building workflow `workflow`'s graph `graphHash` comes to. */
const builds = async (by: Acting, workflow: string, graphHash: string) =>
  await outcome(
    buildPackages(
      env,
      actorOf(by),
      { type: "workflow", id: workflow },
      graphHash,
      "worker"
    )
  );

/** `by`'s decision on `request`, on the graph it shows. */
const decided = async (
  by: Acting,
  request: Pick<DependencyRequest, "id" | "graphHash">,
  approved = true
) =>
  await decideDependency(env, by, request.id, {
    approved,
    graphHash: request.graphHash,
  });

/** The request waiting for `workflow`'s builders, if any. */
const pendingOf = async (by: Acting, workflow: string) => {
  const { pending } = await dependencyStatus(env, by, { workflow });
  return pending?.id ?? null;
};

/** The approval `workflow`'s builders gave last, if any. */
const approvedOf = async (by: Acting, workflow: string) => {
  const { approved } = await dependencyStatus(env, by, { workflow });
  return approved?.id ?? null;
};

/** A package `name` that was published three days ago and more. */
const published = async (base = "dates"): Promise<string> => {
  const name = named(base);
  await publish(plain(name, "1.0.0"));
  return name;
};

/** A workflow of a new builder's whose `name` is asked for and approved. */
const approvedPackage = async (name: string, entries?: string[]) => {
  const { builder, workflow } = await workflowOfBuilder();
  const request = await asked(builder, workflow, { [name]: "^1.0.0" }, entries);
  await decided(builder, request);
  return { builder, workflow, request };
};

/** The chat's agent, acting for `by` in their chat `chatId`. */
const agentFor = (by: Acting, chatId: string): Acting => {
  const via: AgentProposer = {
    type: "agent",
    agentId: "agent-1",
    onBehalfOf: by.userId,
    workspaceId: `workspace-${unique()}`,
    chatId,
  };
  return {
    ...by,
    actor: { type: "agent", agentId: "agent-1", onBehalfOf: by.userId },
    via,
  };
};

describe("asking for packages", () => {
  it("resolves each dependency to its newest version three days old with an integrity, and proposes it, waiting for a builder", async () => {
    const name = named("dates");
    await publish(plain(name, "1.0.0"));
    await publish({ ...plain(name, "1.1.0"), publishedAt: daysAgo(1) });
    const { builder, workflow } = await workflowOfBuilder();

    const events = await auditedDuring(async () => {
      await asked(builder, workflow, { [name]: "^1.0.0" });
    });
    const status = await dependencyStatus(env, builder, { workflow });

    expect({
      direct: status.pending?.lock.direct,
      approved: status.approved,
      audited: events.map(({ action }) => action),
    }).toStrictEqual({
      direct: { [name]: "1.0.0" },
      approved: null,
      audited: ["dependency.requested"],
    });
  });

  it("refuses sources other than the registry, and someone else's package in the platform's scope", async () => {
    const { builder, workflow } = await workflowOfBuilder();
    const sources: Record<string, string>[] = [
      { a: "github:acme/a" },
      { a: "latest" },
      { a: "npm:other@1" },
      { "@grasp-os/sdk": "^1.0.0" },
    ];
    const codes = await Promise.all(
      sources.map(async (dependencies) => {
        const { code } = await failure(asked(builder, workflow, dependencies));
        return code;
      })
    );

    expect(codes).toStrictEqual(
      Array.from({ length: 4 }, () => "package.unsupported_source")
    );
  });

  it("shows the builder a lookalike name and the registry's advisories", async () => {
    // A popular name under a scope of its own: someone else's react.
    const lookalike = `@acme-${unique()}/react`;
    await publish(plain(lookalike, "1.0.0"));
    const advised = await published();
    await advise(advised, {
      id: 1_000_001,
      url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      title: "Regular expression denial of service",
      severity: "high",
      vulnerable_versions: "<1.2.1",
    });
    const { builder, workflow } = await workflowOfBuilder();

    const request = await asked(builder, workflow, {
      [lookalike]: "^1.0.0",
      [advised]: "^1.0.0",
    });

    expect(
      request.findings.map(({ kind, package: { name } }) => ({ kind, name }))
    ).toStrictEqual([
      { kind: "security", name: advised },
      { kind: "lookalike", name: lookalike },
    ]);
  });

  it("refuses known malware before anything is proposed, audited", async () => {
    const name = await published("evil");
    await reportToOsv(name, "1.0.0", "MAL-2026-40001");
    const { builder, workflow } = await workflowOfBuilder();

    let code = "";
    const events = await auditedDuring(async () => {
      ({ code } = await failure(asked(builder, workflow, { [name]: "1" })));
    });

    expect({
      code,
      audited: events.map(({ action }) => action),
      pending: await pendingOf(builder, workflow),
    }).toStrictEqual({
      code: "dependency.malware",
      audited: ["dependency.malware_refused"],
      pending: null,
    });
  });

  it("keeps one request waiting per workflow: another takes its place, audited", async () => {
    const [first, second] = [await published(), await published()];
    const { builder, workflow } = await workflowOfBuilder();
    const replaced = await asked(builder, workflow, { [first]: "1" });

    const events = await auditedDuring(async () => {
      await asked(builder, workflow, { [second]: "1" });
    });

    expect({
      audited: events.map(({ action }) => action),
      replaced: await outcome(decided(builder, replaced)),
    }).toStrictEqual({
      audited: ["dependency.superseded", "dependency.requested"],
      replaced: "dependency.not_found",
    });
  });
});

describe("deciding packages", () => {
  it("never takes a decision from the chat's agent, though it may ask, and shows its request on the chat's card", async () => {
    const name = await published();
    const { builder, workflow } = await workflowOfBuilder();
    const chatId = chatIdSchema.parse(crypto.randomUUID());
    const agent = agentFor(builder, chatId);
    const request = await asked(agent, workflow, { [name]: "1" });

    const shown = await chatPackageRequests(env, builder.userId, chatId);
    const byAgent = await outcome(decided(agent, request));
    const byBuilder = await outcome(decided(builder, request));

    expect({
      shown: shown.map(({ id }) => id),
      byAgent,
      byBuilder,
      left: await chatPackageRequests(env, builder.userId, chatId),
    }).toStrictEqual({
      shown: [request.id],
      byAgent: "dependency.forbidden",
      byBuilder: "ok",
      left: [],
    });
  });

  it("shows a request on the card of every chat whose agent asked for it", async () => {
    const name = await published();
    const { builder, workflow } = await workflowOfBuilder();
    const [first, second] = [
      chatIdSchema.parse(crypto.randomUUID()),
      chatIdSchema.parse(crypto.randomUUID()),
    ];
    const request = await asked(agentFor(builder, first), workflow, {
      [name]: "1",
    });
    const again = await asked(agentFor(builder, second), workflow, {
      [name]: "1",
    });

    const shownIn = async (chatId: typeof first) => {
      const shown = await chatPackageRequests(env, builder.userId, chatId);
      return shown.map(({ id }) => id);
    };

    expect({
      same: again.id === request.id,
      first: await shownIn(first),
      second: await shownIn(second),
    }).toStrictEqual({ same: true, first: [request.id], second: [request.id] });
  });

  it("takes no decision from a builder whose role was taken away while it was checked for malware", async () => {
    const name = await published();
    const { builder: owner, workflow } = await workflowOfBuilder();
    const other = await person("builder");
    await shareWorkflowResource(env, owner, workflow, {
      type: "person",
      id: other.userId,
      role: "builder",
    });
    const request = await asked(owner, workflow, { [name]: "1" });
    // Unshared as the malware sources are asked, before the decision lands.
    const connect = new Proxy(env.CONNECT, {
      get: (target, key): unknown =>
        key === "npmAdvisories"
          ? async (
              ...args: Parameters<typeof target.npmAdvisories>
            ): Promise<NpmAdvisories> => {
              await unshareWorkflowResource(env, owner, workflow, {
                type: "person",
                id: other.userId,
              });
              const advisories: NpmAdvisories = await target.npmAdvisories(
                ...args
              );
              return advisories;
            }
          : Reflect.get(target, key),
    });

    const decision = await outcome(
      decideDependency({ ...env, CONNECT: connect }, other, request.id, {
        approved: true,
        graphHash: request.graphHash,
      })
    );

    expect({ decision, still: await pendingOf(owner, workflow) }).toStrictEqual(
      { decision: "dependency.not_found", still: request.id }
    );
  });

  it("takes a decision only from a builder of the request's own workflow, never Grasp staff", async () => {
    const name = await published();
    const { builder, workflow } = await workflowOfBuilder();
    const request = await asked(builder, workflow, { [name]: "1" });
    const elsewhere = await workflowOfBuilder();

    expect({
      otherBuilder: await outcome(decided(elsewhere.builder, request)),
      user: await outcome(decided(await person("user"), request)),
      staff: await outcome(decided({ ...builder, staff: true }, request)),
      still: await pendingOf(builder, workflow),
    }).toStrictEqual({
      otherBuilder: "dependency.not_found",
      user: "dependency.not_found",
      staff: "dependency.forbidden",
      still: request.id,
    });
  });

  it("takes one decision, on the graph its builder was shown, never one replayed for another", async () => {
    const [mine, theirs] = [await published(), await published()];
    const { builder, workflow } = await workflowOfBuilder();
    const request = await asked(builder, workflow, { [mine]: "1" });
    const other = await workflowOfBuilder();
    const otherRequest = await asked(other.builder, other.workflow, {
      [theirs]: "1",
    });

    const replayed = await outcome(
      decided(builder, { id: request.id, graphHash: otherRequest.graphHash })
    );
    let first = "";
    const events = await auditedDuring(async () => {
      first = await outcome(decided(builder, request));
    });

    expect({
      replayed,
      first,
      again: await outcome(decided(builder, request, false)),
      audited: events.map(({ action, detail }) => ({
        action,
        selfDecided: detail.selfDecided,
      })),
    }).toStrictEqual({
      replayed: "dependency.stale",
      first: "ok",
      again: "dependency.stale",
      audited: [{ action: "dependency.approved", selfDecided: true }],
    });
  });

  it("refuses to approve known malware reported after it was asked for, audited, and fails closed when it can't be checked", async () => {
    const [reported, unchecked] = [await published(), await published()];
    const { builder, workflow } = await workflowOfBuilder();
    const request = await asked(builder, workflow, { [reported]: "1" });
    await reportToOsv(reported, "1.0.0", "MAL-2026-40002");
    const second = await workflowOfBuilder();
    const uncheckable = await asked(second.builder, second.workflow, {
      [unchecked]: "1",
    });
    await osvAnswers(unchecked, 503);

    const malware = await auditedDuring(async () => {
      await expect(outcome(decided(builder, request))).resolves.toBe(
        "dependency.malware"
      );
    });
    const closed = await outcome(decided(second.builder, uncheckable));
    await osvAnswers(unchecked, null);

    expect({
      audited: malware.map(({ action, detail }) => [action, detail.at]),
      closed,
      still: await pendingOf(builder, workflow),
    }).toStrictEqual({
      audited: [["dependency.malware_refused", "approval"]],
      closed: "package.malware_unchecked",
      still: request.id,
    });
  });
});

describe("one current approval", () => {
  it("lets a removal hold: a graph approved before is no longer built once another replaces it", async () => {
    const [a, b] = [await published("left"), await published("right")];
    const { builder, workflow } = await workflowOfBuilder();
    const first = await asked(builder, workflow, { [a]: "^1.0.0" });
    await decided(builder, first);
    const both = await asked(builder, workflow, { [b]: "^1.0.0" });
    await decided(builder, both);

    const removal = await removing(builder, workflow, [b]);
    const waiting = removal.status;
    await decided(builder, removal);

    expect({
      // The same graph as the first approval, asked for again: a new
      // request, never the replaced approval standing in for it.
      sameGraph: removal.graphHash === first.graphHash,
      waiting,
      current: await approvedOf(builder, workflow),
      onlyA: await builds(builder, workflow, removal.graphHash),
      both: await builds(builder, workflow, both.graphHash),
    }).toStrictEqual({
      sameGraph: true,
      waiting: "pending",
      current: removal.id,
      onlyA: "ok",
      both: "dependency.approval_required",
    });
  });

  it("asks again for a package removed before, never stuck on the approval that had it", async () => {
    const [a, b] = [await published("left"), await published("right")];
    const { builder, workflow } = await workflowOfBuilder();
    const both = await asked(builder, workflow, {
      [a]: "^1.0.0",
      [b]: "^1.0.0",
    });
    await decided(builder, both);
    await decided(builder, await removing(builder, workflow, [b]));

    const again = await asked(builder, workflow, { [b]: "^1.0.0" });
    const waiting = again.status;
    await decided(builder, again);

    expect({
      sameGraph: again.graphHash === both.graphHash,
      waiting,
      current: await approvedOf(builder, workflow),
      built: await builds(builder, workflow, again.graphHash),
    }).toStrictEqual({
      sameGraph: true,
      waiting: "pending",
      current: again.id,
      built: "ok",
    });
  });

  it("falls back on nothing once the current approval is revoked", async () => {
    const [a, b] = [await published("left"), await published("right")];
    const { builder, workflow } = await workflowOfBuilder();
    const first = await asked(builder, workflow, { [a]: "^1.0.0" });
    await decided(builder, first);
    const both = await asked(builder, workflow, { [b]: "^1.0.0" });
    await decided(builder, both);
    await reportToOsv(b, "1.0.0", "MAL-2026-40005");

    await rescannedUntil(both.id, new Date());

    expect({
      current: await approvedOf(builder, workflow),
      before: await builds(builder, workflow, first.graphHash),
      revoked: await builds(builder, workflow, both.graphHash),
    }).toStrictEqual({
      current: null,
      before: "dependency.approval_required",
      revoked: "dependency.revoked",
    });
  });
});

describe("building approved packages", () => {
  it("builds nothing nobody approved", async () => {
    const name = await published();
    const { builder, workflow } = await workflowOfBuilder();
    const request = await asked(builder, workflow, { [name]: "1" });

    await expect(
      outcome(
        buildPackages(
          env,
          actorOf(builder),
          { type: "workflow", id: workflow },
          request.graphHash,
          "worker"
        )
      )
    ).resolves.toBe("dependency.approval_required");
  });

  it("builds each entry of an approved graph into one module, audited as installed", async () => {
    const name = await published();
    const { builder, workflow, request } = await approvedPackage(name);

    let modules: Record<string, string> = {};
    const events = await auditedDuring(async () => {
      ({ modules } = await buildPackages(
        env,
        actorOf(builder),
        { type: "workflow", id: workflow },
        request.graphHash,
        "worker"
      ));
    });

    expect({
      entries: Object.keys(modules),
      exports: modules[name]?.includes(JSON.stringify(name)),
      audited: events.map(({ action }) => action),
    }).toStrictEqual({
      entries: [name],
      exports: true,
      audited: ["dependency.built"],
    });
  });

  it("refuses a tarball that isn't the one the lock's integrity names", async () => {
    const name = named("swapped");
    await publish({
      ...plain(name, "1.0.0"),
      integrity: `sha512-${"C".repeat(86)}==`,
    });
    const { builder, workflow, request } = await approvedPackage(name);

    await expect(
      outcome(
        buildPackages(
          env,
          actorOf(builder),
          { type: "workflow", id: workflow },
          request.graphHash,
          "worker"
        )
      )
    ).resolves.toBe("package.integrity_mismatch");
  });

  it("reaches nothing outside the lock's own packages: no undeclared package, built-in, URL, file outside its own or link", async () => {
    const name = named("escapes");
    const entries = ["undeclared", "builtin", "remote", "climbs", "linked"];
    await publish({
      name,
      version: "1.0.0",
      entries: [
        manifestEntry(name, {
          type: "module",
          exports: Object.fromEntries(
            entries.map((entry) => [`./${entry}`, `./${entry}.js`])
          ),
        }),
        {
          path: "package/undeclared.js",
          content: 'export * from "left-pad";',
        },
        { path: "package/builtin.js", content: 'export * from "node:fs";' },
        {
          path: "package/remote.js",
          content: 'export * from "https://example.com/x.js";',
        },
        { path: "package/climbs.js", content: 'export * from "../../x.js";' },
        { path: "package/linked.js", type: "2", linkname: "/etc/passwd" },
      ],
    });
    const { builder, workflow, request } = await approvedPackage(
      name,
      entries.map((entry) => `${name}/${entry}`)
    );

    const { modules, refused } = await buildPackages(
      env,
      actorOf(builder),
      { type: "workflow", id: workflow },
      request.graphHash,
      "worker"
    );
    const entry = (base: string) => `${name}/${base}`;

    expect({ built: Object.keys(modules), refused }).toStrictEqual({
      built: [],
      refused: {
        [entry("undeclared")]: [
          expect.stringContaining("left-pad, which it doesn't depend on"),
        ],
        [entry("builtin")]: [
          expect.stringContaining("node:fs, which is never fetched"),
        ],
        [entry("remote")]: [
          expect.stringContaining(
            "https://example.com/x.js, which is never fetched"
          ),
        ],
        [entry("climbs")]: [
          expect.stringContaining("../../x.js, which isn't a file of its own"),
        ],
        [entry("linked")]: [
          expect.stringContaining(
            `${entry("linked")}, which ${name}@1.0.0 doesn't export`
          ),
        ],
      },
    });
  });

  it("reaches no package of the graph that isn't one of the importing package's own dependencies", async () => {
    const sibling = await published("sibling");
    const name = named("reaches");
    await publish({
      name,
      version: "1.0.0",
      entries: [
        manifestEntry(name, { type: "module", main: "index.js" }),
        {
          path: "package/index.js",
          content: `export * from ${JSON.stringify(sibling)};`,
        },
      ],
    });
    // Both in the graph, as the App's own: neither depends on the other.
    const { builder, workflow } = await workflowOfBuilder();
    const request = await asked(
      builder,
      workflow,
      { [name]: "^1.0.0", [sibling]: "^1.0.0" },
      [name]
    );
    await decided(builder, request);

    const { modules, refused } = await buildPackages(
      env,
      actorOf(builder),
      { type: "workflow", id: workflow },
      request.graphHash,
      "worker"
    );

    expect({ built: Object.keys(modules), refused }).toStrictEqual({
      built: [],
      refused: {
        [name]: [
          expect.stringContaining(`${sibling}, which it doesn't depend on`),
        ],
      },
    });
  });

  it("builds a package that branches on NODE_ENV for production, with no process left to read", async () => {
    const name = named("modes");
    await publish({
      ...plain(name, "1.0.0"),
      files: {
        "index.js":
          'export const mode = process.env.NODE_ENV === "production" ? "production" : "development";',
      },
    });
    const { builder, workflow, request } = await approvedPackage(name);

    const { modules } = await buildPackages(
      env,
      actorOf(builder),
      { type: "workflow", id: workflow },
      request.graphHash,
      "worker"
    );

    expect(modules[name]?.includes("process")).toBeFalsy();
  });

  it("refuses packages that stopped the builder themselves, and says the sandbox was unavailable when a crash cut it off", async () => {
    const name = await published();
    const { builder, workflow, request } = await approvedPackage(name);
    const build = async (stop: Parameters<typeof sandboxStopping>[0]) =>
      await buildPackages(
        { ...env, SANDBOX_HOST: sandboxStopping(stop).host },
        actorOf(builder),
        { type: "workflow", id: workflow },
        request.graphHash,
        "worker"
      );

    expect({
      memory: await outcome(build({ verdict: "memory" })),
      crashed: await build({ verdict: "crashed" }).then(
        () => "built",
        (error: unknown) => error instanceof SandboxUnavailableError
      ),
    }).toStrictEqual({ memory: "package.refused", crashed: true });
  });
});

/** The notifications of `type` `personId` was given. */
const noticesOf = async (personId: string, type: string) => {
  const { results } = await env.DB.prepare(
    "SELECT package_name AS name, advisory FROM notifications WHERE person_id = ? AND type = ?"
  )
    .bind(personId, type)
    .all<{ name: string; advisory: string }>();
  return results;
};

describe("rescanning approved packages", () => {
  it("revokes what is later reported as malware, audited, tells its builders, and builds none of it again", async () => {
    const name = await published();
    const { builder, workflow, request } = await approvedPackage(name);
    await reportToOsv(name, "1.0.0", "MAL-2026-40003");

    const events = await auditedDuring(async () => {
      await rescannedUntil(request.id, new Date());
    });

    expect({
      audited: events
        .filter(({ detail }) => detail.workflow === workflow)
        .map(({ action }) => action),
      told: await noticesOf(builder.userId, "package_revoked"),
      status: await approvedOf(builder, workflow),
      build: await outcome(
        buildPackages(
          env,
          actorOf(builder),
          { type: "workflow", id: workflow },
          request.graphHash,
          "worker"
        )
      ),
    }).toStrictEqual({
      audited: ["dependency.revoked", "dependency.malware_refused"],
      told: [{ name, advisory: "MAL-2026-40003" }],
      status: null,
      build: "dependency.revoked",
    });
  });

  it("tells its builders once of an advisory the approval didn't know, and leaves it approved", async () => {
    const name = await published();
    const { builder, workflow, request } = await approvedPackage(name);
    await advise(name, {
      id: 1_000_002,
      url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
      title: "Prototype pollution",
      severity: "moderate",
      vulnerable_versions: "<2.0.0",
    });

    await rescannedUntil(request.id, new Date());
    await rescannedUntil(request.id, new Date(Date.now() + 7 * 60 * 60 * 1000));

    expect({
      told: await noticesOf(builder.userId, "package_advisory"),
      approved: await approvedOf(builder, workflow),
    }).toStrictEqual({
      told: [{ name, advisory: "GHSA-dddd-eeee-ffff" }],
      approved: request.id,
    });
  });

  it("revokes a graph reported as malware for every workflow approved with it, at once", async () => {
    const name = await published();
    const one = await approvedPackage(name);
    const other = await approvedPackage(name);
    const at = new Date();
    // The other's approval just scanned: only one is due on this run.
    await env.DB.prepare(
      "UPDATE dependency_requests SET malware_checked_at = ? WHERE id = ?"
    )
      .bind(at.getTime(), other.request.id)
      .run();
    await reportToOsv(name, "1.0.0", "MAL-2026-40006");

    await rescannedUntil(one.request.id, at);

    expect({
      sameGraph: one.request.graphHash === other.request.graphHash,
      one: await approvedOf(one.builder, one.workflow),
      other: await approvedOf(other.builder, other.workflow),
      told: await noticesOf(other.builder.userId, "package_revoked"),
    }).toStrictEqual({
      sameGraph: true,
      one: null,
      other: null,
      told: [{ name, advisory: "MAL-2026-40006" }],
    });
  });

  it("stops on a deleted workflow's packages: its approval is withdrawn, audited", async () => {
    const name = await published();
    const { builder, workflow, request } = await approvedPackage(name);

    const events = await auditedDuring(async () => {
      await deleteWorkflowResource(env, builder, workflow);
    });
    const row = await env.DB.prepare(
      "SELECT status FROM dependency_requests WHERE id = ?"
    )
      .bind(request.id)
      .first<{ status: string }>();

    expect({
      status: row?.status,
      audited: events.some(({ action }) => action === "dependency.withdrawn"),
    }).toStrictEqual({ status: "revoked", audited: true });
  });

  it("changes nothing when the sources can't be read", async () => {
    const name = await published();
    const { builder, workflow, request } = await approvedPackage(name);
    await reportToOsv(name, "1.0.0", "MAL-2026-40004");
    await osvAnswers(name, 503);

    await rescanPackages(env, new Date());
    const approved = await approvedOf(builder, workflow);
    await osvAnswers(name, null);

    expect(approved).toBe(request.id);
  });
});
