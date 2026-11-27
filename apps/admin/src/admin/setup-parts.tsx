/**
 * The parts an organization's Setup (src/admin/setup.tsx,
 * src/admin/setup-status.tsx) is laid out with, shared with what staff do
 * there (src/admin/setup-actions.tsx) and its hosting
 * (src/hosting/client-hosting.tsx), set on the page as Grasp Work sets
 * one: a group's name over its facts, the facts as a list of names and
 * values (what needs a look marked amber), a quiet line for what it has
 * none of yet, a form's fields as wide as a form stands, a row of
 * buttons, and an error's code.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import type { KeyValueItem } from "@grasp-os/ui/components/key-value";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { colors, font, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { SubmitEvent, ReactNode } from "react";

const styles = stylex.create({
  code: { fontFamily: font.mono, fontSize: font.textXs },
  failure: {
    margin: 0,
    color: colors.destructive,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  // A form's fields and its buttons, one under the other, as wide as a form stands.
  form: {
    display: "flex",
    flexDirection: "column",
    gap: space["5"],
    minWidth: 0,
    maxWidth: size.formWidth,
  },
  // Buttons on one line, wrapping on a phone, a failure after them.
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["3"],
  },
  // A group's facts, then what staff do about them.
  group: { display: "flex", flexDirection: "column", gap: space["6"] },
});

/** An error code as the section says it: the code alone, as the admin keeps it. */
export const ErrorCode = ({ code }: { code: string }) => (
  <span {...stylex.props(styles.code)}>{code}</span>
);

/** Why the last thing staff did failed, until the next; nothing when it didn't. */
export const Failure = ({ failure }: { failure: ReactNode }) =>
  failure === null || failure === undefined ? null : (
    <p {...stylex.props(styles.failure)} role="alert">
      {failure}
    </p>
  );

/** A line in a group, for what it has none of yet. */
export const Quiet = ({ children }: { children: ReactNode }) => (
  <Empty align="start" size="sm">
    <EmptyHeader>
      <EmptyDescription>{children}</EmptyDescription>
    </EmptyHeader>
  </Empty>
);

/** One fact: its name and value; amber when it needs a look. */
export interface Fact extends Omit<KeyValueItem, "id"> {
  id?: string;
  attention?: boolean;
}

/** A few facts as rows: what each is at the start, the fact at the end. */
export const Facts = ({ rows }: { rows: readonly Fact[] }) => (
  <KeyValueList
    divided
    items={rows.map(({ attention, id, value, ...row }) => ({
      ...row,
      id: id ?? row.label,
      value:
        attention === true ? <Badge variant="warning">{value}</Badge> : value,
    }))}
    orientation="horizontal"
  />
);

/**
 * A named group of the page: its title (and a line, and its own buttons)
 * over what it holds, a region named by its title.
 */
export const Group = ({
  id,
  title,
  description,
  actions,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <Part aria-labelledby={id}>
    <SectionHeader
      actions={actions}
      description={description}
      id={id}
      size="sm"
      title={title}
      variant="group"
    />
    <div {...stylex.props(styles.group)}>{children}</div>
  </Part>
);

/** A form's fields and buttons, as wide as a form stands. */
export const FormStack = ({
  children,
  onSubmit,
}: {
  children: ReactNode;
  onSubmit?: (event: SubmitEvent<HTMLFormElement>) => void;
}) =>
  onSubmit === undefined ? (
    <div {...stylex.props(styles.form)}>{children}</div>
  ) : (
    <form onSubmit={onSubmit} {...stylex.props(styles.form)}>
      {children}
    </form>
  );

/** Buttons on one line, wrapping on a phone. */
export const Actions = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.actions)}>{children}</div>
);
