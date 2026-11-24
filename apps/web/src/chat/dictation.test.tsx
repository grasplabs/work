// @vitest-environment happy-dom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { LiveLine, LiveLineOptions } from "../interview/live-line.ts";
import { micMuted } from "../interview/mic.ts";
import type { DictationMic } from "./dictation-mic.ts";
import { dictate, lineReadyMs, useDictation } from "./dictation.ts";
import type { DictationParts, Problem, StopNote } from "./dictation.ts";

// One dictation, from the moment the browser is asked for the microphone
// to its end, on a fake microphone and a fake line to core: every way out
// lets go of the microphone and closes the line, a microphone the browser
// gives late is let go of at once, and no sound goes to core unless it
// listens. Then the box's hook: the ways out the page has (the box gone,
// another page, the tab hidden or closed), its mute its own, and the words
// that say why it stopped.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A microphone the browser gave: whether it was let go of, and muted. */
interface FakeMic extends DictationMic {
  stopped: boolean;
  muted: boolean;
}

/** Core's line as the dictation sees it: what was sent, and whether it was dropped or closed. */
interface FakeLine extends LiveLine {
  options: LiveLineOptions;
  sent: number;
  dropped: boolean;
  closed: boolean;
}

/**
 * Fake parts: the browser answers the microphone's ask only when the test
 * says (`give`, `refuse`), and core's line listens only when it says
 * (`line().options.onLive(true)`). `speak` is the microphone's sound.
 */
const rig = ({ settled = "Which invoices are late?" } = {}) => {
  const mics: FakeMic[] = [];
  const lines: FakeLine[] = [];
  let asked: PromiseWithResolvers<DictationMic> | undefined;
  let hear: ((sound: Int16Array) => void) | undefined;
  let lose: (() => void) | undefined;
  const parts: DictationParts = {
    microphone: async (onSound, onLost) => {
      hear = onSound;
      lose = onLost;
      asked = Promise.withResolvers<DictationMic>();
      return await asked.promise;
    },
    openLine: (options) => {
      let sending = false;
      const line: FakeLine = {
        options,
        sent: 0,
        dropped: false,
        closed: false,
        begin: () => {
          sending = !line.closed;
          return sending;
        },
        send: () => {
          if (sending && !line.closed) {
            line.sent += 1;
          }
        },
        end: async () => await Promise.resolve(line.closed ? null : settled),
        drop: () => {
          line.dropped = true;
          sending = false;
        },
        close: () => {
          line.closed = true;
          sending = false;
        },
      };
      lines.push(line);
      return line;
    },
  };
  return {
    parts,
    mics,
    lines,
    /** The browser gives the microphone. */
    give: async (): Promise<FakeMic> => {
      const mic: FakeMic = {
        stopped: false,
        muted: false,
        level: () => 0.5,
        mute: (on) => {
          mic.muted = on;
        },
        stop: () => {
          mic.stopped = true;
        },
      };
      mics.push(mic);
      asked?.resolve(mic);
      await Promise.resolve();
      await Promise.resolve();
      return mic;
    },
    /** The browser gives none, with the error it names. */
    refuse: async (name: string): Promise<void> => {
      asked?.reject(new DOMException("No", name));
      await Promise.resolve();
      await Promise.resolve();
    },
    /** The line core opened last. */
    line: (): FakeLine => {
      const last = lines.at(-1);
      if (last === undefined) {
        throw new Error("No line");
      }
      return last;
    },
    /** Some sound from the microphone. */
    speak: (): void => {
      hear?.(new Int16Array(1600));
    },
    /** The microphone is gone: unplugged, or taken by the system. */
    lose: (): void => {
      lose?.();
    },
  };
};

/** A dictation on `parts`, and what it told. */
const started = (parts: DictationParts) => {
  const told: { heard: string[]; problems: Problem[] } = {
    heard: [],
    problems: [],
  };
  const dictation = dictate(
    "en",
    {
      heard: (words) => {
        told.heard.push(words);
      },
      problem: (problem) => {
        told.problems.push(problem);
      },
    },
    parts
  );
  return { dictation, told };
};

/** A dictation listening: microphone given, line live, a little said. */
const listening = async () => {
  const fake = rig();
  const { dictation, told } = started(fake.parts);
  const mic = await fake.give();
  const line = fake.line();
  line.options.onLive(true);
  fake.speak();
  line.options.onPartial("Which invoices");
  return { fake, dictation, told, mic, line };
};

