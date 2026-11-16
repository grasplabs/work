// @vitest-environment happy-dom

import { authErrors } from "@grasp-os/shared/errors";
import {
  interviewErrors,
  interviewProgressSchema,
} from "@grasp-os/shared/interview-links";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import type { SignInOption } from "@grasp-os/shared/rpc";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { Route as interviewRoute } from "../routes/interview.tsx";
import { draftName, hearRecording } from "./api.ts";
import { releaseInterview } from "./kept.ts";
import { loopEventName } from "./loop.ts";
import { prepare, setSound } from "./speech.ts";

// The interview page when the session behind it ends mid-interview
// (GRA-1943): the company's gate opens, they signed out in another tab,
// or it expired. Against core's interview routes faked as `fetch` answers
// them, by who is signed in: the person the link belongs to, someone
// else, or nobody. From the threat model, tried here:
//
// - They are asked to sign in again, with the company's sign-in alone,
//   and told that what isn't saved yet waits in this window, or that this
//   window couldn't keep it; when they were talking, that what they said
//   as it ended is lost.
// - Nothing is sent while nobody is signed in, and what waited is sent
//   only once core opens the link for them again, and only onto the
//   version it was taken at: a new start, a delete, a withdrawal or
//   another window going on meanwhile is never undone, and the page says
//   what waited couldn't be kept.
// - Someone else signing in in that tab gets the answer of a link that
//   never was, and what waited is gone from the tab.
// - An approval that hadn't reached core is never sent by itself: they
//   see the read-back again and agree again.
// - A delete pressed as it ended: nothing of it is saved back.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const secret = "s".repeat(43);

/** Where their interview was: in the conversation, typing, after his question. */
const typing: InterviewProgress = {
  person: "progress",
  told: true,
  mode: "type",
  lines: [{ from: "stephen", text: "What do you do first with an invoice?" }],
  facts: [],
  phase: "steps",
  wants: "answer",
  startedAt: 1,
  confirmed: 0,
  adding: false,
  addedAt: 0,
};

/** Finished, after talking: what is left is to say how it was. */
const finishedTalking: InterviewProgress = {
  ...typing,
  person: "completed",
  mode: "talk",
  phase: "result",
  wants: "end",
};

/** At the read-back, its one part to agree to. */
const readingBack: InterviewProgress = {
  ...typing,
  lines: [
    ...typing.lines,
    { from: "person", text: "I check it in Exact." },
    { from: "stephen", text: "Thank you. Let me read back what I wrote down." },
  ],
  facts: [
    {
      id: "f1",
      tag: "system",
      text: "You check the invoice in Exact.",
      record: "Check the invoice in Exact.",
    },
  ],
  phase: "result",
  wants: "readback",
};

/** At the read-back, its one part two lines long: Stephen tells it as a story. */
const readingBackTwo: InterviewProgress = {
  ...readingBack,
  facts: [
    ...readingBack.facts,
    {
      id: "f2",
      tag: "system",
      text: "You book it in Exact.",
      record: "Book it in Exact.",
    },
  ],
};

/** Who the faked core finds signed in on the browser's cookie. */
type Who = "them" | "someone else" | "nobody";

/** What the faked core keeps, and every call made of it. */
interface FakeCore {
  who: Who;
  version: number;
  progress: InterviewProgress | null;
  withdrawn: boolean;
  /** Deleted, and no copy opened since: a save from before is refused. */
  deleted: boolean;
  /** Its last day passed: nothing more is kept. */
  closed: boolean;
  /** The company paused the interviews: the link opens nothing for now. */
  paused: boolean;
  /** Saves fail on core's side, and are tried again. */
  failing: boolean;
  /** Approvals fail on core's side, and are tried again. */
  approveFailing: boolean;
  /** What his turns write down. */
  turnFacts: { tag: string; text: string; record: string; quote: string }[];
  /** Waited for before a call of this action is answered, while set. */
  holding: Partial<Record<string, Promise<boolean>>>;
  /** Every call, with who was signed in as it came. */
  calls: { path: string; action: unknown; who: Who }[];
  /** Each save core kept, as it kept it. */
  kept: InterviewProgress[];
  /** Each approval core was told of: the ids of the facts it named. */
  approvals: string[][];
}

/** What the page sends: its action, and for a save the version and what it holds. */
const sentSchema = z.object({
  action: z.string().optional(),
  version: z.int().optional(),
  progress: interviewProgressSchema.optional(),
  facts: z.unknown().optional(),
});

/** The facts an approval names: each at its revision. */
const approvedSchema = z.array(
  z.object({ id: z.string(), revision: z.string() })
);

/** Core's refusal, with its code. */
const refusal = (
  status: number,
  code: Parameters<typeof interviewErrors.create>[0]
): Response =>
  Response.json(
    { code, message: interviewErrors.create(code).message },
    { status }
  );

