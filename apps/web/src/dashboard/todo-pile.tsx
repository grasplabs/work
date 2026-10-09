import type { PendingAction } from "@grasp-os/shared/connect";
import type { DependencyRequest } from "@grasp-os/shared/dependencies";
import type { Permission } from "@grasp-os/shared/permissions";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";

import type { PendingRequests } from "../activity/pending.tsx";
import { PackagesCard } from "./dependency-requests.tsx";
import type { Pile } from "./pile-card.tsx";
import { HeldCard, RequestCard } from "./pile-cards.tsx";
import type { Printed } from "./pile-dots.ts";
import { PileFarewell } from "./pile-farewell.tsx";
import { orderOf, placeIn, skip, turn, untouched } from "./pile.ts";
import type { Turned } from "./pile.ts";

// What waits on the person, as the prototype's pile of cards on top of the
// dashboard (`components/dashboard/todo-stack.tsx`), made to be gone
// through fast: one card on top, with its yes and its no; where in the
// pile it is ("3 of 18") between the arrows to the card before and after;
// Skip, which puts it at the back. A card dealt with leaves, the next
// comes up and the keys go on with it: Enter after Enter, the arrow keys
// to go on or back. Only what can be settled on its card is on the pile.
// When the last card is dealt with it goes as dots, and the pile is gone;
// a pile nothing is on isn't shown at all. Nothing moves for whoever asks
// for less motion: the next card is simply there, and the pile simply goes.

/** A card of the pile: what it settles. Its id is the same from one read to the next. */
export type PileItem =
  | { kind: "held"; id: string; action: PendingAction }
  | {
      kind: "request";
      id: string;
      request: Permission;
      pending: PendingRequests;
    }
  | {
      kind: "packages";
      id: string;
      request: DependencyRequest;
      policyGeneration: number;
    };

// Which card is on top, and what was skipped: kept while the app is open,
// so the pile stands the same after a look at another page, and no longer.
// Core never hears of it.
let turned: Turned = untouched;
const listeners = new Set<() => void>();

