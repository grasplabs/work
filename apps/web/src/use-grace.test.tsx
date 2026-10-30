// @vitest-environment happy-dom
import { act } from "react";
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

import { useGrace } from "./use-grace.ts";

// A confirmed change that waits a few seconds with Undo, as pausing a
// workflow and answering in Today do: what could go wrong is a confirmed
// change lost because the page went in those seconds, sent twice, or
// sent after Undo.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const seconds = 5;

/** A confirmed answer held with Undo, recording what was sent and how. */
const Held = ({ sent }: { sent: string[] }) => {
  const { held, hold, undo } = useGrace<string>({
    seconds,
    go: (value) => {
      sent.push(`went ${value}`);
    },
    goOnLeave: (value) => {
      sent.push(`went on leaving ${value}`);
    },
  });
  return held === null ? (
    <button
      onClick={() => {
        hold("approved");
      }}
      type="button"
    >
      Approve
    </button>
  ) : (
    <button onClick={undo} type="button">
      Undo {held.left}
    </button>
  );
};

let root: Root | undefined;

const shown = async (sent: string[]): Promise<void> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<Held sent={sent} />);
    await Promise.resolve();
  });
};

const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.startsWith(label)
  );
  if (button === undefined) {
    throw new Error(`No ${label} button.`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
};

/** Waits `ms`, a second at a time, letting each second's render land. */
const waited = async (ms: number): Promise<void> => {
  for (let passed = 0; passed < ms; passed += 1000) {
    // oxlint-disable-next-line no-await-in-loop -- each second follows the last
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
};

const left = async (): Promise<void> => {
  await act(async () => {
    root?.unmount();
    await Promise.resolve();
  });
  root = undefined;
};

describe("a change held with Undo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await left();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("goes once its seconds are over, and only once", async () => {
    const sent: string[] = [];
    await shown(sent);
    await press("Approve");
    await waited((seconds - 1) * 1000);
    expect(sent).toStrictEqual([]);
    await waited(1000);
    await left();
    expect(sent).toStrictEqual(["went approved"]);
  });

  it("goes at once when the page goes in those seconds, as it was confirmed", async () => {
    const sent: string[] = [];
    await shown(sent);
    await press("Approve");
    await waited(2000);
    await left();
    await waited(seconds * 1000);
    expect(sent).toStrictEqual(["went on leaving approved"]);
  });

  it("never goes once taken back, whether the page stays or goes", async () => {
    const sent: string[] = [];
    await shown(sent);
    await press("Approve");
    await waited(1000);
    await press("Undo");
    await waited(seconds * 1000);
    await left();
    expect(sent).toStrictEqual([]);
  });
});
