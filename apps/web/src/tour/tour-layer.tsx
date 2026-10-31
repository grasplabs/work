import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import { useLingui } from "@lingui/react/macro";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { useActiveChat } from "../chat/active-chat.ts";
import {
  lineOf,
  pageOf,
  pointsAt,
  stopBeside,
  tourDue,
  tourOffer,
  tourOpening,
  tourPages,
  tourStops,
} from "./tour-script.ts";
import type { TourStop } from "./tour-script.ts";
import {
  endTour,
  setTour,
  startTour,
  tourAsked,
  tourBegun,
  tourOffered,
  tourSeen,
  tourState,
  useTour,
} from "./tour-state.ts";

// Stephen's tour, in text, over the shell's pages, as the prototype tells
// it (grasplabs/prototype `components/tour/tour-layer.tsx`) less his voice
// and his flying dots. He is where the chat box is, bottom right, in its
// place: his words and what the person can do, a stop back or on, and end.
// At each stop the page is open behind him and the sidebar's way to it is
// marked (`data-tour-target`, styles.css), so the person sees where to
// find it again; at the last, where he can be asked, it is himself. On Chat, for someone who wasn't offered it before, he
// first offers it, on the new chat in the greeting's place (`TourOffer`).
// A page he didn't go to, Escape or the cross ends it.

/** The sidebar's link to `address`, where the sidebar is on the page; on a phone it is a sheet that comes and goes, not that one. */
const sidebarLink = (address: string | null): HTMLElement | null =>
  address === null
    ? null
    : document.querySelector<HTMLElement>(
        `[data-slot="sidebar"]:not([data-mobile]) nav a[href="${address}"]`
      );

/** Marks what he points at while he is at a stop. */
const usePointing = (stop: TourStop | undefined): void => {
  useEffect(() => {
    const link = stop === undefined ? null : sidebarLink(pointsAt(stop));
    if (link !== null) {
      link.dataset.tourTarget = "";
    }
    return () => {
      if (link !== null) {
        delete link.dataset.tourTarget;
      }
    };
  }, [stop]);
};

/** His card, as the page's hold finds it (its `data-tour-card`). */
const cardSelector = "[data-tour-card]";

/**
 * While he tells the tour, the page under him is held: the frame is inert
 * (frame/app-frame.tsx), but that stops neither a shortcut the page listens
 * for on the window (the sidebar's Cmd/Ctrl+B, the Brain's arrow keys) nor
 * one pressed in his card, which bubbles up to it. So every key stops here
 * before it reaches the page: one pressed elsewhere as the window first
 * gets it, one pressed in his card as it leaves the card, after his buttons
 * had it. Escape ends the tour, wherever the focus is.
 */
/** Nothing held, so nothing to let go of. */
const letGo = (): void => {
  // The page wasn't held.
};

const useHeldPage = (holding: boolean): void => {
  useEffect(() => {
    if (!holding) {
      return letGo;
    }
    const onWindow = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        endTour();
        return;
      }
      const { target } = event;
      const inCard =
        target instanceof Element && target.closest(cardSelector) !== null;
      if (!inCard) {
        event.stopImmediatePropagation();
      }
    };
    const onCard = (event: KeyboardEvent): void => {
      event.stopPropagation();
    };
    const card = document.querySelector<HTMLElement>(cardSelector);
    window.addEventListener("keydown", onWindow, { capture: true });
    card?.addEventListener("keydown", onCard);
    return () => {
      window.removeEventListener("keydown", onWindow, { capture: true });
      card?.removeEventListener("keydown", onCard);
    };
  }, [holding]);
};

/** His card: who speaks, his line, and what the person can do. */
const TourCard = ({
  line,
  children,
  progress,
}: {
  line: string;
  children: ReactNode;
  progress?: string;
}) => {
  const { t } = useLingui();
  // Focus comes to the card as it appears: from "Start the tour", whose
  // button leaves the page, or from the person menu, which closes.
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    card.current?.focus();
  }, []);
  return (
    <section
      aria-label={t`Tour of Grasp`}
      data-tour-card=""
      ref={card}
      tabIndex={-1}
      className="bg-popover text-popover-foreground ring-foreground/10 fixed right-4 bottom-4 left-4 z-50 flex flex-col gap-3 rounded-xl p-4 text-sm shadow-md ring-1 outline-none sm:left-auto sm:w-96"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 font-medium">Stephen</span>
        {progress === undefined ? null : (
          <span className="text-muted-foreground text-xs">{progress}</span>
        )}
        <Button
          aria-label={t`End the tour`}
          onClick={endTour}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      <p aria-live="polite">{line}</p>
      <div className="flex justify-end gap-2">{children}</div>
    </section>
  );
};

