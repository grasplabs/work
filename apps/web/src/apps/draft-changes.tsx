import type { AppReview } from "@grasp-os/shared/app-review";
import type {
  FileDiff,
  ReviewedRowRule,
  TableRowRules,
} from "@grasp-os/shared/apps";
import type { Permission } from "@grasp-os/shared/permissions";
import { Badge } from "@grasp-os/ui/components/badge";
import { DiffViewerFiles } from "@grasp-os/ui/components/diff-viewer";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, KeyIcon, UsersIcon } from "@grasp-os/ui/lib/icons";
import { font, space } from "@grasp-os/ui/lib/tokens.stylex";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";
import { PlanList, planLines } from "./data-model-changes.tsx";

// What publishing an App's draft changes, as Publish's dialog
// (drafts/share-with-team.tsx) shows it before the person publishes, and
// History (drafts/draft-history.tsx) of a version against the one before
// it: its files, grouped by what they are, each with its diff (the
// Damsko's DiffViewerFiles); what it does to the App's data; and the access
// the App waits for. All as core worked it out (`apps.review`), never as
// whoever wrote the draft says.

/** What a changed file is part of: its group in the list. */
export type FileGroup = "pages" | "functions" | "data" | "tests" | "other";

export const groupOrder: readonly FileGroup[] = [
  "pages",
  "functions",
  "data",
  "tests",
  "other",
];

const groupNames = {
  pages: msg({ message: "Pages", context: "files of an App" }),
  functions: msg({ message: "Functions", context: "files of an App" }),
  data: msg({ message: "Data model", context: "files of an App" }),
  tests: msg({ message: "Tests", context: "files of an App" }),
  other: msg({ message: "Other files", context: "files of an App" }),
} as const satisfies Record<FileGroup, unknown>;

/**
 * The group of the file at `path`, by where an App keeps it: its
 * definition and schema are its data model, the rest of its server code
 * its functions.
 */
export const groupOf = (path: string): FileGroup => {
  if (path === "definition.json" || path === "server/schema.ts") {
    return "data";
  }
  if (path.startsWith("src/")) {
    return "pages";
  }
  if (
    path.startsWith("server/") ||
    path === "grasp.config.ts" ||
    path === "values.ts"
  ) {
    return "functions";
  }
  return path.startsWith("tests/") ? "tests" : "other";
};

const styles = stylex.create({
  stack: { display: "grid", gap: space[3], minWidth: 0 },
  list: {
    display: "grid",
    gap: space[1],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  path: { fontFamily: font.mono, overflowWrap: "anywhere" },
  tight: { display: "grid", gap: space[1], minWidth: 0 },
  line: { display: "flex", alignItems: "flex-start", gap: space[2] },
  start: { display: "grid", justifyItems: "start", gap: space[1] },
});

/** A part of what changes: its heading, and what it says. */
export const ChangesSection = ({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) => (
  <section {...stylex.props(styles.tight)}>
    <Heading level={3} size="xs">
      {title}
    </Heading>
    {children}
  </section>
);

/** The draft's files that differ from the live version's, grouped. */
export const FileChanges = ({ files }: { files: readonly FileDiff[] }) => {
  const { i18n } = useLingui();
  return (
    <div {...stylex.props(styles.stack)}>
      {groupOrder.map((group) => {
        const inGroup = files.filter(({ path }) => groupOf(path) === group);
        return inGroup.length === 0 ? null : (
          <div key={group} {...stylex.props(styles.tight)}>
            <Text as="span" size="xs" color="muted">
              {i18n._(groupNames[group])}
            </Text>
            <DiffViewerFiles files={inGroup} total={false} />
          </div>
        );
      })}
    </div>
  );
};

/** What publishing does to the App's records, line by line, migrations last. */
export const DataChanges = ({
  changes,
}: {
  changes: Pick<AppReview, "plan" | "migrations">;
}) => {
  const { i18n } = useLingui();
  const lines = changes.plan === null ? [] : planLines(changes.plan, i18n);
  const migrations = changes.migrations ?? [];
  if (lines.length === 0 && migrations.length === 0) {
    return (
      <Text size="sm" color="muted">
        <Trans>The App&apos;s data stays as it is.</Trans>
      </Text>
    );
  }
  return (
    <div {...stylex.props(styles.tight)}>
      <PlanList lines={lines} />
      {migrations.map(({ name, table }) => (
        <Text key={name} size="sm" color="muted">
          <Trans>
            The migration {name} rewrites every record of {table} once your team
            has this version.
          </Trans>
        </Text>
      ))}
    </div>
  );
};

const objectNames = {
  connection: msg`A connection`,
  workflow: msg`A workflow`,
  app: msg`Another App`,
  platform: msg`Grasp itself`,
} as const satisfies Record<Permission["object"]["type"], unknown>;

/** What a permission lets the App do, in a line: what, as which name, which actions. */
const permissionText = (permission: Permission, i18n: I18n): string => {
  const what = i18n._(objectNames[permission.object.type]);
  const { binding } = permission;
  const actions = formatList(permission.actions);
  return i18n._(msg`${what}, as ${binding} in its code: ${actions}`);
};

/** Lines of access, each with its icon. */
const AccessLines = ({ lines }: { lines: { key: string; text: string }[] }) => (
  <ul {...stylex.props(styles.list)}>
    {lines.map(({ key, text }) => (
      <li key={key} {...stylex.props(styles.line)}>
        <Icon icon={KeyIcon} />
        <Text as="span" size="sm">
          {text}
        </Text>
      </li>
    ))}
  </ul>
);

/** Who a table's row rules admit, as one phrase each, listed. */
const RowRuleWords = ({ rules }: { rules: ReviewedRowRule[] }) => {
  const { t } = useLingui();
  const words = rules.map((rule) => {
    if (rule.kind === "owner") {
      return t`whoever added the row`;
    }
    if (rule.kind === "person") {
      const { field } = rule;
      return t`the person in ${field}`;
    }
    if (rule.kind === "team") {
      const { field } = rule;
      return t`members of the team in ${field}`;
    }
    return rule.role === "builder"
      ? t`the App's builders`
      : t`everyone who uses the App`;
  });
  return <>{formatList(words)}</>;
};

/** Each table's row rules: who reads its rows, and who changes them. */
const RowRules = ({ tables }: { tables: TableRowRules[] }) => (
  <ul {...stylex.props(styles.list)}>
    {tables.map(({ table, read, write }) => (
      <li key={table} {...stylex.props(styles.tight)}>
        <Text as="span" size="xs">
          <code {...stylex.props(styles.path)}>{table}</code>
        </Text>
        {read === null ? null : (
          <span>
            <Trans>
              Read by <RowRuleWords rules={read} />
            </Trans>
          </span>
        )}
        {write === null ? (
          <span>
            <Trans>Changed by nobody</Trans>
          </span>
        ) : (
          <span>
            {read === null ? (
              <Trans>
                Changed by <RowRuleWords rules={write} />
              </Trans>
            ) : (
              // The store holds a write to the read rules too: no one
              // changes a row they can't read.
              <Trans>
                Changed by <RowRuleWords rules={write} />, of the rows they can
                read
              </Trans>
            )}
          </span>
        )}
      </li>
    ))}
  </ul>
);

/**
 * What the App may do that core couldn't read, as its manifest can't be:
 * whoever publishes it sees that it may.
 */
const Unread = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.start)}>
    <Badge variant="warning">
      <Trans>Its code can&apos;t be read</Trans>
    </Badge>
    <Text as="span" size="sm" color="muted">
      {children}
    </Text>
  </div>
);

