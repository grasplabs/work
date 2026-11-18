import type { AppDraftChanges } from "@grasp-os/shared/app-drafts";
import type {
  FileDiff,
  ReviewedRowRule,
  TableRowRules,
} from "@grasp-os/shared/apps";
import type { Permission } from "@grasp-os/shared/permissions";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Collapsible } from "../grasp/collapsible/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Icon, Key, People } from "../grasp/icons/index.ts";
import { Skeleton } from "../grasp/skeleton/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { PlanList, planLines } from "./data-model-changes.tsx";

// What publishing an App's draft changes, as Publish (publish.tsx) shows
// it before the person publishes, and History (app-history.tsx) of a
// version against the one before it: its files, grouped by what they
// are, each with its diff on demand; what it does to the App's data; and
// the access the App waits for or is asked for again. All as core worked
// it out (`apps.drafts.changes`), never as whoever wrote the draft says.

// The diff, with its renderer and highlighter, loads once one opens.
const CodeDiff = lazy(async () => {
  const { CodeDiff: diff } = await import("./code-view.tsx");
  return { default: diff };
});

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

const changeNames = {
  added: msg({ message: "Added", context: "a file a change adds" }),
  modified: msg({ message: "Changed", context: "a file a change changes" }),
  deleted: msg({ message: "Removed", context: "a file a change removes" }),
} as const satisfies Record<FileDiff["change"], unknown>;

// How tall a file's change may stand before it scrolls: Grasp UI has no
// token for a code box's height.
const DIFF_TALL = "24rem";

const styles = stylex.create({
  stack: { display: "grid", gap: grasp.space3, minWidth: 0 },
  tight: { display: "grid", gap: grasp.space1, minWidth: 0 },
  list: {
    display: "grid",
    gap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  path: { fontFamily: grasp.fontMono, overflowWrap: "anywhere" },
  title: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  diff: {
    maxHeight: DIFF_TALL,
    overflow: "auto",
    borderRadius: grasp.corner,
    boxShadow: grasp.edge,
  },
  line: { display: "flex", alignItems: "flex-start", gap: grasp.space2 },
  start: { display: "grid", justifyItems: "start", gap: grasp.space1 },
});

/** One changed file, its diff shown once the person opens it. */
const ChangedFile = ({ diff }: { diff: FileDiff }) => {
  const { i18n } = useLingui();
  return (
    <li>
      <Collapsible
        title={
          <span {...stylex.props(styles.title)}>
            <Text element="span" size="xs">
              <span {...stylex.props(styles.path)}>{diff.path}</span>
            </Text>
            <Badge tone={diff.change === "deleted" ? "danger" : "neutral"}>
              {i18n._(changeNames[diff.change])}
            </Badge>
          </span>
        }
      >
        <div {...stylex.props(styles.diff)}>
          <Suspense fallback={<Skeleton variant="block" />}>
            <CodeDiff diff={diff} />
          </Suspense>
        </div>
      </Collapsible>
    </li>
  );
};

/** A part of what changes: its heading, and what it says. */
export const ChangesSection = ({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) => (
  <section {...stylex.props(styles.tight)}>
    <Heading level={3} size="ui">
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
            <Text element="span" size="xs" tone="muted">
              {i18n._(groupNames[group])}
            </Text>
            <ul {...stylex.props(styles.list)}>
              {inGroup.map((diff) => (
                <ChangedFile diff={diff} key={diff.path} />
              ))}
            </ul>
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
  changes: Pick<AppDraftChanges, "plan" | "migrations">;
}) => {
  const { i18n } = useLingui();
  const lines = changes.plan === null ? [] : planLines(changes.plan, i18n);
  const migrations = changes.migrations ?? [];
  if (lines.length === 0 && migrations.length === 0) {
    return (
      <Text size="sm" tone="muted">
        <Trans>The App&apos;s data stays as it is.</Trans>
      </Text>
    );
  }
  return (
    <div {...stylex.props(styles.tight)}>
      <PlanList lines={lines} />
      {migrations.map(({ name, table }) => (
        <Text key={name} size="sm" tone="muted">
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
  collection: msg`A collection`,
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

/**
 * A workflow's grant to call one of the App's functions, in a line: the
 * workflow's name and the function's path, where core gives them.
 */
const callerText = (permission: Permission, i18n: I18n): string => {
  const { subject, object, workflowNames, functionName } = permission;
  const workflow =
    subject.type === "workflow"
      ? (workflowNames?.[subject.workflowId] ?? subject.workflowId)
      : "";
  const path =
    functionName ??
    (object.type === "app" ? (object.function ?? object.appId) : "");
  return i18n._(msg`${workflow} calls ${path}`);
};

/** Lines of access, each with its icon. */
const AccessLines = ({ lines }: { lines: { key: string; text: string }[] }) => (
  <ul {...stylex.props(styles.list)}>
    {lines.map(({ key, text }) => (
      <li key={key} {...stylex.props(styles.line)}>
        <Icon icon={Key} />
        <Text element="span" size="sm">
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
        <Text element="span" size="xs">
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
    <Badge tone="attention">
      <Trans>Its code can&apos;t be read</Trans>
    </Badge>
    <Text element="span" size="sm" tone="muted">
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
    AppDraftChanges,
    | "permissions"
    | "grants"
    | "callers"
    | "readsPeople"
    | "handsFilesToWorkflows"
    | "rowRules"
  >;
}) => {
  const { i18n } = useLingui();
  const askedAgain = changes.grants.filter((grant) => grant.askedAgain);
  // The workflows that call the App trust its code as its own grants do:
  // publishing asks an admin for those grants again likewise.
  const callersAskedAgain = changes.callers.filter(
    (caller) => caller.askedAgain
  );
  // What core can't read, it can't rule out: only false is nothing new.
  const nothing =
    changes.permissions.length === 0 &&
    askedAgain.length === 0 &&
    callersAskedAgain.length === 0 &&
    changes.readsPeople === false &&
    changes.handsFilesToWorkflows === false &&
    changes.rowRules !== null;
  return (
    <div {...stylex.props(styles.stack)}>
      {nothing ? (
        <Text size="sm" tone="muted">
          <Trans>Nothing new: it needs no admin.</Trans>
        </Text>
      ) : null}
      {changes.permissions.length === 0 ? null : (
        <div {...stylex.props(styles.tight)}>
          <Text element="span" size="xs" tone="muted">
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
      {askedAgain.length === 0 ? null : (
        <div {...stylex.props(styles.tight)}>
          <Text element="span" size="xs" tone="muted">
            <Trans>
              Works again once an admin grants it again for the new version
            </Trans>
          </Text>
          <AccessLines
            lines={askedAgain.map(({ permission }) => ({
              key: permission.id,
              text: permissionText(permission, i18n),
            }))}
          />
        </div>
      )}
      {callersAskedAgain.length === 0 ? null : (
        <div {...stylex.props(styles.tight)}>
          <Text element="span" size="xs" tone="muted">
            <Trans>
              Workflows that call it again once an admin grants it again for the
              new version
            </Trans>
          </Text>
          <AccessLines
            lines={callersAskedAgain.map(({ permission }) => ({
              key: permission.id,
              text: callerText(permission, i18n),
            }))}
          />
        </div>
      )}
      {changes.readsPeople === true ? (
        <div {...stylex.props(styles.line)}>
          <Icon icon={People} />
          <Text element="span" size="sm">
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
        <Text size="sm" tone="muted">
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
          <Text element="span" size="xs" tone="muted">
            <Trans>Who sees which rows</Trans>
          </Text>
          <RowRules tables={changes.rowRules} />
        </div>
      )}
    </div>
  );
};