describe("one dictation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Done while the browser asks for the microphone: one given after is let go of at once, and no line opens", async () => {
    const fake = rig();
    const { dictation } = started(fake.parts);

    const said = await dictation.finish();
    const mic = await fake.give();
    fake.speak();

    expect({
      said,
      stopped: mic.stopped,
      lines: fake.lines.length,
    }).toStrictEqual({ said: "", stopped: true, lines: 0 });
  });

  it("Cancel while the browser asks: the same", async () => {
    const fake = rig();
    const { dictation, told } = started(fake.parts);

    dictation.cancel();
    const mic = await fake.give();
    fake.speak();

    expect({
      stopped: mic.stopped,
      lines: fake.lines.length,
      told,
    }).toStrictEqual({
      stopped: true,
      lines: 0,
      told: { heard: [], problems: [] },
    });
  });

  it("Done while the line opens: the microphone let go of, the line closed, nothing sent", async () => {
    const fake = rig();
    const { dictation } = started(fake.parts);
    const mic = await fake.give();
    fake.speak();

    const said = await dictation.finish();
    fake.line().options.onLive(true);
    fake.speak();

    expect({
      said,
      stopped: mic.stopped,
      closed: fake.line().closed,
      sent: fake.line().sent,
    }).toStrictEqual({ said: "", stopped: true, closed: true, sent: 0 });
  });

  it("sends the sound only while it listens, and Done lets go of the microphone before the words are written down", async () => {
    const { fake, dictation, told, mic, line } = await listening();
    const sentWhileListening = line.sent;

    const settling = dictation.finish();
    const stoppedAtDone = mic.stopped;
    fake.speak();
    const said = await settling;

    expect({
      sentWhileListening,
      sent: line.sent,
      stoppedAtDone,
      closed: line.closed,
      said,
      heard: told.heard,
    }).toStrictEqual({
      sentWhileListening: 1,
      sent: 1,
      stoppedAtDone: true,
      closed: true,
      said: "Which invoices are late?",
      heard: ["Which invoices"],
    });
  });

  it("Cancel while it listens: the stretch dropped, the line closed, the microphone let go of", async () => {
    const { fake, dictation, mic, line } = await listening();

    dictation.cancel();
    fake.speak();

    expect({
      dropped: line.dropped,
      closed: line.closed,
      stopped: mic.stopped,
      sent: line.sent,
    }).toStrictEqual({ dropped: true, closed: true, stopped: true, sent: 1 });
  });

  it("sends nothing while muted, its microphone silent, and the next one starts with it on", async () => {
    const { fake, dictation, mic, line } = await listening();

    dictation.mute(true);
    fake.speak();
    const level = dictation.level();
    dictation.cancel();
    const next = rig();
    started(next.parts);
    const nextMic = await next.give();

    expect({
      sent: line.sent,
      muted: mic.muted,
      level,
      nextMuted: nextMic.muted,
      interviewMuted: micMuted(),
      lines: fake.lines.length,
    }).toStrictEqual({
      sent: 1,
      muted: true,
      level: 0,
      nextMuted: false,
      interviewMuted: false,
      lines: 1,
    });
  });

  it.each([
    ["NotAllowedError", "blocked"],
    ["SecurityError", "blocked"],
    ["NotFoundError", "missing"],
    ["OverconstrainedError", "missing"],
    ["AbortError", "failed"],
  ] as const)(
    "says why when the browser gives no microphone (%s)",
    async (name, problem) => {
      const fake = rig();
      const { told } = started(fake.parts);

      await fake.refuse(name);

      expect({ told, lines: fake.lines.length }).toStrictEqual({
        told: { heard: [], problems: [problem] },
        lines: 0,
      });
    }
  );

  it.each([
    ["transcription.limited", "limited"],
    ["transcription.refused", "failed"],
  ] as const)(
    "stops when core refuses to listen (%s), letting go of the microphone and the line",
    async (code, problem) => {
      const { fake, told, mic, line } = await listening();

      line.options.onRefused?.(code);
      fake.speak();

      expect({
        problems: told.problems,
        stopped: mic.stopped,
        closed: line.closed,
        sent: line.sent,
      }).toStrictEqual({
        problems: [problem],
        stopped: true,
        closed: true,
        sent: 1,
      });
    }
  );

  it("stops when the microphone is lost, so no silence goes on being sent", async () => {
    const { fake, told, mic, line } = await listening();

    fake.lose();
    fake.speak();

    expect({
      problems: told.problems,
      stopped: mic.stopped,
      closed: line.closed,
      sent: line.sent,
    }).toStrictEqual({
      problems: ["lost"],
      stopped: true,
      closed: true,
      sent: 1,
    });
  });

  it("stops when the line goes down mid-way", async () => {
    const { told, mic, line } = await listening();

    line.options.onLive(false);

    expect({
      problems: told.problems,
      stopped: mic.stopped,
      closed: line.closed,
    }).toStrictEqual({ problems: ["failed"], stopped: true, closed: true });
  });

  it("stops when the line doesn't listen in time", async () => {
    const fake = rig();
    const { told } = started(fake.parts);
    const mic = await fake.give();

    vi.advanceTimersByTime(lineReadyMs);

    expect({
      problems: told.problems,
      stopped: mic.stopped,
      closed: fake.line().closed,
    }).toStrictEqual({ problems: ["failed"], stopped: true, closed: true });
  });
});

