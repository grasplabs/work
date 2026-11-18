import { failureText } from "@grasp-os/shared/errors";
import type {
  Opportunity,
  OpportunityBasis,
  OpportunityForm,
  SeenRoutine,
  SeenStep,
} from "@grasp-os/shared/opportunities";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
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
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDecimal, formatList } from "../format.ts";
import { useCore } from "../use-core.ts";

// Opportunities (GRA-1750): what Grasp could automate or improve, from how
// the company's teams describe their work and how five or more of a team
// were seen doing it (GRA-1764), for admins. Each is one of a team's
// routines, the largest first, with what it rests on and what Grasp
// proposes; an admin dismisses one until its evidence changes. Core holds
// every rule (opportunities.ts): the page only asks.

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

/** A work's name as a title: starting with a capital, for display alone (it is named in lower case, as an activity: onboarding/team-map.ts). */
const titleOf = ({ name, local }: Opportunity, locale: string): string => {
  const title = `${name.slice(0, 1).toLocaleUpperCase(locale)}${name.slice(1)}`;
  return local === undefined ? title : `${title} (${local})`;
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

/** Where an opportunity's evidence comes from, as its card says it. */
const BasisText = ({ basis }: { basis: OpportunityBasis }) => {
  if (basis === "observed") {
    return <Trans>Seen in the team&apos;s activity.</Trans>;
  }
  if (basis === "both") {
    return (
      <Trans>
        Described in the team&apos;s interviews, and seen in its activity.
      </Trans>
    );
  }
  return <Trans>Described in the team&apos;s interviews.</Trans>;
};

/** How long after the step before one comes, as people take it. */
const AfterText = ({ hours }: { hours: number }) => {
  const { t } = useLingui();
  return hours === 0
    ? t`Within the hour of the step before`
    : t`${plural(hours, {
        one: "# hour after the step before",
        other: "# hours after the step before",
      })}`;
};

/** One step seen, with when it comes and whether it copies data. */
const SeenStepItem = ({
  seen: { system, step, hoursAfter, copied },
}: {
  seen: SeenStep;
}) => (
  <li>
    <div className="flex flex-wrap items-center gap-2">
      <span>
        <Trans context="a system and a step taken in it">
          {system}: {step}
        </Trans>
      </span>
      {copied ? (
        <Badge variant="attention">
          <Trans>Copied from another system</Trans>
        </Badge>
      ) : null}
    </div>
    {hoursAfter === null ? null : (
      <p className="text-muted-foreground text-xs">
        <AfterText hours={hoursAfter} />
      </p>
    )}
  </li>
);

/** What was seen of a routine in activity: its steps, and what some do instead. */
const SeenSection = ({ seen }: { seen: SeenRoutine }) => (
  <section className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">
      <Trans>Seen in activity</Trans>
    </h3>
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
      {seen.steps.map((step, at) => (
        <SeenStepItem key={`${at}:${step.system}:${step.step}`} seen={step} />
      ))}
    </ol>
    {seen.variants.length === 0 ? null : (
      <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
        {seen.variants.map(({ after, system, step }) => {
          const position = after + 1;
          return (
            <li key={`${after}:${system}:${step}`}>
              <Trans>
                After step {position}, some go to {system}: {step}
              </Trans>
            </li>
          );
        })}
      </ul>
    )}
  </section>
);

/** Where what a team described and what it was seen doing differ, by system. */
const DiffersText = ({
  differs,
}: {
  differs: NonNullable<Opportunity["differs"]>;
}) => {
  const seenOnly = formatList(differs.seenOnly);
  const toldOnly = formatList(differs.toldOnly);
  if (differs.seenOnly.length === 0 && differs.toldOnly.length === 0) {
    return (
      <p className="text-sm">
        <Trans>
          What was described and what was seen use the same systems.
        </Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      {differs.seenOnly.length === 0 ? null : (
        <p>
          <Trans>Seen, but not described: {seenOnly}.</Trans>
        </p>
      )}
      {differs.toldOnly.length === 0 ? null : (
        <p>
          <Trans>Described, but not seen: {toldOnly}.</Trans>
        </p>
      )}
    </div>
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
  const { steps, covers, setup, personApproves, seen, differs } = opportunity;
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
                <BasisText basis={opportunity.basis} />
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
          {steps.length === 0 ? null : (
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
          )}
          {setup.length === 0 ? null : (
            <p className="text-sm">
              <Trans>Connect first: {systems}.</Trans>
            </p>
          )}
          {seen === null ? null : <SeenSection seen={seen} />}
          {differs === null ? null : <DiffersText differs={differs} />}
          <div>
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
              their work and how five or more of a team were seen doing it, the
              largest first. One hidden comes back when its evidence changes.
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
