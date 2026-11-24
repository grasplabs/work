// @vitest-environment happy-dom
import type { InterviewLine } from "@grasp-os/shared/interview-links";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { setSound } from "./speech.ts";
import { Transcript } from "./transcript.tsx";

// The transcript in place of the stage (a phone): the stage, which reads
// his line out, is inert then, so each new line of his is said through
// the page's live region, once, in his words; never their own, and not
// when it is heard out loud.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const asked: InterviewLine = { from: "stephen", text: "What starts one?" };
const answered: InterviewLine = { from: "person", text: "A ticket." };
const next: InterviewLine = { from: "stephen", text: "And then?" };

const shown = async (alone: boolean, lines: InterviewLine[]) => {
  await act(async () => {
    root?.render(
      <I18nProvider i18n={i18n}>
        <Transcript
          alone={alone}
          lines={lines}
          onRemove={() => {
            // Not removed here.
          }}
          open
        />
      </I18nProvider>
    );
    await Promise.resolve();
  });
};

const region = (): Element | null =>
  document.querySelector("[data-slot=live-region][aria-live=polite]");

/** What was said of the lines themselves: the log's own count ("1 new message") is said beside them. */
const linesIn = (heard: string[]): string[] =>
  heard.filter((words) => !/ new messages?$/u.test(words));

/** Everything the page's live region said, in order. */
const said = async (): Promise<string[]> => {
  const heard: string[] = [];
  const seen = new MutationObserver(() => {
    const words = region()?.textContent ?? "";
    if (words !== "") {
      heard.push(words);
    }
  });
  seen.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  seen.disconnect();
  return heard;
};

describe("the transcript in place of the stage", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    setSound(true);
    vi.useRealTimers();
  });

  const opened = async (alone: boolean) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame"] });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await shown(alone, [asked]);
    await said();
  };

  it("says each new line of his once, in his words, and not their own", async () => {
    setSound(false);
    await opened(true);
    await shown(true, [asked, answered]);
    const afterTheirs = await said();
    await shown(true, [asked, answered, next]);
    const afterHis = await said();
    await shown(true, [asked, answered, next]);
    const again = await said();
    expect({
      afterTheirs: linesIn(afterTheirs),
      afterHis: linesIn(afterHis),
      again: linesIn(again),
    }).toStrictEqual({ afterTheirs: [], afterHis: ["And then?"], again: [] });
  });

  it("says nothing of his line beside the stage, or when it is heard", async () => {
    setSound(false);
    await opened(false);
    await shown(false, [asked, answered, next]);
    const beside = await said();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    setSound(true);
    await opened(true);
    await shown(true, [asked, answered, next]);
    const heard = await said();
    expect({
      beside: linesIn(beside),
      heard: linesIn(heard),
    }).toStrictEqual({ beside: [], heard: [] });
  });
});
