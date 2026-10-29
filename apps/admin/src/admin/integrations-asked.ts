/**
 * The apps companies asked Grasp to add, as their cores say it (the
 * snapshot's `asked`, core's app requests): one per app across every
 * company, so an app asked for at three companies is built once. This is
 * where an integration to build starts, at its first step, asked for
 * (`BUILD_STAGES`); the build itself, from Build it on, is the admin's
 * own record (GRA-689), which these rows meet by `key`.
 */
import type {
  BuildStage as ToolStage,
  IntegrationBuild,
} from "@grasp-os/shared/admin/admin-integrations";

import type { Build, BuildStage } from "../builds/builds.ts";
import type { ClientAdmin } from "../clients/admin.ts";

/** One company's request for an app. */
export interface AppAsk {
  /** The client, by its id. */
  org: string;
  /** Its name, as the admin knows it. */
  orgName: string;
  /** When it asked first. */
  on: string;
}

/** An app asked of Grasp, by however many companies. */
export interface AskedApp {
  /** What the app is known by in the admin's links: its name in lower case, words joined by dashes. */
  key: string;
  /** Its name, as the first company to ask for it wrote it. */
  name: string;
  /** The companies that asked, in the order they asked. */
  asks: AppAsk[];
}

const notWord = /[^\p{L}\p{N}]+/gu;
const edgeDashes = /^-+|-+$/gu;

/** An app's key from its name: the same app asked as "Exact Online" and "exact  online" is one. */
export const appKey = (name: string): string =>
  name.toLowerCase().replaceAll(notWord, "-").replaceAll(edgeDashes, "");

/**
 * Every app the answered companies asked for, once each: the app the most
 * companies asked for first, then the one asked for longest ago, as the
 * prototype sorts what waits on Grasp (`sortBuilds`). A company whose core
 * didn't answer says nothing here.
 */
export const askedApps = (admins: readonly ClientAdmin[]): AskedApp[] => {
  const apps = new Map<string, AskedApp>();
  const ordered = admins
    .flatMap((admin) =>
      admin.state === "answered"
        ? admin.snapshot.asked.map((app) => ({
            key: appKey(app.name),
            name: app.name,
            ask: {
              org: admin.client.id,
              orgName: admin.client.name,
              on: app.askedAt,
            },
          }))
        : []
    )
    .filter(({ key }) => key !== "")
    .toSorted((a, b) => a.ask.on.localeCompare(b.ask.on));
  for (const { key, name, ask } of ordered) {
    const app = apps.get(key) ?? { key, name, asks: [] };
    // A company that asked twice, as two spellings, asked once.
    if (!app.asks.some((each) => each.org === ask.org)) {
      app.asks.push(ask);
    }
    apps.set(key, app);
  }
  return [...apps.values()].toSorted(
    (a, b) =>
      b.asks.length - a.asks.length ||
      (a.asks[0]?.on ?? "").localeCompare(b.asks[0]?.on ?? "") ||
      a.name.localeCompare(b.name)
  );
};

/** Each of the admin's build stages as the tools name it. */
const toolStage: Record<BuildStage, ToolStage> = {
  asked: "requested",
  researching: "researching",
  plan_ready: "plan",
  credentials: "credentials",
  writing: "writing",
  in_review: "review",
  merged: "merged",
  needs_person: "needsPerson",
};

/** How a plan's app is signed in to, as the tools name it. */
const signInAuth = { oauth2: "oauth2", api_key: "apiKey" } as const;

/** Where a build's pull request is. */
const pullRequestUrl = (number: number): string =>
  `https://github.com/grasplabs/work/pull/${number}`;

/**
 * The integrations to build, for every answered company at once: each app
 * asked for (`askedApps`) at its first step, asked for, unless the admin
 * keeps a build of it (`integrationBuilds`, met by `key`), which says
 * where it stands. The admin's MCP answers from this
 * (`integrations_to_build`), and the page is to (src/admin/integrations.tsx),
 * so the two can't say different things.
 *
 * An app is known in the answer by an id that says nothing a company
 * wrote: a build's connector name, which a person at Grasp chose, or
 * `asked-<n>` in the order the apps are listed. Its name, as a company
 * wrote it, is data beside it.
 */
export const integrationsToBuild = (
  admins: readonly ClientAdmin[],
  builds: readonly Build[]
): IntegrationBuild[] => {
  const recorded = new Map(builds.map((build) => [build.app, build]));
  return askedApps(admins).map((app, index): IntegrationBuild => {
    const build = recorded.get(app.key);
    const first = app.asks[0]?.on;
    const requests = app.asks.map((ask) => ({
      org: ask.org,
      // A core's app request doesn't say which workflows need it.
      workflows: [],
      on: ask.on,
      by: "",
    }));
    if (build === undefined) {
      return {
        id: `asked-${index + 1}`,
        app: app.name,
        about: "",
        docs: "",
        auth: "none",
        actions: [],
        requests,
        stage: "requested",
        reached: first === undefined ? {} : { requested: first },
      };
    }
    const { plan } = build;
    return {
      id: build.app,
      app: build.name,
      about: "",
      docs: plan?.docs[0] ?? "",
      auth: plan === null ? "none" : signInAuth[plan.signIn],
      actions: (plan?.actions ?? []).map((action) => ({
        name: action.action,
        access: action.changes ? "write" : "read",
      })),
      requests,
      stage: toolStage[build.stage],
      reached: first === undefined ? {} : { requested: first },
      ...(build.pullRequest === null
        ? {}
        : {
            work: {
              session: build.runId,
              branch: build.branch ?? "",
              minutes: 0,
              cost: 0,
              pr: {
                number: build.pullRequest,
                url: pullRequestUrl(build.pullRequest),
                checks: [],
                reviewer: "",
              },
            },
          }),
    };
  });
};
