import type {
  ConnectionBrainAudience,
  ListedConnection,
  SharedSyncPlaces,
} from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import { syncErrors } from "@grasp-os/shared/sync";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Checkbox, CheckboxGroup } from "../grasp/checkbox/index.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../grasp/field/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCore } from "../use-core.ts";
import { useChange } from "./use-change.ts";

// For an admin, on a shared connection's card beside who may read in the
// Brain what comes through it (brain-audience.tsx): which of its shared
// drives or SharePoint libraries Grasp may copy into the Brain. The two
// decisions belong together: everyone who may read it can read
// everything in a picked place, whatever the source's own permissions
// (GRA-2207). So a save that picks a place asks the admin to tick, for
// the audience held now, that they know it; another audience asks again.
// Core and connect decide who may pick and check every pick, the tick
// too (sync-picks.ts, connect's sync.ts); the card only asks. It promises
// nothing about when a copy is made or taken away.
//
// A save changes only what the admin ticked or unticked: it starts from
// every place picked now (`picks`), those the listing doesn't show too,
// and connect refuses it (`sync.picks_changed`) once another change
// landed meanwhile, as the audience beside it does. The page then shows
// what is picked now, and says so.

const styles = stylex.create({
  // The section's name in the card's flush rows, on their inset, as the
  // card's other sections have it (connection-list.tsx).
  head: {
    marginInline: grasp.space4,
    marginBlockStart: grasp.space3,
    marginBlockEnd: grasp.space1,
  },
  // What the section holds, on the same inset.
  body: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    rowGap: grasp.space2,
    paddingInline: grasp.space4,
    paddingBlockEnd: grasp.space4,
  },
  reading: {
    display: "flex",
    alignItems: "center",
    columnGap: grasp.space2,
  },
});

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
 * picks changed meanwhile, `unconfirmed` when core refused it as the
 * audience confirmed is no longer the one held (nothing changed either
 * way). Any other refusal is thrown.
 * Outside the components, as the React Compiler can't compile `try`.
 */
