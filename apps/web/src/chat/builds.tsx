import type {
  App,
  ReviewedRowRule,
  TableRowRules,
  VersionReview,
} from "@grasp-os/shared/apps";
import { appErrors } from "@grasp-os/shared/apps";
import type { ChatDraft } from "@grasp-os/shared/chat";
import { failureText } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { HammerIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { makeCurrentFailure } from "../engines/store-change-errors.ts";
import { storeChangesAnchor } from "../engines/store-changes.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import {
  migrationFixturesText,
  pendingToShow,
  readyToMakeCurrent,
  stillMadeCurrent,
  serverFileLabels,
  serverFileOf,
  versionKey,
} from "./builds-state.ts";
import type { ServerFile } from "./builds-state.ts";

// While the chat's agent builds Apps (`app_builder`): what the chat page
// reads of them (`useChatBuilds`), the Apps it is still changing in the
// chat's own drafts, which stand in the studio beside the chat
// (studio.tsx), and, in the side panel, the Apps the person builds with a
// version up for review, which they review (what core says it changes,
// never the proposer's word) and make current there.

/** What the panel read: the person's Apps, and the chat's drafts. */
interface Builds {
  apps: App[];
  drafts: ChatDraft[];
}

/**
 * The person's Apps and the chat's drafts. Outside the component, as the
 * React Compiler can't compile `try`.
 */
