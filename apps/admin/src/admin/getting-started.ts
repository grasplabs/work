// What it takes before a company's admins get in and its people get
// their interview links, in the order it is done: who has to do each,
// and how it stands. Pure: the page that shows it is getting-started.tsx.

/** One thing that has to be in place. */
export type StartItemId =
  | "window"
  | "closed"
  | "admin"
  | "roster"
  | "plan"
  | "agreements"
  | "links";

/** One thing that has to be in place, and how it stands. */
export interface StartItem {
  id: StartItemId;
  /**
   * `done` once it is in place; `todo` while it is Grasp's to do, here;
   * `waits` while it is the company's, or follows from the others.
   */
  state: "done" | "todo" | "waits";
  /** What it is, as a row's label. */
  title: string;
  /** How it stands, and what it holds up, in a line. */
  detail: string;
}

/** What the items are read from: the admin's own record, and the company's Grasp. */
export interface StartFacts {
  /** Grasp's staff window: open now, and whether the company's Grasp has it. Null when it couldn't be read. */
  window: { open: boolean; live: boolean } | null;
  /** The gate: open to the company's people now, and when Grasp gave its go. */
  gate: { open: boolean; openedAt: string | null };
  /** Who the deployment makes its admins when they first sign in. */
  admins: readonly string[];
  /** Whether the company's flow interviews its people. */
  interviews: boolean;
  roster: boolean;
  plan: boolean;
  agreed: boolean;
  told: boolean;
  /** The interviews are paused: no link goes out until they run again. */
  paused: boolean;
}

const windowItem = (window: StartFacts["window"]): StartItem => {
  const title = "Grasp’s staff window is open";
  if (window === null) {
    return {
      id: "window",
      state: "todo",
      title,
      detail: "Not read just now. See it under Setup.",
    };
  }
  if (window.live) {
    return {
      id: "window",
      state: "done",
      title,
      detail: "Staff can steer the onboarding from here.",
    };
  }
  return {
    id: "window",
    state: "todo",
    title,
    detail: window.open
      ? "Opened here, but not live yet: apply its settings, or nothing below can be changed."
      : "Without it nothing below can be changed from here. It lasts up to 7 days, and is live once its settings are applied.",
  };
};

const closedItem = ({ open, openedAt }: StartFacts["gate"]): StartItem => {
  const title = "Closed for the onboarding";
  if (!open) {
    return {
      id: "closed",
      state: "done",
      title,
      detail: "Only its admins and Grasp’s staff come in until it opens.",
    };
  }
  // Opened since, on Grasp's go or as its flow says: nothing left to close.
  if (openedAt !== null) {
    return {
      id: "closed",
      state: "done",
      title,
      detail: "It was, and has opened since: everyone at the company is in.",
    };
  }
  return {
    id: "closed",
    state: "todo",
    title,
    detail:
      "It is open to everyone at the company. Close it, so only its admins come in while it onboards.",
  };
};

const companyItem = (
  id: "roster" | "plan",
  done: boolean,
  title: string,
  waiting: string
): StartItem => ({
  id,
  state: done ? "done" : "waits",
  title,
  detail: done ? "Done by the company’s admin." : waiting,
});

/** What holds the links, of what comes before them: the first of them, in words. */
const linksDetail = ({
  roster,
  plan,
  agreed,
  paused,
}: Pick<StartFacts, "roster" | "plan" | "agreed" | "paused">): string => {
  if (paused) {
    return "The interviews are paused: no link goes out until they run again.";
  }
  if (!roster) {
    return "Wait for the staff list.";
  }
  if (!plan) {
    return "Wait for the plan.";
  }
  return agreed
    ? "Each goes out by email on its day."
    : "Wait for the agreements: they go out the moment those are in.";
};

/**
 * What has to be in place, in order: for every company the staff window,
 * the closed gate and an admin who can sign in; where its people are
 * interviewed, the staff list and the plan from its admin, the
 * agreements from Grasp, and then the links, which go out by themselves.
 */
export const startItems = (facts: StartFacts): StartItem[] => {
  const { admins } = facts;
  const always: StartItem[] = [
    windowItem(facts.window),
    closedItem(facts.gate),
    {
      id: "admin",
      state: admins.length > 0 ? "done" : "todo",
      title: "Its admin can sign in",
      detail:
        admins.length > 0
          ? `${admins.join(", ")}: an admin from their first sign-in, and they can invite more.`
          : "Nobody is named as its admin: nobody can start its onboarding.",
    },
  ];
  if (!facts.interviews) {
    return always;
  }
  return [
    ...always,
    companyItem(
      "roster",
      facts.roster,
      "The staff list is confirmed",
      "Its admin gives who works where, in their onboarding."
    ),
    companyItem(
      "plan",
      facts.plan,
      "The plan is set",
      "Its admin picks when the interviews start, in their onboarding."
    ),
    {
      id: "agreements",
      state: facts.agreed ? "done" : "todo",
      title: "The agreements are in",
      detail: facts.agreed
        ? "What was agreed is on record."
        : "No link goes out until they are. Say where they stand.",
    },
    {
      id: "links",
      state: facts.told ? "done" : "waits",
      title: "The interview links go out",
      detail: facts.told ? "The team is told." : linksDetail(facts),
    },
  ];
};

/**
 * Whether the company is past its start, so the list has nothing left to
 * say: its team is told, where its people are interviewed; elsewhere,
 * once every item is in place.
 */
export const started = (facts: StartFacts): boolean =>
  facts.interviews
    ? facts.told
    : startItems(facts).every(({ state }) => state === "done");
