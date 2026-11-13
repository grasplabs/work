import type { AppReview } from "@grasp-os/shared/app-review";
import type {
  FileDiff,
  ReviewedRowRule,
  TableRowRules,
} from "@grasp-os/shared/apps";
import type { Permission } from "@grasp-os/shared/permissions";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
} from "@grasp-os/ui/components/item";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRightIcon, KeyRoundIcon, UsersIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";
import { PlanList, planLines } from "./data-model-changes.tsx";

// What publishing an App's draft changes, as Share with your team (drafts/share-with-team.tsx)
// shows it before the person publishes, and History
// (drafts/draft-history.tsx) of a
// version against the one before it: its files, grouped by what they
// are, each with its diff on demand; what it does to the App's data; and
// the access the App waits for or is asked for again. All as core worked
// it out (`apps.review`), never as whoever wrote the draft says.

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

/** One changed file, its diff shown once the person opens it. */
const ChangedFile = ({ diff }: { diff: FileDiff }) => {
  const { i18n } = useLingui();
  return (
    <Collapsible render={<li />}>
      <CollapsibleTrigger
        render={
          <Button className="w-full justify-start" size="sm" variant="ghost" />
        }
      >
        <ChevronRightIcon data-icon="inline-start" />
        <span className="min-w-0 flex-1 truncate text-left font-mono text-xs">
          {diff.path}
        </span>
        <Badge variant={diff.change === "deleted" ? "outline" : "secondary"}>
          {i18n._(changeNames[diff.change])}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="max-h-96 overflow-auto rounded-lg border">
          <Suspense fallback={<Skeleton className="h-24" />}>
            <CodeDiff diff={diff} />
          </Suspense>
        </div>
      </CollapsibleContent>
    </Collapsible>
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
  <section className="flex flex-col gap-2">
    <h3 className="text-sm font-medium">{title}</h3>
    {children}
  </section>
);

/** The draft's files that differ from the live version's, grouped. */
export const FileChanges = ({ files }: { files: readonly FileDiff[] }) => {
  const { i18n } = useLingui();
  return (
    <div className="flex flex-col gap-3">
      {groupOrder.map((group) => {
        const inGroup = files.filter(({ path }) => groupOf(path) === group);
        return inGroup.length === 0 ? null : (
          <div className="flex flex-col gap-1" key={group}>
            <span className="text-muted-foreground text-xs">
              {i18n._(groupNames[group])}
            </span>
            <ul className="flex flex-col">
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
  changes: Pick<AppReview, "plan" | "migrations">;
}) => {
  const { i18n } = useLingui();
  const lines = changes.plan === null ? [] : planLines(changes.plan, i18n);
  const migrations = changes.migrations ?? [];
  if (lines.length === 0 && migrations.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>The App&apos;s data stays as it is.</Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <PlanList lines={lines} />
      {migrations.map(({ name, table }) => (
        <p className="text-muted-foreground" key={name}>
          <Trans>
            The migration {name} rewrites every record of {table} once your team
            has this version.
          </Trans>
        </p>
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
  <ItemGroup render={<ul />} spacing="tight">
    {lines.map(({ key, text }) => (
      <Item key={key} render={<li />} size="xs">
        <ItemMedia variant="icon">
          <KeyRoundIcon />
        </ItemMedia>
        <ItemContent>
          <span className="text-sm">{text}</span>
        </ItemContent>
      </Item>
    ))}
  </ItemGroup>
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
  <ul className="flex flex-col gap-2">
    {tables.map(({ table, read, write }) => (
      <li className="flex flex-col gap-0.5" key={table}>
        <code className="font-mono text-xs">{table}</code>
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
  <div className="flex flex-col items-start gap-1">
    <Badge variant="attention">
      <Trans>Its code can&apos;t be read</Trans>
    </Badge>
    <span className="text-muted-foreground">{children}</span>
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
    <div className="flex flex-col gap-3">
      {nothing ? (
        <p className="text-muted-foreground">
          <Trans>Nothing new: it needs no admin.</Trans>
        </p>
      ) : null}
      {changes.permissions.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            <Trans>Waits for an admin to grant it</Trans>
          </span>
          <AccessLines
            lines={changes.permissions.map((permission) => ({
              key: permission.id,
              text: permissionText(permission, i18n),
            }))}
          />
        </div>
      )}
      {askedAgain.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            <Trans>
              Works again once an admin grants it again for the new version
            </Trans>
          </span>
          <AccessLines
            lines={askedAgain.map(({ permission }) => ({
              key: permission.id,
              text: permissionText(permission, i18n),
            }))}
          />
        </div>
      )}
      {callersAskedAgain.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            <Trans>
              Workflows that call it again once an admin grants it again for the
              new version
            </Trans>
          </span>
          <AccessLines
            lines={callersAskedAgain.map(({ permission }) => ({
              key: permission.id,
              text: callerText(permission, i18n),
            }))}
          />
        </div>
      )}
      {changes.readsPeople === true ? (
        <p className="flex items-center gap-2">
          <UsersIcon aria-hidden />
          <Trans>
            Reads your organization&apos;s people: names, emails and teams.
          </Trans>
        </p>
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
        <p className="text-muted-foreground">
          <Trans>Can hand files people can read to its workflows.</Trans>
        </p>
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
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            <Trans>Who sees which rows</Trans>
          </span>
          <RowRules tables={changes.rowRules} />
        </div>
      )}
    </div>
  );
};