/**
 * The access the App waits for an admin to grant, what publishing it asks
 * an admin for again, what its code reaches beyond its own data, and who
 * sees which rows of its tables.
 */
export const AccessChanges = ({
  changes,
}: {
  changes: Pick<
    AppReview,
    "permissions" | "readsPeople" | "handsFilesToWorkflows" | "rowRules"
  >;
}) => {
  const { i18n } = useLingui();
  // What core can't read, it can't rule out: only false is nothing new.
  const nothing =
    changes.permissions.length === 0 &&
    changes.readsPeople === false &&
    changes.handsFilesToWorkflows === false &&
    changes.rowRules !== null;
  return (
    <div {...stylex.props(styles.stack)}>
      {nothing ? (
        <Text size="sm" color="muted">
          <Trans>Nothing new: it needs no admin.</Trans>
        </Text>
      ) : null}
      {changes.permissions.length === 0 ? null : (
        <div {...stylex.props(styles.tight)}>
          <Text as="span" size="xs" color="muted">
            <Trans>Waits for an admin to grant it</Trans>
          </Text>
          <AccessLines
            lines={changes.permissions.map((permission) => ({
              key: permission.id,
              text: permissionText(permission, i18n),
            }))}
          />
        </div>
      )}
      {changes.readsPeople === true ? (
        <div {...stylex.props(styles.line)}>
          <Icon icon={UsersIcon} />
          <Text as="span" size="sm">
            <Trans>
              Reads your organization&apos;s people: names, emails and teams.
            </Trans>
          </Text>
        </div>
      ) : null}
      {changes.readsPeople === null ? (
        <Unread>
          <Trans>
            It may read the name, email and teams of everyone in the
            organization.
          </Trans>
        </Unread>
      ) : null}
      {changes.handsFilesToWorkflows === true ? (
        <Text size="sm" color="muted">
          <Trans>Can hand files people can read to its workflows.</Trans>
        </Text>
      ) : null}
      {changes.handsFilesToWorkflows === null ? (
        <Unread>
          <Trans>
            Its pages and server code may hand files people can read to the
            workflows it binds.
          </Trans>
        </Unread>
      ) : null}
      {changes.rowRules === null ? (
        <Unread>
          <Trans>Its tables may say who sees and changes which rows.</Trans>
        </Unread>
      ) : null}
      {changes.rowRules === null || changes.rowRules.length === 0 ? null : (
        <div {...stylex.props(styles.tight)}>
          <Text as="span" size="xs" color="muted">
            <Trans>Who sees which rows</Trans>
          </Text>
          <RowRules tables={changes.rowRules} />
        </div>
      )}
    </div>
  );
};