const pickedFrom = async (
  session: Session,
  request: {
    connectionId: string;
    feed: string;
    from: string[];
    places: string[];
    acknowledged?: ConnectionBrainAudience;
  }
): Promise<"picked" | "changed" | "unconfirmed"> => {
  try {
    await session.connections.pickSyncPlaces(request);
    return "picked";
  } catch (error) {
    const code = syncErrors.codeOf(error);
    if (code === "sync.picks_changed") {
      return "changed";
    }
    if (code === "sync.unacknowledged") {
      return "unconfirmed";
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

/** An audience, as a value that tells one from another. */
const keyOf = (audience: ConnectionBrainAudience): string =>
  audience.kind === "team" ? `team:${audience.teamId}` : audience.kind;

/** What the admin ticks to say who will read everything in the places picked. */
const Readers = ({
  audience,
  team,
  label,
}: {
  audience: ConnectionBrainAudience;
  team: string | undefined;
  label: string;
}) => {
  if (audience.kind === "everyone") {
    return (
      <Trans>
        Everyone in the company will be able to read everything in the places
        you pick, whatever their permissions in {label}.
      </Trans>
    );
  }
  if (audience.kind === "team" && team !== undefined) {
    return (
      <Trans>
        Everyone in the team {team} will be able to read everything in the
        places you pick, whatever their permissions in {label}.
      </Trans>
    );
  }
  if (audience.kind === "team") {
    return (
      <Trans>
        Everyone in this team will be able to read everything in the places you
        pick, whatever their permissions in {label}.
      </Trans>
    );
  }
  return (
    <Trans>
      Whoever you let read {label} in the Brain will be able to read everything
      in the places you pick, whatever their permissions in {label}.
    </Trans>
  );
};

/** The places of a connection, each to pick, and saving the picks. */
const PlacesForm = ({
  connection,
  label,
  audience,
  team,
  places,
  onSaved,
  onAudienceStale,
}: {
  connection: ListedConnection;
  label: string;
  /** The connection's Brain audience as core holds it now. */
  audience: ConnectionBrainAudience;
  /** The name of the audience's team, if it is one the page knows. */
  team: string | undefined;
  places: SharedSyncPlaces;
  /** Core holds another audience than `audience`: read it again. */
  onAudienceStale: () => void;
  /**
   * The picks were asked for, `changed` when another change landed
   * meanwhile: the places are read again.
   */
  onSaved: (changed: boolean) => Promise<void>;
}) => {
  const { t } = useLingui();
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
  // Picking a place asks for the tick, for the audience it was ticked
  // for: another audience, chosen meanwhile, asks again.
  const picksMore = picked.some((place) => !places.picks.includes(place));
  const [confirmedFor, setConfirmedFor] = useState<string>();
  const confirmed = confirmedFor === keyOf(audience);
  return (
    <>
      <CheckboxGroup
        aria-label={t`Copy into the Brain from ${label}`}
        disabled={busy}
        onValueChange={(value: string[]) => {
          setPicked([
            ...picked.filter((place) => value.includes(place)),
            ...value.filter((place) => !picked.includes(place)),
          ]);
        }}
        value={picked}
      >
        {places.choices.map(({ place, title, within }) => (
          <Field key={place} orientation="horizontal">
            <Checkbox value={place} />
            <FieldContent>
              {/* Named by the place and its site: every site has its own
                  "Documents". */}
              <FieldLabel>
                {title}
                {within === null ? null : (
                  <span {...stylex.props(visuallyHidden)}> {within}</span>
                )}
              </FieldLabel>
              {within === null ? null : (
                <FieldDescription>{within}</FieldDescription>
              )}
            </FieldContent>
          </Field>
        ))}
      </CheckboxGroup>
      {picksMore ? (
        <Field orientation="horizontal">
          <Checkbox
            checked={confirmed}
            disabled={busy}
            onCheckedChange={(checked) => {
              setConfirmedFor(checked === true ? keyOf(audience) : undefined);
            }}
          />
          <FieldContent>
            <FieldLabel>
              <Readers audience={audience} label={label} team={team} />
            </FieldLabel>
          </FieldContent>
        </Field>
      ) : null}
      <Button
        disabled={
          busy || samePlaces(before, picked) || (picksMore && !confirmed)
        }
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
                ...(picksMore ? { acknowledged: audience } : {}),
              });
              changed = outcome === "changed";
              // Confirmed for an audience no longer held: asked again, for
              // the one held now.
              if (outcome === "unconfirmed") {
                setConfirmedFor(undefined);
                onAudienceStale();
              }
            });
            await onSaved(changed);
            setRereading(false);
          })();
        }}
        size="sm"
        variant="quiet"
      >
        {t`Save the places`}
      </Button>
      <ErrorText>{failure}</ErrorText>
    </>
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
  <Empty size="inline">
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
  audience,
  team,
  onAudienceStale,
}: {
  connection: ListedConnection;
  label: string;
  /** The connection's Brain audience as core holds it now. */
  audience: ConnectionBrainAudience;
  /** The name of the audience's team, if it is one the page knows. */
  team: string | undefined;
  /** Core holds another audience than `audience`: read it again. */
  onAudienceStale: () => void;
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
  const body = (): ReactNode => {
    if (read.state === "loading") {
      return (
        <div {...stylex.props(styles.reading)}>
          <Spinner aria-label={t`Reading the places`} />
          <Text size="sm" tone="muted">
            <Trans>Reading the places {label} can open…</Trans>
          </Text>
        </div>
      );
    }
    if (read.state === "refused") {
      return (
        <>
          <Alert tone="danger">{read.message}</Alert>
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
            variant="quiet"
          >
            {t`Try again`}
          </Button>
        </>
      );
    }
    if (read.places.choices.length === 0) {
      return <NothingToPick connection={connection} label={label} />;
    }
    // Read again after a save: the form starts from what core holds now.
    const key = read.places.picks.toSorted().join(",");
    return (
      <>
        <PlacesForm
          audience={audience}
          connection={connection}
          key={key}
          label={label}
          onAudienceStale={onAudienceStale}
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
          team={team}
        />
        {changedMeanwhile ? (
          <Text size="sm" tone="muted">
            <Trans>
              The places picked from {label} were changed in the meantime. These
              are the ones picked now: pick again if you still want to change
              them.
            </Trans>
          </Text>
        ) : null}
        <ErrorText>{read.refused}</ErrorText>
      </>
    );
  };
  return (
    <section>
      <SectionHeader
        headingLevel={3}
        layout={styles.head}
        size="sm"
        title={t`Copy into the Brain from ${label}`}
      />
      <div {...stylex.props(styles.body)}>{body()}</div>
    </section>
  );
};
