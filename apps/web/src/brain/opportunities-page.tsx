import { failureText } from "@grasp-os/shared/errors";
import type {
  Opportunity,
  OpportunityBasis,
  OpportunityForm,
  SeenRoutine,
  SeenStep,
} from "@grasp-os/shared/opportunities";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDecimal, formatList } from "../format.ts";
import { RouterLink } from "../frame/router-link.tsx";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { PageColumn } from "../grasp/page-column/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { StatsGrid } from "../grasp/stats/index.ts";
import { Tag } from "../grasp/tag/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCore } from "../use-core.ts";
import { draftOf, titleOf } from "./opportunity-drafts.ts";

// Opportunities (GRA-1750): what Grasp could automate or improve, from how
// the company's teams describe their work and how five or more of a team
// were seen doing it (GRA-1764), for admins. Each is one of a team's
// routines, the largest first, with what it rests on and what Grasp
// proposes; an admin dismisses one until its evidence changes, or drafts
// it (GRA-1751): an App or a workflow in Make something's chat, a skill on
// Skills, each started with what the card shows, under the admin's own
// name (opportunity-drafts.ts). Core holds every rule (opportunities.ts):
// the page only asks.

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

const styles = stylex.create({
  // A page of the brain: its own pane that scrolls, round the library's page column.
  pane: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  section: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  card: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: grasp.space3,
  },
  words: { display: "flex", flexDirection: "column", gap: grasp.space1 },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  cards: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // A routine's steps, numbered.
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    margin: 0,
    paddingInlineStart: grasp.space5,
    listStyleType: "decimal",
  },
  plain: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
});

/** What Grasp proposes, as the page names it; none proposed yet, when it couldn't ask a model. */
const FormTag = ({ form }: { form: OpportunityForm | null }) => {
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
    <Tag size="sm" variant="outline">
      {t`Nothing proposed yet`}
    </Tag>
  ) : (
    <Tag size="sm">{labels[form]}</Tag>
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
    <span {...stylex.props(styles.row)}>
      <Text element="span" size="sm">
        <Trans context="a system and a step taken in it">
          {system}: {step}
        </Trans>
      </Text>
      {copied ? (
        <Badge size="sm" tone="attention">
          <Trans>Copied from another system</Trans>
        </Badge>
      ) : null}
    </span>
    {hoursAfter === null ? null : (
      <Text size="xs" tone="muted">
        <AfterText hours={hoursAfter} />
      </Text>
    )}
  </li>
);