const readBuilds = async (
  core: CoreConnection,
  chatId: string
): Promise<Loaded<Builds>> => {
  try {
    const [apps, drafts] = await core.withSession(
      async (session) =>
        await Promise.all([session.apps.list(), session.chats.drafts(chatId)])
    );
    return { state: "ready", data: { apps, drafts } };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/**
 * A version's review, or `hidden` for an App the person doesn't build:
 * only builders review and make versions current, so they alone see it.
 */
const readReview = async (
  core: CoreConnection,
  app: string,
  version: number
): Promise<Loaded<VersionReview> | { state: "hidden" }> => {
  try {
    const review = await core.withSession(
      async (session) => await session.apps.versions.review(app, version)
    );
    return { state: "ready", data: review };
  } catch (error) {
    const hidden =
      roleErrors.codeOf(error) !== undefined ||
      appErrors.codeOf(error) === "app.not_found";
    return hidden
      ? { state: "hidden" }
      : { state: "refused", message: failureText(error) };
  }
};

/** How something changed, as a reviewer reads it. */
const changeWords = {
  added: msg`Added`,
  modified: msg`Changed`,
  removed: msg`Removed`,
} as const;

/** How the server code changed, as a whole sentence for its warning. */
const serverChangeWarnings = {
  added: msg`Added: it acts for whoever uses the App, with everything the App holds`,
  modified: msg`Changed: it acts for whoever uses the App, with everything the App holds`,
  removed: msg`Removed: it acts for whoever uses the App, with everything the App holds`,
} as const;

/** How a migration changed, with its table, as a whole sentence for its warning. */
const migrationWarning = (
  change: "added" | "modified",
  table: string
): string =>
  change === "added"
    ? i18n._(
        msg`Added: it reads and rewrites every record of ${table}, whoever owns it`
      )
    : i18n._(
        msg`Changed: it reads and rewrites every record of ${table}, whoever owns it`
      );

/** Who proposed a version, as its reviewer reads it. */
const proposerText = ({ proposedBy }: VersionReview): string => {
  if (proposedBy === null) {
    return i18n._(msg`Committed by a person.`);
  }
  if (!proposedBy.ownChat) {
    return i18n._(msg`Proposed by the agent, in another person's chat.`);
  }
  const { chatTitle } = proposedBy;
  return chatTitle === null
    ? i18n._(msg`Proposed by the agent, in a chat of yours that was deleted.`)
    : i18n._(msg`Proposed by the agent in chat "${chatTitle}".`);
};

/**
 * Each changed file of a version's server code (`app.ts`, `schema.ts`, `server/` and the rest its seal builds), before and
 * after: against the current version, or as a first version has it.
 */
const serverCodeOf = async (
  session: Session,
  {
    app,
    current,
    version,
    serverFiles,
  }: {
    app: string;
    current: number | null;
    version: number;
    serverFiles: VersionReview["serverFiles"];
  }
): Promise<ServerFile[]> => {
  const paths = new Set(serverFiles.map(({ path }) => path));
  if (current === null) {
    const files = await session.apps.files.read(app, version);
    return [...paths].map((path) => ({ path, after: files[path] }));
  }
  const diff = await session.apps.versions.diff(app, current, version);
  return diff.filter(({ path }) => paths.has(path)).map(serverFileOf);
};

/**
 * The server code a version runs, as it changes: it acts for whoever uses
 * the App, with everything the App holds, so it is shown in full, what
 * runs now and what would after approval, each labelled.
 */
const ServerCode = ({
  code,
  onRetry,
}: {
  code: Loaded<ServerFile[]> | undefined;
  onRetry: () => void;
}) => {
  if (code === undefined) {
    return <LoadingLines />;
  }
  if (code.state !== "ready") {
    return (
      <div className="flex items-center gap-2">
        <NotLoaded page={code} />
        <Button onClick={onRetry} size="sm" variant="outline">
          <Trans>Load the server code again</Trans>
        </Button>
      </div>
    );
  }
  return (
    <>
      {code.data.map((file) => {
        const labels = serverFileLabels(file);
        return (
          <details key={file.path}>
            <summary>{labels.summary}</summary>
            {file.before === undefined ? null : (
              <figure className="flex flex-col gap-1">
                <figcaption className="text-xs">{labels.before}</figcaption>
                <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                  <code className="font-mono">{file.before}</code>
                </pre>
              </figure>
            )}
            {file.after === undefined ? null : (
              <figure className="flex flex-col gap-1">
                <figcaption className="text-xs">{labels.after}</figcaption>
                <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                  <code className="font-mono">{file.after}</code>
                </pre>
              </figure>
            )}
          </details>
        );
      })}
    </>
  );
};

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

/** Each table's row rules, as a version's reviewer reads them. */
const RowRules = ({ tables }: { tables: TableRowRules[] }) => (
  <ul className="flex flex-col gap-2">
    {tables.map(({ table, read, write }) => (
      <li className="flex flex-col gap-1" key={table}>
        <code className="font-mono">{table}</code>
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

/** What a version changes, as core worked it out. */
const ReviewDetails = ({
  review,
  serverCode,
  onRetryServerCode,
}: {
  review: VersionReview;
  serverCode: Loaded<ServerFile[]> | undefined;
  onRetryServerCode: () => void;
}) => {
  const { t } = useLingui();
  const { current } = review;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>{proposerText(review)}</p>
      <blockquote className="border-l-2 pl-3">
        <span className="text-muted-foreground block text-xs">
          <Trans>In the proposer&apos;s words</Trans>
        </span>
        {review.version.message}
      </blockquote>
      <p className="text-muted-foreground">
        {current === null
          ? t`Nothing runs yet: this would be the App's first current version.`
          : t`Compared with version ${current}, which runs now.`}
      </p>
      <section aria-label={t`Files`} className="flex flex-col gap-1">
        <h4 className="font-medium">
          <Trans>Files</Trans>
        </h4>
        {review.files.length === 0 ? (
          <p className="text-muted-foreground">
            <Trans>No file changes.</Trans>
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {review.files.map(({ path, change }) => (
              <li key={path}>
                {i18n._(changeWords[change])}{" "}
                <code className="font-mono">{path}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
      {review.server === null ? null : (
        <section aria-label={t`Server code`} className="flex flex-col gap-1">
          <h4 className="font-medium">
            <Trans>Server code</Trans>
          </h4>
          <Badge variant="attention">
            {i18n._(serverChangeWarnings[review.server])}
          </Badge>
          <ServerCode code={serverCode} onRetry={onRetryServerCode} />
        </section>
      )}
      {review.migrations?.length === 0 ? null : (
        <section aria-label={t`Migrations`} className="flex flex-col gap-1">
          <h4 className="font-medium">
            <Trans>Migrations</Trans>
          </h4>
          {review.migrations === null ? (
            <Badge variant="attention">
              {t`Its migrations can't be read: it may rewrite the records of any table`}
            </Badge>
          ) : (
            <ul className="flex flex-col gap-1">
              {review.migrations.map((migration) => {
                const { name, table, change } = migration;
                const fixtures = migrationFixturesText(migration);
                return (
                  <li className="flex flex-col gap-1" key={name}>
                    <code className="font-mono">{name}</code>
                    <Badge variant="attention">
                      {migrationWarning(change, table)}
                    </Badge>
                    {fixtures.failed ? (
                      <Badge variant="attention">{fixtures.text}</Badge>
                    ) : (
                      <p className="text-muted-foreground">{fixtures.text}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {review.handsFilesToWorkflows === false ? null : (
        <section
          aria-label={t`Files to workflows`}
          className="flex flex-col gap-1"
        >
          <h4 className="font-medium">
            <Trans>Files to workflows</Trans>
          </h4>
          <Badge variant="destructive">
            {review.handsFilesToWorkflows === null
              ? t`Its code can't be read: its screens and server code may hand files people can read to the workflows it binds`
              : t`Its screens and server code may hand files people can read to the workflows it binds`}
          </Badge>
        </section>
      )}
      {review.readsPeople === false ? null : (
        <section aria-label={t`People`} className="flex flex-col gap-1">
          <h4 className="font-medium">
            <Trans>People</Trans>
          </h4>
          <Badge variant="attention">
            {review.readsPeople === null
              ? t`Its code can't be read: it may read the name, email and teams of everyone in the organization`
              : t`It reads the name, email and teams of everyone in the organization`}
          </Badge>
        </section>
      )}
      {review.rowRules?.length === 0 ? null : (
        <section
          aria-label={t`Who sees which rows`}
          className="flex flex-col gap-1"
        >
          <h4 className="font-medium">
            <Trans>Who sees which rows</Trans>
          </h4>
          {review.rowRules === null ? (
            <Badge variant="attention">
              {t`Its code can't be read: its tables may say who sees and changes which rows`}
            </Badge>
          ) : (
            <RowRules tables={review.rowRules} />
          )}
        </section>
      )}
      <section
        aria-label={t`What the App holds`}
        className="flex flex-col gap-1"
      >
        <h4 className="font-medium">
          <Trans>What the App holds</Trans>
        </h4>
        {review.grants.length === 0 ? (
          <p className="text-muted-foreground">
            <Trans>No permissions.</Trans>
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {review.grants.map(({ permission, askedAgain }) => {
              const { binding } = permission;
              const actions = formatList(permission.actions);
              const object = permission.object.type;
              return (
                <li key={permission.id}>
                  {askedAgain
                    ? t`${binding}: ${actions} on ${object}, asked for again of an admin if you make this current`
                    : t`${binding}: ${actions} on ${object}`}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section
        aria-label={t`Permissions asked for`}
        className="flex flex-col gap-1"
      >
        <h4 className="font-medium">
          <Trans>Permissions asked for</Trans>
        </h4>
        {review.permissions.length === 0 ? (
          <p className="text-muted-foreground">
            <Trans>None waiting for an admin.</Trans>
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {review.permissions.map((permission) => {
              const { binding } = permission;
              const actions = formatList(permission.actions);
              const object = permission.object.type;
              return (
                <li key={permission.id}>
                  {permission.requestedVia === null
                    ? t`${binding}: ${actions} on ${object}, waiting for an admin`
                    : t`${binding}: ${actions} on ${object}, waiting for an admin (asked by the agent)`}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};

/** Why a version wasn't made current, as `makeCurrentFailure` says. */
type MadeCurrent = { made: true } | ReturnType<typeof makeCurrentFailure>;

/**
 * Makes `version` of `app` current, and with `publish` then publishes the
 * App (a draft until then: its users can't open it, its triggers don't
 * fire), or says why core refused: a store's failed change it waits on
 * points to the engine's page (`link`). Outside the component, as the
 * React Compiler can't compile `try`.
 */
const setCurrentOf = async (
  session: Session,
  app: string,
  version: number,
  publish: boolean,
  /** The version current as the review compared it: refused if another is now. */
  expected: number | null
): Promise<MadeCurrent> => {
  try {
    await session.apps.versions.setCurrent(app, version, expected);
    if (publish) {
      await session.apps.publish(app);
    }
    return { made: true };
  } catch (error) {
    return makeCurrentFailure(error);
  }
};

/**
 * An App's version up for review: what it changes, and making it current;
 * nothing for an App the person doesn't build.
 */
export const PendingVersion = ({
  app,
  version,
  onDone,
}: {
  app: App;
  version: number;
  onDone: (made: string) => void;
}) => {
  const [review, setReview] = useState<
    Loaded<VersionReview> | { state: "hidden" }
  >();
  const [serverCode, setServerCode] = useState<Loaded<ServerFile[]>>();
  // Bumped to read what failed again.
  const [reviewReads, setReviewReads] = useState(0);
  const [codeReads, setCodeReads] = useState(0);
  const core = useCore();
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const { name } = app;
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const found = await readReview(core, app.id, version);
      if (current) {
        setReview(found);
      }
    };
    void read();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `reviewReads` says when to read again
  }, [core, app.id, version, reviewReads]);
  const loaded = review?.state === "ready" ? review.data : undefined;
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      if (loaded === undefined || loaded.server === null) {
        return;
      }
      const found = await loadFromCore(
        core,
        async (session) =>
          await serverCodeOf(session, {
            app: app.id,
            current: loaded.current,
            version,
            serverFiles: loaded.serverFiles,
          })
      );
      if (current) {
        setServerCode(found);
      }
    };
    void read();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `codeReads` says when to read again
  }, [core, app.id, version, loaded, codeReads]);
  const [refused, setRefused] =
    useState<Exclude<MadeCurrent, { made: true }>>();
  const makeCurrent = async (publish: boolean): Promise<void> => {
    setRefused(undefined);
    const made = await run(
      async (session) =>
        await setCurrentOf(
          session,
          app.id,
          version,
          publish,
          loaded?.current ?? null
        )
    );
    if (made === undefined) {
      return;
    }
    if ("made" in made) {
      onDone(versionKey(app.id, version));
      return;
    }
    setRefused(made);
  };
  if (review === undefined) {
    return null;
  }
  if (review.state === "hidden") {
    return null;
  }
  // Only once all of what the reviewer reads has loaded.
  const ready = readyToMakeCurrent(
    review,
    loaded !== undefined && loaded.server !== null,
    serverCode
  );
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          {t`${name}: version ${version} waiting for review`}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loaded === undefined ? (
          <div className="flex items-center gap-2">
            <NotLoaded page={review} />
            <Button
              onClick={() => {
                setReviewReads(reviewReads + 1);
              }}
              size="sm"
              variant="outline"
            >
              <Trans>Load the review again</Trans>
            </Button>
          </div>
        ) : (
          <ReviewDetails
            onRetryServerCode={() => {
              setCodeReads(codeReads + 1);
            }}
            review={loaded}
            serverCode={serverCode}
          />
        )}
        <ErrorText>{failure ?? refused?.text}</ErrorText>
        {failure !== undefined || refused?.issues === undefined ? null : (
          <ul className="flex flex-col gap-1">
            {refused.issues.map((issue) => (
              <li key={issue}>
                <code className="font-mono text-sm break-all">{issue}</code>
              </li>
            ))}
          </ul>
        )}
        {refused?.link === undefined ? null : (
          <p className="text-muted-foreground">
            <Link
              className="underline underline-offset-3"
              hash={storeChangesAnchor}
              params={{ app: app.id }}
              to="/apps/$app/settings"
            >
              {refused.link}
            </Link>
          </p>
        )}
      </CardContent>
      {loaded === undefined ? null : (
        <CardFooter>
          <div className="flex flex-col items-start gap-2">
            {/* A draft is released for its builders alone until published:
              the two together, for who means it for its users now. */}
            {app.status === "draft" ? (
              <p className="text-muted-foreground">
                <Trans>
                  {name} is a draft: only its builders open it, and its triggers
                  don&apos;t fire, until it is published.
                </Trans>
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || !ready}
                onClick={() => {
                  void makeCurrent(false);
                }}
                variant={app.status === "draft" ? "outline" : "default"}
              >
                <Trans>Make version {version} current</Trans>
              </Button>
              {app.status === "draft" ? (
                <Button
                  disabled={busy || !ready}
                  onClick={() => {
                    void makeCurrent(true);
                  }}
                >
                  <Trans>Make version {version} current and publish</Trans>
                </Button>
              ) : null}
            </div>
          </div>
        </CardFooter>
      )}
    </Card>
  );
};

/** A read of the builds that came back without them. */
type BuildsFailed = Exclude<Loaded<Builds>, { state: "ready" }>;

/** What the chat's builds read, and what was made current here since. */
export interface ChatBuildsRead {
  /**
   * The latest builds read; undefined until a read succeeds. A read that
   * fails later leaves them, so the App being built stays beside the chat.
   */
  builds: Builds | undefined;
  /** Why the latest read failed; undefined once one succeeds. */
  failure: BuildsFailed | undefined;
  /** Whether a read the person asked for is under way. */
  retrying: boolean;
  /** Reads the builds again, as after a failed read. */
  retry: () => void;
  /** Versions made current here (`versionKey`): gone from the panel at once. */
  madeCurrent: ReadonlySet<string>;
  /** A version was made current here: read again, whatever the agent does. */
  onMadeCurrent: (made: string) => void;
}

/**
 * The person's Apps and the chat's drafts, read again whenever the agent
 * stops working (`running` turns false) or writes or drops a draft
 * (`drafts` changes), and after a version is made current here or the
 * person asks again, whatever the agent does. The chat page reads them
 * once, for the studio and the side panel both.
 */
export const useChatBuilds = (
  /** The chat; none while it is found, and nothing is read. */
  chatId: string | undefined,
  running: boolean,
  drafts: number
): ChatBuildsRead => {
  // Each answer with the chat it is of: another chat's never shows.
  const [answer, setAnswer] = useState<{
    chatId: string;
    builds?: Builds;
    failure?: BuildsFailed;
  }>();
  const ofChat = answer?.chatId === chatId ? answer : undefined;
  const builds = ofChat?.builds;
  const failure = ofChat?.failure;
  const [reads, setReads] = useState(0);
  // The read the person asked for last, until it ends.
  const [retried, setRetried] = useState<number>();
  const [madeCurrent, setMadeCurrent] = useState<ReadonlySet<string>>(
    new Set()
  );
  // Only the latest read shows, whichever ends last.
  const latest = useRef(0);
  // The chat the reads are of: another one starts afresh.
  const readFor = useRef<string | null>(null);
  // The reads asked for (after making a version current, or again after
  // a failure) done so far: those go whether the agent works or not.
  const handledReads = useRef(0);
  // The drafts' changes read so far: those go whether the agent works or
  // not, so a preview follows each write.
  const handledDrafts = useRef(-1);
  const core = useCore();
  useEffect(() => {
    // A read under way for a chat no longer shown never lands.
    if ((chatId ?? null) !== readFor.current) {
      readFor.current = chatId ?? null;
      latest.current += 1;
      handledReads.current = -1;
    }
    if (chatId === undefined) {
      return;
    }
    if (
      running &&
      reads === handledReads.current &&
      drafts === handledDrafts.current
    ) {
      return;
    }
    handledReads.current = reads;
    handledDrafts.current = drafts;
    latest.current += 1;
    const read = latest.current;
    const load = async (): Promise<void> => {
      const found = await readBuilds(core, chatId);
      if (latest.current !== read) {
        return;
      }
      setRetried(undefined);
      if (found.state === "ready") {
        setAnswer({ chatId, builds: found.data });
        setMadeCurrent((made) => stillMadeCurrent(made, found.data.apps));
      } else {
        // A read that fails later leaves the builds read before.
        setAnswer((before) => ({
          chatId,
          ...(before?.chatId === chatId && before.builds !== undefined
            ? { builds: before.builds }
            : {}),
          failure: found,
        }));
      }
    };
    void load();
  }, [core, chatId, running, reads, drafts]);
  return {
    builds,
    failure,
    retrying: retried !== undefined,
    retry: () => {
      setRetried(reads + 1);
      setReads(reads + 1);
    },
    madeCurrent,
    onMadeCurrent: (made) => {
      setMadeCurrent((before) => new Set([...before, made]));
      setReads(reads + 1);
    },
  };
};

/**
 * Why the builds didn't load, beside the chat, and a way to read them
 * again: the App being built would otherwise be missing without a word.
 */
export const BuildsFailure = ({ read }: { read: ChatBuildsRead }) => {
  const { t } = useLingui();
  const { failure, retrying, retry } = read;
  if (failure === undefined) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3.5 py-3 text-sm">
      <TriangleAlertIcon
        aria-hidden="true"
        className="text-status-attention size-4 flex-none"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium">
          <Trans>The Apps this chat builds didn&apos;t load.</Trans>
        </p>
        {/* Gone while trying, so the alert is announced again if it fails again. */}
        {retrying ? null : <NotLoaded page={failure} />}
      </div>
      <Button disabled={retrying} onClick={retry} size="sm" variant="outline">
        {retrying ? t`Trying again…` : t`Try again`}
      </Button>
    </div>
  );
};

/** A draft the chat's agent is writing, with its App's name. */
export interface NamedDraft {
  draft: ChatDraft;
  /** The App's name; its ID where the person can't see the App. */
  name: string;
}

/** The chat's drafts, as core lists them in the latest builds read; none until one succeeds. */
export const draftsOf = ({ builds }: ChatBuildsRead): NamedDraft[] => {
  if (builds === undefined) {
    return [];
  }
  const names = new Map<string, string>(
    builds.apps.map((app) => [app.id, app.name])
  );
  return builds.drafts.map((draft) => ({
    draft,
    name: names.get(draft.app) ?? draft.app,
  }));
};

/**
 * The side panel's part of the builds: the Apps the person builds with a
 * version up for review. The drafts themselves stand in the studio, beside
 * the chat (studio.tsx).
 */
export const ChatBuilds = ({ read }: { read: ChatBuildsRead }) => {
  const { t } = useLingui();
  const { builds, failure, madeCurrent, onMadeCurrent } = read;
  const pending =
    builds === undefined ? [] : pendingToShow(builds.apps, madeCurrent);
  if (pending.length === 0) {
    return failure === undefined ? null : <NotLoaded page={failure} />;
  }
  return (
    <section aria-label={t`Being built`} className="flex flex-col gap-3">
      {failure === undefined ? null : <NotLoaded page={failure} />}
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <HammerIcon
          aria-hidden="true"
          className="text-muted-foreground size-4"
        />
        <Trans>Being built</Trans>
      </h3>
      {pending.map((app) => (
        <PendingVersion
          app={app}
          key={versionKey(app.id, app.pendingVersion)}
          onDone={onMadeCurrent}
          version={app.pendingVersion}
        />
      ))}
    </section>
  );
};