let root: Root | undefined;

/** What the box's hook gave last, and the box's text. */
interface Seen {
  hook: ReturnType<typeof useDictation>;
  text: string;
}

/**
 * A box dictating on `parts` inside the shell, which stays as the page
 * under it changes (`/` and `/other`), as the chat's does; `boxes` of
 * them, each drawing its dictation's bar as Damsko's box does while it
 * listens, in a place of its own the page can hide (`[data-box]`).
 */
const shown = async (parts: DictationParts, boxes = 1) => {
  const seen: (Seen | undefined)[] = [];
  const Box = ({ index }: { index: number }) => {
    const [text, setText] = useState("For finance:");
    const [off, setOff] = useState(false);
    const hook = useDictation(text, setText, { off, parts });
    useEffect(() => {
      seen[index] = { hook, text };
    }, [hook, index, text]);
    // What takes dictation away from the box, as the chat's bar does while the chat is open.
    return (
      <div data-box={index} data-slot="prompt-input">
        <button
          aria-label="Dictate"
          data-slot="prompt-input-speech-button"
          type="button"
        />
        <button
          aria-label="Dictation off"
          data-off
          onClick={() => {
            setOff(!off);
          }}
          type="button"
        />
        {hook.speech?.listening === true ? (
          <div data-slot="prompt-input-dictation">
            <button data-slot="prompt-input-dictation-done" type="button">
              Done
            </button>
          </div>
        ) : null}
      </div>
    );
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "_shell",
    component: () => (
      <>
        {Array.from({ length: boxes }, (_, index) => (
          <Box index={index} key={index} />
        ))}
        <Outlet />
      </>
    ),
  });
  const home = createRoute({
    getParentRoute: () => shell,
    path: "/",
    component: () => null,
  });
  const other = createRoute({
    getParentRoute: () => shell,
    path: "/other",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([home, other])]),
    history: createMemoryHistory(),
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
  const nowOf = (index: number): Seen => {
    const box = seen[index];
    if (box === undefined) {
      throw new Error("No box");
    }
    return box;
  };
  return { now: () => nowOf(0), nowOf, router };
};

/**
 * The chat's two boxes, its idle bar (0) and its panel (1), writing into
 * one draft that their page keeps, as the chat's does (use-ask.ts): its
 * text and why dictating stopped last. Each box can be taken away from
 * the page (the agent's questions in its place, the chat undocked) or
 * kept from dictating (the bar while the chat is open, the panel while it
 * is closed), as `set` says; the panel starts closed.
 */
const sharing = async (parts: DictationParts) => {
  const seen: (Seen | undefined)[] = [];
  interface Change {
    shown?: boolean;
    off?: boolean;
  }
  const control: { set?: (index: number, box: Change) => void } = {};
  const Box = ({
    index,
    text,
    onText,
    note,
    off,
  }: {
    index: number;
    text: string;
    onText: (text: string) => void;
    note: StopNote;
    off: boolean;
  }) => {
    const hook = useDictation(text, onText, { off, parts, note });
    useEffect(() => {
      seen[index] = { hook, text };
    }, [hook, index, text]);
    return hook.speech?.listening === true ? (
      <div data-slot="prompt-input-dictation" />
    ) : null;
  };
  const Draft = () => {
    const [text, setText] = useState("For finance:");
    const [stopped, setStopped] = useState<Problem>();
    const note: StopNote = [stopped, setStopped];
    const [boxes, setBoxes] = useState([
      { shown: true, off: false },
      { shown: true, off: true },
    ]);
    useEffect(() => {
      control.set = (index, box) => {
        setBoxes((now) =>
          now.map((each, at) => (at === index ? { ...each, ...box } : each))
        );
      };
    }, []);
    return boxes.map((box, index) =>
      box.shown ? (
        <Box
          index={index}
          key={index}
          note={note}
          off={box.off}
          onText={setText}
          text={text}
        />
      ) : null
    );
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "_shell",
    component: Draft,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell]),
    history: createMemoryHistory(),
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
  const nowOf = (index: number) => (): Seen => {
    const box = seen[index];
    if (box === undefined) {
      throw new Error("No box");
    }
    return box;
  };
  return {
    bar: nowOf(0),
    panel: nowOf(1),
    set: (index: number, box: Change) => {
      act(() => {
        control.set?.(index, box);
      });
    },
  };
};

