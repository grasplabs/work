import type {
  ConnectionBrainAudience,
  ConnectionBrainAudienceSetting,
  ListedConnection,
} from "@grasp-os/shared/connect";
import { connectionErrors } from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
  FieldStatus,
} from "@grasp-os/ui/components/field";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { InfoTip } from "../frame/info-tip.tsx";
import { useCore } from "../use-core.ts";
import { RowAlert } from "./app/rows.tsx";
import { SyncPlaces } from "./sync-places.tsx";
import { useChange } from "./use-change.ts";

// For an admin, on a shared connection's card: who may read in the Brain
// what agents read through it (GRA-1831), one team, everyone or nobody,
// and erasing what the Brain kept of it. Core decides who may change it
// and checks every choice (connection-audiences.ts, shared-reads.ts);
// the card only asks. Opening it or widening it is confirmed first, in a
// whole sentence that says what was kept before is shown too; back to
// nobody hides it and keeps it, so it needs none. Erasing is for good.
// Beside it, which of the connection's shared drives or libraries Grasp
// may copy into the Brain (sync-places.tsx): what comes in, and who may
// read it, are decided in one place.

const styles = stylex.create({
  // A setting's label and its info mark, as #2503's setting row: on one
  // line, the label wrapping beside the mark.
  named: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    width: "fit-content",
    minWidth: 0,
  },
  // The mark in a box one line tall: its button never makes the row taller.
  mark: {
    display: "inline-flex",
    alignItems: "center",
    height: font.textSmLine,
  },
  // The section's name in the card's flush rows, on their inset, as the
  // card's other sections have it (connection-list.tsx).
  head: {
    marginInline: space["4"],
    marginBlockStart: space["3"],
    marginBlockEnd: space["1"],
  },
});

/** A team of the company, to choose. */
interface Team {
  id: string;
  name: string;
}

/** What the cards read from core once for all of them: every shared connection's audience, and the company's teams. */
interface Audiences {
  settings: ConnectionBrainAudienceSetting[];
  teams: Team[];
}

/** What reading the audiences from core came to. */
type AudiencesRead =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | {
      state: "ready";
      data: Audiences;
      /** A re-read was refused: the data read before stays, with why. */
      refused?: string;
    };

/**
 * Every shared connection's audience, or why not: one read of core's
 * list. Outside the components, as the React Compiler can't compile
 * `try`.
 */
const readSettings = async (
  core: CoreConnection
): Promise<ConnectionBrainAudienceSetting[] | { refused: string }> => {
  try {
    return await core.withSession(
      async (session: Session) => await session.connections.brainAudiences()
    );
  } catch (error) {
    return { refused: failureText(error) };
  }
};

