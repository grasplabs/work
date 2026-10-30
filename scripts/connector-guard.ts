/**
 * What CI holds a branch of Grasp's agent to (GRA-689): a branch
 * `feat/connector-<app>` adds one new connector and nothing else, takes no
 * dependency the repository doesn't already have, and carries the plan a
 * person at Grasp approved, signed by the admin, whose hosts are the only
 * ones its manifest may name. The checks themselves, over a view of the
 * pull request; scripts/check-connector-pr.ts runs them.
 *
 * Threat model (the design note on GRA-689, T2 to T4), and what closes it:
 *
 * - The agent edits CI, these checks, other code or another connector: on
 *   its branch, every changed path must be in the new connector's folder,
 *   or the lockfile's entry for that folder; `static` runs from main's own
 *   copy of this file (`pull_request_target`, .github/workflows/
 *   connector-guard.yml), reading the branch as data, so a branch can't
 *   change what checks it.
 * - The agent changes an existing connector: the folder must be new.
 * - The agent adds a dependency, or one that runs on install: the
 *   package's dependencies may only be the repository's own packages
 *   (`workspace:*`) or its vetted catalog (`catalog:`), it may have no
 *   scripts and no field but the few a connector needs, and the lockfile
 *   may differ from main's only by the new folder's own entry.
 * - The connector reaches hosts nobody approved: the plan must be signed by
 *   the admin's key (`verifyPlanSignature`), name this app, and the
 *   manifest may name no host the plan doesn't (`manifestProblems`, run
 *   by `manifest` in CI's own job, as connect's build loads a connector).
 * - A branch of some other name: the guard checks only these branches;
 *   GitHub keeps the agent's app to them (.github/rulesets/
 *   connector-agent.json).
 */
import { connectorNameSchema } from "@grasp-os/connector-kit/manifest";
import {
  planFiles,
  signedPlanSchema,
  verifyPlanSignature,
} from "@grasp-os/connector-kit/plan-signature";
import type { SignedPlan } from "@grasp-os/connector-kit/plan-signature";

/** The prefix of the agent's branches, before the app's connector name. */
export const agentBranchPrefix = "feat/connector-";

/** Where connectors live: each a folder of its own. */
const connectorsDir = "packages/connectors";

/** The lockfile, whose only allowed change is the new folder's entry. */
export const lockfile = "pnpm-lock.yaml";

/** One changed path, as `git diff --name-status` gives it. */
export interface ChangedPath {
  /** Git's status letter: A(dded), M(odified), D(eleted), R(enamed)... */
  status: string;
  path: string;
  /** For a rename or copy, where it came from. */
  from?: string;
}

/** The pull request as the checks read it. */
export interface PullRequestView {
  branch: string;
  changed: readonly ChangedPath[];
  /** A file's text at the branch's head; undefined when it has none. */
  head: (path: string) => string | undefined;
  /** A file's text at the branch's base; undefined when it has none. */
  base: (path: string) => string | undefined;
  /** Whether the base has any file under `folder`. */
  baseHasFolder: (folder: string) => boolean;
}

/**
 * The app whose connector branch `branch` is, or undefined when it is no
 * agent's branch. A name the connector kit wouldn't take is still the
 * agent's: it is refused, not waved through (`""`).
 */
export const connectorOfBranch = (branch: string): string | undefined => {
  if (!branch.startsWith(agentBranchPrefix)) {
    return undefined;
  }
  const name = branch.slice(agentBranchPrefix.length);
  return connectorNameSchema.safeParse(name).success ? name : "";
};

/** The folder of connector `app`. */
export const folderOf = (app: string): string => `${connectorsDir}/${app}`;

/** The fields a connector's package.json may have. */
const packageFields = new Set([
  "name",
  "private",
  "description",
  "license",
  "type",
  "exports",
  "dependencies",
  "devDependencies",
]);

/** The versions a connector's dependency may have: none of its own. */
const allowedVersions = new Set(["workspace:*", "catalog:"]);

/** What's wrong with the new connector's package.json `text`. */
const packageProblems = (app: string, text: string | undefined): string[] => {
  const where = `${folderOf(app)}/package.json`;
  if (text === undefined) {
    return [`${where} is missing`];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [`${where} isn't JSON`];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [`${where} isn't an object`];
  }
  const problems: string[] = [];
  for (const [field, value] of Object.entries(parsed)) {
    if (!packageFields.has(field)) {
      problems.push(`${where} has "${field}", which a connector may not`);
      continue;
    }
    if (field !== "dependencies" && field !== "devDependencies") {
      continue;
    }
    const dependencies: unknown = value;
    if (typeof dependencies !== "object" || dependencies === null) {
      problems.push(`${where}'s ${field} isn't an object`);
      continue;
    }
    for (const [dependency, version] of Object.entries(dependencies)) {
      if (typeof version !== "string" || !allowedVersions.has(version)) {
        problems.push(
          `${where} takes ${dependency} at ${JSON.stringify(version)}: only workspace:* or catalog: may be used`
        );
      }
    }
  }
  if (Reflect.get(parsed, "name") !== `@grasp-os/connector-${app}`) {
    problems.push(`${where} must be named @grasp-os/connector-${app}`);
  }
  return problems;
};

/**
 * `lock` without the importer entry for `folder`: the lines from its key to
 * the next importer's, or the next top-level section's.
 */
