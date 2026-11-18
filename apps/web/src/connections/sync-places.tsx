import type {
  ListedConnection,
  SharedSyncPlaces,
} from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import { syncErrors } from "@grasp-os/shared/sync";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";
import { useChange } from "./use-change.ts";

// For an admin, on a shared connection's card beside who may read in the
// Brain what comes through it (brain-audience.tsx): which of its shared
// drives or SharePoint libraries Grasp may copy into the Brain. The two
// decisions belong together, and the page says, before anything is
// picked, that everyone who may read it can read everything in a picked
// place: the source's own permissions are not copied (GRA-1831). Core
// and connect decide who may pick and check every pick (sync-picks.ts,
// connect's sync.ts); the card only asks. It promises nothing about when
// a copy is made or taken away.
//
// A save changes only what the admin ticked or unticked: it starts from
// every place picked now (`picks`), those the listing doesn't show too,
// and connect refuses it (`sync.picks_changed`) once another change
// landed meanwhile, as the audience beside it does. The page then shows
// what is picked now, and says so.

/** What reading the places from core came to. */
type PlacesRead =
  | { state: "loading" }
  | { state: "refused"; message: string }
  /** The connection syncs no picked places: nothing is shown. */
  | { state: "none" }
  | {
      state: "ready";
      places: SharedSyncPlaces;
      /** A re-read was refused: what was read before stays, with why. */
      refused?: string;
    };

/**
 * The connection's places to pick, or why not. Outside the components, as
 * the React Compiler can't compile `try`.
 */