/** What was seen of a routine in activity: its steps, and what some do instead. */
const SeenSection = ({ seen }: { seen: SeenRoutine }) => (
  <section {...stylex.props(styles.words)}>
    <Heading level={3} size="ui-sm">
      <Trans>Seen in activity</Trans>
    </Heading>
    <ol {...stylex.props(styles.steps)}>
      {seen.steps.map((step, at) => (
        <SeenStepItem key={`${at}:${step.system}:${step.step}`} seen={step} />
      ))}
    </ol>
    {seen.variants.length === 0 ? null : (
      <ul {...stylex.props(styles.plain)}>
        {seen.variants.map(({ after, system, step }) => {
          const position = after + 1;
          return (
            <li key={`${after}:${system}:${step}`}>
              <Text size="sm" tone="muted">
                <Trans>
                  After step {position}, some go to {system}: {step}
                </Trans>
              </Text>
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
  // Null until a proposal says which systems the description names: then
  // nothing is said of those described and not seen, nor that they match.
  const toldOnlyList = differs.toldOnly ?? [];
  const toldOnly = formatList(toldOnlyList);
  if (
    differs.toldOnly !== null &&
    differs.seenOnly.length === 0 &&
    toldOnlyList.length === 0
  ) {
    return (
      <Text size="sm">
        <Trans>
          What was described and what was seen use the same systems.
        </Trans>
      </Text>
    );
  }
  return (
    <div {...stylex.props(styles.words)}>
      {differs.seenOnly.length === 0 ? null : (
        <Text size="sm">
          <Trans>Seen, but not described: {seenOnly}.</Trans>
        </Text>
      )}
      {toldOnlyList.length === 0 ? null : (
        <Text size="sm">
          <Trans>Described, but not seen: {toldOnly}.</Trans>
        </Text>
      )}
    </div>
  );
};

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
  const label = t({
    message: "Draft it",
    context: "drafts what an opportunity proposes",
  });
  const { routine } = opportunity;
  return (
    <Button
      aria-label={named}
      render={
        draft.kind === "skill" ? (
          <Link search={{ opportunity: routine }} to="/brain/skills" />
        ) : (
          <Link search={{ make: draft.kind, opportunity: routine }} to="/" />
        )
      }
      size="sm"
      variant="quiet"
    >
      {label}
    </Button>
  );
};

/** A figure of an opportunity, or a dash for one not known. */
const figure = (value: number | null): string =>
  value === null ? "–" : formatDecimal(value);

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
    <Card element="li" padding="lg">
      <div {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.head)}>
          <div {...stylex.props(styles.words)}>
            <Heading level={2} size="ui">
              {titleOf(opportunity, i18n.locale)}
            </Heading>
            <Text size="sm" tone="muted">
              <BasisText basis={opportunity.basis} />
            </Text>
          </div>
          <FormTag form={opportunity.form} />
        </div>
        <StatsGrid
          aria-label={t`What it takes now`}
          columns={2}
          items={[
            {
              title: t`Hours a week`,
              value: figure(opportunity.hoursPerWeek),
              bare: true,
            },
            {
              title: t`Cases a week`,
              value: figure(opportunity.casesPerWeek),
              bare: true,
            },
          ]}
        />
        {covers === null ? null : (
          <Text size="sm">
            <Trans>
              Already covered by{" "}
              <RouterLink params={{ app: covers.app }} to="/apps/$app">
                {app}
              </RouterLink>
              : a change to it, nothing new.
            </Trans>
          </Text>
        )}
        {steps.length === 0 ? null : (
          <ol {...stylex.props(styles.steps)}>
            {steps.map((step, at) => (
              <li key={`${at}:${step}`}>
                <span {...stylex.props(styles.row)}>
                  <Text element="span" size="sm">
                    {step}
                  </Text>
                  {approves.has(at + 1) ? (
                    <Badge size="sm" tone="attention">
                      <Trans>A person approves</Trans>
                    </Badge>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
        {setup.length === 0 ? null : (
          <Text size="sm">
            <Trans>Connect first: {systems}.</Trans>
          </Text>
        )}
        {seen === null ? null : <SeenSection seen={seen} />}
        {differs === null ? null : <DiffersText differs={differs} />}
        <div {...stylex.props(styles.row)}>
          <DraftLink opportunity={opportunity} />
          <Button
            disabled={busy}
            onClick={onDismiss}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t({
              message: "Hide for every admin",
              context:
                "hides an opportunity for every admin until its evidence changes",
            })}
          </Button>
        </div>
      </div>
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
  const { t, i18n } = useLingui();
  return (
    <section {...stylex.props(styles.section)}>
      <Heading level={2} size="ui-sm">
        <Trans context="opportunities hidden for every admin">Hidden</Trans>
      </Heading>
      <Text size="sm" tone="muted">
        <Trans>
          Hidden for every admin until their evidence changes, or until one of
          you shows them again.
        </Trans>
      </Text>
      <ItemGroup separated>
        {dismissed.map((opportunity) => (
          <Item key={opportunity.routine} size="xs">
            <ItemContent>
              <ItemTitle>{titleOf(opportunity, i18n.locale)}</ItemTitle>
            </ItemContent>
            <ItemActions>
              <Button
                disabled={busy}
                onClick={() => {
                  onRestore(opportunity);
                }}
                size="sm"
                type="button"
                variant="quiet"
              >
                {t({
                  message: "Show again",
                  context: "shows a hidden opportunity again for every admin",
                })}
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </section>
  );
};

/** The admin's Opportunities page. */
export const OpportunitiesPage = () => {
  const core = useCore();
  const { i18n, t } = useLingui();
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
    // A page of the brain: the title in the serif, in the library's page column.
    <div {...stylex.props(styles.pane)}>
      <PageColumn measure="page">
        <PageHeader
          description={<Trans>What Grasp could automate, largest first.</Trans>}
          title={
            <Trans context="the Brain's opportunities page">
              Opportunities
            </Trans>
          }
        />
        {read.state === "refused" ? (
          <ErrorText>{read.message}</ErrorText>
        ) : null}
        {failed === undefined ? null : <ErrorText>{failed}</ErrorText>}
        {hidden === undefined ? null : (
          <div {...stylex.props(styles.row)}>
            <Text element="span" size="sm">
              <Trans>
                {hiddenTitle} is hidden for every admin until its evidence
                changes.
              </Trans>
            </Text>
            <Button
              disabled={busy}
              onClick={() => {
                act(hidden, false);
              }}
              size="sm"
              type="button"
              variant="quiet"
            >
              {t({
                message: "Undo",
                context: "shows the opportunity just hidden again",
              })}
            </Button>
          </div>
        )}
        {read.state === "ready" && all.length === 0 ? (
          <Empty size="section">
            <EmptyHeader>
              <EmptyTitle headingLevel={2}>
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
          <ul {...stylex.props(styles.cards)}>
            {open.map((opportunity) => (
              <OpportunityCard
                busy={busy}
                key={opportunity.routine}
                onDismiss={() => {
                  act(opportunity, true);
                }}
                opportunity={opportunity}
              />
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
      </PageColumn>
    </div>
  );
};
