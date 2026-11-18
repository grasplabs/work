import { failureText } from "@grasp-os/shared/errors";
import type {
  Opportunity,
  OpportunityForm,
} from "@grasp-os/shared/opportunities";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Stat } from "@grasp-os/ui/components/stat";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDecimal, formatList } from "../format.ts";
import { useCore } from "../use-core.ts";
import { draftOf, titleOf } from "./opportunity-drafts.ts";

// Opportunities (GRA-1750): what Grasp could automate or improve, from how
// the company's teams describe their work, for admins. Each is one of a
// team's routines, the largest first, with what it rests on and what
// Grasp proposes; an admin dismisses one until its evidence changes, or
// drafts it (GRA-1751): an App or a workflow in Make something's chat, a
// skill on Skills, each started with what the card shows, under the
// admin's own name (opportunity-drafts.ts). Core holds every rule
// (opportunities.ts): the page only asks.

/** What a call to core came to. */
type Read<T> =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; data: T };

/**
 * Every opportunity, or why not. Outside the components, as the React
 * Compiler can't compile `try`.
 */
const readOpportunities = async (
  core: CoreConnection
): Promise<Read<Opportunity[]>> => {
  try {
    const data = await core.withSession(
      async (session) => await session.opportunities.list()
    );
    return { state: "ready", data };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/** Hides `opportunity` for every admin, or shows it again; why not, when it wasn't. */
const acting = async (
  core: CoreConnection,
  { routine, evidence }: Opportunity,
  hide: boolean
): Promise<string | undefined> => {
  try {
    await core.withSession(async (session) => {
      await (hide
        ? session.opportunities.dismiss({ routine, evidence })
        : session.opportunities.restore({ routine, evidence }));
    });
    return undefined;
  } catch (error) {
    return failureText(error);
  }
};

/** What Grasp proposes, as the page names it; none proposed yet, when it couldn't ask a model. */
const FormBadge = ({ form }: { form: OpportunityForm | null }) => {
  const { t } = useLingui();
  const labels: Record<OpportunityForm, string> = {
    workflow: t({
      message: "A workflow",
      context: "what an opportunity could become",
    }),
    app: t({
      message: "An App",
      context: "what an opportunity could become",
    }),
    skill: t({
      message: "A skill",
      context: "what an opportunity could become",
    }),
    change: t({
      message: "A change to an existing App",
      context: "what an opportunity could become",
    }),
    connection: t({
      message: "A connection only",
      context: "what an opportunity could become",
    }),
  };
  return form === null ? (
    <Badge variant="outline">
      <Trans>Nothing proposed yet</Trans>
    </Badge>
  ) : (
    <Badge variant="secondary">{labels[form]}</Badge>
  );
};

/** One figure of an opportunity, with what it counts under it. */
const Figure = ({ value, label }: { value: number | null; label: string }) => (
  // The term first, as a description list reads; shown under its figure.
  <div className="flex flex-col-reverse gap-1">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <Stat render={<dd />}>{value === null ? "–" : formatDecimal(value)}</Stat>
  </div>
);

/**
 * Draft it: Make something's chat for an App or a workflow, its box
 * filled with the opportunity's brief, or Skills' editor filled with a
 * skill for it; none for a change or a connection alone. Nothing is made
 * or asked of a model until the admin sends or saves it.
 */
const DraftLink = ({ opportunity }: { opportunity: Opportunity }) => {
  const { t, i18n } = useLingui();
  const draft = draftOf(opportunity.form);
  if (draft === null) {
    return null;
  }
  // Named for its opportunity, so a list of the page's links tells them
  // apart; it starts with the words it shows.
  const title = titleOf(opportunity, i18n.locale);
  const named = t({
    message: `Draft it for “${title}”`,
    context: "drafts what an opportunity proposes, named for it",
  });
  const label = (
    <Trans context="drafts what an opportunity proposes">Draft it</Trans>
  );
  const { routine } = opportunity;
  return draft.kind === "skill" ? (
    <Link
      aria-label={named}
      className={buttonVariants({ size: "sm" })}
      search={{ opportunity: routine }}
      to="/brain/skills"
    >
      {label}
    </Link>
  ) : (
    <Link
      aria-label={named}
      className={buttonVariants({ size: "sm" })}
      search={{ make: draft.kind, opportunity: routine }}
      to="/"
    >
      {label}
    </Link>
  );
};

/** One opportunity, as its card shows it. */
const OpportunityCard = ({
  opportunity,
  busy,
  onDismiss,
}: {
  opportunity: Opportunity;
  busy: boolean;
  onDismiss: () => void;
}) => {
  const { t, i18n } = useLingui();
  const { steps, covers, setup, personApproves } = opportunity;
  const approves = new Set(personApproves);
  const systems = formatList(setup);
  const app = covers?.name ?? "";
  return (
    <Card>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-medium">
                {titleOf(opportunity, i18n.locale)}
              </h2>
              <p className="text-muted-foreground text-sm">
                <Trans>Described in the team&apos;s interviews.</Trans>
              </p>
            </div>
            <FormBadge form={opportunity.form} />
          </div>
          <dl className="flex flex-wrap gap-8">
            <Figure label={t`Hours a week`} value={opportunity.hoursPerWeek} />
            <Figure label={t`Cases a week`} value={opportunity.casesPerWeek} />
          </dl>
          {covers === null ? null : (
            <p className="text-sm">
              <Trans>
                Already covered by{" "}
                <Link
                  className="underline underline-offset-4"
                  params={{ app: covers.app }}
                  to="/apps/$app"
                >
                  {app}
                </Link>
                : a change to it, nothing new.
              </Trans>
            </p>
          )}
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
            {steps.map((step, at) => (
              <li key={`${at}:${step}`}>
                <span className="mr-2">{step}</span>
                {approves.has(at + 1) ? (
                  <Badge variant="attention">
                    <Trans>A person approves</Trans>
                  </Badge>
                ) : null}
              </li>
            ))}
          </ol>
          {setup.length === 0 ? null : (
            <p className="text-sm">
              <Trans>Connect first: {systems}.</Trans>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <DraftLink opportunity={opportunity} />
            <Button
              disabled={busy}
              onClick={onDismiss}
              size="sm"
              type="button"
              variant="outline"
            >
              <Trans context="hides an opportunity for every admin until its evidence changes">
                Hide for every admin
              </Trans>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

/** The opportunities an admin hid, each with a way to show it again. */
const Dismissed = ({
  dismissed,
  busy,
  onRestore,
}: {
  dismissed: readonly Opportunity[];
  busy: boolean;
  onRestore: (opportunity: Opportunity) => void;
}) => {
  const { i18n } = useLingui();
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">
        <Trans context="opportunities hidden for every admin">Hidden</Trans>
      </h2>
      <p className="text-muted-foreground text-sm">
        <Trans>
          Hidden for every admin until their evidence changes, or until one of
          you shows them again.
        </Trans>
      </p>
      <ul className="flex flex-col gap-2">
        {dismissed.map((opportunity) => (
          <li
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
            key={opportunity.routine}
          >
            <span>{titleOf(opportunity, i18n.locale)}</span>
            <Button
              disabled={busy}
              onClick={() => {
                onRestore(opportunity);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <Trans context="shows a hidden opportunity again for every admin">
                Show again
              </Trans>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** The admin's Opportunities page. */
export const OpportunitiesPage = () => {
  const core = useCore();
  const { i18n } = useLingui();
  const [read, setRead] = useState<Read<Opportunity[]>>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  // The one hidden last on this page, with Undo, until the page is left.
  const [hidden, setHidden] = useState<Opportunity | undefined>();

  useEffect(() => {
    let current = true;
    void (async () => {
      const answer = await readOpportunities(core);
      if (current) {
        setRead(answer);
      }
    })();
    return () => {
      current = false;
    };
  }, [core]);

  /** Hides `opportunity` for every admin, or shows it again. */
  const act = (opportunity: Opportunity, hide: boolean) => {
    setBusy(true);
    setFailed(undefined);
    void (async () => {
      const refused = await acting(core, opportunity, hide);
      setBusy(false);
      if (refused !== undefined) {
        setFailed(refused);
        return;
      }
      setHidden(hide ? opportunity : undefined);
      setRead((now) =>
        now.state === "ready"
          ? {
              state: "ready",
              data: now.data.map((each) =>
                each.routine === opportunity.routine
                  ? { ...each, dismissed: hide }
                  : each
              ),
            }
          : now
      );
    })();
  };

  const all = read.state === "ready" ? read.data : [];
  const open = all.filter(({ dismissed }) => !dismissed);
  const dismissed = all.filter(({ dismissed: hiddenNow }) => hiddenNow);
  const hiddenTitle = hidden === undefined ? "" : titleOf(hidden, i18n.locale);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="pb-chat mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-8 md:px-12">
        <PageHeader>
          <PageHeaderTitle>
            <Trans context="the Brain's opportunities page">
              Opportunities
            </Trans>
          </PageHeaderTitle>
          <PageHeaderDescription>
            <Trans>
              What Grasp could automate or improve, from how your teams describe
              their work, the largest first. One hidden comes back when its
              evidence changes.
            </Trans>
          </PageHeaderDescription>
        </PageHeader>
        {read.state === "refused" ? (
          <ErrorText>{read.message}</ErrorText>
        ) : null}
        {failed === undefined ? null : <ErrorText>{failed}</ErrorText>}
        {hidden === undefined ? null : (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>
              <Trans>
                {hiddenTitle} is hidden for every admin until its evidence
                changes.
              </Trans>
            </span>
            <Button
              disabled={busy}
              onClick={() => {
                act(hidden, false);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <Trans context="shows the opportunity just hidden again">
                Undo
              </Trans>
            </Button>
          </div>
        )}
        {read.state === "ready" && all.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                <Trans>No opportunities yet</Trans>
              </EmptyTitle>
              <EmptyDescription>
                <Trans>
                  They appear once your teams&apos; interviews describe how
                  their work runs.
                </Trans>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {open.length > 0 ? (
          <ul className="flex flex-col gap-4">
            {open.map((opportunity) => (
              <li key={opportunity.routine}>
                <OpportunityCard
                  busy={busy}
                  onDismiss={() => {
                    act(opportunity, true);
                  }}
                  opportunity={opportunity}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {dismissed.length > 0 ? (
          <Dismissed
            busy={busy}
            dismissed={dismissed}
            onRestore={(opportunity) => {
              act(opportunity, false);
            }}
          />
        ) : null}
      </div>
    </div>
  );
};
