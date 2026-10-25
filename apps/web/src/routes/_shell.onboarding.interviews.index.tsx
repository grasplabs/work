import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { adminOrgOf } from "@grasp-os/shared/admin/admin-snapshot-adapter";
import { adminViewOf } from "@grasp-os/shared/admin/admin-view";
import type { OrgView } from "@grasp-os/shared/admin/onboarding-admin";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { InterviewList } from "../onboarding/interview-list.tsx";
import { InterviewPeople } from "../onboarding/interview-people.tsx";
import { InterviewTeams } from "../onboarding/interview-teams.tsx";
import { SettingsError } from "../settings/settings-parts.tsx";

// The onboarding area's interviews (prototype `org-interviews.tsx`), from
// three sides, the side in the address: where every team stands and what
// can be done there, everyone by name, and the interviews one by one. All
// from the snapshot Grasp's admin reads (core's admin-snapshot.ts), read
// as the admin reads it, as numbers. What anyone said stays with them:
// nobody at Grasp reads it (GRA-329); one interview opens as where it
// stands and its numbers, on record (interviews.$person). The company sees
// none of this: it gets numbers per team.

const tabs = ["teams", "people", "transcripts"] as const;
type Tab = (typeof tabs)[number];

const tabTitles: Record<Tab, MessageDescriptor> = {
  teams: msg({ message: "Teams", context: "view of the interviews" }),
  people: msg({ message: "People", context: "view of the interviews" }),
  transcripts: msg({
    message: "One by one",
    context: "view of the interviews",
  }),
};

interface InterviewsSearch {
  tab?: Tab;
  /** The person whose dialog is open. */
  person?: string;
}

const searchOf = (search: Record<string, unknown>): InterviewsSearch => {
  const tab = tabs.find((each) => each === search.tab);
  const { person } = search;
  return {
    ...(tab === undefined || tab === "teams" ? {} : { tab }),
    ...(typeof person === "string" && person !== "" ? { person } : {}),
  };
};

/** The snapshot as Grasp's admin reads it, on the day core answered. */
const viewOf = (snapshot: AdminSnapshot): OrgView => {
  const { org, state } = adminOrgOf(snapshot, { id: "organization" });
  return adminViewOf(org, state, snapshot.now.slice(0, 10));
};

const linkClass =
  "text-muted-foreground hover:bg-muted/60 hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground flex h-8 flex-none items-center rounded-md px-3 transition-colors";

const Interviews = () => {
  const { t, i18n } = useLingui();
  const loaded = Route.useLoaderData();
  const { tab = "teams", person } = Route.useSearch();
  if (loaded.state !== "ready") {
    return (
      <div className="bg-card overflow-hidden rounded-xl border">
        <NotLoadedState heading="h2" page={loaded} />
      </div>
    );
  }
  const snapshot = loaded.data;
  const view = viewOf(snapshot);
  return (
    <>
      <nav aria-label={t`Interviews`} className="flex gap-1">
        {tabs.map((each) => (
          <Link
            aria-current={each === tab ? "page" : undefined}
            className={linkClass}
            key={each}
            search={each === "teams" ? {} : { tab: each }}
            to="/onboarding/interviews"
          >
            {i18n._(tabTitles[each])}
          </Link>
        ))}
      </nav>
      {tab === "teams" ? <InterviewTeams view={view} /> : null}
      {tab === "people" ? (
        <InterviewPeople open={person} snapshot={snapshot} view={view} />
      ) : null}
      {tab === "transcripts" ? (
        <InterviewList snapshot={snapshot} view={view} />
      ) : null}
    </>
  );
};

export const Route = createFileRoute("/_shell/onboarding/interviews/")({
  validateSearch: searchOf,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session): Promise<AdminSnapshot> =>
        await session.onboardingStaff.interviews()
    ),
  errorComponent: SettingsError,
  component: Interviews,
});
