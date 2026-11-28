/**
 * The release signing key's environment (signing-environment-lib.ts),
 * against a stand-in for GitHub's environments API that keeps one
 * repository's environments in memory, as GitHub answers them.
 *
 * Threat model: the key is readable by any job that names the
 * environment and that the environment lets in. It must let in main
 * alone, with no admin bypass; a check must say so whatever else was set
 * by hand, and setting it must leave nothing else in.
 */
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  applySigningEnvironment,
  signingEnvironmentProblem,
} from "./signing-environment-lib.ts";
import type { ApiAnswer, GitHubApi } from "./signing-environment-lib.ts";

const REPO = "grasplabs/work";
const BASE = `/repos/${REPO}/environments/release-signing`;

interface Environment {
  canAdminsBypass: boolean;
  /** Null: any branch may use it. */
  branchPolicy: {
    protected_branches: boolean;
    custom_branch_policies: boolean;
  } | null;
  policies: { id: number; name: string; type: string }[];
}

/** What a PUT of the environment and a POST of a policy send. */
const environmentUpdate = z.object({
  can_admins_bypass: z.boolean(),
  deployment_branch_policy: z
    .object({
      protected_branches: z.boolean(),
      custom_branch_policies: z.boolean(),
    })
    .nullable(),
});
const policyCreate = z.object({ name: z.string(), type: z.string() });

/** GitHub's environments API over `state` (undefined: no environment yet). */
const github = (start?: Environment) => {
  let state = start;
  let nextId = 100;
  const api: GitHubApi = async (method, path, body): Promise<ApiAnswer> => {
    await Promise.resolve();
    const policies = `${BASE}/deployment-branch-policies`;
    if (method === "PUT" && path === BASE) {
      const update = environmentUpdate.parse(body);
      state = {
        canAdminsBypass: update.can_admins_bypass,
        branchPolicy: update.deployment_branch_policy,
        policies: state?.policies ?? [],
      };
      return { status: 200, body: {} };
    }
    if (state === undefined) {
      return { status: 404, body: { message: "Not Found" } };
    }
    if (method === "GET" && path === BASE) {
      return {
        status: 200,
        body: {
          name: "release-signing",
          can_admins_bypass: state.canAdminsBypass,
          deployment_branch_policy: state.branchPolicy,
        },
      };
    }
    if (method === "GET" && path.startsWith(policies)) {
      return {
        status: 200,
        body: {
          total_count: state.policies.length,
          branch_policies: state.policies,
        },
      };
    }
    if (method === "POST" && path === policies) {
      const { name, type } = policyCreate.parse(body);
      nextId += 1;
      state.policies.push({ id: nextId, name, type });
      return { status: 200, body: {} };
    }
    if (method === "DELETE" && path.startsWith(`${policies}/`)) {
      const id = Number(path.slice(policies.length + 1));
      state.policies = state.policies.filter((policy) => policy.id !== id);
      return { status: 204, body: undefined };
    }
    return { status: 404, body: undefined };
  };
  return { api, state: () => state };
};

const mainOnly = (): Environment => ({
  canAdminsBypass: false,
  branchPolicy: { protected_branches: false, custom_branch_policies: true },
  policies: [{ id: 1, name: "main", type: "branch" }],
});

describe("the release signing key's environment", () => {
  it("passes the check when main alone may use it, with no admin bypass", async () => {
    await expect(
      signingEnvironmentProblem(github(mainOnly()).api, REPO)
    ).resolves.toBeUndefined();
  });

  it("fails the check when it's missing, open to any branch, to protected branches, to another branch or a tag named main, to no branch, or bypassable by admins", async () => {
    const cases: Record<string, Environment | undefined> = {
      missing: undefined,
      anyBranch: { ...mainOnly(), branchPolicy: null },
      protectedBranches: {
        ...mainOnly(),
        branchPolicy: {
          protected_branches: true,
          custom_branch_policies: false,
        },
      },
      anotherBranch: {
        ...mainOnly(),
        policies: [
          { id: 1, name: "main", type: "branch" },
          { id: 2, name: "feat/*", type: "branch" },
        ],
      },
      tagNamedMain: {
        ...mainOnly(),
        policies: [{ id: 1, name: "main", type: "tag" }],
      },
      noBranch: { ...mainOnly(), policies: [] },
      adminBypass: { ...mainOnly(), canAdminsBypass: true },
    };
    const problems = Object.fromEntries(
      await Promise.all(
        Object.entries(cases).map(
          async ([name, environment]) =>
            [
              name,
              (await signingEnvironmentProblem(
                github(environment).api,
                REPO
              )) !== undefined,
            ] as const
        )
      )
    );
    expect(problems).toStrictEqual(
      Object.fromEntries(Object.keys(cases).map((name) => [name, true]))
    );
  });

  it("sets a missing environment, or one set by hand to let in more, to main alone, which the check then passes", async () => {
    const missing = github();
    const loose = github({
      canAdminsBypass: true,
      branchPolicy: { protected_branches: true, custom_branch_policies: false },
      policies: [
        { id: 1, name: "release/*", type: "branch" },
        { id: 2, name: "main", type: "tag" },
      ],
    });
    for (const { api } of [missing, loose]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await applySigningEnvironment(api, REPO);
    }

    expect({
      missing: await signingEnvironmentProblem(missing.api, REPO),
      loose: await signingEnvironmentProblem(loose.api, REPO),
      policies: loose
        .state()
        ?.policies.map(({ name, type }) => `${type}:${name}`),
    }).toStrictEqual({
      missing: undefined,
      loose: undefined,
      policies: ["branch:main"],
    });
  });
});