/** Every shared connection's audience and the company's teams, or why not. */
const readAudiences = async (core: CoreConnection): Promise<AudiencesRead> => {
  try {
    const data = await core.withSession(
      async (session: Session): Promise<Audiences> => {
        const [settings, teams] = await Promise.all([
          session.connections.brainAudiences(),
          session.organization.teams(),
        ]);
        return { settings, teams };
      }
    );
    return { state: "ready", data };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/**
 * The shared connections' audiences and the company's teams, read once
 * for every card of a page when `wanted` (an admin who chooses on at
 * least one), and `onChanged`, which reads the audiences again, once,
 * after a change or an erase was asked for: the cards show only what core
 * says, never a copy of their own. Read again too when the window comes
 * back to the page, as other lists are (chat/build-progress.tsx): so an
 * erasure that ended, or another admin's choice, shows without a reload.
 * A refused re-read keeps what was read before and says why beside it;
 * after any refusal the next read is a whole one, teams too.
 */
export const useBrainAudiences = (
  wanted: boolean
): { read: AudiencesRead; onChanged: () => void } => {
  const core = useCore();
  const [read, setRead] = useState<AudiencesRead>({ state: "loading" });
  useEffect(() => {
    let left = false;
    const load = async (): Promise<void> => {
      const answer = await readAudiences(core);
      if (!left) {
        setRead(answer);
      }
    };
    if (wanted) {
      void load();
    }
    return () => {
      left = true;
    };
  }, [core, wanted]);
  const whole = read.state !== "ready" || read.refused !== undefined;
  const onChanged = (): void => {
    void (async () => {
      if (whole) {
        const answer = await readAudiences(core);
        setRead((before) =>
          answer.state === "refused" && before.state === "ready"
            ? { ...before, refused: answer.message }
            : answer
        );
        return;
      }
      const settings = await readSettings(core);
      setRead((before) => {
        if (before.state !== "ready") {
          return before;
        }
        if ("refused" in settings) {
          return { ...before, refused: settings.refused };
        }
        return { state: "ready", data: { ...before.data, settings } };
      });
    })();
  };
  const back = useEffectEvent(onChanged);
  useEffect(() => {
    const returned = (): void => {
      if (wanted) {
        back();
      }
    };
    window.addEventListener("focus", returned);
    return () => {
      window.removeEventListener("focus", returned);
    };
  }, [wanted]);
  return { read, onChanged };
};

/**
 * Chooses `next` for `connectionId` from `from`, the audience the admin
 * was looking at: `changed` when core refused it as another was held
 * meanwhile (nothing changed). Any other refusal is thrown. Outside the
 * components, as the React Compiler can't compile `try`.
 */
const chosenFrom = async (
  session: Session,
  connectionId: string,
  next: ConnectionBrainAudience,
  from: ConnectionBrainAudience,
  confirmed: boolean
): Promise<"chosen" | "changed"> => {
  try {
    await session.connections.setBrainAudience(
      connectionId,
      next,
      from,
      // Opening it to someone new is confirmed first (`WidenDialog`), and
      // core refuses it unconfirmed.
      ...(confirmed ? [next] : [])
    );
    return "chosen";
  } catch (error) {
    if (
      connectionErrors.codeOf(error) === "connection.brain_audience_changed"
    ) {
      return "changed";
    }
    throw error;
  }
};

/** The name of `audience`'s team, if it is a team the list holds. */
const teamNameOf = (
  audience: ConnectionBrainAudience,
  teams: readonly Team[]
): string | undefined =>
  audience.kind === "team"
    ? teams.find(({ id }) => id === audience.teamId)?.name
    : undefined;

/** An audience as the select names it: `nobody`, `everyone`, or a team's ID. */
const valueOf = (audience: ConnectionBrainAudience): string =>
  audience.kind === "team" ? audience.teamId : audience.kind;

/** The audience the select's `value` names. */
const audienceOf = (value: string): ConnectionBrainAudience => {
  if (value === "nobody" || value === "everyone") {
    return { kind: value };
  }
  return { kind: "team", teamId: value };
};

/** Whether `next` lets anyone read who `now` doesn't: confirmed first. */
const widens = (
  now: ConnectionBrainAudience,
  next: ConnectionBrainAudience
): boolean =>
  next.kind !== "nobody" &&
  valueOf(now) !== valueOf(next) &&
  now.kind !== "everyone";

/** Asks before `next` is chosen for `label`: what it shows, and to whom. */
const WidenDialog = ({
  label,
  next,
  teams,
  onConfirm,
  onCancel,
}: {
  label: string;
  next: ConnectionBrainAudience;
  teams: Team[];
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const { t } = useLingui();
  const team = teamNameOf(next, teams);
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      open
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Keep what agents read through {label} in the Brain?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {next.kind === "everyone" ? (
              <Trans>
                Everyone in the company will be able to find what agents read
                through {label} and what is copied from it, including what was
                kept before, whatever their permissions in {label}. Their
                assistants will also read {label} directly, in their own chats.
                Choose a team if not everyone should have this.
              </Trans>
            ) : null}
            {next.kind === "team" && team !== undefined ? (
              <Trans>
                Everyone in {team} will be able to find what agents read through{" "}
                {label} and what is copied from it, including what was kept
                before, whatever their permissions in {label}. Their assistants
                will also read {label} directly, in their own chats.
              </Trans>
            ) : null}
            {next.kind === "team" && team === undefined ? (
              <Trans>
                Everyone in this team will be able to find what agents read
                through {label} and what is copied from it, including what was
                kept before, whatever their permissions in {label}. Their
                assistants will also read {label} directly, in their own chats.
              </Trans>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction onClick={onConfirm}>
            {t`Keep it for them`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/**
 * The erase dialog's answers, and why an erase was refused. Mounted only
 * while the dialog is open, so a reason from an earlier try is gone when
 * it opens again; while the erase runs the dialog stays open.
 */
const EraseAnswers = ({
  connection,
  onErased,
  onDone,
}: {
  connection: ListedConnection;
  onErased: () => void;
  /** Closes the question once it is erased. */
  onDone: () => void;
}) => {
  const { failure, change } = useChange();
  const { t } = useLingui();
  return (
    <>
      {failure === undefined ? null : (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel />
        {/* Work that runs before it closes: the question stays open, with core's reason, when it fails. */}
        <Button
          errorText={t`Couldn't erase`}
          onClick={async () => {
            let erased = false;
            await change(async (session) => {
              await session.connections.eraseBrainReads(connection.id);
              erased = true;
            });
            onErased();
            if (!erased) {
              throw new Error("Not erased");
            }
            onDone();
          }}
          size="sm"
          variant="destructive"
        >
          {t`Erase for good`}
        </Button>
      </AlertDialogFooter>
    </>
  );
};

/** Erasing what the Brain kept of the connection, once confirmed: for good. */
const EraseKept = ({
  connection,
  label,
  onErased,
}: {
  connection: ListedConnection;
  label: string;
  /** The erase was asked for: what the card shows is read again. */
  onErased: () => void;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          {t`Erase what the Brain kept`}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t`Erase what the Brain kept from ${label}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t`Everything the Brain kept from it is erased for good, and nobody reads it from now on. This can't be undone. To keep anything from it again, choose who may read it once the erasure is done.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <EraseAnswers
          connection={connection}
          onDone={() => {
            setOpen(false);
          }}
          onErased={onErased}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
};

/**
 * For an admin, on a shared connection's card: its Brain audience as
 * core holds it (`audiences`, read once for every card), and erasing what
 * was kept. `onChanged` once a change or an erase was asked for, whether
 * it went through or was refused, so the audiences are read again; its
 * own error stays on the card meanwhile.
 */
export const BrainAudience = ({
  connection,
  label,
  audiences,
  onChanged,
}: {
  connection: ListedConnection;
  label: string;
  audiences: AudiencesRead;
  onChanged: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, change } = useChange();
  // The widening asked about, and the audience it was asked from: what
  // core is told the choice was made from, so another admin's change
  // meanwhile is refused, not overwritten.
  const [asked, setAsked] = useState<{
    next: ConnectionBrainAudience;
    from: ConnectionBrainAudience;
  }>();
  // Refused as the audience changed meanwhile: said until the next choice.
  const [changedMeanwhile, setChangedMeanwhile] = useState(false);
  if (audiences.state === "loading") {
    return null;
  }
  const title = t`The Brain`;
  if (audiences.state === "refused") {
    return (
      <section>
        <SectionHeader style={styles.head} size="sm" title={title} />
        <RowAlert variant="destructive">{audiences.message}</RowAlert>
      </section>
    );
  }
  const { settings, teams } = audiences.data;
  const setting = settings.find(
    ({ connectionId }) => connectionId === connection.id
  );
  const audience: ConnectionBrainAudience = setting?.audience ?? {
    kind: "nobody",
  };
  const erasing = setting?.erasing ?? false;
  const choose = (
    next: ConnectionBrainAudience,
    from: ConnectionBrainAudience,
    confirmed = false
  ): void => {
    setAsked(undefined);
    setChangedMeanwhile(false);
    void (async () => {
      await change(async (session) => {
        const outcome = await chosenFrom(
          session,
          connection.id,
          next,
          from,
          confirmed
        );
        setChangedMeanwhile(outcome === "changed");
      });
      onChanged();
    })();
  };
  const choices = [
    { value: "nobody", label: t`Nobody` },
    { value: "everyone", label: t`Everyone in the company` },
    ...teams.map(({ id, name }) => ({ value: id, label: t`Team ${name}` })),
  ];
  return (
    <section>
      <SectionHeader
        actions={
          !erasing &&
          (audience.kind !== "nobody" || connection.keepsReads === true) ? (
            <EraseKept
              connection={connection}
              label={label}
              onErased={onChanged}
            />
          ) : null
        }
        style={styles.head}
        size="sm"
        title={title}
      />
      <FieldGroup>
        <Field orientation="responsive">
          <FieldContent>
            {/* The label and its info mark on one line, the mark outside it so the select keeps the label's words, as #2503's setting row. */}
            <div {...stylex.props(styles.named)}>
              <FieldLabel>{t`Keep what agents read through it for`}</FieldLabel>
              <span {...stylex.props(styles.mark)}>
                <InfoTip>
                  {t`Who may read it, in the Brain and through their assistant in their own chat, is decided inside Grasp, not by the permissions in ${label}: choose a team if not everyone should have it.`}
                </InfoTip>
              </span>
            </div>
          </FieldContent>
          <Select
            disabled={busy || erasing}
            items={choices}
            onValueChange={(value: string | null) => {
              if (value === null) {
                return;
              }
              const next = audienceOf(value);
              if (widens(audience, next)) {
                setAsked({ next, from: audience });
                return;
              }
              choose(next, audience);
            }}
            value={valueOf(audience)}
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent />
          </Select>
          <FieldStatus status={busy ? "loading" : "idle"} />
        </Field>
        {failure === undefined ? null : (
          <RowAlert variant="destructive">{failure}</RowAlert>
        )}
        {connection.status === "needs_reauth" ? (
          <RowAlert variant="warning">
            {t`Nobody can find what the Brain kept from ${label} until someone signs in again. None of it is erased.`}
          </RowAlert>
        ) : null}
        {erasing ? (
          <RowAlert>
            {t`What the Brain kept from ${label} is being erased. You can choose who may read it again once that is done.`}
          </RowAlert>
        ) : null}
        {changedMeanwhile ? (
          <RowAlert variant="warning">
            {t`Who may read what agents read through ${label} was changed in the meantime. This is who may read it now: choose again if you still want to change it.`}
          </RowAlert>
        ) : null}
        {audiences.refused === undefined ? null : (
          <RowAlert variant="destructive">{audiences.refused}</RowAlert>
        )}
      </FieldGroup>
      {asked === undefined ? null : (
        <WidenDialog
          label={label}
          next={asked.next}
          onCancel={() => {
            setAsked(undefined);
          }}
          onConfirm={() => {
            choose(asked.next, asked.from, true);
          }}
          teams={teams}
        />
      )}
      <SyncPlaces
        audience={audience}
        connection={connection}
        label={label}
        onAudienceStale={onChanged}
        team={teamNameOf(audience, teams)}
      />
    </section>
  );
};
