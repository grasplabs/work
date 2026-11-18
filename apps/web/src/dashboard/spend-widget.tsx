import type {
  ModelMonthSpend,
  WorkflowMonthSpend,
} from "@grasp-os/shared/models";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { RouterLink } from "../frame/router-link.tsx";
import { ChevronRight, Icon } from "../grasp/icons/index.ts";
import { Stat } from "../grasp/stats/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { dollars } from "../settings/money.ts";
import { costPerRun, spendShown } from "./spend.ts";
import { useFull, WidgetBlock } from "./widget-block.tsx";

const styles = stylex.create({
  list: { margin: 0, padding: 0, listStyle: "none" },
  line: {
    display: "flex",
    alignItems: "baseline",
    columnGap: grasp.space3,
    paddingBlock: grasp.space2,
    borderTopWidth: grasp.hairline,
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
  },
  names: { display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 },
  amounts: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    flexShrink: 0,
  },
  figures: { fontVariantNumeric: "tabular-nums" },
  // The way to Settings stands at the block's foot.
  foot: { marginBlockStart: "auto" },
  footWords: {
    display: "inline-flex",
    alignItems: "center",
    columnGap: grasp.space1,
  },
});

// The AI spend widget of the dashboard's board, for admins: what the
// models cost this month, budget or not, and the workflows that spent
// most, each with what one run of it cost. Settings → AI spend has the
// rest: budgets and each binding.

/** A workflow that spent this month, by its name, which opens it while core still has it. */
const WorkflowName = ({ workflow }: { workflow: WorkflowMonthSpend }) => {
  const name = workflow.name ?? workflow.workflowId;
  if (workflow.appId === null && workflow.name !== null) {
    return (
      <Text element="span" wrap="truncate">
        <RouterLink
          params={{ workflow: workflow.workflowId }}
          to="/workflows/$workflow"
          variant="standalone"
        >
          {name}
        </RouterLink>
      </Text>
    );
  }
  return (
    <Text element="span" wrap="truncate">
      {name}
    </Text>
  );
};

/** A workflow that spent this month: its name, its App for an App's, and what a run cost. */
const SpendLine = ({ workflow }: { workflow: WorkflowMonthSpend }) => {
  const { t } = useLingui();
  const domain =
    workflow.appId === null ? null : (workflow.appName ?? workflow.appId);
  const perRun = costPerRun(workflow);
  const amount = dollars(workflow.amount);
  const each = perRun === null ? null : dollars(perRun);
  return (
    <li {...stylex.props(styles.line)}>
      <span {...stylex.props(styles.names)}>
        <WorkflowName workflow={workflow} />
        {domain === null ? null : (
          <Text element="span" size="xs" tone="muted" wrap="truncate">
            {domain}
          </Text>
        )}
      </span>
      <span {...stylex.props(styles.amounts)}>
        <span {...stylex.props(styles.figures)}>
          {each === null ? amount : t`${each} a run`}
        </span>
        {each === null ? null : (
          <Text element="span" size="xs" tone="muted">
            <span {...stylex.props(styles.figures)}>
              <Trans>{amount} in all</Trans>
            </span>
          </Text>
        )}
      </span>
    </li>
  );
};

/** The month's total, then the workflows that spent most: a few in the block, all core sent in full. */
const SpendView = ({ spend }: { spend: ModelMonthSpend }) => {
  const { t } = useLingui();
  const full = useFull();
  const total = dollars(spend.total);
  const shown = full ? spend.workflows : spend.workflows.slice(0, spendShown);
  return (
    <>
      <Stat title={t`For every model call this month`} value={total} />
      {shown.length === 0 ? (
        <Text tone="muted">
          <Trans>No workflow has called a model this month.</Trans>
        </Text>
      ) : (
        <ul
          aria-label={t`Workflows that spent most`}
          {...stylex.props(styles.list)}
        >
          {shown.map((workflow) => (
            <SpendLine
              key={JSON.stringify([workflow.appId, workflow.workflowId])}
              workflow={workflow}
            />
          ))}
        </ul>
      )}
      <Text element="div" layout={styles.foot} tone="muted">
        <RouterLink to="/settings/ai-providers" variant="standalone">
          <span {...stylex.props(styles.footWords)}>
            <Trans>AI spend in Settings</Trans>
            <Icon icon={ChevronRight} />
          </span>
        </RouterLink>
      </Text>
    </>
  );
};

/** The AI spend widget, titled `title`: in full, every workflow core listed. */
export const SpendWidget = ({
  spend,
  title,
}: {
  spend: ModelMonthSpend;
  title: string;
}) => (
  <WidgetBlock
    full={
      spend.workflows.length > spendShown ? (
        <SpendView spend={spend} />
      ) : undefined
    }
    title={title}
  >
    <SpendView spend={spend} />
  </WidgetBlock>
);
