import { onlyForAsking } from "@grasp-os/shared/interview-links";
import type { InterviewFact } from "@grasp-os/shared/interview-links";
import { Button } from "@grasp-os/ui/components/button";
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@grasp-os/ui/components/sheet";
import { Text } from "@grasp-os/ui/components/text";
import { EyeOffIcon, Icon, UsersIcon } from "@grasp-os/ui/lib/icons";
import { colors, font, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import {
  approveWhenKept,
  saveAgainNow,
  update,
  useHeld,
  useKind,
  useSaveState,
  useUnapproved,
} from "./kept.ts";
import type { SaveState } from "./kept.ts";
import { withShares } from "./progress.ts";

// Where each line of an interview goes (GRA-1987), the person's to choose:
// shared in their company as how their team works (every member reads a
// team's claims and drawings), or only counted anonymously.
// Under each line of the read-back, and once they agreed, in "Where your
// lines go". Approving binds where a line goes, so a line moved after
// they agreed counts again only once it is approved where it goes now.

const styles = stylex.create({
  // The agreed lines, one under another with a hairline between them.
  lines: { margin: 0, padding: 0, listStyle: "none", textAlign: "start" },
  line: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["1"],
    paddingBlock: space["2"],
    borderBlockStartWidth: size.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  // What became of the change, at the foot's start.
  note: {
    flexGrow: 1,
    margin: 0,
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    textWrap: "balance",
  },
  trouble: { color: colors.warning },
  wide: { display: "grid", width: "100%", maxWidth: "24rem" },
});

/** The other place a line can go. */
const moved = (share: InterviewFact["share"]): InterviewFact["share"] =>
  share === "team" ? undefined : "team";

/**
 * Where one line goes, under it: a press moves it. A line only used to
 * know whom to ask (`onlyForAsking`: who does the work, and in their own
 * interview the work someone says they do instead) has no choice, and
 * says so. `of` is the id of the line's words, which describe the button.
 */
export const Destination = ({
  tag,
  share,
  of,
  onMove,
  disabled = false,
}: Pick<InterviewFact, "tag" | "share"> & {
  /** The id of the line's words, shown now; none while they aren't. */
  of: string | undefined;
  onMove: () => void;
  disabled?: boolean;
}) => {
  const { t } = useLingui();
  const kind = useKind();
  if (onlyForAsking(tag, kind)) {
    return (
      <Text color="muted" size="xs">
        {t`Only used to know whom to ask`}
      </Text>
    );
  }
  const team = share === "team";
  return (
    <Button
      aria-describedby={of}
      disabled={disabled}
      onClick={onMove}
      size="xs"
      variant="ghost"
    >
      <Icon icon={team ? UsersIcon : EyeOffIcon} />
      {team ? t`Shared as how your team works` : t`Only counted anonymously`}
    </Button>
  );
};

/** One agreed line in "Where your lines go", with where it goes as chosen here. */
const PlacedLine = ({
  fact,
  share,
  onMove,
  disabled,
}: {
  fact: InterviewFact;
  share: InterviewFact["share"];
  onMove: () => void;
  disabled: boolean;
}) => {
  const words = useId();
  return (
    <li {...stylex.props(styles.line)}>
      <span id={words}>{fact.text}</span>
      <Destination
        disabled={disabled}
        of={words}
        onMove={onMove}
        share={share}
        tag={fact.tag}
      />
    </li>
  );
};

/**
 * Where a change of where lines go stands: being chosen, on its way, not
 * kept yet (tried again), refused, or kept as chosen.
 */
type SendState = "choosing" | "saving" | "not_kept" | "refused" | "kept";

/** What a change sent is, from whether core holds all of it yet and how saving stands. */
const sendingOf = (
  sent: boolean,
  held: boolean,
  save: SaveState["state"]
): SendState => {
  if (!sent) {
    return "choosing";
  }
  if (held) {
    return "kept";
  }
  if (save === "retrying") {
    return "not_kept";
  }
  return save === "refused" ? "refused" : "saving";
};

/** The sheet's foot: what became of the change, and what can be done now. */
const SendFoot = ({
  sending,
  refusal,
  canSave,
  onSave,
}: {
  sending: SendState;
  /** Why core refused it, in core's words. */
  refusal: string | null;
  canSave: boolean;
  onSave: () => void;
}) => {
  const { t } = useLingui();
  const unapproved = useUnapproved();
  const trouble = sending === "not_kept" || sending === "refused";
  let note: string | null = null;
  if (trouble && unapproved) {
    // Kept, but not approved: core took the lines back from where they
    // went, and counts them where they go only once approved there.
    note = t`Not saved yet. Until it is, the lines you moved count nowhere.`;
  } else if (sending === "refused") {
    note = refusal;
  } else if (sending === "not_kept") {
    note = t`Not saved yet. Until it is, your lines still go where they went before.`;
  } else if (sending === "kept") {
    note = t`Saved`;
  }
  const saving = sending === "saving";
  return (
    <SheetFooter>
      {note === null ? null : (
        <p
          aria-live="polite"
          role={trouble ? "alert" : undefined}
          {...stylex.props(styles.note, trouble && styles.trouble)}
        >
          {note}
        </p>
      )}
      <SheetClose>{sending === "choosing" ? t`Cancel` : t`Close`}</SheetClose>
      {sending === "not_kept" ? (
        <Button onClick={saveAgainNow}>{t`Try again`}</Button>
      ) : (
        <Button
          disabled={!canSave}
          loadingText={t`Saving…`}
          onClick={onSave}
          status={saving ? "loading" : "idle"}
        >
          {t`Save where they go`}
        </Button>
      )}
    </SheetFooter>
  );
};

/**
 * Every line they agreed to, with where it goes as core holds it
 * (`useHeld`), to move after the fact. Saving keeps and approves the lines
 * as they go now; a line moved to only counted anonymously is taken out of
 * what rested on it before core keeps that. Until core confirms both, the
 * change is shown as on its way, never as done: a save not kept yet, or
 * refused (as while the Brain can't take out what rested on a line), says
 * so here, with a way to try again.
 */
export const WhereLinesGo = () => {
  const { t } = useLingui();
  const held = useHeld();
  const save = useSaveState();
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState(
    new Map<string, InterviewFact["share"]>()
  );
  const [sent, setSent] = useState(false);
  const lines = held.facts.filter(
    ({ out, agreed }) => out !== true && agreed === true
  );
  const shareOf = (fact: InterviewFact): InterviewFact["share"] =>
    shares.has(fact.id) ? shares.get(fact.id) : fact.share;
  const changed = lines.filter((fact) => shareOf(fact) !== fact.share);
  const sending = sendingOf(sent, changed.length === 0, save.state);
  if (lines.length === 0) {
    return null;
  }
  return (
    <Sheet
      onOpenChange={(opening) => {
        setOpen(opening);
        setShares(new Map());
        setSent(false);
      }}
      open={open}
    >
      <div {...stylex.props(styles.wide)}>
        <SheetTrigger asChild>
          <Button variant="outline">{t`Where your lines go`}</Button>
        </SheetTrigger>
      </div>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t`Where your lines go`}</SheetTitle>
          <SheetDescription>{t`Choose where each line goes. A line you move counts again once you save.`}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <ol {...stylex.props(styles.lines)}>
            {lines.map((fact) => (
              <PlacedLine
                disabled={sending === "saving" || sending === "not_kept"}
                fact={fact}
                key={fact.id}
                onMove={() => {
                  setShares(new Map(shares).set(fact.id, moved(shareOf(fact))));
                  setSent(false);
                }}
                // Once sent, where core holds it: never shown moved before it is.
                share={sending === "choosing" ? shareOf(fact) : fact.share}
              />
            ))}
          </ol>
        </SheetBody>
        <SendFoot
          canSave={changed.length > 0}
          onSave={() => {
            const chosen = new Map(
              changed.map((fact) => [fact.id, shareOf(fact)] as const)
            );
            update((now) => withShares(now, chosen));
            // Approves the lines it shows, as they go now: nothing else.
            approveWhenKept(lines.map(({ id }) => id));
            setSent(true);
          }}
          refusal={save.state === "refused" ? save.message : null}
          sending={sending}
        />
      </SheetContent>
    </Sheet>
  );
};

/** Moves line `id` of the read-back to where it doesn't go now. */
export const moveLine = (id: string, share: InterviewFact["share"]): void => {
  update((now) => withShares(now, new Map([[id, moved(share)]])));
};
