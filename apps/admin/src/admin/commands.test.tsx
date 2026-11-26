// @vitest-environment happy-dom
import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { describe, expect, it } from "vite-plus/test";

import {
  act,
  answeredAdmin,
  gridRow,
  openAdmin,
  sectionReads,
  settle,
  until,
} from "../../test/app.tsx";
import { interviewingSnapshot, readySnapshot } from "../../test/snapshots.ts";

// A command that can't be undone is given only once staff confirm it: the
// gate's close button and a person's New start in their row's menu each
// ask first, give the command once on the confirm, and give nothing when
// staff cancel or press Escape.

/** What `data` holds under `key`, as the page sent it. */
const fieldOf = (data: object, key: string): unknown => Reflect.get(data, key);

const acme = gridRow({ id: "acme", name: "Acme" });

/** Acme's page at `path`, its core answering `snapshot`, every command applied. */
const openAcme = async (path: string, snapshot: AdminSnapshot) => {
  const admin = answeredAdmin({ client: acme, snapshot });
  const page = await openAdmin(path, {
    fetchClientGrid: [acme],
    fetchClientAdmins: [admin],
    fetchClientAdmin: admin,
    ...sectionReads,
    commandFn: () => ({ refused: null, issuedAt: new Date().toISOString() }),
  });
  /** The commands given to a company, as the page sent them. */
  const given = () =>
    page.calls
      .filter(({ fn }) => fn === "commandFn")
      .map(({ data }): { clientId: unknown; command: unknown } =>
        typeof data === "object" && data !== null
          ? {
              clientId: fieldOf(data, "clientId"),
              command: fieldOf(data, "command"),
            }
          : { clientId: undefined, command: undefined }
      );
  return { ...page, given };
};

/** The button whose name is `name`: its `aria-label`, or else its words. */
const buttonNamed = (root: Element | Document, name: string) =>
  [...root.querySelectorAll("button")].find(
    (button) =>
      (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name
  );

/** Presses `name`, waiting until it is there. */
const press = async (root: () => Element | Document, name: string) => {
  await until(() => buttonNamed(root(), name) !== undefined);
  await act(() => {
    buttonNamed(root(), name)?.click();
  });
  await settle();
};

/** The confirming dialog, while it is open. */
const dialog = () => document.querySelector('[role="alertdialog"]');

/** Presses Escape where focus is. */
const escape = async () => {
  await act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
  });
  await settle();
};

/** Acme with its Grasp open: closing it signs everyone else out. */
const opened = (): AdminSnapshot => {
  const ready = readySnapshot("Acme");
  return { ...ready, gate: { ...ready.gate, open: true } };
};

const close = {
  clientId: "acme",
  command: { type: "onboarding.gate.close", payload: {} },
};

describe("a command that can't be undone", () => {
  const atGate = "/organizations/acme/steps?stage=open";

  it("closes the company's Grasp once staff confirm it in its dialog", async () => {
    const page = await openAcme(atGate, opened());
    await press(() => page.container, "Close it for the onboarding");
    const asked = dialog()?.textContent ?? "";
    await press(() => dialog() ?? document, "Close it");
    await until(() => page.given().length > 0);

    expect({
      asked: asked.includes("Close the company’s Grasp?"),
      given: page.given(),
    }).toStrictEqual({ asked: true, given: [close] });
  });

  it("gives nothing when staff cancel the close, or press Escape", async () => {
    const page = await openAcme(atGate, opened());
    await press(() => page.container, "Close it for the onboarding");
    await press(() => dialog() ?? document, "Cancel");
    const cancelled = { open: dialog() !== null, given: page.given() };
    await press(() => page.container, "Close it for the onboarding");
    await escape();

    expect({
      cancelled,
      escaped: { open: dialog() !== null, given: page.given() },
    }).toStrictEqual({
      cancelled: { open: false, given: [] },
      escaped: { open: false, given: [] },
    });
  });

  const people = "/organizations/acme/interviews?tab=people";
  /** Ana, sent her link in the snapshot: one the menu can give a new start. */
  const sent = { id: "p-ana", name: "Ana Smit" };

  it("gives a person a new start from their row's menu once staff confirm it", async () => {
    const page = await openAcme(people, interviewingSnapshot());
    await press(() => page.container, `More for ${sent.name}`);
    await until(() =>
      [...document.querySelectorAll('[role="menuitem"]')].some(
        (item) => item.textContent?.trim() === "New start"
      )
    );
    await act(() => {
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.trim() === "New start")
        ?.click();
    });
    await settle();
    const asked = dialog()?.textContent ?? "";
    await press(() => dialog() ?? document, "Delete and start over");
    await until(() => page.given().length > 0);

    expect({
      asked: asked.includes(`Give ${sent.name} a new start?`),
      given: page.given(),
    }).toStrictEqual({
      asked: true,
      given: [
        {
          clientId: "acme",
          command: {
            type: "onboarding.new_start",
            payload: { person: sent.id },
          },
        },
      ],
    });
  });

  /** Opens Ana's row menu and picks New start, which asks first. */
  const askNewStart = async (page: { container: HTMLElement }) => {
    await press(() => page.container, `More for ${sent.name}`);
    await until(() =>
      [...document.querySelectorAll('[role="menuitem"]')].some(
        (item) => item.textContent?.trim() === "New start"
      )
    );
    await act(() => {
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.trim() === "New start")
        ?.click();
    });
    await settle();
  };

  it("gives no new start when staff cancel it, or press Escape, and focus goes back to the row's menu", async () => {
    const page = await openAcme(people, interviewingSnapshot());
    const trigger = () => buttonNamed(page.container, `More for ${sent.name}`);
    await askNewStart(page);
    const shown = dialog() !== null;
    await press(() => dialog() ?? document, "Cancel");
    const cancelled = {
      open: dialog() !== null,
      given: page.given(),
      focus: document.activeElement === trigger(),
    };
    await askNewStart(page);
    await escape();

    expect({
      shown,
      cancelled,
      escaped: {
        open: dialog() !== null,
        given: page.given(),
        focus: document.activeElement === trigger(),
      },
    }).toStrictEqual({
      shown: true,
      cancelled: { open: false, given: [], focus: true },
      escaped: { open: false, given: [], focus: true },
    });
  });
});
