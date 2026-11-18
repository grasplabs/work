import type {
  ListedConnection,
  SharedSyncPlaces,
} from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
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
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import { Trans } from "@lingui/react/macro";
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

/** What reading the places from core came to. */
type PlacesRead =
  | { state: "loading" }
  | { state: "refused"; message: string }
  /** The connection syncs no picked places: nothing is shown. */
  | { state: "none" }
  | { state: "ready"; places: SharedSyncPlaces };

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

/** The places of `connectionId` to pick, and a way to read them again. */
const usePlaces = (
  connectionId: string
): { read: PlacesRead; reload: () => Promise<void> } => {
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
  const reload = async (): Promise<void> => {
    setRead(await readPlaces(core, connectionId));
  };
  return { read, reload };
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
  /** The picks were asked for: the places are read again. */
  onSaved: () => Promise<void>;
}) => {
  const ids = useId();
  const { busy, failure, change } = useChange();
  const before = places.choices
    .filter(({ picked }) => picked)
    .map(({ place }) => place);
  const [picked, setPicked] = useState<string[]>(before);
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
        {places.choices.map(({ place, title }) => (
          <li key={place}>
            <Field orientation="horizontal">
              <Checkbox
                checked={picked.includes(place)}
                disabled={busy}
                id={`${ids}-${place}`}
                onCheckedChange={(checked) => {
                  const rest = picked.filter((one) => one !== place);
                  setPicked(checked ? [...rest, place] : rest);
                }}
              />
              <FieldLabel htmlFor={`${ids}-${place}`}>{title}</FieldLabel>
            </Field>
          </li>
        ))}
      </ul>
      <Button
        className="self-start"
        disabled={busy || samePlaces(before, picked)}
        onClick={() => {
          void (async () => {
            await change(async (session) => {
              await session.connections.pickSyncPlaces({
                connectionId: connection.id,
                feed: places.feed,
                places: picked,
              });
            });
            await onSaved();
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
  const { read, reload } = usePlaces(connection.id);
  if (read.state === "loading" || read.state === "none") {
    return null;
  }
  if (read.state === "refused") {
    return <ErrorText>{read.message}</ErrorText>;
  }
  if (read.places.choices.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <Trans>Nothing to copy into the Brain yet</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              The account connected as {label} can&apos;t open any shared drives
              or SharePoint libraries.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  // Read again after a save: the form starts from what core holds now.
  const key = read.places.choices
    .map(({ place, picked }) => `${place}:${String(picked)}`)
    .join(",");
  return (
    <PlacesForm
      connection={connection}
      key={key}
      label={label}
      onSaved={reload}
      places={read.places}
    />
  );
};
