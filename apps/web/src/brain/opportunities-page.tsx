import { failureText } from "@grasp-os/shared/errors";
import type {
  Opportunity,
  OpportunityForm,
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
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { useCore } from "../use-core.ts";

// Opportunities (GRA-1750): what Grasp could automate or improve, from how
// the company's teams describe their work, for admins. Each is one of a
// team's routines, the largest first, with what it rests on and what
// Grasp proposes; an admin dismisses one until its evidence changes. Core
// holds every rule (opportunities.ts): the page only asks.

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

/** Dismisses `opportunity`; why not, when it wasn't. */
const dismissing = async (
  core: CoreConnection,
  { routine, evidence }: Opportunity
): Promise<string | undefined> => {
  try {
    await core.withSession(async (session) => {
      await session.opportunities.dismiss({ routine, evidence });
    });
    return undefined;
  } catch (error) {
    return failureText(error);
  }
};

/** What Grasp proposes, as the page names it. */
const FormBadge = ({ form }: { form: OpportunityForm }) => {
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
  return <Badge variant="secondary">{labels[form]}</Badge>;
};

/** One figure of an opportunity, with what it counts under it. */
const Figure = ({ value, label }: { value: number | null; label: string }) => (
  <div className="flex flex-col gap-1">
    <Stat render={<dd />}>{value ?? "–"}</Stat>
    <dt className="text-muted-foreground order-last text-xs">{label}</dt>
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
  const { t } = useLingui();
  const { name, local, steps, covers, setup, personApproves } = opportunity;
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
                {local === undefined ? name : `${name} (${local})`}
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
              <li key={step}>
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
          <div>
            <Button
              disabled={busy}
              onClick={onDismiss}
              size="sm"
              type="button"
              variant="outline"
            >
              <Trans>Dismiss</Trans>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

/** The admin's Opportunities page. */
export const OpportunitiesPage = () => {
  const core = useCore();
  const [read, setRead] = useState<Read<Opportunity[]>>({ state: "loading" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();

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

  const dismiss = (opportunity: Opportunity) => {
    setBusy(true);
    setFailed(undefined);
    void (async () => {
      const refused = await dismissing(core, opportunity);
      setBusy(false);
      if (refused !== undefined) {
        setFailed(refused);
        return;
      }
      setRead((now) =>
        now.state === "ready"
          ? {
              state: "ready",
              data: now.data.filter(
                ({ routine }) => routine !== opportunity.routine
              ),
            }
          : now
      );
    })();
  };

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
              their work, the largest first. A dismissed one comes back when its
              evidence changes.
            </Trans>
          </PageHeaderDescription>
        </PageHeader>
        {read.state === "refused" ? (
          <ErrorText>{read.message}</ErrorText>
        ) : null}
        {failed === undefined ? null : <ErrorText>{failed}</ErrorText>}
        {read.state === "ready" && read.data.length === 0 ? (
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
        {read.state === "ready" ? (
          <ul className="flex flex-col gap-4">
            {read.data.map((opportunity) => (
              <li key={opportunity.routine}>
                <OpportunityCard
                  busy={busy}
                  onDismiss={() => {
                    dismiss(opportunity);
                  }}
                  opportunity={opportunity}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
};
