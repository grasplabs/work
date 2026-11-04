import { describe, expect, it } from "vite-plus/test";

import { previewReceiver } from "../src/preview-updates.ts";
import type { PreviewFrame } from "../src/preview-updates.ts";
import type { PreviewPart } from "../src/screen-runtime.ts";

// A chat's preview's frame taking its draft's updates: the ways it can
// fail, from its threat model (preview-updates.ts): bytes other than
// core's, a stale or replayed or broken update, an update that doesn't
// evaluate, and one that evaluates but fails to render, which must leave
// the last version that rendered on screen. React Fast Refresh is
// outside: the frame here stands in for its runtime and the browser's
// module loader, which these modules decide nothing of.

const encoder = new TextEncoder();

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** `code` at `revision`, as one part, the way the page sends it. */
const update = async (
  revision: number,
  code: string,
  css = `.r${revision}{}`
): Promise<PreviewPart> => ({
  revision,
  part: 0,
  parts: 1,
  code,
  bytes: encoder.encode(code).byteLength,
  sha256: await sha256(encoder.encode(code)),
  css,
});

/** What a module's code says it renders: `render:<what>` or `throw`. */
const rendersOf = (url: string): string =>
  decodeURIComponent(url.slice(url.indexOf(",") + 1)).split("\n")[0] ?? "";

/**
 * A frame whose modules "render" what their code says: what is on
 * screen, the CSS, what was evaluated and reported. Like a browser's
 * module map, it evaluates one address once: importing it again hands
 * back the module made then, and registers nothing anew. Each module's
 * default export is a screen, as the compiler makes one.
 */
const screen = (): null => null;

const fakeFrame = () => {
  const evaluated: string[] = [];
  const reported: string[] = [];
  const seen = { screen: "opened", css: "", evaluated, reported };
  const modules = new Set<string>();
  let staged = "";
  let failures = 0;
  const frame: PreviewFrame = {
    evaluate: async (url) => {
      await Promise.resolve();
      seen.evaluated.push(url);
      if (modules.has(url)) {
        return { default: screen };
      }
      modules.add(url);
      const code = rendersOf(url);
      if (code === "syntax error") {
        throw new SyntaxError("Unexpected token");
      }
      staged = code;
      return { default: screen };
    },
    commit: () => {
      if (staged === "") {
        // Nothing registered: Refresh swaps nothing.
        return;
      }
      const code = staged;
      staged = "";
      if (code.startsWith("throw")) {
        failures += 1;
        seen.screen = "error boundary";
      } else {
        seen.screen = code.replace("render:", "");
      }
    },
    discard: () => {
      staged = "";
    },
    refresh: () => true,
    show: () => {},
    renderFailures: () => failures,
    settle: async () => {
      await Promise.resolve();
    },
    setCss: (css) => {
      seen.css = css;
    },
    report: (value) => {
      seen.reported.push(value instanceof Error ? value.message : "?");
    },
    sha256,
  };
  return { frame, seen };
};

describe("a preview's frame taking its draft's updates", () => {
  it("swaps in each newer revision, and refuses one it is past or replayed", async () => {
    const { frame, seen } = fakeFrame();
    const receive = previewReceiver(frame);
    const answers = [
      await receive(await update(1, "render:one")),
      await receive(await update(2, "render:two")),
      // Replayed, then older.
      await receive(await update(2, "render:two")),
      await receive(await update(1, "render:one")),
    ];
    expect({ answers, screen: seen.screen, css: seen.css }).toStrictEqual({
      answers: ["applied", "applied", "refused", "refused"],
      screen: "two",
      css: ".r2{}",
    });
  });

  it("evaluates nothing whose size or SHA-256 isn't what core answered", async () => {
    const { frame, seen } = fakeFrame();
    const receive = previewReceiver(frame);
    const honest = await update(1, "render:one");
    const answers = [
      await receive({ ...honest, code: "render:evil" }),
      await receive({ ...honest, bytes: honest.bytes + 1 }),
      await receive({ ...honest, sha256: "0".repeat(64) }),
    ];
    expect({ answers, evaluated: seen.evaluated }).toStrictEqual({
      answers: ["refused", "refused", "refused"],
      evaluated: [],
    });
  });

  it("puts an update in parts together only in order, each of the same update", async () => {
    const { frame, seen } = fakeFrame();
    const receive = previewReceiver(frame);
    const whole = await update(1, "render:joined");
    const first = { ...whole, parts: 2, code: "render:" };
    const second = { ...whole, parts: 2, part: 1, code: "joined" };
    const outOfTurn = await receive(second);
    const fromAnother = [
      await receive(first),
      await receive({ ...second, revision: 2 }),
    ];
    const inOrder = [await receive(first), await receive(second)];
    expect({
      outOfTurn,
      fromAnother,
      inOrder,
      screen: seen.screen,
    }).toStrictEqual({
      outOfTurn: "refused",
      fromAnother: ["more", "refused"],
      inOrder: ["more", "applied"],
      screen: "joined",
    });
  });

  it("keeps the last working version when an update doesn't evaluate, and says why", async () => {
    const { frame, seen } = fakeFrame();
    const receive = previewReceiver(frame);
    await receive(await update(1, "render:one"));
    const broken = await receive(await update(2, "syntax error"));
    expect({
      broken,
      screen: seen.screen,
      css: seen.css,
      reported: seen.reported,
    }).toStrictEqual({
      broken: "failed",
      screen: "one",
      css: ".r1{}",
      reported: ["Unexpected token"],
    });
  });

  it("swaps the last version that rendered back in when an update fails to render, then takes the fix", async () => {
    const { frame, seen } = fakeFrame();
    const receive = previewReceiver(frame);
    await receive(await update(1, "render:one"));
    const failing = await receive(await update(2, "throw"));
    const back = seen.screen;
    const fixed = await receive(await update(3, "render:three"));
    expect({ failing, back, fixed, screen: seen.screen }).toStrictEqual({
      failing: "failed",
      back: "one",
      fixed: "applied",
      screen: "three",
    });
  });

  it("swaps code back in that it evaluated before, as an update back to an earlier write, under an address of its own each time", async () => {
    const { frame, seen } = fakeFrame();
    const receive = previewReceiver(frame);
    const answers = [
      await receive(await update(1, "render:A")),
      await receive(await update(2, "render:B")),
      // The agent writes the screen back as it was: the same code.
      await receive(await update(3, "render:A")),
    ];
    expect({
      answers,
      screen: seen.screen,
      addresses: new Set(seen.evaluated).size,
      // What is evaluated is the code checked, and one comment after it.
      checked: seen.evaluated.every((url) =>
        decodeURIComponent(url).includes("\n//# grasp-evaluation=")
      ),
    }).toStrictEqual({
      answers: ["applied", "applied", "applied"],
      screen: "A",
      addresses: 3,
      checked: true,
    });
  });

  it("asks for a fresh start once React Fast Refresh can't go on", async () => {
    const { frame } = fakeFrame();
    const receive = previewReceiver({ ...frame, refresh: () => false });
    await expect(receive(await update(1, "render:one"))).resolves.toBe("reset");
  });
});
