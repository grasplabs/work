import type { AppOverview } from "@grasp-os/shared/apps";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { LayoutGridIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { formatDate } from "../format.ts";
import { Page, PageHeading } from "../frame/page.tsx";
import { StatusBadge } from "./app-status.tsx";

// The Apps page: every App the person can open, newest first, as a grid of
// cards (its icon, name, where it stands and when it was made), each
// opening the live App (/apps/$app). A search over their names, and New
// App for who builds, which starts one from a single box (new-app.tsx).

/** New App: the page's one action. */
const NewAppLink = () => (
  <Link className={buttonVariants()} to="/apps/new">
    <PlusIcon data-icon="inline-start" />
    <Trans>New App</Trans>
  </Link>
);

/** One App: its card, whose name opens it. */
const AppCard = ({ overview: { app } }: { overview: AppOverview }) => {
  const made = formatDate(app.createdAt);
  return (
    <li className="bg-card hover:border-ring/40 relative flex min-w-0 flex-col gap-3 rounded-xl border p-4 transition-colors">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="bg-muted text-foreground inline-flex size-9 flex-none items-center justify-center rounded-lg"
        >
          <LayoutGridIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Link
            className="truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:underline"
            params={{ app: app.id }}
            to="/apps/$app"
          >
            {app.name}
          </Link>
          {app.description === "" ? null : (
            <p className="text-muted-foreground line-clamp-2 text-sm">
              {app.description}
            </p>
          )}
        </div>
      </div>
      <div className="text-muted-foreground mt-auto flex items-center gap-2 text-xs">
        <StatusBadge status={app.status} />
        <span className="truncate">
          <Trans>Made {made}</Trans>
        </span>
      </div>
    </li>
  );
};

/** The Apps, the newest first. */
const newestFirst = (apps: readonly AppOverview[]): AppOverview[] =>
  apps.toSorted((one, other) =>
    other.app.createdAt.localeCompare(one.app.createdAt)
  );

/** The Apps page's body: `listed`, as core lists them; New App for who `builds`. */
export const AppsOverview = ({
  listed,
  builds,
}: {
  listed: readonly AppOverview[];
  builds: boolean;
}) => {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const apps = newestFirst(listed);
  const asked = query.trim();
  const needle = asked.toLocaleLowerCase();
  const shown = apps.filter(
    ({ app }) => needle === "" || app.name.toLocaleLowerCase().includes(needle)
  );
  return (
    <Page wide>
      <PageHeading
        action={builds ? <NewAppLink /> : undefined}
        title={<Trans>Apps</Trans>}
      />
      {apps.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGridIcon />
            </EmptyMedia>
            <EmptyTitle>
              <Trans>No Apps yet</Trans>
            </EmptyTitle>
            <EmptyDescription>
              {builds ? (
                <Trans>Say what you want to build, and Grasp builds it.</Trans>
              ) : (
                <Trans>
                  The Apps your colleagues share with you show here.
                </Trans>
              )}
            </EmptyDescription>
          </EmptyHeader>
          {builds ? (
            <EmptyContent>
              <NewAppLink />
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <>
          <div className="w-full sm:w-72">
            <InputGroup>
              <InputGroupInput
                aria-label={t`Search the Apps`}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder={t`Search`}
                value={query}
              />
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
            </InputGroup>
          </div>
          {shown.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  <Trans>No App is called “{asked}”</Trans>
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul
              aria-label={t`Apps`}
              className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            >
              {shown.map((overview) => (
                <AppCard key={overview.app.id} overview={overview} />
              ))}
            </ul>
          )}
        </>
      )}
    </Page>
  );
};
