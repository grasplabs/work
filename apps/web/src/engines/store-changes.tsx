import type { App } from "@grasp-os/shared/apps";
import type {
  AbandonBackfill,
  AbandonedBackfill,
  AppStoreBackfill,
  StoreBackfillFailure,
} from "@grasp-os/shared/stores";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Trans, useLingui } from "@lingui/react/macro";
import { Await, useRouter } from "@tanstack/react-router";
import { DatabaseIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { abandonFailureText } from "./store-change-errors.ts";

// A schema change of a store the engine uses (store-backfill.ts in core),
// for the organization's admins: while its new fields' defaults are being
// filled in, and once filling them in failed on a record, which blocks
// every schema change of that store, whichever engine's, until the record
// is mended or an admin abandons the change (core's store-abandon.ts).
// Only admins read it, so only they see any of it: for anyone else the
// engine page doesn't read it at all.

/** Where the engine page shows its stores' changes, for links to them. */
export const storeChangesAnchor = "store-changes";

/** What a failure means, in a sentence naming the record and field. */
const FailureText = ({ failure }: { failure: StoreBackfillFailure }) => {
  if (failure.reason === "stalled") {
    return (
      <Trans>
        Filling in the new fields stopped making progress, and trying again
        didn&apos;t help.
      </Trans>
    );
  }
  const { table, field, id } = failure;
  const record = <span className="font-mono">{id}</span>;
  return failure.reason === "too_large" ? (
    <Trans>
      Filling in the new field {field} of the table {table} would make the
      record {record} larger than a record may be.
    </Trans>
  ) : (
    <Trans>
      The new field {field} of the table {table} can&apos;t be filled in: the
      record {record} already holds a value under that name that the field
      doesn&apos;t accept.
    </Trans>
  );
};

/** How far filling in got. */
const Progress = ({ change }: { change: AppStoreBackfill }) => {
  const { scanned, filled } = change.backfill;
  return (
    <p className="tabular-nums">
      <Trans>
        Records checked: {scanned}. Filled in: {filled}.
      </Trans>
    </p>
  );
};

/** Abandoning the change to `store`, once confirmed. */
const AbandonDialog = ({
  store,
  busy,
  onConfirm,
}: {
  store: string;
  busy: boolean;
  onConfirm: () => void;
}) => {
  const { t } = useLingui();
  const [confirming, setConfirming] = useState(false);
  return (
    <Dialog onOpenChange={setConfirming} open={confirming}>
      <DialogTrigger
        render={
          <Button
            aria-label={t`Abandon the change to store ${store}`}
            disabled={busy}
            size="sm"
            variant="destructive"
          />
        }
      >
        <Trans>Abandon this change</Trans>
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Abandon this change?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              The store keeps its tables as they are, and takes changes again.
              The release that needed this change can never be made current, in
              this engine or any other engine using the store: it has to be
              built again.
            </Trans>
          </DialogDescription>
          <DialogDescription>
            <Trans>
              The new fields stay reserved with the meaning this change gave
              them: a later version can add them again only exactly as they
              were. The values already filled in stay in the records, unseen.
              This can&apos;t be undone.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter closeLabel={t`Close`} showCloseButton>
          <Button
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              onConfirm();
            }}
            variant="destructive"
          >
            <Trans>Abandon the change</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * One store's pending change: how far filling in got and, once it failed,
 * which record and field failed, what that blocks, and abandoning it.
 */
export const StoreChange = ({
  change,
  busy,
  onAbandon,
}: {
  change: AppStoreBackfill;
  busy: boolean;
  onAbandon: () => void;
}) => {
  const { store, backfill } = change;
  if (backfill.state === "running" || backfill.failure === null) {
    return (
      <Alert>
        <DatabaseIcon aria-hidden="true" />
        <AlertTitle>
          <Trans>A change to the store {store} is being applied</Trans>
        </AlertTitle>
        <AlertDescription>
          <p>
            <Trans>
              Its new fields&apos; defaults are being filled in. Releases that
              need it can be made current once it has finished.
            </Trans>
          </p>
          <Progress change={change} />
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>
        <Trans>A change to the store {store} can&apos;t be applied</Trans>
      </AlertTitle>
      <AlertDescription>
        <p>
          <FailureText failure={backfill.failure} />
        </p>
        <p>
          <Trans>
            Until this is resolved, no release that changes this store&apos;s
            tables can be made current, in this engine or any other engine using
            the store. Mend the record through the engine and the change is
            tried again, or abandon it.
          </Trans>
        </p>
        <Progress change={change} />
        <div className="pt-2">
          <AbandonDialog busy={busy} onConfirm={onAbandon} store={store} />
        </div>
      </AlertDescription>
    </Alert>
  );
};

/** What abandoning a change took out of force, named for the engine's page. */
export const Abandoned = ({
  abandoned,
  engine,
}: {
  abandoned: AbandonedBackfill;
  engine: App;
}) => {
  const { t } = useLingui();
  const { name } = engine;
  const { store } = abandoned;
  const releases = formatList(
    abandoned.releases.map(({ app, version }) =>
      app === engine.id
        ? t`${name}, version ${version}`
        : t`engine ${app}, version ${version}`
    )
  );
  const reserved = formatList(
    abandoned.reserved.map(({ table, field }) => `${table}.${field}`)
  );
  return (
    <Alert>
      <DatabaseIcon aria-hidden="true" />
      <AlertTitle>
        <Trans>The change to the store {store} was abandoned</Trans>
      </AlertTitle>
      <AlertDescription>
        {abandoned.releases.length === 0 ? null : (
          <p>
            <Trans>These releases can never be made current: {releases}.</Trans>
          </p>
        )}
        {abandoned.reserved.length === 0 ? null : (
          <p>
            <Trans>
              These fields stay reserved with their current meaning: {reserved}.
            </Trans>
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
};

/** What came of abandoning a change: what it took out of force, or why not. */
type Outcome = { abandoned: AbandonedBackfill } | { failure: string };

/**
 * Abandons the change `input` names, then reads the page again whatever
 * came of it: a refusal may mean the change moved on. Outside the
 * component, as the React Compiler can't compile `try`.
 */
const abandonThenRefresh = async (
  core: CoreConnection,
  input: AbandonBackfill,
  refresh: () => Promise<void>
): Promise<Outcome> => {
  let outcome: Outcome;
  try {
    const abandoned = await core.withSession(
      async (session) => await session.stores.abandonBackfill(input)
    );
    outcome = { abandoned };
  } catch (error) {
    outcome = { failure: abandonFailureText(error) };
  }
  await refresh();
  return outcome;
};

/** A read of the engine's stores' changes, which the page doesn't wait for. */
type ChangesRead = Promise<Loaded<AppStoreBackfill[]>>;

const StoreChangesOf = ({
  changes,
  engine,
}: {
  changes: ChangesRead;
  engine: App;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const abandon = async ({ store, backfill }: AppStoreBackfill) => {
    setBusy(true);
    setOutcome(undefined);
    const ended = await abandonThenRefresh(
      core,
      { store, target: backfill.target, attempt: backfill.attempt },
      async () => {
        // `sync` waits for the loader, so the controls stay off until what
        // they act on is back.
        await router.invalidate({ sync: true });
      }
    );
    setOutcome(ended);
    setBusy(false);
  };
  return (
    <section
      aria-label={t`Changes to the engine's stores`}
      className="flex flex-col gap-3 empty:hidden"
      id={storeChangesAnchor}
    >
      <Await fallback={null} promise={changes}>
        {(loaded) =>
          loaded.state === "ready" ? (
            <>
              {loaded.data.map((change) => (
                <StoreChange
                  busy={busy}
                  change={change}
                  key={`${change.store}:${change.backfill.target}:${change.backfill.attempt}`}
                  onAbandon={() => {
                    void abandon(change);
                  }}
                />
              ))}
            </>
          ) : (
            <NotLoaded page={loaded} />
          )
        }
      </Await>
      {outcome !== undefined && "abandoned" in outcome ? (
        <Abandoned abandoned={outcome.abandoned} engine={engine} />
      ) : null}
      <ErrorText>
        {outcome !== undefined && "failure" in outcome
          ? outcome.failure
          : undefined}
      </ErrorText>
    </section>
  );
};

/**
 * The engine's stores' pending changes, read only for the organization's
 * admins (`changes`); nothing for anyone else.
 */
export const StoreChanges = ({
  changes,
  engine,
}: {
  changes: ChangesRead | undefined;
  engine: App;
}) =>
  changes === undefined ? null : (
    <StoreChangesOf changes={changes} engine={engine} />
  );
