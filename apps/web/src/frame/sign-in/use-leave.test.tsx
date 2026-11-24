// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useLeave } from "./use-leave.ts";

// Leaving for the identity provider core names, against core's answer
// faked at the network: the page leaves once core answers, and not at all
// when the page has gone meanwhile (the person went Back).

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const idp = "https://login.example.test/authorize";

/** Core's answer to the sign-in's start, given when `answer` is called. */
const coreAnswersLater = () => {
  const { promise, resolve } = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", async () => await promise);
  return () => {
    resolve(Response.json({ url: idp }));
  };
};

/** A page whose one button asks core and leaves at once; what it did, and its taking down. */
const page = () => {
  const refused = vi.fn<() => void>();
  const leaving: Promise<void>[] = [];
  const Page = () => {
    const { ask, leave } = useLeave("/");
    return (
      <button
        onClick={() => {
          ask("google");
          leaving.push(leave(refused));
        }}
        type="button"
      >
        Continue with Google
      </button>
    );
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<Page />);
  });
  const left = vi.spyOn(window.location, "assign").mockImplementation(() => {
    // Never leaves the test's page.
  });
  act(() => {
    host.querySelector("button")?.click();
  });
  return { leaving: Promise.all(leaving), left, refused, root };
};

describe("leaving for the identity provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("leaves for the address core gives", async () => {
    const answer = coreAnswersLater();
    const { leaving, left, refused, root } = page();
    answer();
    await leaving;
    expect(left).toHaveBeenCalledWith(idp);
    expect(refused).not.toHaveBeenCalled();
    act(() => {
      root.unmount();
    });
  });

  it("stays put when the page has gone before core answered", async () => {
    const answer = coreAnswersLater();
    const { leaving, left, refused, root } = page();
    act(() => {
      root.unmount();
    });
    answer();
    await leaving;
    expect(left).not.toHaveBeenCalled();
    expect(refused).not.toHaveBeenCalled();
  });
});
