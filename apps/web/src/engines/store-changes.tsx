import type { App } from "@grasp-os/shared/apps";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type {
  AbandonBackfill,
  AbandonedBackfill,
  AppStoreBackfill,
  MigrationFailure,
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
import { Await } from "@tanstack/react-router";
import { DatabaseIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
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

/**
 * What an explicit migration's failure means: its migration, table and
 * record, and what its transform threw or why its output was refused,
 * which only admins and the migration's own engine are shown.
 */
const MigrationFailureText = ({ failure }: { failure: MigrationFailure }) => {
  const { migration, table, id, issues } = failure;
  const record = <span className="font-mono">{id}</span>;
  return (
    <>
      {id === null ? (
        <Trans>
          The migration {migration} of the table {table} failed as a whole: its
          code failed, not a record.
        </Trans>
      ) : (
        <Trans>
          The migration {migration} of the table {table} failed on the record{" "}
          {record}.
        </Trans>
      )}
      {issues.length === 0 ? null : (
        <code className="block font-mono whitespace-pre-wrap">
          {issues.join("\n")}
        </code>
      )}
    </>
  );
};

/** Whether no record is to blame for `failure`: abandoning is all that's left. */
const nothingToMend = (failure: StoreBackfillFailure): boolean =>
  failure.reason === "stalled" ||
  ("migration" in failure && failure.id === null);

/** What a failure means, in a sentence naming the record and field. */
const FailureText = ({ failure }: { failure: StoreBackfillFailure }) => {
  if ("migration" in failure) {
    return <MigrationFailureText failure={failure} />;
  }
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

/** Abandoning the change, once confirmed; `describedBy` names its store. */
const AbandonDialog = ({
  describedBy,
  busy,
  onConfirm,
}: {
  describedBy: string;
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
            aria-describedby={describedBy}
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
              built again. The new fields stay reserved with the meaning this
              change gave them: a later version can add them again only exactly
              as they were. The values already filled in stay in the records,
              unseen. This can&apos;t be undone.
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

/** The store's ID, under the alias the change names it by. */
const StoreId = ({ change }: { change: AppStoreBackfill }) => {
  const { store } = change;
  return change.alias === null ? null : (
    <p className="font-mono">
      <Trans>Store ID: {store}</Trans>
    </p>
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
  const titleId = useId();
  const { backfill } = change;
  const name = change.alias ?? change.store;
  if (backfill.state === "running" || backfill.failure === null) {
    // Polite: it is where things stand, not news to interrupt with.
    return (
      <Alert live="polite">
        <DatabaseIcon aria-hidden="true" />
        <AlertTitle>
          <Trans>A change to the store {name} is being applied</Trans>
        </AlertTitle>
        <AlertDescription>
          <p>
            <Trans>
              Its new fields&apos; defaults are being filled in. Releases that
              need it can be made current once it has finished.
            </Trans>
          </p>
          <Progress change={change} />
          <StoreId change={change} />
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle id={titleId}>
        <Trans>A change to the store {name} can&apos;t be applied</Trans>
      </AlertTitle>
      <AlertDescription>
        <p>
          <FailureText failure={backfill.failure} />
        </p>
        <p>
          {nothingToMend(backfill.failure) ? (
            <Trans>
              Until this is resolved, no release that changes this store&apos;s
              tables can be made current, in this engine or any other engine
              using the store. No record is to blame, so there is nothing to
              mend: abandon the change for the store to take changes again.
            </Trans>
          ) : (
            <Trans>
              Until this is resolved, no release that changes this store&apos;s
              tables can be made current, in this engine or any other engine
              using the store. Mend the record through the engine and the change
              is tried again, or abandon it.
            </Trans>
          )}
        </p>
        <Progress change={change} />
        <StoreId change={change} />
        <div className="pt-2">
          <AbandonDialog
            busy={busy}
            describedBy={titleId}
            onConfirm={onAbandon}
          />
        </div>
      </AlertDescription>
    </Alert>
  );
};

/** What abandoning a change took out of force, named for the engine's page. */
export const Abandoned = ({
  abandoned,
  name,
  engine,
}: {
  abandoned: AbandonedBackfill;
  /** What the engine calls the store. */
  name: string;
  engine: App;
}) => {
  const { t } = useLingui();
  const engineName = engine.name;
  const releases = formatList(
    abandoned.releases.map(({ app, version }) =>
      app === engine.id
        ? t`${engineName}, version ${version}`
        : t`engine ${app}, version ${version}`
    )
  );
  const reserved = formatList(
    abandoned.reserved.map(({ table, field }) => `${table}.${field}`)
  );
  // Polite: focus moves to it once it shows (`StoreChangesOf`).
  return (
    <Alert live="polite">
      <DatabaseIcon aria-hidden="true" />
      <AlertTitle>
        <Trans>The change to the store {name} was abandoned</Trans>
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
export type Outcome =
  | { abandoned: AbandonedBackfill; name: string }
  | { failure: string };

/**
 * Abandons `change` as the page loaded it (its store, target and the run
 * seen failing) with `abandon`, core's `stores.abandonBackfill`, then reads
 * the page again with `refresh` whatever came of it, as a refusal may mean
 * the change moved on, and hands `settle` the outcome even if reading
 * again fails. Outside the component, as the React Compiler can't compile
 * `try`.
 */
export const abandonChange = async (
  change: AppStoreBackfill,
  abandon: (input: AbandonBackfill) => Promise<AbandonedBackfill>,
  refresh: () => Promise<void>,
  settle: (outcome: Outcome) => void
): Promise<void> => {
  const { store, alias, backfill } = change;
  let outcome: Outcome;
  try {
    const abandoned = await abandon({
      store,
      target: backfill.target,
      attempt: backfill.attempt,
    });
    outcome = { abandoned, name: alias ?? store };
  } catch (error) {
    outcome = { failure: abandonFailureText(error) };
  }
  try {
    await refresh();
  } finally {
    settle(outcome);
  }
};

/** A read of the engine's stores' changes, which the page doesn't wait for. */
type ChangesRead = Promise<Loaded<AppStoreBackfill[]>>;

/** The engine's stores' changes, read from core. */
const readChangesOf = async (
  core: Pick<CoreConnection, "withSession">,
  engine: string
): ChangesRead =>
  await loadFromCore(
    core,
    async (session) => await session.stores.appBackfills(engine)
  );

/**
 * The read of the engine's stores' changes, for its loader: started only
 * for the organization's own admins, never Grasp staff, who alone may
 * abandon one; nothing, and nothing asked of core, for anyone else.
 */
export const readStoreChanges = (
  core: Pick<CoreConnection, "withSession">,
  viewer: { role: string; staff: boolean },
  engine: string
): ChangesRead | undefined =>
  isMemberAdmin(viewer) ? readChangesOf(core, engine) : undefined;

const StoreChangesOf = ({
  changes,
  engine,
}: {
  changes: ChangesRead;
  engine: App;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [busy, setBusy] = useState(false);
  // After an abandonment, only this section reads again, never the whole
  // route: a route read that failed (offline, refused) would swap the page
  // for its error and take the outcome below with it, so the admin would
  // never learn which releases can't run or which fields stay reserved.
  // The read is kept with the loader's read it replaced, so a later reload
  // of the route shows what that reads.
  const [reread, setReread] = useState<{
    of: ChangesRead;
    read: ChangesRead;
  }>();
  const shown = reread?.of === changes ? reread.read : changes;
  const [outcome, setOutcome] = useState<Outcome>();
  const outcomeRef = useRef<HTMLDivElement>(null);
  // The control that was confirmed may be gone once the page is read
  // again: focus goes to what came of it, never back to the page's body.
  useEffect(() => {
    if (outcome !== undefined) {
      outcomeRef.current?.focus();
    }
  }, [outcome]);
  const abandon = async (change: AppStoreBackfill) => {
    setBusy(true);
    setOutcome(undefined);
    await abandonChange(
      change,
      async (input) =>
        await core.withSession(
          async (session) => await session.stores.abandonBackfill(input)
        ),
      async () => {
        const read = readChangesOf(core, engine.id);
        setReread({ of: changes, read });
        // Waited for, so the controls stay off until what they act on is
        // back. A failed read never throws: it shows where the list was.
        await read;
      },
      (ended) => {
        setOutcome(ended);
        setBusy(false);
      }
    );
  };
  return (
    <section
      aria-label={t`Changes to the engine's stores`}
      className="flex flex-col gap-3 empty:hidden"
      id={storeChangesAnchor}
    >
      <Await fallback={null} promise={shown}>
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
      {outcome === undefined ? null : (
        <div className="outline-none" ref={outcomeRef} tabIndex={-1}>
          {"abandoned" in outcome ? (
            <Abandoned
              abandoned={outcome.abandoned}
              engine={engine}
              name={outcome.name}
            />
          ) : (
            <ErrorText>{outcome.failure}</ErrorText>
          )}
        </div>
      )}
    </section>
  );
};

/**
 * The engine's stores' pending changes, as `readStoreChanges` read them;
 * nothing for anyone it didn't read them for.
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
