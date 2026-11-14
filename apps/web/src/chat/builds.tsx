import type { App } from "@grasp-os/shared/apps";
import type { ChatWork } from "@grasp-os/shared/chat";
import { failureText } from "@grasp-os/shared/errors";
import type { WorkflowResource } from "@grasp-os/shared/workflow-resources";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// While a chat's agent builds Apps and workflows: what is read of them
// (`useChatBuilds`), the Apps and workflows whose drafts it worked on,
// which an App's workspace previews (apps/app-workspace.tsx) and a
// workflow's page draws.

/** What was read: the person's Apps and workflows, and what the chat worked on. */
interface Builds {
  apps: App[];
  workflows: WorkflowResource[];
  worked: ChatWork[];
}

/**
 * The person's Apps and workflows, and what the chat worked on. Outside
 * the component, as the React Compiler can't compile `try`.
 */
const readBuilds = async (
  core: CoreConnection,
  chatId: string
): Promise<Loaded<Builds>> => {
  try {
    const [apps, workflows, worked] = await core.withSession(
      async (session) =>
        await Promise.all([
          session.apps.list(),
          session.workflowResources.list(),
          session.chats.worked(chatId),
        ])
    );
    return { state: "ready", data: { apps, workflows, worked } };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/** A read of the builds that came back without them. */
type BuildsFailed = Exclude<Loaded<Builds>, { state: "ready" }>;

/** What the chat's builds read. */
export interface ChatBuildsRead {
  /**
   * The latest builds read; undefined until a read succeeds. A read that
   * fails later leaves them, so the App being built stays in view.
   */
  builds: Builds | undefined;
  /** Why the latest read failed; undefined once one succeeds. */
  failure: BuildsFailed | undefined;
  /** Whether a read the person asked for is under way. */
  retrying: boolean;
  /** Reads the builds again, as after a failed read. */
  retry: () => void;
}

/**
 * The person's Apps and what the chat worked on, read again whenever the
 * agent stops working (`running` turns false) or writes a draft (`worked`
 * changes), and when the person asks again, whatever the agent does.
 */
export const useChatBuilds = (
  /** The chat; none while it is found, and nothing is read. */
  chatId: string | undefined,
  running: boolean,
  worked: number
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
  // Only the latest read shows, whichever ends last.
  const latest = useRef(0);
  // The chat the reads are of: another one starts afresh.
  const readFor = useRef<string | null>(null);
  // The reads asked for (again after a failure) done so far: those go whether the agent works or not.
  const handledReads = useRef(0);
  // The writes read so far: those go whether the agent works or not, so a
  // preview follows each write.
  const handledWorked = useRef(-1);
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
      worked === handledWorked.current
    ) {
      return;
    }
    handledReads.current = reads;
    handledWorked.current = worked;
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
  }, [core, chatId, running, reads, worked]);
  return {
    builds,
    failure,
    retrying: retried !== undefined,
    retry: () => {
      setRetried(reads + 1);
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

/** An App or a workflow the chat's agent worked on, with its name. */
export interface NamedWork {
  work: ChatWork;
  /** Its name; its ID where the person can't see it. */
  name: string;
}

/**
 * What the chat worked on, as core lists it in the latest builds read;
 * none until one succeeds. Not an archived App, which has no preview.
 */
export const workOf = ({ builds }: ChatBuildsRead): NamedWork[] => {
  if (builds === undefined) {
    return [];
  }
  const apps = new Map<string, App>(builds.apps.map((app) => [app.id, app]));
  const workflows = new Map<string, string>(
    builds.workflows.map(({ id, name }) => [id, name])
  );
  return builds.worked.flatMap((work) => {
    if (work.kind === "workflow") {
      return [{ work, name: workflows.get(work.id) ?? work.id }];
    }
    const app = apps.get(work.id);
    if (app?.archived === true) {
      return [];
    }
    return [{ work, name: app?.name ?? work.id }];
  });
};
