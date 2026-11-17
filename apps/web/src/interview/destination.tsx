import { neverShared } from "@grasp-os/shared/interview-links";
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
import { useLingui } from "@lingui/react/macro";
import { EyeOffIcon, UsersIcon } from "lucide-react";
import { useId, useState } from "react";

import { approveWhenKept, update, useProgress } from "./kept.ts";
import { withShares } from "./progress.ts";

// Where each line of an interview goes (GRA-1987), the person's to choose:
// shared with their team as how they work, or only counted anonymously.
// Under each line of the read-back, and once they agreed, in "Where your
// lines go". Approving binds where a line goes, so a line moved after
// they agreed counts again only once it is approved where it goes now.

/** The other place a line can go. */
const moved = (share: InterviewFact["share"]): InterviewFact["share"] =>
  share === "team" ? undefined : "team";

/**
 * Where one line goes, under it: a press moves it. Who does the work is
 * only used to know whom to ask, and has no choice. `of` is the id of the
 * line's words, which describe the button.
 */
export const Destination = ({
  tag,
  share,
  of,
  onMove,
}: Pick<InterviewFact, "tag" | "share"> & {
  of: string;
  onMove: () => void;
}) => {
  const { t } = useLingui();
  if (tag === neverShared) {
    return (
      <p className="text-muted-foreground text-xs">{t`Only used to know whom to ask`}</p>
    );
  }
  const team = share === "team";
  return (
    <Button aria-describedby={of} onClick={onMove} size="xs" variant="ghost">
      {team ? (
        <UsersIcon data-icon="inline-start" />
      ) : (
        <EyeOffIcon data-icon="inline-start" />
      )}
      {team
        ? t`Shared with your team as how you work`
        : t`Only counted anonymously`}
    </Button>
  );
};

/** One agreed line in "Where your lines go", with where it goes as chosen here. */
const PlacedLine = ({
  fact,
  share,
  onMove,
}: {
  fact: InterviewFact;
  share: InterviewFact["share"];
  onMove: () => void;
}) => {
  const words = useId();
  return (
    <li className="flex flex-col items-start gap-1 border-t py-2">
      <span id={words}>{fact.text}</span>
      <Destination of={words} onMove={onMove} share={share} tag={fact.tag} />
    </li>
  );
};

/**
 * Every line they agreed to, with where it goes, to move after the fact.
 * Saving approves the lines as they go now: a line moved to only counted
 * anonymously is taken out of what rested on it before the save is kept.
 */
export const WhereLinesGo = () => {
  const { t } = useLingui();
  const progress = useProgress();
  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState(
    new Map<string, InterviewFact["share"]>()
  );
  const lines = progress.facts.filter(
    ({ out, agreed }) => out !== true && agreed === true
  );
  const shareOf = (fact: InterviewFact): InterviewFact["share"] =>
    shares.has(fact.id) ? shares.get(fact.id) : fact.share;
  const changed = lines.filter((fact) => shareOf(fact) !== fact.share);
  if (lines.length === 0) {
    return null;
  }
  return (
    <Sheet
      onOpenChange={(opening) => {
        setOpen(opening);
        setShares(new Map());
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
              fact={fact}
              key={fact.id}
              onMove={() => {
                setShares(new Map(shares).set(fact.id, moved(shareOf(fact))));
              }}
              share={shareOf(fact)}
            />
          ))}
        </ol>
        <SheetFooter>
          <Button
            disabled={changed.length === 0}
            onClick={() => {
              const chosen = new Map(
                changed.map((fact) => [fact.id, shareOf(fact)] as const)
              );
              update((now) => withShares(now, chosen));
              approveWhenKept();
              setOpen(false);
            }}
            variant="highlight"
          >
            {t`Save where they go`}
          </Button>
          <SheetClose render={<Button variant="outline" />}>
            {t`Cancel`}
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

/** Moves line `id` of the read-back to where it doesn't go now. */
export const moveLine = (id: string, share: InterviewFact["share"]): void => {
  update((now) => withShares(now, new Map([[id, moved(share)]])));
};