/** His turn, as core streams it, writing down `facts`. */
const turnStream = (facts: FakeCore["turnFacts"]): Response => {
  const turn = {
    say: "Thanks. And then?",
    tone: null,
    phase: "steps",
    facts,
    changes: [],
    wants: "answer",
    more: false,
    approved: false,
  };
  return new Response(
    [
      { line: { say: turn.say, tone: null } },
      { next: { phase: "steps", wants: "answer" } },
      { turn },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
    { headers: { "content-type": "application/x-ndjson" } }
  );
};

/** A save, as core answers it: versioned, and refused once withdrawn or deleted. */
const saved = (
  core: FakeCore,
  body: z.output<typeof sentSchema>,
  progress: InterviewProgress
): Response => {
  if (core.failing) {
    return Response.json({}, { status: 503 });
  }
  // As core: nothing more is kept once withdrawn, or once it closed.
  if (core.withdrawn) {
    return refusal(410, "interview.withdrawn");
  }
  if (core.closed) {
    return refusal(410, "interview.closed");
  }
  if (body.version !== core.version) {
    return core.deleted && core.progress === null
      ? refusal(410, "interview.deleted")
      : Response.json(
          { saved: false, version: core.version, progress: core.progress },
          { status: 409 }
        );
  }
  core.deleted = false;
  core.progress = progress;
  core.version += 1;
  core.kept.push(progress);
  return Response.json({ saved: true, version: core.version });
};

/** `/api/interview` as core answers whoever the link belongs to. */
const onLink = (
  core: FakeCore,
  body: z.output<typeof sentSchema>
): Response => {
  switch (body.action ?? "") {
    case "session": {
      return Response.json({
        state: "open",
        name: "Oli",
        team: "Ops",
        lead: null,
        kind: "own",
        closes: "2026-12-31",
        closed: core.closed,
        progress: core.progress,
        version: core.version,
        withdrawn: core.withdrawn,
        removing: false,
      });
    }
    case "save": {
      return body.progress === undefined
        ? refusal(400, "interview.invalid")
        : saved(core, body, body.progress);
    }
    case "approve": {
      if (core.approveFailing) {
        return Response.json({}, { status: 503 });
      }
      core.approvals.push(approvedSchema.parse(body.facts).map(({ id }) => id));
      return Response.json({
        approved: true,
        receipt: "receipt",
        at: "2026-11-16T10:00:00.000Z",
      });
    }
    case "withdraw": {
      core.withdrawn = true;
      return Response.json({ withdrawn: true, at: "2026-11-16T10:00:00.000Z" });
    }
    case "delete": {
      core.progress = null;
      core.version += 1;
      core.deleted = true;
      return Response.json({ deleted: true });
    }
    default: {
      return Response.json({}, { status: 503 });
    }
  }
};

/** Core's interview routes, faked: what they keep and every call made of them. */
const fakeCore = (progress: InterviewProgress): FakeCore => {
  const core: FakeCore = {
    who: "them",
    version: 1,
    progress,
    withdrawn: false,
    deleted: false,
    closed: false,
    paused: false,
    failing: false,
    approveFailing: false,
    turnFacts: [],
    holding: {},
    calls: [],
    kept: [],
    approvals: [],
  };
  const fetched = async (
    input: string,
    init?: RequestInit
  ): Promise<Response> => {
    await Promise.resolve();
    const path = new URL(input, "https://grasp.test").pathname;
    const sent = typeof init?.body === "string" ? init.body : "{}";
    const body = sentSchema.parse(JSON.parse(sent));
    // Whose session it is, as the call was sent: a call held on its way
    // is answered for whoever sent it.
    const { who } = core;
    core.calls.push({ path, action: body.action, who });
    await core.holding[body.action ?? path];
    if (who === "nobody") {
      return refusal(401, "interview.sign_in");
    }
    if (who === "someone else") {
      return refusal(404, "interview.link_invalid");
    }
    if (path === "/api/speech") {
      return Response.json({ code: "speech.unavailable" }, { status: 503 });
    }
    if (core.paused) {
      return refusal(423, "interview.paused");
    }
    if (path === "/api/interview/turn") {
      return turnStream(core.turnFacts);
    }
    if (path === "/api/interview/hear") {
      return Response.json({ heard: "" });
    }
    return path === "/api/interview"
      ? onLink(core, body)
      : Response.json({}, { status: 503 });
  };
  vi.stubGlobal("fetch", vi.fn(fetched));
  return core;
};

/** The company's sign-in, and Grasp staff's, which an interview never offers. */
const signInOptions: SignInOption[] = [
  { providerId: "acme", label: "Microsoft", staff: false },
  { providerId: "grasp-staff", label: "Grasp", staff: true },
];

/** Core over RPC, faked, as the page asks it how people sign in: nobody is signed in to the app. */
const rpcCore = {
  api: async () =>
    await Promise.resolve({
      ping: async () => await Promise.resolve("pong"),
      signInOptions: async () => await Promise.resolve(signInOptions),
    }),
  withSession: async () => {
    await Promise.resolve();
    throw authErrors.create("auth.unauthenticated");
  },
};

let root: Root | undefined;

/**
 * Waits until `ready` says so, React's updates flushed at each look. Fails
 * with `what` when it doesn't come.
 */
const until = async (ready: () => boolean, what: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await act(async () => {
        await Promise.resolve();
      });
      if (!ready()) {
        throw new Error(`Still waiting for ${what}`);
      }
    },
    { timeout: 4000, interval: 10 }
  );
};

const text = (): string => document.body.textContent ?? "";

const buttonNamed = (label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.textContent === label || each.getAttribute("aria-label") === label
  );