/** What a box says when its dictation stopped as it went out of sight. */
const awayWords =
  "Dictation stopped as its box went out of sight. What was heard is kept.";

/** Takes dictation away from the box, or gives it back. */
const toggleOff = (): void => {
  act(() => {
    document.querySelector<HTMLButtonElement>("[data-off]")?.click();
  });
};

/** The speech button's props now. */
const speechOf = (seen: Seen) => {
  const { speech } = seen.hook;
  if (speech === undefined) {
    throw new Error("No dictation offered");
  }
  return speech;
};

/** Starts dictating in the box, its microphone given and the line listening, and something heard. */
const dictating = async (now: () => Seen, fake: ReturnType<typeof rig>) => {
  await act(async () => {
    speechOf(now()).onListeningChange?.(true);
    await Promise.resolve();
  });
  let mic: FakeMic | undefined;
  await act(async () => {
    mic = await fake.give();
    fake.line().options.onLive(true);
    fake.line().options.onPartial("which invoices are late");
  });
  if (mic === undefined) {
    throw new Error("No microphone");
  }
  return mic;
};

const setVisibility = (state: DocumentVisibilityState): void => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("dictating in the box", () => {
  beforeEach(() => {
    // The browser can ask for a microphone; the fake parts answer.
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {},
    });
  });
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    setVisibility("visible");
  });

  it("stops, keeps what was heard, and says so when the tab is hidden", async () => {
    const fake = rig();
    const { now } = await shown(fake.parts);
    const mic = await dictating(now, fake);

    act(() => {
      setVisibility("hidden");
    });

    expect({
      stopped: mic.stopped,
      closed: fake.line().closed,
      listening: speechOf(now()).listening,
      text: now().text,
      problem: now().hook.problem,
    }).toStrictEqual({
      stopped: true,
      closed: true,
      listening: false,
      text: "For finance: which invoices are late",
      problem:
        "Dictation stopped as you left this tab. What was heard is kept.",
    });
  });

  it("goes when the tab is closed", async () => {
    const fake = rig();
    const { now } = await shown(fake.parts);
    const mic = await dictating(now, fake);

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect({
      stopped: mic.stopped,
      closed: fake.line().closed,
      listening: speechOf(now()).listening,
    }).toStrictEqual({ stopped: true, closed: true, listening: false });
  });

  it("goes on another page, keeping what was heard", async () => {
    const fake = rig();
    const { now, router } = await shown(fake.parts);
    const mic = await dictating(now, fake);

    await act(async () => {
      router.history.push("/other");
      await router.load();
    });

    expect({
      stopped: mic.stopped,
      closed: fake.line().closed,
      listening: speechOf(now()).listening,
      text: now().text,
      problem: now().hook.problem,
    }).toStrictEqual({
      stopped: true,
      closed: true,
      listening: false,
      text: "For finance: which invoices are late",
      problem:
        "Dictation stopped as you went to another page. What was heard is kept.",
    });
  });

  it("goes as the box goes, and as it stops offering dictation", async () => {
    const fake = rig();
    const { now } = await shown(fake.parts);
    const first = await dictating(now, fake);

    toggleOff();
    const offered = now().hook.speech;
    toggleOff();
    const second = await dictating(now, fake);
    act(() => {
      root?.unmount();
    });
    root = undefined;

    expect({
      offered,
      first: first.stopped,
      second: second.stopped,
      closed: fake.lines.map(({ closed }) => closed),
    }).toStrictEqual({
      offered: undefined,
      first: true,
      second: true,
      closed: [true, true],
    });
  });

  it("a press of Done while the browser asks leaves nothing listening once the microphone comes", async () => {
    const fake = rig();
    const { now } = await shown(fake.parts);

    await act(async () => {
      speechOf(now()).onListeningChange?.(true);
      await Promise.resolve();
    });
    await act(async () => {
      speechOf(now()).onListeningChange?.(false);
      await Promise.resolve();
    });
    let mic: FakeMic | undefined;
    await act(async () => {
      mic = await fake.give();
    });
    fake.speak();

    expect({
      stopped: mic?.stopped,
      lines: fake.lines.length,
      listening: speechOf(now()).listening,
      settling: speechOf(now()).settling,
    }).toStrictEqual({
      stopped: true,
      lines: 0,
      listening: false,
      settling: false,
    });
  });

  it("keeps its mute to itself: off again once it ends, and never the interview's", async () => {
    const fake = rig();
    const { now } = await shown(fake.parts);
    const first = await dictating(now, fake);

    act(() => {
      speechOf(now()).onMutedChange?.(true);
    });
    const mutedWhile = { bar: speechOf(now()).muted, mic: first.muted };
    await act(async () => {
      speechOf(now()).onListeningChange?.(false);
      await Promise.resolve();
    });
    const after = speechOf(now()).muted;
    const second = await dictating(now, fake);

    expect({
      mutedWhile,
      after,
      next: { bar: speechOf(now()).muted, mic: second.muted },
      interview: micMuted(),
    }).toStrictEqual({
      mutedWhile: { bar: true, mic: true },
      after: false,
      next: { bar: false, mic: false },
      interview: false,
    });
  });

  it("stops, keeping what was heard, once its bar is out of sight, though the page never said so", async () => {
    const fake = rig();
    const { now } = await shown(fake.parts);
    const mic = await dictating(now, fake);
    fake.speak();
    const sentBefore = fake.line().sent;

    // Its place hidden, as a page may hide a box without a word.
    document.querySelector("[data-box]")?.setAttribute("hidden", "");
    await act(async () => {
      await vi.waitFor(() => {
        expect(mic.stopped).toBeTruthy();
      });
    });
    fake.speak();

    expect({
      closed: fake.line().closed,
      sent: fake.line().sent - sentBefore,
      listening: speechOf(now()).listening,
      text: now().text,
      problem: now().hook.problem,
    }).toStrictEqual({
      closed: true,
      sent: 0,
      listening: false,
      text: "For finance: which invoices are late",
      problem: awayWords,
    });
  });

  it("keeps what was heard as the draft when the box goes mid-dictation (the agent's questions in its place, the chat undocked), and the box that comes back says why", async () => {
    const fake = rig();
    const { bar, set } = await sharing(fake.parts);
    const mic = await dictating(bar, fake);

    set(0, { shown: false });
    const gone = { stopped: mic.stopped, closed: fake.line().closed };
    set(0, { shown: true });

    expect({
      gone,
      text: bar().text,
      problem: bar().hook.problem,
      listening: speechOf(bar()).listening,
    }).toStrictEqual({
      gone: { stopped: true, closed: true },
      text: "For finance: which invoices are late",
      problem: awayWords,
      listening: false,
    });
  });

  it("keeps what was heard in the idle bar for the panel as the chat opens over it, and says why there", async () => {
    const fake = rig();
    const { bar, panel, set } = await sharing(fake.parts);
    const mic = await dictating(bar, fake);

    // The chat opens: its bar dictates no more, its panel does.
    set(0, { off: true });
    set(1, { off: false });

    expect({
      stopped: mic.stopped,
      text: panel().text,
      problem: panel().hook.problem,
    }).toStrictEqual({
      stopped: true,
      text: "For finance: which invoices are late",
      problem: awayWords,
    });
  });

  it("keeps what was heard in the panel for the idle bar as the chat closes (Close, or the shortcut), and says why there", async () => {
    const fake = rig();
    const { bar, panel, set } = await sharing(fake.parts);
    set(0, { off: true });
    set(1, { off: false });
    const mic = await dictating(panel, fake);

    set(1, { off: true });
    set(0, { off: false });

    expect({
      stopped: mic.stopped,
      text: bar().text,
      problem: bar().hook.problem,
    }).toStrictEqual({
      stopped: true,
      text: "For finance: which invoices are late",
      problem: awayWords,
    });
  });

  it("keeps nothing on Cancel, and says nothing", async () => {
    const fake = rig();
    const { bar } = await sharing(fake.parts);
    const mic = await dictating(bar, fake);

    act(() => {
      speechOf(bar()).onCancel?.();
    });

    expect({
      stopped: mic.stopped,
      text: bar().text,
      problem: bar().hook.problem,
    }).toStrictEqual({
      stopped: true,
      text: "For finance:",
      problem: undefined,
    });
  });

  it("puts the focus on the bar's Done where starting left it on the page, so Escape reaches the bar", async () => {
    const fake = rig();
    const { now } = await shown(fake.parts);
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    await dictating(now, fake);
    await act(async () => {
      await vi.waitFor(() => {
        const focused = document.activeElement;
        expect(focused instanceof HTMLElement && focused.dataset.slot).toBe(
          "prompt-input-dictation-done"
        );
      });
    });
  });

  it("gives the focus it took for the bar back to the microphone as the bar goes", async () => {
    const fake = rig();
    const { now } = await shown(fake.parts);
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    await dictating(now, fake);
    await act(async () => {
      await vi.waitFor(() => {
        const focused = document.activeElement;
        expect(focused instanceof HTMLElement && focused.dataset.slot).toBe(
          "prompt-input-dictation-done"
        );
      });
    });

    act(() => {
      speechOf(now()).onCancel?.();
    });

    const focused = document.activeElement;
    expect(focused instanceof HTMLElement && focused.dataset.slot).toBe(
      "prompt-input-speech-button"
    );
  });

  it("dictates in one box of the app at a time: another starting stops the first, keeping what it heard", async () => {
    const fake = rig();
    const { nowOf } = await shown(fake.parts, 2);
    const first = await dictating(() => nowOf(0), fake);

    const second = await dictating(() => nowOf(1), fake);

    expect({
      first: first.stopped,
      second: second.stopped,
      listening: [speechOf(nowOf(0)).listening, speechOf(nowOf(1)).listening],
      kept: nowOf(0).text,
      lines: fake.lines.map(({ closed }) => closed),
    }).toStrictEqual({
      first: true,
      second: false,
      listening: [false, true],
      kept: "For finance: which invoices are late",
      lines: [true, false],
    });
  });

  it.each([
    [
      "the microphone refused",
      async (fake: ReturnType<typeof rig>) => {
        await fake.refuse("NotAllowedError");
      },
      "Your browser doesn't let Grasp use the microphone. Allow it in the browser's settings to dictate.",
    ],
    [
      "no microphone",
      async (fake: ReturnType<typeof rig>) => {
        await fake.refuse("NotFoundError");
      },
      "No microphone was found.",
    ],
    [
      "core refusing",
      async (fake: ReturnType<typeof rig>) => {
        await fake.give();
        fake.line().options.onRefused?.("transcription.refused");
      },
      "Dictation stopped. What was heard is kept.",
    ],
    [
      "the microphone lost",
      async (fake: ReturnType<typeof rig>) => {
        await fake.give();
        fake.line().options.onLive(true);
        fake.lose();
      },
      "Dictation stopped: the microphone was lost. What was heard is kept.",
    ],
    [
      "the day's 30 minutes used",
      async (fake: ReturnType<typeof rig>) => {
        await fake.give();
        fake.line().options.onRefused?.("transcription.limited");
      },
      "You've dictated as much as you can today.",
    ],
  ] as const)(
    "tells the person when it stops for %s",
    async (_, stop, words) => {
      const fake = rig();
      const { now } = await shown(fake.parts);

      await act(async () => {
        speechOf(now()).onListeningChange?.(true);
        await Promise.resolve();
      });
      await act(async () => {
        await stop(fake);
      });

      expect({
        problem: now().hook.problem,
        listening: speechOf(now()).listening,
        stopped: fake.mics.every(({ stopped }) => stopped),
        closed: fake.lines.every(({ closed }) => closed),
      }).toStrictEqual({
        problem: words,
        listening: false,
        stopped: true,
        closed: true,
      });
    }
  );

  // Last: core's word that it isn't set up holds for the rest of the visit.
  it("says dictation isn't set up when core says so, and offers it no more", async () => {
    const fake = rig();
    const { now } = await shown(fake.parts);

    await act(async () => {
      speechOf(now()).onListeningChange?.(true);
      await Promise.resolve();
    });
    await act(async () => {
      await fake.give();
      fake.line().options.onRefused?.("transcription.unavailable");
    });

    expect({
      problem: now().hook.problem,
      offered: now().hook.speech,
      stopped: fake.mics.every(({ stopped }) => stopped),
      closed: fake.line().closed,
    }).toStrictEqual({
      problem: "Dictation isn't set up here yet.",
      offered: undefined,
      stopped: true,
      closed: true,
    });
  });
});