const readPlaces = async (
  core: CoreConnection,
  connectionId: string
): Promise<PlacesRead> => {
  try {
    const places = await core.withSession(
      async (session: Session) =>
        await session.connections.syncPlaces(connectionId)
    );
    return places === null ? { state: "none" } : { state: "ready", places };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/**
 * The places of `connectionId` to pick, and a way to read them again: a
 * refused re-read keeps what was read before, and says why beside it,
 * unless `keep` is false, when it shows the refusal alone, to try again.
 */
const usePlaces = (
  connectionId: string
): { read: PlacesRead; reload: (keep?: boolean) => Promise<void> } => {
  const core = useCore();
  const [read, setRead] = useState<PlacesRead>({ state: "loading" });
  useEffect(() => {
    let left = false;
    const load = async (): Promise<void> => {
      const answer = await readPlaces(core, connectionId);
      if (!left) {
        setRead(answer);
      }
    };
    void load();
    return () => {
      left = true;
    };
  }, [core, connectionId]);
  const reload = async (keep = true): Promise<void> => {
    const answer = await readPlaces(core, connectionId);
    setRead((before) =>
      keep && answer.state === "refused" && before.state === "ready"
        ? { ...before, refused: answer.message }
        : answer
    );
  };
  return { read, reload };
};

/**
 * Saves `places` from `from`: `changed` when connect refused it as the
 * picks changed meanwhile (nothing changed). Any other refusal is thrown.
 * Outside the components, as the React Compiler can't compile `try`.
 */
const pickedFrom = async (
  session: Session,
  request: {
    connectionId: string;
    feed: string;
    from: string[];
    places: string[];
  }
): Promise<"picked" | "changed"> => {
  try {
    await session.connections.pickSyncPlaces(request);
    return "picked";
  } catch (error) {
    if (syncErrors.codeOf(error) === "sync.picks_changed") {
      return "changed";
    }
    throw error;
  }
};

/** Whether `picked` holds the same places as `before`. */
const samePlaces = (
  before: readonly string[],
  picked: readonly string[]
): boolean =>
  before.length === picked.length &&
  before.every((place) => picked.includes(place));

/** The places of a connection, each to pick, and saving the picks. */
const PlacesForm = ({
  connection,
  label,
  places,
  onSaved,
}: {
  connection: ListedConnection;
  label: string;
  places: SharedSyncPlaces;
  /**
   * The picks were asked for, `changed` when another change landed
   * meanwhile: the places are read again.
   */
  onSaved: (changed: boolean) => Promise<void>;
}) => {
  const ids = useId();
  const { busy: saving, failure, change } = useChange();
  // From the save until the places are read again: a box ticked meanwhile
  // would be lost when the form starts again from what is picked now.
  const [rereading, setRereading] = useState(false);
  const busy = saving || rereading;
  const before = places.choices
    .filter(({ picked }) => picked)
    .map(({ place }) => place);
  const [picked, setPicked] = useState<string[]>(before);
  const shown = new Set(places.choices.map(({ place }) => place));
  // A picked place this listing doesn't show stays picked: only what the
  // admin unticked here goes.
  const unshown = places.picks.filter((place) => !shown.has(place));
  return (
    <FieldSet>
      <FieldLegend variant="label">
        <Trans>Copy into the Brain from {label}</Trans>
      </FieldLegend>
      <FieldDescription>
        <Trans>
          Everyone you let read {label} in the Brain will be able to read
          everything in the places you pick, because the permissions in {label}{" "}
          are not copied.
        </Trans>
      </FieldDescription>
      <ul className="flex flex-col gap-2">
        {places.choices.map(({ place, title, within }, index) => {
          // By position: a place's ID is the provider's, in any alphabet.
          const box = `${ids}-${index}`;
          return (
            <li key={place}>
              <Field orientation="horizontal">
                <Checkbox
                  // Named by the place and its site: every site has its
                  // own "Documents".
                  aria-labelledby={
                    within === null ? `${box}-title` : `${box}-title ${box}-in`
                  }
                  checked={picked.includes(place)}
                  disabled={busy}
                  id={box}
                  onCheckedChange={(checked) => {
                    const rest = picked.filter((one) => one !== place);
                    setPicked(checked ? [...rest, place] : rest);
                  }}
                />
                <FieldContent>
                  <FieldLabel htmlFor={box} id={`${box}-title`}>
                    {title}
                  </FieldLabel>
                  {within === null ? null : (
                    <FieldDescription id={`${box}-in`}>
                      {within}
                    </FieldDescription>
                  )}
                </FieldContent>
              </Field>
            </li>
          );
        })}
      </ul>
      <Button
        className="self-start"
        disabled={busy || samePlaces(before, picked)}
        onClick={() => {
          setRereading(true);
          void (async () => {
            let changed = false;
            await change(async (session) => {
              const outcome = await pickedFrom(session, {
                connectionId: connection.id,
                feed: places.feed,
                from: places.picks,
                places: [...unshown, ...picked],
              });
              changed = outcome === "changed";
            });
            await onSaved(changed);
            setRereading(false);
          })();
        }}
        size="sm"
        variant="outline"
      >
        <Trans>Save the places</Trans>
      </Button>
      <ErrorText>{failure}</ErrorText>
    </FieldSet>
  );
};

/** What the connected account can't open, by the connection's provider. */
const NothingToPick = ({
  connection,
  label,
}: {
  connection: ListedConnection;
  label: string;
}) => (
  <Empty>
    <EmptyHeader>
      <EmptyTitle>
        <Trans>Nothing to copy into the Brain yet</Trans>
      </EmptyTitle>
      <EmptyDescription>
        {connection.provider === "google" ? (
          <Trans>
            The account connected as {label} can&apos;t open any shared drives.
          </Trans>
        ) : (
          <Trans>
            The account connected as {label} can&apos;t open any SharePoint
            document libraries.
          </Trans>
        )}
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
);

/**
 * For an admin, on a shared connection's card: the shared drives or
 * SharePoint libraries Grasp may copy into the Brain, as the connected
 * account sees them, and which are picked. Nothing for a connection that
 * syncs no picked places.
 */
export const SyncPlaces = ({
  connection,
  label,
}: {
  connection: ListedConnection;
  label: string;
}) => {
  const { t } = useLingui();
  const { read, reload } = usePlaces(connection.id);
  // A save refused as the picks changed meanwhile: said, once the places
  // were read again, until the next save.
  const [changedMeanwhile, setChangedMeanwhile] = useState(false);
  const [retrying, setRetrying] = useState(false);
  if (read.state === "none") {
    return null;
  }
  if (read.state === "loading") {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner aria-label={t`Reading the places`} />
        <Trans>Reading the places {label} can open…</Trans>
      </p>
    );
  }
  if (read.state === "refused") {
    return (
      <div className="flex flex-col items-start gap-2">
        <ErrorText>{read.message}</ErrorText>
        <Button
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void (async () => {
              await reload();
              setRetrying(false);
            })();
          }}
          size="sm"
          variant="outline"
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  if (read.places.choices.length === 0) {
    return <NothingToPick connection={connection} label={label} />;
  }
  // Read again after a save: the form starts from what core holds now.
  const key = read.places.picks.toSorted().join(",");
  return (
    <div className="flex flex-col gap-2">
      <PlacesForm
        connection={connection}
        key={key}
        label={label}
        onSaved={async (changed) => {
          // Said only beside what was read after it: never while the form
          // still shows the admin's own ticks.
          setChangedMeanwhile(false);
          // Another change landed first: what the form shows is stale, so a
          // failed read shows its refusal alone, to try again.
          await reload(!changed);
          setChangedMeanwhile(changed);
        }}
        places={read.places}
      />
      {changedMeanwhile ? (
        <p className="text-muted-foreground text-sm">
          <Trans>
            The places picked from {label} were changed in the meantime. These
            are the ones picked now: pick again if you still want to change
            them.
          </Trans>
        </p>
      ) : null}
      <ErrorText>{read.refused}</ErrorText>
    </div>
  );
};
