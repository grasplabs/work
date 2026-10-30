import { requestRanges } from "@grasp-os/shared/stephen-requests";
import type {
  Need,
  RequestKind,
  RequestRange,
  RequestsPage,
  WeeklySummary,
} from "@grasp-os/shared/stephen-requests";
import { Card } from "@grasp-os/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatMonth } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore, orNull } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
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
// else. The span and the filters are in the address, and only the report
// follows them: what needs fixing and the weekly summary don't, so they
// are read on their own, once, without holding up the page.

interface RequestsSearch {
  range?: RequestRange;
  place?: string;
  team?: string;
}

/** How long to wait before reading again while Grasp makes proposals. */
const proposalWait = 4000;

/** Most times to read again for proposals: a model that keeps failing ends it. */
const proposalReads = 8;

/** What needs fixing (null when it can't be read) and the summary (null when it can't, or isn't the viewer's to set). */
interface Aside {
  needs: Need[] | null;
  summary: WeeklySummary | null;
}

/** Reads what needs fixing and the summary. Outside components, as the React Compiler can't compile `try`. */
const readAside = async (
  core: CoreConnection,
  locale: string,
  canManage: boolean
): Promise<Aside> => {
  const read = await loadFromCore(core, async (session) => {
    const [needs, summary] = await Promise.all([
      orNull(async () => await session.stephenRequests.needs(locale)),
      canManage
        ? orNull(async () => await session.stephenRequests.summary())
        : null,
    ]);
    return { needs, summary };
  });
  return read.state === "ready" ? read.data : { needs: null, summary: null };
};

/**
 * What needs fixing and the weekly summary, read once the page shows
 * (undefined until then), again in a while as long as Grasp is still
 * making proposals, a few times at most, and again on `reread`.
 */
const useAside = (canManage: boolean) => {
  const core = useCore();
  const { i18n } = useLingui();
  const { locale } = i18n;
  const [aside, setAside] = useState<Aside>();
  useEffect(() => {
    let current = true;
    let reads = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      const got = await readAside(core, locale, canManage);
      if (!current) {
        return;
      }
      setAside(got);
      reads += 1;
      if (
        got.needs?.some((need) => need.proposing) === true &&
        reads <= proposalReads
      ) {
        timer = setTimeout(() => {
          void read();
        }, proposalWait);
      }
    };
    void read();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [core, locale, canManage]);
  const reread = async (): Promise<void> => {
    setAside(await readAside(core, locale, canManage));
  };
  return { aside, reread };
};

/** The page's one line in a card, where the table would be. */
const Note = ({ children }: { children: string }) => (
  <Card>
    <Empty>
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  </Card>
);

const RequestsView = ({ page }: { page: RequestsPage }) => {
  const { t } = useLingui();
  const router = useRouter();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/workflows/requests" });
  const { busy, failure, run } = useCoreAction();
  const canManage = page.canSetPerPerson;
  const { aside, reread } = useAside(canManage);
  const refresh = async (): Promise<void> => {
    await Promise.all([reread(), router.invalidate({ sync: true })]);
  };
  // Only what the person changed, so a change someone else made meanwhile stays.
  const change = async (
    action: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    await run(async (session) => {
      await action(session);
    });
    await router.invalidate({ sync: true });
  };
  const place = search.place ?? null;
  const team = search.team ?? null;
  const narrowed = place !== null || team !== null;
  const month = formatMonth(page.report.from);
  const summary = aside?.summary ?? null;
  const setMinutes = (kind: RequestKind, minutes: number) => {
    void change(async (session) => {
      await session.stephenRequests.updateSettings({
        minutesSaved: { [kind]: minutes },
      });
    });
  };
  return (
    <>
      <PageHeading
        action={
          canManage && summary !== null ? (
            <RequestSummary onChanged={refresh} summary={summary} />
          ) : undefined
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
        canSet={canManage}
        narrowed={narrowed}
        onRange={(range) => {
          void navigate({ search: { ...search, range } });
        }}
        onSetMinutes={setMinutes}
        page={page}
      />
      <ErrorText>{failure}</ErrorText>
      {page.tooFew ? (
        <Note>{t`Fewer than five people: this isn't shown on its own.`}</Note>
      ) : null}
      {!page.tooFew && page.report.total.requests === 0 ? (
        <Note>
          {page.range === "year"
            ? t`No requests in the last twelve months`
            : t`No requests in ${month}`}
        </Note>
      ) : null}
      {!page.tooFew && page.report.total.requests > 0 ? (
        <RequestTable
          busy={busy}
          needs={aside === undefined ? undefined : aside.needs}
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
          <RequestsView page={read.data} />
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
  loader: async ({
    context: { core },
    deps: { range = "month", place, team },
  }) =>
    await loadFromCore(
      core,
      async (session) =>
        await session.stephenRequests.report({
          range,
          place: place ?? null,
          team: team ?? null,
        })
    ),
  component: RequestsRoute,
});
