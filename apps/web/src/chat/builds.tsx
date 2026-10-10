import type { App, VersionReview } from "@grasp-os/shared/apps";
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
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { HammerIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import {
  exportChangeText,
  pendingToShow,
  readyToMakeCurrent,
  triggerChangeText,
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
  added: msg`Added: it acts for whoever uses the domain, with everything the domain holds`,
  modified: msg`Changed: it acts for whoever uses the domain, with everything the domain holds`,
  removed: msg`Removed: it acts for whoever uses the domain, with everything the domain holds`,
} as const;

/** How a workflow changed, before its ID. */
const workflowChangeWords = {
  added: msg`Added workflow`,
  modified: msg`Changed workflow`,
  removed: msg`Removed workflow`,
} as const;

type Change = keyof typeof changeWords;

/** How a step changed, with its name. */
const stepChangeText = (change: Change, name: string): string => {
  if (change === "added") {
    return i18n._(msg`Added step ${name}`);
  }
  return change === "modified"
    ? i18n._(msg`Changed step ${name}`)
    : i18n._(msg`Removed step ${name}`);
};

/** How a parameter changed, with its name. */
const paramChangeText = (change: Change, name: string): string => {
  if (change === "added") {
    return i18n._(msg`Added parameter ${name}`);
  }
  return change === "modified"
    ? i18n._(msg`Changed parameter ${name}`)
    : i18n._(msg`Removed parameter ${name}`);
};

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
 * Each changed file of a version's server code (`app/**.ts`), before and
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
          ? t`Nothing runs yet: this would be the domain's first current version.`
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
          <Badge variant="destructive">
            {i18n._(serverChangeWarnings[review.server])}
          </Badge>
          <ServerCode code={serverCode} onRetry={onRetryServerCode} />
        </section>
      )}
      {review.workflows.length === 0 ? null : (
        <section aria-label={t`Workflows`} className="flex flex-col gap-1">
          <h4 className="font-medium">
            <Trans>Workflows</Trans>
          </h4>
          <ul className="flex flex-col gap-2">
            {review.workflows.map((workflow) => (
              <li className="flex flex-col gap-1" key={workflow.id}>
                <span className="flex items-center gap-2">
                  {i18n._(workflowChangeWords[workflow.change])}{" "}
                  <code className="font-mono">{workflow.id}</code>
                  {workflow.sideEffect && workflow.change !== "removed" ? (
                    <Badge variant="destructive">
                      <Trans>May change something outside Grasp</Trans>
                    </Badge>
                  ) : null}
                </span>
                {workflow.change === "removed" ? (
                  <span className="text-muted-foreground">
                    {workflow.sideEffect
                      ? t`It no longer runs (it could change things).`
                      : t`It no longer runs.`}
                  </span>
                ) : null}
                {workflow.triggers === null ? (
                  <span className="text-muted-foreground">
                    <Trans>
                      What makes it run on its own can&apos;t be read from its
                      code.
                    </Trans>
                  </span>
                ) : (
                  workflow.triggers.map((change) => (
                    <span
                      key={`${change.change}:${JSON.stringify(change.trigger)}`}
                    >
                      {triggerChangeText(change)}
                    </span>
                  ))
                )}
                {workflow.shared.length === 0 ? null : (
                  <span className="text-muted-foreground">
                    {t`Code it may use changed: ${ph({ code: formatList(workflow.shared) })}`}
                  </span>
                )}
                {workflow.steps === null ? (
                  <span className="text-muted-foreground">
                    {workflow.calls.length === 0
                      ? t`Its steps can't be read from its code, so any step may do anything its code does, calling none of the App's bindings.`
                      : t`Its steps can't be read from its code, so any step may do anything its code does, calling ${ph({ tools: formatList(workflow.calls) })}.`}
                  </span>
                ) : (
                  workflow.steps.map((step) => (
                    <span className="flex items-center gap-2" key={step.name}>
                      {stepChangeText(step.change, step.name)}
                      {step.sideEffect ? (
                        <Badge variant="destructive">
                          <Trans>May change something outside Grasp</Trans>
                        </Badge>
                      ) : null}
                      {step.calls.length === 0 ? null : (
                        <Badge variant="outline">
                          {t`Calls ${ph({ tools: formatList(step.calls) })} (any of their methods): may change things`}
                        </Badge>
                      )}
                      {step.sharedCode ? (
                        <Badge variant="outline">
                          <Trans>Shared code changed</Trans>
                        </Badge>
                      ) : null}
                    </span>
                  ))
                )}
                {workflow.params === null ? (
                  <span className="text-muted-foreground">
                    <Trans>
                      Its parameters can&apos;t be read from its code.
                    </Trans>
                  </span>
                ) : (
                  workflow.params.map((param) => (
                    <span key={param.name}>
                      {paramChangeText(param.change, param.name)}
                    </span>
                  ))
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {review.exports.length === 0 ? null : (
        <section aria-label={t`Exports`} className="flex flex-col gap-1">
          <h4 className="font-medium">
            <Trans>What other domains may call</Trans>
          </h4>
          <ul className="flex flex-col gap-1">
            {review.exports.map((change) => {
              const { text, widens } = exportChangeText(change);
              return (
                <li className="flex items-center gap-2" key={change.name}>
                  {text}
                  {widens ? (
                    <Badge variant="destructive">
                      <Trans>Changes the domain&apos;s data</Trans>
                    </Badge>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section
        aria-label={t`What the domain holds`}
        className="flex flex-col gap-1"
      >
        <h4 className="font-medium">
          <Trans>What the domain holds</Trans>
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
      <section aria-label={t`Tests`} className="flex flex-col gap-1">
        <h4 className="font-medium">
          <Trans>Tests</Trans>
        </h4>
        <p>
          {review.tests.status === "passed"
            ? t`All workflow tests pass.`
            : null}
          {review.tests.status === "none" ? t`No workflows to test.` : null}
          {review.tests.status === "failed" ? t`Workflow tests fail:` : null}
        </p>
        {review.tests.failures.map((failure) => (
          <p className="text-destructive" key={failure}>
            {failure}
          </p>
        ))}
      </section>
    </div>
  );
};

/**
 * An App's version up for review: what it changes, and making it current;
 * nothing for an App the person doesn't build.
 */
const PendingVersion = ({
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
  const makeCurrent = async (): Promise<void> => {
    const made = await run(
      async (session) => await session.apps.versions.setCurrent(app.id, version)
    );
    if (made !== undefined) {
      onDone(versionKey(app.id, version));
    }
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
        <ErrorText>{failure}</ErrorText>
      </CardContent>
      {loaded === undefined ? null : (
        <CardFooter>
          <Button
            disabled={busy || !ready}
            onClick={() => {
              void makeCurrent();
            }}
          >
            <Trans>Make version {version} current</Trans>
          </Button>
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
  chatId: string,
  running: boolean,
  drafts: number
): ChatBuildsRead => {
  const [builds, setBuilds] = useState<Builds>();
  const [failure, setFailure] = useState<BuildsFailed>();
  const [reads, setReads] = useState(0);
  // The read the person asked for last, until it ends.
  const [retried, setRetried] = useState<number>();
  const [madeCurrent, setMadeCurrent] = useState<ReadonlySet<string>>(
    new Set()
  );
  // Only the latest read shows, whichever ends last.
  const latest = useRef(0);
  // The reads asked for (after making a version current, or again after
  // a failure) done so far: those go whether the agent works or not.
  const handledReads = useRef(0);
  // The drafts' changes read so far: those go whether the agent works or
  // not, so a preview follows each write.
  const handledDrafts = useRef(-1);
  const core = useCore();
  useEffect(() => {
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
        setBuilds(found.data);
        setFailure(undefined);
        setMadeCurrent((made) => stillMadeCurrent(made, found.data.apps));
      } else {
        setFailure(found);
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3.5 py-3 text-sm">
      <TriangleAlertIcon
        aria-hidden="true"
        className="text-destructive size-4 flex-none"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium">
          <Trans>The domains this chat builds didn&apos;t load.</Trans>
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