/** Presses the button named `label`. */
const press = async (label: string): Promise<void> => {
  await act(async () => {
    buttonNamed(label)?.click();
    await Promise.resolve();
  });
};

const answerBox = (): HTMLTextAreaElement | null =>
  document.querySelector('textarea[aria-label="Your answer"]');

/** Types into the answer box, as a person does. */
const type = async (words: string): Promise<void> => {
  const box = answerBox();
  if (box === null) {
    throw new Error("No answer box");
  }
  await act(async () => {
    // React tracks the value it set: the element's own setter, as typing
    // goes through, is what it hears change.
    Reflect.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(box, words);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/** The page leaves: as a sign-in does, nothing of it is left but this tab's storage. */
const leave = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  releaseInterview();
  document.body.replaceChildren();
};

/** The interview page opened at `hash`, as the browser loads it. */
const load = async (hash: string): Promise<void> => {
  window.history.replaceState(null, "", `/interview${hash}`);
  const rootRoute = createRootRoute({ component: Outlet });
  // SAFETY: the options the generated route tree (routeTree.gen.ts) puts
  // a file route under the root with, which the route's own type leaves out.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const page = interviewRoute.update({
    id: "/interview",
    path: "/interview",
    getParentRoute: () => rootRoute,
  } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/interview"] }),
    context: { core: rpcCore },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
};

/** In the conversation, his line answered, with the box to type in. */
const inConversation = async (): Promise<void> => {
  await load(`#${secret}`);
  await until(() => answerBox() !== null, "the answer box");
  await until(() => text().includes("Thanks. And then?"), "his line");
};

const signInAgain = "Sign in again to go on";

/** In the conversation, the session ends as they send `words`: the page asks them to sign in again. */
const endedSending = async (core: FakeCore, words: string): Promise<void> => {
  await inConversation();
  core.who = "nobody";
  await type(words);
  await press("Send");
  await until(() => text().includes(signInAgain), "the sign-in again");
};

/** Back from signing in: the tab comes back to the page, its link without the secret. */
const backSignedIn = async (): Promise<void> => {
  leave();
  await load("");
};

/** Everything this tab's storage holds, as text. */
const stored = (): string =>
  Array.from({ length: sessionStorage.length }, (_, at) => {
    const key = sessionStorage.key(at) ?? "";
    return `${key}=${sessionStorage.getItem(key) ?? ""}`;
  }).join("\n");

/** What each save core kept holds of what was said. */
const linesKept = (core: FakeCore): string[][] =>
  core.kept.map(({ lines }) => lines.map((line) => line.text));

const lost =
  "What you hadn't saved when your sign-in ended couldn't be kept, because your interview changed while you were away.";

/**
 * Wraps the faked core so `after` runs right after it answered the link's
 * first `session` call from here on: what happens elsewhere between the
 * page opening the link and its first save.
 */
const afterOpen = (after: () => void): void => {
  const inner = globalThis.fetch;
  let done = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const answer = await inner(input, init);
      const sent = typeof init?.body === "string" ? init.body : "{}";
      if (!done && sent.includes('"action":"session"')) {
        done = true;
        after();
      }
      return answer;
    })
  );
};

/** A stretch they said, sent to be written down from its recording, as the microphone path sends it. */
const heard = async (): Promise<void> => {
  await act(async () => {
    await hearRecording({
      secret,
      locale: "en",
      seconds: 2,
      audio: new Blob(["a stretch said"]),
    });
  });
};

/** Holds every call of `action` until the returned release is called. */
const hold = (core: FakeCore, action: string): (() => void) => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  core.holding[action] = promise;
  return () => {
    core.holding[action] = undefined;
    resolve(true);
  };
};

/** The calls made since `from`, by action, and who was signed in as each came. */
const callsSince = (core: FakeCore, from: number) =>
  core.calls.slice(from).map(({ action, who, path }) => ({
    action: action ?? path,
    who,
  }));

/** What waits in the tab, read as the page writes it: its version, the copy and the box. */
const asideSchemaOf = (raw: string) => {
  const parsed = z
    .object({
      version: z.int(),
      progress: z.unknown(),
      typed: z.string(),
    })
    .parse(JSON.parse(raw.slice(raw.indexOf("=") + 1)));
  return {
    version: parsed.version,
    progress: parsed.progress,
    typed: parsed.typed,
  };
};

/** The page's audio, faked for lines said out loud: a level meter, and no sound. */
const audioContext = {
  destination: {},
  createAnalyser: () => ({
    fftSize: 1024,
    connect: (): void => {
      // Nothing to hear it.
    },
  }),
};

/** `new AudioContext()`, faked: it gives the faked context. */
const FakeAudioContext = function FakeAudioContext(): typeof audioContext {
  return audioContext;
};

/** Counts the conversation's starts on this page, as the loop tells them. */
const countLoopStarts = (): { count: number; stop: () => void } => {
  const counted = {
    count: 0,
    stop: (): void => {
      // Replaced once listening.
    },
  };
  const started = (event: Event): void => {
    if (
      event instanceof CustomEvent &&
      JSON.stringify(event.detail).includes('"type":"voice"')
    ) {
      counted.count += 1;
    }
  };
  window.addEventListener(loopEventName, started);
  counted.stop = () => {
    window.removeEventListener(loopEventName, started);
  };
  return counted;
};