const setTurned = (next: Turned): void => {
  turned = next;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const readTurned = (): Turned => turned;

/** Where this browser tab keeps that the pile was pointed out: once a session, not on every visit. */
const pointedOutKey = "grasp.todo.pointed-out";

/** Whether the pile was pointed out before in this session; a browser that keeps nothing counts as not yet. */
const pointedOut = (): boolean => {
  try {
    return sessionStorage.getItem(pointedOutKey) !== null;
  } catch {
    return false;
  }
};

const notePointedOut = (): void => {
  try {
    sessionStorage.setItem(pointedOutKey, "yes");
  } catch {
    // Nothing is kept: it is pointed out again next time.
  }
};

const lessMotion = (): boolean =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A press this soon after a card came up is the second of a double press,
 * meant for the card that left: it does nothing to the next one. In
 * milliseconds.
 */
const guardMs = 400;

/** Where the card's name and its buttons are printed on it, for the dots it goes as. */
const printOf = (frame: HTMLElement | null): Printed[] => {
  const card = frame?.querySelector("article");
  if (card === null || card === undefined) {
    return [];
  }
  const origin = card.getBoundingClientRect();
  const on = (rect: DOMRect): Printed => ({
    x: rect.left - origin.left,
    y: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
  });
  const printed: Printed[] = [];
  const name = card.querySelector("h2");
  if (name !== null) {
    // Every line of the name, as wide as its words.
    const range = document.createRange();
    range.selectNodeContents(name);
    printed.push(...[...range.getClientRects()].map(on));
  }
  for (const button of card.querySelectorAll("button")) {
    printed.push(on(button.getBoundingClientRect()));
  }
  return printed;
};

/** The first button of the card on top that can be pressed: its yes, unless that waits. */
const firstOf = (frame: HTMLElement | null): HTMLElement | null => {
  const card = frame?.querySelector("article");
  return (
    card?.querySelector<HTMLElement>("[data-first]:not(:disabled)") ??
    card?.querySelector<HTMLElement>("button:not(:disabled)") ??
    null
  );
};

/** Whether the keys are on the card on top, rather than the pile's own arrows. */
const onCard = (frame: HTMLElement | null): boolean =>
  frame?.querySelector("article")?.contains(document.activeElement) ?? false;

const TopCard = ({ item, pile }: { item: PileItem; pile: Pile }) => {
  if (item.kind === "held") {
    return <HeldCard action={item.action} pile={pile} />;
  }
  if (item.kind === "request") {
    return (
      <RequestCard pending={item.pending} pile={pile} request={item.request} />
    );
  }
  return (
    <PackagesCard
      pile={pile}
      policyGeneration={item.policyGeneration}
      request={item.request}
    />
  );
};

/** The pile's corners: where in it the card on top is, between the arrows, and Skip. */
const PileCorner = ({
  place,
  count,
  onBack,
  onward,
  onSkip,
}: {
  place: number;
  count: number;
  onBack: () => void;
  onward: () => void;
  onSkip: () => void;
}) => {
  const { t } = useLingui();
  return (
    <>
      <div className="absolute top-3 left-3 z-10 flex items-center gap-0.5">
        <Button
          aria-label={t`The one before`}
          onClick={onBack}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronLeftIcon />
        </Button>
        <span className="text-muted-foreground min-w-14 text-center text-sm tabular-nums">
          <Trans>
            {place} of {count}
          </Trans>
        </span>
        <Button
          aria-label={t`The next one`}
          onClick={onward}
          size="icon-sm"
          variant="ghost"
        >
          <ChevronRightIcon />
        </Button>
      </div>
      {/* Skipping is no answer: it stands apart from the yes and the no, in the other corner. */}
      <Button
        className="absolute top-3 right-3 z-10"
        onClick={onSkip}
        size="sm"
        variant="ghost"
      >
        <Trans context="put a to-do card at the back of the pile">Skip</Trans>
      </Button>
    </>
  );
};

/** A card that stands in for the last one while it goes: there to be seen, not to be pressed or read. */
const still: Pile = {
  answering: () => false,
  answered: () => {
    // Nothing is pressed on it.
  },
};

/** How the pile ends once nothing on it waits: its last card goes as dots, its room closes, and it is gone. */
type Ending = "dots" | "closing" | "gone";

/**
 * The pile, named "To do". `onSaid` says what was done with a card, for a
 * screen reader: the pile itself only shows the next one.
 */
export const TodoPile = ({
  items,
  onSaid,
}: {
  items: PileItem[];
  onSaid: (said: string) => void;
}) => {
  const { t } = useLingui();
  const now = useSyncExternalStore(subscribe, readTurned);
  const ids = items.map(({ id }) => id);
  const order = orderOf(ids, now.skipped);
  const place = placeIn(order, now.at);
  const topId = order[place];
  const top = items.find(({ id }) => id === topId);
  const count = order.length;
  const more = count > 1;
  // The pile ends only where there was one, on this visit.
  const [had, setHad] = useState(items.length > 0);
  if (items.length > 0 && !had) {
    setHad(true);
  }
  const [ending, setEnding] = useState<Ending>("dots");
  // Something waits again: the pile is back, and ends anew when it is done.
  if (top !== undefined && ending !== "dots") {
    setEnding("dots");
  }
  /** The card last on top, which stands in while the last one goes. */
  const [last, setLast] = useState(top);
  if (top !== undefined && top.id !== last?.id) {
    setLast(top);
  }
  /** Where the last card's name and buttons stood, for its dots. */
  const [printed, setPrinted] = useState<Printed[]>([]);
  /** Whether a card left the top yet: the first one is simply there. */
  const [moved, setMoved] = useState(false);
  // The first time the dashboard shows in a session, the pile is pointed
  // out, briefly: this is to be done.
  const [pointing, setPointing] = useState(
    () => items.length > 0 && !pointedOut()
  );
  useEffect(() => {
    if (pointing) {
      notePointedOut();
    }
  }, [pointing]);
  const frame = useRef<HTMLElement>(null);
  /** When the card on top came up, for the guard. */
  const cameUp = useRef(0);
  /** The keys were on the card when it left: they go on with the next one. */
  const follow = useRef(false);

  useEffect(() => {
    // The card on top is noted with its place, so that when it is dealt
    // with the one after it comes up.
    if (
      topId !== undefined &&
      (turned.at?.id !== topId || turned.at.index !== place)
    ) {
      setTurned({ ...turned, at: { id: topId, index: place } });
    }
  }, [topId, place]);
  useEffect(() => {
    cameUp.current = performance.now();
    if (follow.current && topId !== undefined) {
      follow.current = false;
      firstOf(frame.current)?.focus({ preventScroll: true });
    }
  }, [topId]);

  if (top === undefined) {
    // With less motion there are no dots: the pile is simply gone.
    if (!had || ending === "gone" || last === undefined || lessMotion()) {
      return null;
    }
    return (
      <div
        aria-hidden="true"
        className={
          ending === "closing" ? "pile-room pile-room-closed" : "pile-room"
        }
        onTransitionEnd={() => {
          setEnding("gone");
        }}
      >
        <div className="min-h-0">
          <div className="relative pb-4">
            {/* As high as the last card stood, so nothing under the pile moves until its dots are gone. */}
            <div className="invisible" inert>
              <TopCard item={last} pile={still} />
            </div>
            {ending === "dots" ? (
              <PileFarewell
                onGone={() => {
                  setEnding("closing");
                }}
                printed={printed}
              />
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const go = (by: 1 | -1 | "skip") => {
    if (!more) {
      return;
    }
    follow.current = onCard(frame.current);
    setMoved(true);
    setTurned(by === "skip" ? skip(ids, turned) : turn(ids, turned, by));
  };
  const pile: Pile = {
    answering: () => {
      if (performance.now() - cameUp.current < guardMs) {
        return false;
      }
      follow.current = onCard(frame.current);
      setMoved(true);
      if (count === 1) {
        setPrinted(printOf(frame.current));
      }
      return true;
    },
    answered: onSaid,
  };
  /** The pile's keys: the arrow right goes on to the next card, the arrow left back to the one before. */
  const onKeys = (event: KeyboardEvent<HTMLElement>) => {
    // Not from a dialog the card opened: it only sits in the pile in React.
    if (
      !(event.target instanceof Node) ||
      !event.currentTarget.contains(event.target)
    ) {
      return;
    }
    // A key held down presses once: the pile is not gone through by leaning on Enter.
    if (event.repeat && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    }
  };
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the keys are on the buttons in it: the pile only hears the arrows as they bubble up
    <section
      aria-label={t({
        message: "To do",
        context: "dashboard: what waits on you",
      })}
      className="min-w-0"
      onKeyDown={onKeys}
      ref={frame}
    >
      <div className="relative pb-4">
        {/* The cards under it: an edge of each of the next two, as far as there are. */}
        {count > 2 ? (
          <span
            aria-hidden="true"
            className="bg-card absolute inset-x-8 bottom-0 h-10 rounded-xl border"
          />
        ) : null}
        {more ? (
          <span
            aria-hidden="true"
            className="bg-card absolute inset-x-4 bottom-2 h-10 rounded-xl border"
          />
        ) : null}
        <div
          className={
            moved ? "motion-safe:animate-pile-up relative" : "relative"
          }
          key={top.id}
        >
          <TopCard item={top} pile={pile} />
        </div>
        {/* A ring in the colour of what needs someone, twice around the card and gone: seen once, in the way of nothing. */}
        {pointing ? (
          <span
            aria-hidden="true"
            className="ring-status-attention motion-safe:animate-pile-point pointer-events-none absolute inset-x-0 top-0 bottom-4 z-10 hidden rounded-xl ring-2 motion-safe:block"
            onAnimationEnd={() => {
              setPointing(false);
            }}
          />
        ) : null}
        {more ? (
          <PileCorner
            count={count}
            onBack={() => {
              go(-1);
            }}
            onSkip={() => {
              go("skip");
            }}
            onward={() => {
              go(1);
            }}
            place={place + 1}
          />
        ) : null}
      </div>
    </section>
  );
};
