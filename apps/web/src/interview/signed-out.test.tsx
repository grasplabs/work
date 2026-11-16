import { authErrors } from "@grasp-os/shared/errors";
// @vitest-environment happy-dom
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
import { releaseInterview } from "./kept.ts";

// The interview page when the session behind it ends mid-interview
// (GRA-1943): the company's gate opens, they signed out in another tab,
// or it expired. Against core's interview routes faked as `fetch` answers
// them, by who is signed in: the person the link belongs to, someone
// else, or nobody. From the threat model, tried here:
//
// - They are asked to sign in again, with the company's sign-in alone,
//   and told that what isn't saved yet waits in this window; when they
//   were talking, that what they said as it ended is lost.
// - Nothing is sent while nobody is signed in, and what waited is sent
//   only once core opens the link for them again: kept at the version it
//   went on from, so a copy that went on elsewhere is the interview.
// - Someone else signing in in that tab gets the answer of a link that
//   never was, and nothing that waited is shown to them or sent.

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

/** Who the faked core finds signed in on the browser's cookie. */
type Who = "them" | "someone else" | "nobody";

/** What the faked core keeps, and every call made of it. */
interface FakeCore {
  who: Who;
  version: number;
  progress: InterviewProgress;
  /** Every call, with who was signed in as it came. */
  calls: { path: string; action: unknown; who: Who }[];
  /** Each save core kept, as it kept it. */
  kept: InterviewProgress[];
}

/** What the page sends: its action, and for a save the version and what it holds. */
const sentSchema = z.object({
  action: z.string().optional(),
  version: z.int().optional(),
  progress: interviewProgressSchema.optional(),
});

/** Core's refusal, with its code. */
const refusal = (
  status: number,
  code: Parameters<typeof interviewErrors.create>[0]
): Response =>
  Response.json(
    { code, message: interviewErrors.create(code).message },
    { status }
  );

