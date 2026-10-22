import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import { useLingui } from "@lingui/react/macro";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useEffect } from "react";
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
// first offers it. A page he didn't go to, Escape or the cross ends it.

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

/** His card: who speaks, his line, and what the person can do. */
const TourCard = ({
  line,
  children,
  progress,
  closable = true,
}: {
  line: string;
  children: ReactNode;
  progress?: string;
  /** Whether it has a cross to end the tour; the offer has its own answers. */
  closable?: boolean;
}) => {
  const { t } = useLingui();
  return (
    <section
      aria-label={t`Tour of Grasp`}
      className="bg-popover text-popover-foreground ring-foreground/10 fixed right-4 bottom-4 left-4 z-50 flex flex-col gap-3 rounded-xl p-4 text-sm shadow-md ring-1 sm:left-auto sm:w-96"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 font-medium">Stephen</span>
        {progress === undefined ? null : (
          <span className="text-muted-foreground text-xs">{progress}</span>
        )}
        {closable ? (
          <Button
            aria-label={t`End the tour`}
            onClick={endTour}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      <p aria-live="polite">{line}</p>
      <div className="flex justify-end gap-2">{children}</div>
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

  // Escape ends the tour, wherever the focus is.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const { phase } = tourState();
      if (
        event.key === "Escape" &&
        (phase === "opening" || phase === "running")
      ) {
        endTour();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);

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

  if (tour.phase === "invited") {
    return (
      <TourCard closable={false} line={i18n._(tourOffer.say)}>
        <Button
          onClick={() => {
            tourOffered(userId);
            endTour();
          }}
          variant="ghost"
        >
          {i18n._(tourOffer.later)}
        </Button>
        <Button
          onClick={() => {
            startTour(userId, pathname);
          }}
        >
          {i18n._(tourOffer.start)}
        </Button>
      </TourCard>
    );
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
