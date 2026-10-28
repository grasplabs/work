import { describe, expect, it } from "vite-plus/test";

import {
  clientConnectScriptPattern,
  clientResourceName,
  clientRoleNames,
  deploymentIdAlphabet,
  deploymentIdLength,
  adminDatabaseName,
  clientsNamespace,
  isResourceName,
  platformWorkerName,
  platformWorkers,
  releasesBucketName,
  routerHostsName,
  stageNamed,
  stages,
} from "../src/names.ts";

// The platform's Cloudflare names, as the scheme's table gives them, and
// every one a name Cloudflare takes for each kind of resource.

describe("the platform's names", () => {
  it("are grasp-<what> in production and grasp-<what>-staging in staging", () => {
    expect(
      Object.fromEntries(
        stages.map((stage) => [
          stage,
          {
            workers: platformWorkers.map((worker) =>
              platformWorkerName(worker, stage)
            ),
            database: adminDatabaseName(stage),
            releases: releasesBucketName(stage),
            hosts: routerHostsName(stage),
            namespace: clientsNamespace(stage),
          },
        ])
      )
    ).toStrictEqual({
      production: {
        workers: ["grasp-admin", "grasp-router", "grasp-connect-gateway"],
        database: "grasp-admin",
        releases: "grasp-releases",
        hosts: "grasp-router-hosts",
        namespace: "grasp-clients",
      },
      staging: {
        workers: [
          "grasp-admin-staging",
          "grasp-router-staging",
          "grasp-connect-gateway-staging",
        ],
        database: "grasp-admin-staging",
        releases: "grasp-releases-staging",
        hosts: "grasp-router-hosts-staging",
        namespace: "grasp-clients-staging",
      },
    });
  });

  it("are each a name Cloudflare takes for a Worker, a D1 database, an R2 bucket and a namespace", () => {
    const names = stages.flatMap((stage) => [
      ...platformWorkers.map((worker) => platformWorkerName(worker, stage)),
      adminDatabaseName(stage),
      releasesBucketName(stage),
      routerHostsName(stage),
      clientsNamespace(stage),
    ]);
    expect({
      refused: names.filter((name) => !isResourceName(name)),
      tooLong: isResourceName(`grasp-${"a".repeat(58)}`),
      upper: isResourceName("grasp-Admin"),
      edge: isResourceName("grasp-admin-"),
    }).toStrictEqual({
      refused: [],
      tooLong: false,
      upper: false,
      edge: false,
    });
  });

  it("take a stage only as exactly staging or production, never production by default", () => {
    expect(
      [
        "production",
        "staging",
        undefined,
        "",
        "Production",
        "prod",
        "staging ",
        "STAGING",
      ].map(stageNamed)
    ).toStrictEqual([
      "production",
      "staging",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("a placed client's names", () => {
  // The longest a deployment id gets is its fixed length; the "z" and "7"
  // ends of its alphabet stand in for any.
  const longest = "z7".repeat(deploymentIdLength / 2);

  it("are grasp-<id>-<component and purpose> for every resource a release names, each one Cloudflare takes", () => {
    const names = Object.keys(clientRoleNames).map((role) =>
      clientResourceName(longest, role)
    );
    expect({
      core: clientResourceName(longest, "worker:grasp-os-core"),
      db: clientResourceName(longest, "d1:grasp-os-core"),
      connectDb: clientResourceName(longest, "d1:grasp-os-connect"),
      refused: names.filter(
        (name) => name === undefined || !isResourceName(name)
      ),
      longestLength: Math.max(...names.map((name) => name?.length ?? 0)),
      unnamed: clientResourceName(longest, "r2:grasp-os-backups"),
      idLength: longest.length,
      alphabet: new RegExp(`^[${deploymentIdAlphabet}]+$`, "u").test(longest),
    }).toStrictEqual({
      core: `grasp-${longest}-core`,
      db: `grasp-${longest}-core-db`,
      connectDb: `grasp-${longest}-connect-db`,
      refused: [],
      longestLength: 31,
      unnamed: undefined,
      idLength: 10,
      alphabet: true,
    });
  });

  it("let the connect gateway reach a client's connect, and nothing else", () => {
    const connect =
      clientResourceName(longest, "worker:grasp-os-connect") ?? "";
    expect({
      connect: clientConnectScriptPattern.test(connect),
      core: clientConnectScriptPattern.test(
        clientResourceName(longest, "worker:grasp-os-core") ?? ""
      ),
      platform: clientConnectScriptPattern.test("grasp-connect-gateway"),
      shortId: clientConnectScriptPattern.test("grasp-abc-connect"),
      oldScheme: clientConnectScriptPattern.test(
        `g${longest}-grasp-os-connect`
      ),
    }).toStrictEqual({
      connect: true,
      core: false,
      platform: false,
      shortId: false,
      oldScheme: false,
    });
  });
});