/** Core's interview routes, faked: what they keep and every call made of them. */
const fakeCore = (progress: InterviewProgress): FakeCore => {
  const core: FakeCore = {
    who: "them",
    version: 1,
    progress,
    calls: [],
    kept: [],
  };
  const fetched = async (
    input: string,
    init?: RequestInit
  ): Promise<Response> => {
    await Promise.resolve();
    const path = new URL(input, "https://grasp.test").pathname;
    const sent = typeof init?.body === "string" ? init.body : "{}";
    const body = sentSchema.parse(JSON.parse(sent));
    core.calls.push({ path, action: body.action, who: core.who });
    if (path === "/api/speech") {
      return Response.json({ code: "speech.unavailable" }, { status: 503 });
    }
    if (core.who === "nobody") {
      return refusal(401, "interview.sign_in");
    }
    if (core.who === "someone else") {
      return refusal(404, "interview.link_invalid");
    }
    if (path === "/api/interview/turn") {
      const turn = {
        say: "Thanks. And then?",
        tone: null,
        phase: "steps",
        facts: [],
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
    }
    if (path !== "/api/interview") {
      return Response.json({}, { status: 503 });
    }
    if (body.action === "session") {
      return Response.json({
        state: "open",
        name: "Oli",
        team: "Ops",
        lead: null,
        kind: "own",
        closes: "2026-12-31",
        closed: false,
        progress: core.progress,
        version: core.version,
        withdrawn: false,
        removing: false,
      });
    }
    if (body.action === "save" && body.progress !== undefined) {
      if (body.version !== core.version) {
        return Response.json(
          { saved: false, version: core.version, progress: core.progress },
          { status: 409 }
        );
      }
      core.progress = body.progress;
      core.version += 1;
      core.kept.push(core.progress);
      return Response.json({ saved: true, version: core.version });
    }
    return Response.json({}, { status: 503 });
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

/** Back from signing in: the tab comes back to the page, its link without the secret. */
const backSignedIn = async (): Promise<void> => {
  leave();
  await load("");
};

const signInAgain = "Sign in again to go on";

describe("the interview page when its session ends mid-interview", () => {
  afterEach(() => {
    leave();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks them to sign in again with the company's sign-in alone, says what they typed waits here, and sends nothing while nobody is signed in", async () => {
    const core = fakeCore(typing);
    await inConversation();
    core.who = "nobody";
    await type("I check it in Exact.");
    await act(async () => {
      buttonNamed("Send")?.click();
      await Promise.resolve();
    });
    await until(() => text().includes(signInAgain), "the sign-in again");
    const sentSince = core.calls.length;
    // Longer than a change waits to be kept, and than a first retry.
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      setTimeout(() => {
        resolve(true);
      }, 1200);
      await promise;
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
      keptByCore: core.kept.flatMap(({ lines }) =>
        lines.map((line) => line.text)
      ),
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
    await inConversation();
    core.who = "nobody";
    await type("I check it in Exact.");
    await act(async () => {
      buttonNamed("Send")?.click();
      await Promise.resolve();
    });
    await until(() => text().includes(signInAgain), "the sign-in again");
    core.who = "them";
    await backSignedIn();
    await until(
      () =>
        core.kept.some(({ lines }) =>
          lines.some(({ text: said }) => said === "I check it in Exact.")
        ),
      "what they said, kept"
    );
    await until(() => answerBox() !== null, "the answer box again");
    expect({
      inTheInterview: !text().includes(signInAgain),
      address: window.location.hash,
      waiting: sessionStorage.length,
    }).toStrictEqual({
      inTheInterview: true,
      address: `#${secret}`,
      waiting: 0,
    });
  });

  it("puts what they typed and didn't send back in the box once they are back", async () => {
    const core = fakeCore(typing);
    await inConversation();
    core.who = "nobody";
    await type("Half an answer");
    // Something of theirs is saved meanwhile: it finds the session ended.
    await act(async () => {
      buttonNamed("Stop for now")?.click();
      await Promise.resolve();
    });
    await until(() => text().includes(signInAgain), "the sign-in again");
    core.who = "them";
    await backSignedIn();
    // Back on the link after stopping, it carries on where it was.
    await until(() => answerBox() !== null, "the answer box again");
    await until(() => sessionStorage.length === 0, "what waited, kept");
    expect({
      box: answerBox()?.value,
      keptSinceBack: core.kept.length > 0,
    }).toStrictEqual({ box: "Half an answer", keptSinceBack: true });
  });

  it("shows the copy kept elsewhere once they are back when another window went on meanwhile, and says so", async () => {
    const core = fakeCore(typing);
    await inConversation();
    core.who = "nobody";
    await type("Mine, from this window.");
    await act(async () => {
      buttonNamed("Send")?.click();
      await Promise.resolve();
    });
    await until(() => text().includes(signInAgain), "the sign-in again");
    // Another window went on, signed in, meanwhile.
    const elsewhere: InterviewProgress = {
      ...typing,
      lines: [
        ...typing.lines,
        { from: "person", text: "From the other window." },
      ],
    };
    core.progress = elsewhere;
    core.version += 1;
    core.who = "them";
    await backSignedIn();
    await until(
      () =>
        text().includes(
          "This interview went on in another window. You now see that one."
        ),
      "the copy kept elsewhere"
    );
    expect({
      kept: core.progress.lines.map(({ text: said }) => said),
      waiting: sessionStorage.length,
    }).toStrictEqual({
      kept: ["What do you do first with an invoice?", "From the other window."],
      waiting: 0,
    });
  });

  it("tells someone who was talking that what they said as it ended wasn't heard, before they speak again", async () => {
    const core = fakeCore(finishedTalking);
    await load(`#${secret}`);
    await until(() => buttonNamed("4 of 5") !== undefined, "the rating");
    core.who = "nobody";
    await act(async () => {
      buttonNamed("4 of 5")?.click();
      await Promise.resolve();
    });
    await until(() => text().includes(signInAgain), "the sign-in again");
    expect(text()).toContain(
      "If you were saying something as it ended, it wasn't heard. Say it again once you're back."
    );
  });

  it("answers someone else who signs in in that tab as for a link that never was, and shows or sends them nothing that waited", async () => {
    const core = fakeCore(typing);
    await inConversation();
    core.who = "nobody";
    await type("Only mine.");
    await act(async () => {
      buttonNamed("Send")?.click();
      await Promise.resolve();
    });
    await until(() => text().includes(signInAgain), "the sign-in again");
    core.who = "someone else";
    const before = core.calls.length;
    await backSignedIn();
    await until(
      () => text().includes("This interview can't be opened"),
      "the refusal"
    );
    expect({
      shown: text().includes("Only mine."),
      sent: core.calls
        .slice(before)
        .map(({ path, action }) => ({ path, action })),
      kept: core.kept.length,
    }).toStrictEqual({
      shown: false,
      sent: [{ path: "/api/interview", action: "session" }],
      kept: 0,
    });
  });
});