/**
 * His offer, on the new chat, as the prototype makes it (grasplabs/
 * prototype `routes/index.tsx`): his question in the greeting's place,
 * in the greeting's serif, and its two answers under it, taking the tour
 * the page's one highlight. The page shows it while the tour is
 * `invited`, which the layer decides.
 */
export const TourOffer = ({
  userId,
  headingId,
  onDeclined,
}: {
  userId: string;
  /** The new chat's heading's ID, which labels it: his question is it while he asks. */
  headingId: string;
  /** "Not now" was pressed: its button is gone, so the page moves focus on. */
  onDeclined: () => void;
}) => {
  const { i18n, t } = useLingui();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <section
      aria-label={t`Tour of Grasp`}
      className="flex flex-col items-center gap-6"
    >
      <h1 className="type-display" id={headingId}>
        {i18n._(tourOffer.say)}
      </h1>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          onClick={() => {
            startTour(userId, pathname);
          }}
          variant="highlight"
        >
          {i18n._(tourOffer.start)}
        </Button>
        <Button
          onClick={() => {
            tourOffered(userId);
            endTour();
            onDeclined();
          }}
          variant="ghost"
        >
          {i18n._(tourOffer.later)}
        </Button>
      </div>
    </section>
  );
};

export const TourLayer = ({ identity }: { identity: Identity }) => {
  const { i18n, t } = useLingui();
  const tour = useTour();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const router = useRouter();
  const chat = useActiveChat();
  const { userId, role, staff, onboardingOnly } = identity;
  const stops = tourStops({ role, staff, onboardingOnly });
  const stop = tour.phase === "running" ? stops[tour.stop] : undefined;
  usePointing(stop);

  // Offered on Chat, over a new chat, once.
  useEffect(() => {
    const viewer = { role, staff, onboardingOnly };
    const due = tourDue({
      viewer,
      seen: tourSeen(userId),
      asked: tourAsked(userId),
    });
    if (
      tourState().phase === "idle" &&
      due &&
      pathname === "/" &&
      chat === undefined
    ) {
      setTour({ phase: "invited" });
    }
  }, [userId, role, staff, onboardingOnly, pathname, chat]);

  // Offered and not answered, the person went on: to another page, or with
  // a question of their own. During the tour, a page it didn't go to ends it.
  useEffect(() => {
    const { phase } = tourState();
    if (phase === "invited" && (pathname !== "/" || chat !== undefined)) {
      tourOffered(userId);
      endTour();
    }
    if (
      (phase === "opening" || phase === "running") &&
      !tourPages.includes(pathname)
    ) {
      endTour();
    }
  }, [pathname, chat, userId]);

  // Every tour begins on Chat: someone who started it from the menu
  // elsewhere is taken there.
  useEffect(() => {
    if (tour.phase === "opening" && pathname !== "/") {
      void navigate({ to: "/" });
    }
  }, [tour.phase, pathname, navigate]);

  // The page under him is held from his question on.
  useHeldPage(tour.phase === "opening" || tour.phase === "running");

  /** To the stop `at`, on its page; one entry in the history for the whole tour. */
  const goTo = (at: number): void => {
    const next = stops[at];
    if (next === undefined) {
      endTour();
      return;
    }
    setTour({ stop: at });
    const page = pageOf(next);
    if (page !== null && page !== pathname) {
      void navigate({ to: page, replace: true });
    }
  };

  const step = (by: 1 | -1): void => {
    const at = stopBeside(tour.stop, by, stops.length);
    if (at === "end") {
      endTour();
    } else {
      goTo(at);
    }
  };

  // The offer stands on the new chat itself (`TourOffer`), not in a card.
  if (tour.phase === "invited") {
    return null;
  }
  if (tour.phase === "opening") {
    return (
      <TourCard line={i18n._(tourOpening.say)}>
        <Button
          onClick={() => {
            const { from } = tour;
            endTour();
            // Taken to Chat for it, they are back on the page they were on.
            if (from !== null) {
              router.history.back();
            }
          }}
          variant="ghost"
        >
          {i18n._(tourOpening.later)}
        </Button>
        <Button
          onClick={() => {
            tourBegun(userId);
            goTo(0);
          }}
        >
          {i18n._(tourOpening.ready)}
        </Button>
      </TourCard>
    );
  }
  if (stop === undefined) {
    return null;
  }
  const position = tour.stop + 1;
  const count = stops.length;
  const last = position === count;
  return (
    <TourCard line={i18n._(lineOf(stop))} progress={t`${position} of ${count}`}>
      <Button
        disabled={tour.stop === 0}
        onClick={() => {
          step(-1);
        }}
        variant="ghost"
      >
        {t`Back`}
      </Button>
      <Button
        onClick={() => {
          step(1);
        }}
      >
        {last ? t({ message: "Done", context: "tour" }) : t`Next`}
      </Button>
    </TourCard>
  );
};