export const withoutImporter = (lock: string, folder: string): string => {
  const lines = lock.split("\n");
  const start = lines.indexOf(`  ${folder}:`);
  if (start === -1) {
    return lock;
  }
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}\S/u.test(lines[end] ?? "")) {
    end += 1;
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
};

/** What's wrong with the lockfile's change, if anything. */
const lockProblems = (app: string, view: PullRequestView): string[] => {
  const head = view.head(lockfile);
  const base = view.base(lockfile);
  if (head === undefined || base === undefined) {
    return [`${lockfile} is missing`];
  }
  return withoutImporter(head, folderOf(app)) === base
    ? []
    : [
        `${lockfile} changes more than ${folderOf(app)}'s own entry: no dependency may be added or changed`,
      ];
};

/** The signed plan on the branch, or why there is none to trust. */
const signedPlanOf = async (
  app: string,
  view: PullRequestView,
  publicKey: string | undefined
): Promise<{ plan: SignedPlan } | { problems: string[] }> => {
  const folder = folderOf(app);
  const text = view.head(`${folder}/${planFiles.plan}`);
  const signature = view.head(`${folder}/${planFiles.signature}`);
  if (text === undefined || signature === undefined) {
    return {
      problems: [
        `${folder} needs the approved plan the admin signed (${planFiles.plan} and ${planFiles.signature})`,
      ],
    };
  }
  if (publicKey === undefined || publicKey.trim() === "") {
    return {
      problems: [
        "CONNECTOR_PLAN_KEY isn't set, so no plan can be trusted: set the repository variable to the admin's plan signing public key",
      ],
    };
  }
  if (!(await verifyPlanSignature(publicKey, text, signature))) {
    return {
      problems: [
        `${folder}/${planFiles.plan} isn't signed by the admin's plan key`,
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problems: [`${folder}/${planFiles.plan} isn't JSON`] };
  }
  const plan = signedPlanSchema.safeParse(parsed);
  if (!plan.success) {
    return { problems: [`${folder}/${planFiles.plan} isn't a build plan`] };
  }
  if (plan.data.app !== app) {
    return {
      problems: [
        `${folder}/${planFiles.plan} is the plan for ${plan.data.app}, not ${app}`,
      ],
    };
  }
  return { plan: plan.data };
};

/**
 * What's wrong with pull request `view`, from what it changes alone, with
 * nothing of it run: no problems for a branch that is no agent's. For a
 * branch `feat/connector-<app>`, with the admin's plan signing public key
 * `publicKey`.
 */
export const staticProblems = async (
  view: PullRequestView,
  publicKey: string | undefined
): Promise<string[]> => {
  const app = connectorOfBranch(view.branch);
  if (app === undefined) {
    return [];
  }
  if (app === "") {
    return [
      `${view.branch} isn't a connector's branch: after ${agentBranchPrefix} comes a connector's name`,
    ];
  }
  const folder = folderOf(app);
  const problems: string[] = [];
  if (view.baseHasFolder(folder)) {
    problems.push(
      `${folder} already exists: the agent only adds a connector, never changes one`
    );
  }
  for (const { status, path, from } of view.changed) {
    const touched = [path, ...(from === undefined ? [] : [from])];
    for (const one of touched) {
      if (one === lockfile) {
        continue;
      }
      if (!one.startsWith(`${folder}/`)) {
        problems.push(`${one} (${status}) is outside ${folder}`);
      }
    }
  }
  if (view.changed.some(({ path }) => path === lockfile)) {
    problems.push(...lockProblems(app, view));
  }
  problems.push(...packageProblems(app, view.head(`${folder}/package.json`)));
  const plan = await signedPlanOf(app, view, publicKey);
  if ("problems" in plan) {
    problems.push(...plan.problems);
  }
  return problems;
};

/**
 * What's wrong with connector `app`'s `manifest`, as its module exports
 * it, against its signed plan `plan`: its name, and any host the plan
 * doesn't name.
 */
export const manifestProblems = (
  app: string,
  manifest: unknown,
  plan: SignedPlan
): string[] => {
  if (typeof manifest !== "object" || manifest === null) {
    return [`${folderOf(app)} exports no manifest`];
  }
  const problems: string[] = [];
  const name: unknown = Reflect.get(manifest, "name");
  if (name !== app) {
    problems.push(
      `${folderOf(app)}'s manifest is named ${JSON.stringify(name)}, not ${app}`
    );
  }
  const hosts: unknown = Reflect.get(manifest, "hosts");
  if (!Array.isArray(hosts)) {
    return [...problems, `${folderOf(app)}'s manifest names no hosts`];
  }
  const approved = new Set(plan.plan.hosts);
  for (const host of hosts) {
    if (typeof host !== "string" || !approved.has(host)) {
      problems.push(
        `${folderOf(app)}'s manifest reaches ${JSON.stringify(host)}, which the approved plan doesn't name`
      );
    }
  }
  return problems;
};

/** The signed plan of connector `app`, read from its folder by `read`. */
export const readSignedPlan = async (
  app: string,
  read: (path: string) => string | undefined,
  publicKey: string | undefined
): Promise<SignedPlan | string[]> => {
  const found = await signedPlanOf(
    app,
    {
      branch: `${agentBranchPrefix}${app}`,
      changed: [],
      head: read,
      base: read,
      baseHasFolder: () => false,
    },
    publicKey
  );
  return "plan" in found ? found.plan : found.problems;
};
