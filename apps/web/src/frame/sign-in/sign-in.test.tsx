// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { GoogleLogo } from "../../connections/brand-logos.ts";
import { SignIn } from "./sign-in.tsx";

// The sign-in page's way out: a press opens the door, and only once it
// has opened does the page leave (`onChoose`). A page taken down while the
// door opens (the person went Back) never leaves.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(window, "matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {
    // Nothing changes.
  },
  removeEventListener: () => {
    // Nothing changes.
  },
}));

/**
 * A WebGL context that draws nothing, so the door runs its way out as in
 * a browser: every call answers, compiling and linking succeed.
 */
const fakeWebGl = new Proxy(
  {},
  {
    get: (_target, name) => {
      if (name === "getShaderParameter" || name === "getProgramParameter") {
        return () => true;
      }
      return () => ({});
    },
  }
);

/** The browser's own canvas contexts, put back after each test. */
const drawing: unknown = Reflect.get(HTMLCanvasElement.prototype, "getContext");

/** The page drawn, its way in to Google pressed; what it was told to leave for. */
const pressed = async () => {
  const chosen: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider i18n={i18n}>
        <SignIn
          foot={null}
          onChoose={(id) => {
            chosen.push(id);
          }}
          onPress={() => {
            // Core is asked elsewhere.
          }}
          providers={[{ id: "google", name: "Google", icon: GoogleLogo }]}
          staff={false}
        />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  const way = [...host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("Continue with Google")
  );
  act(() => {
    way?.click();
  });
  return { chosen, host, root };
};

describe("the sign-in page", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "performance",
      ],
    });
    Reflect.set(HTMLCanvasElement.prototype, "getContext", (kind: string) =>
      kind === "webgl" ? fakeWebGl : null
    );
  });

  afterEach(() => {
    Reflect.set(HTMLCanvasElement.prototype, "getContext", drawing);
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("is the page's one main landmark, named by its title", async () => {
    const { host, root } = await pressed();
    const mains = host.querySelectorAll("main");
    expect(mains).toHaveLength(1);
    const title = mains[0]?.querySelector("h1");
    expect(title?.textContent).toBe("Log in");
    expect(mains[0]?.getAttribute("aria-labelledby")).toBe(title?.id);
    act(() => {
      root.unmount();
    });
  });

  it("leaves for the chosen way once the door has opened", async () => {
    const { chosen, root } = await pressed();
    expect(chosen).toStrictEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(chosen).toStrictEqual(["google"]);
    act(() => {
      root.unmount();
    });
  });

  it("never leaves once the page is taken down while the door opens", async () => {
    const { chosen, root } = await pressed();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    act(() => {
      root.unmount();
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(chosen).toStrictEqual([]);
  });
});