/** At the read-back, the conversation started: they agree to it, and core's first approval fails. */
const agreedWhileApprovalFails = async (core: FakeCore): Promise<void> => {
  const loops = countLoopStarts();
  await load(`#${secret}`);
  await until(
    () => buttonNamed("Yes, that’s correct") !== undefined,
    "the read-back"
  );
  await until(() => loops.count > 0, "the conversation");
  loops.stop();
  core.approveFailing = true;
  await press("Yes, that’s correct");
  await until(
    () => core.calls.some(({ action }) => action === "approve"),
    "the approval, asked for once"
  );
};

describe("the interview page when its session ends mid-interview", () => {
  afterEach(() => {
    leave();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks them to sign in again with the company's sign-in alone, says what they typed waits here, and sends nothing while nobody is signed in", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const core = fakeCore(typing);
    await endedSending(core, "I check it in Exact.");
    const sentSince = core.calls.length;
    // Past the wait before a change is kept, and past a first retry.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect({
      told: text().includes(
        "Your sign-in ended. Sign in again with your work account to go on where you were. What isn't saved yet is kept in this window until then."
      ),
      company: buttonNamed("Sign in with Microsoft") !== undefined,
      staff: buttonNamed("Sign in with Grasp") !== undefined,
      lostSpeech: text().includes("it wasn't heard"),
      refusal: text().includes(
        interviewErrors.create("interview.sign_in").message
      ),
      sentSince: core.calls.slice(sentSince),
      keptByCore: linesKept(core),
    }).toStrictEqual({
      told: true,
      company: true,
      staff: false,
      lostSpeech: false,
      refusal: false,
      sentSince: [],
      keptByCore: [],
    });
  });

  it("takes them back to their interview once signed in again, with what they said kept at the version it went on from", async () => {
    const core = fakeCore(typing);
    await endedSending(core, "I check it in Exact.");
    core.who = "them";
    await backSignedIn();
    await until(
      () =>
        linesKept(core).some((said) => said.includes("I check it in Exact.")),
      "what they said, kept"
    );
    await until(() => answerBox() !== null, "the answer box again");
    expect({
      inTheInterview: !text().includes(signInAgain),
      address: window.location.hash,
      stored: stored(),
    }).toStrictEqual({
      inTheInterview: true,
      address: `#${secret}`,
      stored: "",
    });
  });

  it("puts what they typed and didn't send back in the box once they are back", async () => {
    const core = fakeCore(typing);
    await inConversation();
    core.who = "nobody";
    await type("Half an answer");
    // Something of theirs is saved meanwhile: it finds the session ended.
    await press("Stop for now");
    await until(() => text().includes(signInAgain), "the sign-in again");
    core.who = "them";
    await backSignedIn();
    // Back on the link after stopping, it carries on where it was.
    await until(() => answerBox() !== null, "the answer box again");
    await until(() => stored() === "", "what waited, kept");
    expect({
      box: answerBox()?.value,
      keptSinceBack: core.kept.length > 0,
    }).toStrictEqual({ box: "Half an answer", keptSinceBack: true });
  });

  it("keeps nothing of this window once another window went on meanwhile, and says what waited couldn't be kept", async () => {
    const core = fakeCore(typing);
    await endedSending(core, "Mine, from this window.");
    // Another window went on, signed in, meanwhile.
    core.progress = {
      ...typing,
      lines: [
        ...typing.lines,
        { from: "person", text: "From the other window." },
      ],
    };
    core.version += 1;
    core.who = "them";
    await backSignedIn();
    await until(() => text().includes(lost), "what couldn't be kept, said");
    expect({
      keptByCore: linesKept(core),
      held: core.progress.lines.map(({ text: said }) => said),
      stored: stored(),
    }).toStrictEqual({
      keptByCore: [],
      held: ["What do you do first with an invoice?", "From the other window."],
      stored: "",
    });
  });

  it("saves nothing of the old interview back after staff gave a new start while they were away, and says what waited couldn't be kept", async () => {
    const core = fakeCore(typing);
    await endedSending(core, "Something only I said.");
    // Staff began it anew on their request: nothing of it is held.
    core.progress = null;
    core.version += 1;
    core.who = "them";
    await backSignedIn();
    await until(() => text().includes(lost), "what couldn't be kept, said");
    expect({
      keptOld: core.kept.some(({ lines }) =>
        lines.some(({ text: said }) => said === "Something only I said.")
      ),
      held: core.progress,
      stored: stored(),
    }).toStrictEqual({ keptOld: false, held: null, stored: "" });
  });

  it("saves nothing back after they deleted the interview in another window while away, and says what waited couldn't be kept", async () => {
    const core = fakeCore(typing);
    await endedSending(core, "Something only I said.");
    core.progress = null;
    core.version += 1;
    core.deleted = true;
    core.who = "them";
    await backSignedIn();
    await until(() => text().includes(lost), "what couldn't be kept, said");
    expect({
      keptByCore: linesKept(core),
      held: core.progress,
      stored: stored(),
    }).toStrictEqual({ keptByCore: [], held: null, stored: "" });
  });

  it("changes nothing of an interview they withdrew in another window while away, and says what waited couldn't be kept", async () => {
    const core = fakeCore(typing);
    await endedSending(core, "Something only I said.");
    core.withdrawn = true;
    core.who = "them";
    const before = core.calls.length;
    await backSignedIn();
    await until(() => text().includes(lost), "what couldn't be kept, said");
    expect({
      saves: core.calls.slice(before).filter(({ action }) => action === "save")
        .length,
      stored: stored(),
    }).toStrictEqual({ saves: 0, stored: "" });
  });

  it("tells someone who was talking that what they said as it ended wasn't heard, before they speak again", async () => {
    const core = fakeCore(finishedTalking);
    await load(`#${secret}`);
    await until(() => buttonNamed("4 of 5") !== undefined, "the rating");
    core.who = "nobody";
    await press("4 of 5");
    await until(() => text().includes(signInAgain), "the sign-in again");
    expect(text()).toContain(
      "If you were saying something as it ended, it wasn't heard. Say it again once you're back."
    );
  });

  it("says the unsaved words are lost when this window can't keep them, rather than that they are kept", async () => {
    const core = fakeCore(typing);
    await inConversation();
    const refusing = vi
      .spyOn(sessionStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("The storage is full.");
      });
    core.who = "nobody";
    await type("Words this window can't keep.");
    await press("Send");
    await until(() => text().includes(signInAgain), "the sign-in again");
    expect({
      lost: text().includes(
        "Your sign-in ended. Sign in again with your work account to go on where you were. This window couldn't keep what wasn't saved yet, so it is lost."
      ),
      keptHere: text().includes("is kept in this window"),
    }).toStrictEqual({ lost: true, keptHere: false });
    refusing.mockRestore();
  });

  it("answers someone else who signs in in that tab as for a link that never was, and leaves nothing that waited in the tab", async () => {
    const core = fakeCore(typing);
    await endedSending(core, "Only mine.");
    const waited = stored().includes("Only mine.");
    core.who = "someone else";
    const before = core.calls.length;
    await backSignedIn();
    await until(
      () => text().includes("This interview can't be opened"),
      "the refusal"
    );
    expect({
      waited,
      shown: text().includes("Only mine."),
      sent: core.calls
        .slice(before)
        .map(({ path, action }) => ({ path, action })),
      kept: core.kept.length,
      stored: stored(),
    }).toStrictEqual({
      waited: true,
      shown: false,
      sent: [{ path: "/api/interview", action: "session" }],
      kept: 0,
      stored: "",
    });
  });

  it("sends no approval by itself once they are back: they see the read-back again and agree again", async () => {
    const core = fakeCore(readingBack);
    // The conversation starts a moment after the page shows: they agree once it has.
    let loopsStarted = 0;
    const started = (event: Event): void => {
      if (
        event instanceof CustomEvent &&
        JSON.stringify(event.detail).includes('"type":"voice"')
      ) {
        loopsStarted += 1;
      }
    };
    window.addEventListener(loopEventName, started);
    await load(`#${secret}`);
    await until(
      () => buttonNamed("Yes, that’s correct") !== undefined,
      "the read-back"
    );
    await until(() => loopsStarted > 0, "the conversation");
    core.who = "nobody";
    await press("Yes, that’s correct");
    await until(() => text().includes(signInAgain), "the sign-in again");
    core.who = "them";
    await backSignedIn();
    await until(
      () => buttonNamed("Yes, that’s correct") !== undefined,
      "the read-back again"
    );
    await until(() => loopsStarted > 1, "the conversation again");
    const unasked = core.approvals.length;
    await press("Yes, that’s correct");
    await until(() => core.approvals.length > 0, "their approval");
    window.removeEventListener(loopEventName, started);
    expect({
      unasked,
      approved: core.approvals,
    }).toStrictEqual({
      unasked: 0,
      approved: [["f1"]],
    });
  });

  it("saves nothing of their interview back once they are back after asking to delete it as it ended", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const core = fakeCore(finishedTalking);
    await load(`#${secret}`);
    await until(() => buttonNamed("4 of 5") !== undefined, "the rating");
    // A change core couldn't keep yet: it waits here, and is tried again.
    core.failing = true;
    await press("4 of 5");
    await until(
      () => core.calls.some(({ action }) => action === "save"),
      "the rating's save"
    );
    await act(async () => {
      buttonNamed("Delete my interview")?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true })
      );
      await vi.advanceTimersByTimeAsync(4000);
    });
    await until(() => buttonNamed("Delete it") !== undefined, "Delete it");
    // Their session ends as they press it.
    core.failing = false;
    core.who = "nobody";
    await press("Delete it");
    await until(() => text().includes(signInAgain), "the sign-in again");
    const signInSaid = text();
    core.who = "them";
    const before = core.calls.length;
    await backSignedIn();
    await until(
      () => buttonNamed("Delete my interview") !== undefined,
      "their interview, to delete again"
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect({
      saves: core.calls.slice(before).filter(({ action }) => action === "save")
        .length,
      stored: stored(),
      said: text().includes(
        "Your sign-in had ended, so your interview wasn't deleted: delete it again if you still want to."
      ),
      signIn: {
        notDeleted: signInSaid.includes(
          "Your sign-in ended, so your interview wasn't deleted and what wasn't saved yet wasn't kept: sign in again with your work account to delete it."
        ),
        keptHere: signInSaid.includes("is kept in this window"),
      },
    }).toStrictEqual({
      saves: 0,
      stored: "",
      said: true,
      signIn: { notDeleted: true, keptHere: false },
    });
  });

  it("saves nothing of their interview back once they are back after asking to withdraw as it ended, and says they didn't withdraw", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const core = fakeCore(finishedTalking);
    await load(`#${secret}`);
    await until(() => buttonNamed("4 of 5") !== undefined, "the rating");
    core.failing = true;
    await press("4 of 5");
    await until(
      () => core.calls.some(({ action }) => action === "save"),
      "the rating's save"
    );
    await act(async () => {
      buttonNamed("Delete my interview")?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true })
      );
      await vi.advanceTimersByTimeAsync(4000);
    });
    await until(
      () => buttonNamed("Withdraw instead") !== undefined,
      "Withdraw instead"
    );
    core.failing = false;
    core.who = "nobody";
    await press("Withdraw instead");
    await until(() => text().includes(signInAgain), "the sign-in again");
    const signInSaid = text();
    core.who = "them";
    const before = core.calls.length;
    await backSignedIn();
    await until(
      () => buttonNamed("Delete my interview") !== undefined,
      "their interview, to withdraw from again"
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect({
      saves: callsSince(core, before).filter(({ action }) => action === "save"),
      withdrawn: core.withdrawn,
      stored: stored(),
      said: text().includes(
        "Your sign-in had ended, so you didn't withdraw: withdraw again if you still want to."
      ),
      signIn: {
        notWithdrawn: signInSaid.includes(
          "Your sign-in ended, so you didn't withdraw and what wasn't saved yet wasn't kept: sign in again with your work account to withdraw."
        ),
        keptHere: signInSaid.includes("is kept in this window"),
      },
    }).toStrictEqual({
      saves: [],
      withdrawn: false,
      stored: "",
      said: true,
      signIn: { notWithdrawn: true, keptHere: false },
    });
  });

  it("keeps nothing of this window when another window goes on between opening the link and its first save, and says so", async () => {
    const core = fakeCore(typing);
    await endedSending(core, "Mine, from this window.");
    core.who = "them";
    afterOpen(() => {
      core.progress = {
        ...typing,
        lines: [...typing.lines, { from: "person", text: "Other window." }],
      };
      core.version += 1;
    });
    await backSignedIn();
    await until(() => text().includes(lost), "what couldn't be kept, said");
    expect({
      kept: linesKept(core),
      stored: stored(),
      shown: text().includes("Mine, from this window."),
    }).toStrictEqual({ kept: [], stored: "", shown: false });
  });

  it("saves nothing of the old interview back when staff give a new start between opening the link and its first save", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const core = fakeCore(typing);
    await endedSending(core, "Something only I said.");
    core.who = "them";
    afterOpen(() => {
      core.progress = null;
      core.version += 1;
    });
    await backSignedIn();
    await until(() => text().includes(lost), "what couldn't be kept, said");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect({
      keptOld: core.kept.some(({ lines }) =>
        lines.some(({ text: said }) => said === "Something only I said.")
      ),
      stored: stored(),
    }).toStrictEqual({ keptOld: false, stored: "" });
  });

  it("forgets what waited once core refuses to keep it for good: withdrawn between opening the link and its first save", async () => {
    const core = fakeCore(typing);
    await endedSending(core, "Mine, from this window.");
    core.who = "them";
    afterOpen(() => {
      core.withdrawn = true;
    });
    await backSignedIn();
    await until(
      () =>
        core.calls.some(
          ({ action, who }) => action === "save" && who === "them"
        ),
      "the save core refuses"
    );
    await until(() => stored() === "", "nothing left in the tab");
    expect(linesKept(core)).toStrictEqual([]);
  });

  it("says what waited couldn't be kept because the interview closed while they were away, and saves nothing", async () => {
    const core = fakeCore(typing);
    await endedSending(core, "Something only I said.");
    core.closed = true;
    core.who = "them";
    const before = core.calls.length;
    await backSignedIn();
    await until(
      () =>
        text().includes(
          "What you hadn't saved when your sign-in ended couldn't be kept, because your interview has closed."
        ),
      "what couldn't be kept, said"
    );
    expect({
      changed: text().includes(lost),
      saves: callsSince(core, before).filter(({ action }) => action === "save"),
      stored: stored(),
    }).toStrictEqual({ changed: false, saves: [], stored: "" });
  });

  it("forgets a kept copy that no longer reads as one", async () => {
    fakeCore(typing);
    const draft = await draftName(secret);
    sessionStorage.setItem(draft, '{"version":"not a kept copy"}');
    await inConversation();
    expect(stored()).toBe("");
  });

  it("approves the facts as they stood when they agreed, however the interview went on before core could be told", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const core = fakeCore(readingBack);
    await agreedWhileApprovalFails(core);
    // They go back to add something, and he writes down a new fact.
    await until(
      () => buttonNamed("Add something") !== undefined,
      "Add something"
    );
    core.turnFacts = [
      {
        tag: "system",
        text: "You book it in Exact.",
        record: "Book it in Exact.",
        quote: "",
      },
    ];
    await press("Add something");
    await until(() => answerBox() !== null, "the answer box");
    await type("Then I book it in Exact.");
    await press("Send");
    await until(
      () =>
        core.kept.some(({ facts }) =>
          facts.some(({ text: fact }) => fact === "You book it in Exact.")
        ),
      "the new fact, kept"
    );
    core.approveFailing = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    await until(() => core.approvals.length > 0, "the approval");
    expect(core.approvals).toStrictEqual([["f1"]]);
  });

  it("drops an approval core wasn't told of once another window's copy takes this one's place", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const core = fakeCore(readingBack);
    await agreedWhileApprovalFails(core);
    // Another window went on meanwhile; a change here meets its copy.
    core.progress = readingBack;
    core.version += 5;
    const before = core.calls.length;
    await until(() => buttonNamed("4 of 5") !== undefined, "the rating");
    await press("4 of 5");
    await until(
      () => callsSince(core, before).some(({ action }) => action === "save"),
      "the save that meets the other copy"
    );
    core.approveFailing = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });
    expect(core.approvals).toStrictEqual([]);
  });

  it("sends no approval once their session ended while it was being made", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const core = fakeCore(readingBack);
    await agreedWhileApprovalFails(core);
    // Its facts' revisions are being worked out as the session ends.
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const held: (() => void)[] = [];
    let holding = true;
    vi.spyOn(crypto.subtle, "digest").mockImplementation(
      async (algorithm, data) => {
        if (holding) {
          const { promise, resolve } = Promise.withResolvers<boolean>();
          held.push(() => {
            resolve(true);
          });
          await promise;
        }
        return await digest(algorithm, data);
      }
    );
    core.approveFailing = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await until(() => held.length > 0, "the approval being made");
    core.who = "nobody";
    const before = core.calls.length;
    await heard();
    holding = false;
    for (const release of held.splice(0)) {
      release();
    }
    await until(() => text().includes(signInAgain), "the sign-in again");
    expect(
      callsSince(core, before).filter(({ action }) => action === "approve")
    ).toStrictEqual([]);
  });

  it("asks them to sign in again when a stretch they said finds the session ended", async () => {
    const core = fakeCore(typing);
    await inConversation();
    core.who = "nobody";
    const before = core.calls.length;
    await heard();
    await until(() => text().includes(signInAgain), "the sign-in again");
    // Asked to sign in again by that answer itself: the link, asked again.
    expect(callsSince(core, before)).toStrictEqual([
      { action: "/api/interview/hear", who: "nobody" },
      { action: "session", who: "nobody" },
    ]);
  });

  it("sends nothing as the page goes once their session ended", async () => {
    const core = fakeCore(typing);
    await endedSending(core, "Not sent as the page goes.");
    const before = core.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await Promise.resolve();
    });
    expect(callsSince(core, before)).toStrictEqual([]);
  });

  it("sends nothing when they stop for now in the moment between their session ending and the sign-in showing", async () => {
    const core = fakeCore(typing);
    await inConversation();
    core.who = "nobody";
    // The sign-in shows once core answers the link again: not yet.
    const release = hold(core, "session");
    const before = core.calls.length;
    await heard();
    await press("Stop for now");
    const sent = callsSince(core, before);
    release();
    await until(() => text().includes(signInAgain), "the sign-in again");
    expect(sent.filter(({ action }) => action === "save")).toStrictEqual([]);
  });

  it("keeps what a save on its way held when their session ends before core answers it", async () => {
    const core = fakeCore(typing);
    await inConversation();
    const release = hold(core, "save");
    await type("Said while a save was on its way.");
    await press("Send");
    await until(
      () => core.calls.some(({ action }) => action === "save"),
      "the save on its way"
    );
    core.who = "nobody";
    await heard();
    await until(() => text().includes(signInAgain), "the sign-in again");
    const waiting = stored();
    release();
    expect(waiting).toContain("Said while a save was on its way.");
  });

  it("changes nothing, here or in what waits, when an approval's answer lands after their session ended", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const core = fakeCore(readingBack);
    // Core answers the approval with its own copy, in the conversation
    // again: another window pressed "Add something" meanwhile.
    const answerApproval = hold(core, "approve");
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const sent = typeof init?.body === "string" ? init.body : "{}";
        const answer = await inner(input, init);
        return sent.includes('"action":"approve"') && answer.ok
          ? Response.json({
              approved: false,
              version: core.version + 3,
              progress: typing,
            })
          : answer;
      })
    );
    const loops = countLoopStarts();
    await load(`#${secret}`);
    await until(
      () => buttonNamed("Yes, that’s correct") !== undefined,
      "the read-back"
    );
    await until(() => loops.count > 0, "the conversation");
    await press("Yes, that’s correct");
    await until(
      () => core.calls.some(({ action }) => action === "approve"),
      "the approval on its way"
    );
    core.who = "nobody";
    const showSignIn = hold(core, "session");
    await heard();
    const waited = stored();
    const before = core.calls.length;
    const startedBefore = loops.count;
    answerApproval();
    // Past the moment a conversation starts again, and his first turn.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const meanwhile = {
      sent: callsSince(core, before),
      restarted: loops.count - startedBefore,
      stored: stored(),
      elsewhere: text().includes("This interview went on in another window."),
    };
    showSignIn();
    await until(() => text().includes(signInAgain), "the sign-in again");
    loops.stop();
    expect(meanwhile).toStrictEqual({
      sent: [],
      restarted: 0,
      stored: waited,
      elsewhere: false,
    });
  });

  it("keeps nothing of the interview in the tab's storage while their session lasts", async () => {
    const core = fakeCore(typing);
    await inConversation();
    await type("I check it in Exact.");
    await press("Send");
    await until(() => core.kept.length > 0, "what they said, kept");
    await type("Half an answer");
    expect(stored()).toBe("");
  });

  it("waits on from a save that lands just after their session ended: only what changed since, at the version it made", async () => {
    const core = fakeCore(typing);
    await inConversation();
    const land = hold(core, "save");
    await type("Said as the save went out.");
    await press("Send");
    await until(
      () => core.calls.some(({ action }) => action === "save"),
      "the save on its way"
    );
    core.who = "nobody";
    await heard();
    await until(() => text().includes(signInAgain), "the sign-in again");
    land();
    await until(() => core.kept.length > 0, "the save, landed");
    await act(async () => {
      await Promise.resolve();
    });
    const waiting = asideSchemaOf(stored());
    expect(waiting).toStrictEqual({
      version: core.version,
      progress: null,
      typed: "",
    });
  });

  it("says nothing of a delete that didn't happen once the interview changed while they were away", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const core = fakeCore(finishedTalking);
    await load(`#${secret}`);
    await act(async () => {
      buttonNamed("Delete my interview")?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true })
      );
      await vi.advanceTimersByTimeAsync(4000);
    });
    await until(() => buttonNamed("Delete it") !== undefined, "Delete it");
    core.who = "nobody";
    await press("Delete it");
    await until(() => text().includes(signInAgain), "the sign-in again");
    // Deleted in another window meanwhile.
    core.progress = null;
    core.version += 1;
    core.who = "them";
    await backSignedIn();
    await until(() => text().includes("Which language"), "the interview, anew");
    expect(text()).not.toContain("wasn't deleted");
  });

  it("keeps what waits while the link refuses for now (paused), and keeps it once it opens", async () => {
    const core = fakeCore(typing);
    await endedSending(core, "Said before the pause.");
    core.paused = true;
    core.who = "them";
    await backSignedIn();
    await until(
      () => text().includes("This interview can't be opened"),
      "the pause"
    );
    const whilePaused = stored().includes("Said before the pause.");
    core.paused = false;
    await backSignedIn();
    await until(
      () =>
        linesKept(core).some((said) => said.includes("Said before the pause.")),
      "what waited, kept"
    );
    expect(whilePaused).toBeTruthy();
  });

  it("asks them to sign in again when his turn finds the session ended, before anything else is sent", async () => {
    const core = fakeCore(typing);
    await inConversation();
    core.who = "nobody";
    const before = core.calls.length;
    await type("I check it in Exact.");
    await press("Send");
    await until(() => text().includes(signInAgain), "the sign-in again");
    expect(callsSince(core, before)).toStrictEqual([
      { action: "/api/interview/turn", who: "nobody" },
      { action: "session", who: "nobody" },
    ]);
  });

  it("asks them to sign in again when a part's story finds the session ended", async () => {
    const core = fakeCore(readingBackTwo);
    afterOpen(() => {
      core.who = "nobody";
    });
    await load(`#${secret}`);
    await until(() => text().includes(signInAgain), "the sign-in again");
    expect(callsSince(core, 1)).toStrictEqual([
      { action: "/api/interview/story", who: "nobody" },
      { action: "session", who: "nobody" },
    ]);
  });

  it("asks them to sign in again when a line said finds the session ended, and asks for no line still waiting", async () => {
    const core = fakeCore(typing);
    await inConversation();
    vi.stubGlobal("AudioContext", FakeAudioContext);
    setSound(true);
    core.who = "nobody";
    const before = core.calls.length;
    const voicing = { speaker: "stephen", tone: null } as const;
    await act(async () => {
      for (const line of ["One.", "Two.", "Three.", "Four."]) {
        prepare(line, voicing);
      }
      await Promise.resolve();
    });
    await until(() => text().includes(signInAgain), "the sign-in again");
    setSound(false);
    expect(
      callsSince(core, before).filter(({ action }) => action === "/api/speech")
    ).toStrictEqual([
      { action: "/api/speech", who: "nobody" },
      { action: "/api/speech", who: "nobody" },
    ]);
  });

  it("goes on with the conversation when the link opens again on a new session before the sign-in shows", async () => {
    const core = fakeCore(typing);
    const loops = countLoopStarts();
    await inConversation();
    core.who = "nobody";
    const reopen = hold(core, "session");
    await heard();
    // They signed in again in another tab meanwhile.
    core.who = "them";
    reopen();
    await until(() => loops.count > 1, "the conversation, again");
    await until(() => answerBox() !== null, "the answer box");
    const before = core.calls.length;
    await type("Back from the other tab.");
    await press("Send");
    await until(
      () =>
        callsSince(core, before).some(
          ({ action, who }) =>
            action === "/api/interview/turn" && who === "them"
        ),
      "his turn, asked"
    );
    loops.stop();
    expect(text()).not.toContain(signInAgain);
  });
});
