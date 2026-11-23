import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldStatus,
  FieldTitle,
} from "@grasp-os/ui/components/field";
import type { FieldStatusValue } from "@grasp-os/ui/components/field";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Text } from "@grasp-os/ui/components/text";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Icon, InfoIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import type { Session } from "../core.ts";

// The agents pages in Damsko's settings pattern (its docs, Patterns ›
// Settings): a topic is one small flush Card, its title on the page just
// above it (SectionHeader variant="group"), its rows inside, each a
// responsive Field with its control or its value on one end edge. More
// about a topic or a row stands behind an info mark beside its name, said
// on hover and focus. A row that saves as it changes says so beside its
// control (`useRowSave`, FieldStatus): a spinner, then a tick; failed, its
// value kept and Try again.

/** What a page change asks of core, then the page read again: whether it went through. */
export type Change = (
  action: (session: Session) => Promise<unknown>
) => Promise<boolean>;

/**
 * Follows a row's save as it changes (`save`, given the work, which says
 * whether it went through), and says it beside the row's control
 * (`status`, for SettingRow): a spinner, then a tick; failed, Try again.
 */
export const useRowSave = () => {
  const [status, setStatus] = useState<FieldStatusValue>("idle");
  const [last, setLast] = useState<() => Promise<boolean>>();
  const save = async (work: () => Promise<boolean>): Promise<void> => {
    setLast(() => work);
    setStatus("loading");
    setStatus((await work()) ? "success" : "error");
  };
  const handleRetry = () => {
    if (last !== undefined) {
      void save(last);
    }
  };
  return {
    status: <FieldStatus onRetry={handleRetry} status={status} />,
    save,
  };
};

const styles = stylex.create({
  // A group's title a small step over its card, its words where the rows' start.
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space["2"],
    minWidth: 0,
  },
  head: { paddingInline: space.tableCellInline },
  // A fact's value fills the control column, from its start, as the
  // reference's fact rows have it.
  value: { display: "block", width: "100%", textAlign: "start" },
  // A row's name and its info mark, on one line.
  named: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
  },
});

/** More about something, behind an info mark: said on hover and focus. */
export const InfoTip = ({ children }: { children: string }) => {
  const { t } = useLingui();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={t`More about this`} size="icon-xs" variant="ghost">
          <Icon icon={InfoIcon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
};

/** A topic of a page: its title over a flush card that holds its rows. */
export const SettingsCard = ({
  title,
  description,
  info,
  badge,
  actions,
  "aria-label": label,
  children,
}: {
  /** Its title on the page, over the card; left out, `aria-label` names the card. */
  title?: string;
  description?: ReactNode;
  /** More about the topic, behind an info mark beside its title. */
  info?: string;
  /** Beside the title: a mark such as the agent as it looks now. */
  badge?: ReactNode;
  /** At the end of the title's row: the topic's own button. */
  actions?: ReactNode;
  "aria-label"?: string;
  children: ReactNode;
}) => {
  const id = useId();
  const card = (
    <Card size="sm" {...(title === undefined ? { "aria-label": label } : {})}>
      <CardContent flush>{children}</CardContent>
    </Card>
  );
  if (title === undefined) {
    return card;
  }
  const aside =
    info === undefined && badge === undefined ? undefined : (
      <>
        {info === undefined ? null : <InfoTip>{info}</InfoTip>}
        {badge}
      </>
    );
  return (
    <section aria-labelledby={id} {...stylex.props(styles.group)}>
      <div {...stylex.props(styles.head)}>
        <SectionHeader
          actions={actions}
          badge={aside}
          description={description}
          id={id}
          title={title}
          variant="group"
        />
      </div>
      {card}
    </section>
  );
};

/** A row's words: its name (with its info mark) and one short line under it. */
const RowWords = ({
  label,
  help,
  info,
  control,
}: {
  label: string;
  help?: ReactNode;
  info?: string | undefined;
  /** Whether the row holds a control its name labels. */
  control: boolean;
}) => {
  const name = control ? (
    <FieldLabel>{label}</FieldLabel>
  ) : (
    <FieldTitle>{label}</FieldTitle>
  );
  return (
    <FieldContent>
      {info === undefined ? (
        name
      ) : (
        <span {...stylex.props(styles.named)}>
          {name}
          <InfoTip>{info}</InfoTip>
        </span>
      )}
      {help === undefined ? null : <FieldDescription>{help}</FieldDescription>}
    </FieldContent>
  );
};

/** A setting: its name and a line on it, its control on the end edge. */
export const SettingRow = ({
  label,
  help,
  info,
  saving,
  children,
}: {
  label: string;
  help?: ReactNode;
  info?: string | undefined;
  /** Its save as it changes, beside the control (`useRowSave`). */
  saving?: ReactNode;
  children: ReactNode;
}) => (
  <Field orientation="responsive">
    <RowWords control help={help} info={info} label={label} />
    {children}
    {saving}
  </Field>
);

/** A fact: its name, and its value on the end edge where the controls stand. */
export const FactRow = ({
  label,
  help,
  info,
  children,
}: {
  label: string;
  help?: ReactNode;
  info?: string | undefined;
  children: ReactNode;
}) => (
  <Field orientation="responsive">
    <RowWords control={false} help={help} info={info} label={label} />
    <span {...stylex.props(styles.value)}>
      <Text as="span" color="default" size="sm">
        {children}
      </Text>
    </span>
  </Field>
);
