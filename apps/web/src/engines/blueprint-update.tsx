import type {
  BlueprintUpdate,
  FileDiff,
  ViewedApp,
} from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { GitMergeIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { buildsApp } from "./app-role.ts";

// A built-in blueprint's newer code, offered on the domain page of an App
// created from it (`apps.blueprints.update`, which core works out and
// offers to the App's builders only, never Grasp staff). Core merges it
// file by file over the App's latest version: what only the blueprint
// changed comes along, what only the App's builders changed stays theirs,
// and a file both changed stays theirs, listed apart. Nothing is written
// until a builder reviews what changes and accepts exactly that
// (`acceptUpdate`, over the update's code and the version it was merged
// over, so an update that moved on meanwhile is refused). It is then the
// App's next version, which runs once it is made current, as any.

/** How a file changes, in words. */
const ChangeBadge = ({ diff }: { diff: FileDiff }) => {
  if (diff.change === "added") {
    return (
      <Badge>
        <Trans>Added</Trans>
      </Badge>
    );
  }
  if (diff.change === "deleted") {
    return (
      <Badge>
        <Trans>Removed</Trans>
      </Badge>
    );
  }
  return (
    <Badge>
      <Trans>Changed</Trans>
    </Badge>
  );
};

/** A file's text in the review. */
const Code = ({ text }: { text: string }) => (
  <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
    <code className="font-mono">{text}</code>
  </pre>
);

/** One file the update changes, with its text before and after. */
const FileChange = ({ diff }: { diff: FileDiff }) => (
  <details>
    <summary className="flex items-center gap-2">
      <span className="font-mono text-xs">{diff.path}</span>
      <ChangeBadge diff={diff} />
    </summary>
    <div className="flex flex-col gap-2 pt-2">
      {diff.change === "added" ? null : (
        <>
          <span className="text-muted-foreground text-xs">
            <Trans>Before</Trans>
          </span>
          <Code text={diff.before} />
        </>
      )}
      {diff.change === "deleted" ? null : (
        <>
          <span className="text-muted-foreground text-xs">
            <Trans>After</Trans>
          </span>
          <Code text={diff.after} />
        </>
      )}
    </div>
  </details>
);

/** What the update changes, and accepting it. */
const ReviewDialog = ({
  app,
  update,
  onClose,
  onAccepted,
}: {
  app: string;
  update: BlueprintUpdate;
  onClose: () => void;
  onAccepted: (version: number) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { changes, conflicts } = update;
  const kept = conflicts.length;
  const accept = async (): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          const version = await session.apps.blueprints.acceptUpdate(app, {
            to: update.to,
            over: update.over,
          });
          onAccepted(version.version);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Take the blueprint&apos;s update?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              It becomes this domain&apos;s next version, which runs once it is
              made current. Nothing your builders changed is overwritten.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-96 flex-col gap-3 overflow-y-auto">
          {changes.length === 0 ? (
            <p className="text-muted-foreground">
              <Trans>None of this domain&apos;s files change.</Trans>
            </p>
          ) : (
            changes.map((diff) => <FileChange diff={diff} key={diff.path} />)
          )}
          {conflicts.length === 0 ? null : (
            <section className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">
                <Plural
                  one="# file stays as your builders made it"
                  other="# files stay as your builders made them"
                  value={kept}
                />
              </h3>
              <p className="text-muted-foreground">
                <Trans>
                  Both the blueprint and your builders changed these, so the
                  blueprint&apos;s change to them is left out.
                </Trans>
              </p>
              <ul className="font-mono text-xs">
                {conflicts.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <ErrorText>{failure}</ErrorText>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              void accept();
            }}
          >
            <Trans>Take the update</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * The banner offering a built-in blueprint's update to an App created
 * from it, for its builders, read when the page opens.
 */
export const BlueprintUpdateBanner = ({
  app,
  identity,
}: {
  app: ViewedApp;
  identity: Pick<Identity, "staff">;
}) => {
  const core = useCore();
  const offered = buildsApp(app, identity) && app.status !== "archived";
  const [update, setUpdate] = useState<BlueprintUpdate | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [accepted, setAccepted] = useState<number | null>(null);
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      if (!offered) {
        return;
      }
      const loaded = await loadFromCore(
        core,
        async (session) => await session.apps.blueprints.update(app.id),
        left.signal
      );
      // Without an update, or when core can't say, the page goes on as
      // without one: there is nothing the builder must do.
      if (!left.signal.aborted && loaded.state === "ready") {
        setUpdate(loaded.data);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [app.id, core, offered]);
  if (accepted !== null) {
    const version = accepted;
    return (
      <Alert live="polite">
        <GitMergeIcon aria-hidden="true" />
        <AlertTitle>
          <Trans>The blueprint&apos;s update is version {version}</Trans>
        </AlertTitle>
        <AlertDescription>
          <Trans>It runs once it is made current.</Trans>
        </AlertDescription>
      </Alert>
    );
  }
  if (!offered || update === null) {
    return null;
  }
  const files = update.changes.length;
  return (
    <Alert live="polite">
      <GitMergeIcon aria-hidden="true" />
      <AlertTitle>
        <Trans>The blueprint this domain was made from has an update</Trans>
      </AlertTitle>
      <AlertDescription>
        <p>
          <Plural
            one="It changes # file. Review it before you take it."
            other="It changes # files. Review it before you take it."
            value={files}
          />
        </p>
        <div className="pt-2">
          <Button
            onClick={() => {
              setReviewing(true);
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Review the update</Trans>
          </Button>
        </div>
      </AlertDescription>
      {reviewing ? (
        <ReviewDialog
          app={app.id}
          onAccepted={setAccepted}
          onClose={() => {
            setReviewing(false);
          }}
          update={update}
        />
      ) : null}
    </Alert>
  );
};
