import { requestRanges } from "@grasp-os/shared/stephen-requests";
import type {
  Need,
  RequestKind,
  RequestRange,
  RequestsPage,
  WeeklySummary,
} from "@grasp-os/shared/stephen-requests";
import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatMonth } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { RequestFilters } from "../workflows/requests/request-filters.tsx";
import { RequestPlan } from "../workflows/requests/request-plan.tsx";
import { RequestSummary } from "../workflows/requests/request-summary.tsx";
import { RequestTable } from "../workflows/requests/request-table.tsx";

// Workflows › Requests, as the prototype's `routes/workflows/requests.tsx`:
// how people use Stephen outside Grasp, counted in requests as the plan
// bills them. Two blocks: the plan as one picture (request-plan.tsx), and
// one table to work from whose first view is what needs fixing
// (request-table.tsx). Counts only, never anyone's own words, and no group
// of fewer than five on its own: core folds them before the page sees
// them (stephen-requests.ts). For owners and admins; core refuses anyone
// else. The span and the filters are in the address.

interface RequestsSearch {
  range?: RequestRange;
  place?: string;
  team?: string;
}

/** What the page read: the report, and what needs fixing and the weekly summary where they could be read. */
interface Read {
  page: RequestsPage;
  needs: Need[] | null;
  summary: WeeklySummary | null;
}

/** A read that may fail on its own without failing the page. */
const orNull = async <T,>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

const readPage = async (
  session: Session,
  { range = "month", place, team }: RequestsSearch
): Promise<Read> => {
  const [page, needs, summary] = await Promise.all([
    session.stephenRequests.report({
      range,
      place: place ?? null,
      team: team ?? null,
    }),
    orNull(async () => await session.stephenRequests.needs(i18n.locale)),
    orNull(async () => await session.stephenRequests.summary()),
  ]);
  return { page, needs, summary };
};

const RequestsView = ({ read }: { read: Read }) => {
  const { t } = useLingui();
  const router = useRouter();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/workflows/requests" });
  const { busy, failure, run } = useCoreAction();
  const { page, needs, summary } = read;
  const refresh = async (): Promise<void> => {
    await router.invalidate({ sync: true });
  };
  const change = async (
    action: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    await run(async (session) => {
      await action(session);
    });
    await refresh();
  };
  const place = search.place ?? null;
  const team = search.team ?? null;
  const narrowed = place !== null || team !== null;
  const month = formatMonth(page.report.from);
  const setMinutes = (kind: RequestKind, minutes: number) => {
    void change(async (session) => {
      await session.stephenRequests.updateSettings({
        ...page.settings,
        minutesSaved: { ...page.settings.minutesSaved, [kind]: minutes },
      });
    });
  };
  return (
    <>
      <PageHeading
        action={
          summary === null ? undefined : (
            <RequestSummary onChanged={refresh} summary={summary} />
          )
        }
        title={t({
          message: "Requests",
          context: "Stephen's requests: the page",
        })}
      />
      <RequestFilters
        onPlace={(next) => {
          void navigate({ search: { ...search, place: next ?? undefined } });
        }}
        onTeam={(next) => {
          void navigate({ search: { ...search, team: next ?? undefined } });
        }}
        page={page}
        place={place}
        team={team}
      />
      <RequestPlan
        canSet={page.canSetPerPerson}
        narrowed={narrowed}
        onRange={(range) => {
          void navigate({ search: { ...search, range } });
        }}
        onSetMinutes={setMinutes}
        page={page}
      />
      <ErrorText>{failure}</ErrorText>
      {page.tooFew ? (
        <p className="bg-card text-muted-foreground rounded-xl border px-4 py-12 text-center">
          <span>{t`Fewer than five people: this isn't shown on its own.`}</span>
        </p>
      ) : null}
      {!page.tooFew && page.report.total.requests === 0 ? (
        <p className="bg-card text-muted-foreground rounded-xl border px-4 py-12 text-center">
          <span>
            {page.range === "year"
              ? t`No requests in the last twelve months`
              : t`No requests in ${month}`}
          </span>
        </p>
      ) : null}
      {!page.tooFew && page.report.total.requests > 0 ? (
        <RequestTable
          busy={busy}
          needs={needs}
          onChanged={refresh}
          onOnlyTeam={
            team === null
              ? (next) => {
                  void navigate({ search: { ...search, team: next } });
                }
              : null
          }
          onPerPerson={(on) => {
            void change(async (session) => {
              await session.stephenRequests.updateSettings({
                ...page.settings,
                requestsPerPerson: on,
              });
            });
          }}
          page={page}
          place={place}
        />
      ) : null}
    </>
  );
};

const RequestsRoute = () => {
  const { t } = useLingui();
  const read = Route.useLoaderData();
  const title = t({
    message: "Requests",
    context: "Stephen's requests: the page",
  });
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Workflows`, to: "/workflows" }, { label: title }]}
      />
      <Page wide>
        {read.state === "ready" ? (
          <RequestsView read={read.data} />
        ) : (
          <>
            <PageHeading title={title} />
            <NotLoadedState page={read} />
          </>
        )}
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/requests")({
  validateSearch: (search: Record<string, unknown>): RequestsSearch => {
    const range = requestRanges.find((each) => each === search.range);
    return {
      ...(range === undefined ? {} : { range }),
      ...(typeof search.place === "string" ? { place: search.place } : {}),
      ...(typeof search.team === "string" ? { team: search.team } : {}),
    };
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { core }, deps }) =>
    await loadFromCore(core, async (session) => await readPage(session, deps)),
  component: RequestsRoute,
});
