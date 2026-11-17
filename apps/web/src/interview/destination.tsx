import { onlyForAsking } from "@grasp-os/shared/interview-links";
import type { InterviewFact } from "@grasp-os/shared/interview-links";
import { Button } from "@grasp-os/ui/components/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@grasp-os/ui/components/sheet";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { useLingui } from "@lingui/react/macro";
import { EyeOffIcon, UsersIcon } from "lucide-react";
import { useId, useState } from "react";

import {
  approveWhenKept,
  saveAgainNow,
  update,
  useHeld,
  useKind,
  useSaveState,
} from "./kept.ts";
import type { SaveState } from "./kept.ts";
import { withShares } from "./progress.ts";

// Where each line of an interview goes (GRA-1987), the person's to choose:
// shared in their company as how their team works (every member reads a
// team's claims and drawings), or only counted anonymously.
// Under each line of the read-back, and once they agreed, in "Where your
// lines go". Approving binds where a line goes, so a line moved after
// they agreed counts again only once it is approved where it goes now.

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
  of: string;
  onMove: () => void;
  disabled?: boolean;
}) => {
  const { t } = useLingui();
  const kind = useKind();
  if (onlyForAsking(tag, kind)) {
    return (
      <p className="text-muted-foreground text-xs">{t`Only used to know whom to ask`}</p>
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
      {team ? (
        <UsersIcon data-icon="inline-start" />
      ) : (
        <EyeOffIcon data-icon="inline-start" />
      )}
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
    <li className="flex flex-col items-start gap-1 border-t py-2">
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
  const trouble = sending === "not_kept" || sending === "refused";
  let note: string | null = null;
  if (sending === "refused") {
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
          className={
            trouble
              ? "text-status-attention text-xs text-balance"
              : "text-muted-foreground text-xs"
          }
          role={trouble ? "alert" : undefined}
        >
          {note}
        </p>
      )}
      {sending === "not_kept" ? (
        <Button onClick={saveAgainNow} variant="highlight">
          {t`Try again`}
        </Button>
      ) : (
        <Button
          disabled={!canSave || saving}
          onClick={onSave}
          variant="highlight"
        >
          {saving ? <Spinner data-icon="inline-start" /> : null}
          {saving ? t`Saving…` : t`Save where they go`}
        </Button>
      )}
      <SheetClose render={<Button variant="outline" />}>
        {sending === "choosing" ? t`Cancel` : t`Close`}
      </SheetClose>
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
      <SheetTrigger
        render={<Button className="w-full max-w-sm" variant="outline" />}
      >
        {t`Where your lines go`}
      </SheetTrigger>
      <SheetContent closeLabel={t`Close`} side="right">
        <SheetHeader>
          <SheetTitle>{t`Where your lines go`}</SheetTitle>
          <SheetDescription>{t`Choose where each line goes. A line you move counts again once you save.`}</SheetDescription>
        </SheetHeader>
        <ol className="flex min-h-0 flex-1 flex-col overflow-y-auto border-b px-4 text-left">
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
