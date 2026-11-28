/**
 * The GitHub environment whose secret is the release signing key
 * (`release-signing`, read by CI's sign-release job alone): how it must
 * be set, setting it so, and checking it is. Only main may use it, and
 * repository admins can't bypass that: a job on any other branch, a pull
 * request or the merge queue gets no secret from it. GitHub makes an
 * environment a job names when it doesn't exist, with no rule at all, and
 * a secret set before the rule is readable from any branch of the
 * repository; so the key is set only once a check reads the rule back
 * (signing-environment.ts), and CI checks it again before every signing.
 *
 * Nothing but Node's built-ins: CI's check runs before anything is
 * installed. Through GitHub's REST API, as `api` reaches it.
 */

export const SIGNING_ENVIRONMENT = "release-signing";
export const SIGNING_SECRET = "RELEASE_SIGNING_KEY";

/** A REST call's answer: its status and its JSON body (undefined when none). */
export interface ApiAnswer {
  status: number;
  body: unknown;
}

/** GitHub's REST API: `method` on `path` (from `/repos/…`), with `body` as JSON. */
export type GitHubApi = (
  method: string,
  path: string,
  body?: unknown
) => Promise<ApiAnswer>;

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined;

const parseJson = (text: string): unknown => JSON.parse(text);

const environmentPath = (repo: string): string =>
  `/repos/${repo}/environments/${SIGNING_ENVIRONMENT}`;

/** The environment's branch policies, as `<type>:<name>` with their ids. */
const branchPolicies = async (
  api: GitHubApi,
  repo: string
): Promise<{ id: unknown; rule: string }[]> => {
  const answer = await api(
    "GET",
    `${environmentPath(repo)}/deployment-branch-policies?per_page=100`
  );
  if (answer.status !== HTTP_OK) {
    throw new Error(
      `Reading ${SIGNING_ENVIRONMENT}'s branch policies: ${answer.status}`
    );
  }
  const policies = fieldOf(answer.body, "branch_policies");
  return (Array.isArray(policies) ? policies : []).map((policy: unknown) => {
    const type = fieldOf(policy, "type");
    const name = fieldOf(policy, "name");
    return {
      id: fieldOf(policy, "id"),
      rule: `${typeof type === "string" ? type : "branch"}:${typeof name === "string" ? name : "?"}`,
    };
  });
};

/**
 * Why the environment isn't as it must be: there, limited to the branches
 * its policies name, with no admin bypass, and its one policy the branch
 * `main`; undefined when it is.
 */
export const signingEnvironmentProblem = async (
  api: GitHubApi,
  repo: string
): Promise<string | undefined> => {
  const environment = await api("GET", environmentPath(repo));
  if (environment.status === HTTP_NOT_FOUND) {
    return `${SIGNING_ENVIRONMENT} doesn't exist`;
  }
  if (environment.status !== HTTP_OK) {
    throw new Error(`Reading ${SIGNING_ENVIRONMENT}: ${environment.status}`);
  }
  const policy = fieldOf(environment.body, "deployment_branch_policy");
  if (
    fieldOf(policy, "custom_branch_policies") !== true ||
    fieldOf(policy, "protected_branches") !== false
  ) {
    return `${SIGNING_ENVIRONMENT} isn't limited to the branches it names`;
  }
  if (fieldOf(environment.body, "can_admins_bypass") !== false) {
    return `${SIGNING_ENVIRONMENT} lets repository admins bypass its rules`;
  }
  const policies = await branchPolicies(api, repo);
  const rules = policies.map(({ rule }) => rule);
  if (rules.length !== 1 || rules[0] !== "branch:main") {
    return `${SIGNING_ENVIRONMENT} lets ${rules.join(", ") || "no branch"} use it, not main alone`;
  }
  return undefined;
};

const succeeded = (answer: ApiAnswer, what: string): void => {
  if (answer.status >= 300) {
    throw new Error(`${what}: ${answer.status} ${JSON.stringify(answer.body)}`);
  }
};

/**
 * Sets the environment as it must be: creates or updates it, limited to
 * the branches it names, with no admin bypass, drops every policy but the
 * branch `main` and adds that one if missing.
 */
export const applySigningEnvironment = async (
  api: GitHubApi,
  repo: string
): Promise<void> => {
  succeeded(
    await api("PUT", environmentPath(repo), {
      can_admins_bypass: false,
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    }),
    `Setting ${SIGNING_ENVIRONMENT}`
  );
  const policies = await branchPolicies(api, repo);
  for (const { id, rule } of policies) {
    if (rule !== "branch:main") {
      succeeded(
        // oxlint-disable-next-line no-await-in-loop -- a few policies
        await api(
          "DELETE",
          `${environmentPath(repo)}/deployment-branch-policies/${String(id)}`
        ),
        `Removing ${rule} from ${SIGNING_ENVIRONMENT}`
      );
    }
  }
  if (!policies.some(({ rule }) => rule === "branch:main")) {
    succeeded(
      await api("POST", `${environmentPath(repo)}/deployment-branch-policies`, {
        name: "main",
        type: "branch",
      }),
      `Limiting ${SIGNING_ENVIRONMENT} to main`
    );
  }
};

/** GitHub's REST API with `token`, at `base` (GitHub's own unless said). */
export const githubApi =
  (token: string, base = "https://api.github.com"): GitHubApi =>
  async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === "" ? undefined : parseJson(text),
    };
  };
