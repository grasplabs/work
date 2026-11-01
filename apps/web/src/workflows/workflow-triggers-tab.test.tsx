// @vitest-environment happy-dom
import type { ListedConnection } from "@grasp-os/shared/connect";
import type { WorkflowTrigger } from "@grasp-os/shared/workflow-triggers";
import { Tabs } from "@grasp-os/ui/components/tabs";
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
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { TriggersTabContent } from "./workflow-triggers-tab.tsx";

// A workflow's Triggers tab, against core's workflowResources.triggers as
// the page reaches them over RPC, faked: a stopped schedule says so, and
// its owner turns it on again; a builder turns another's trigger off and
// deletes it only once they confirm; a builder adds a schedule, and a
// connection's event, with exactly the configuration typed, for the
// version picked; anyone else is offered nothing to change.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Lets every reply already on its way arrive. */
const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await Promise.resolve();
  }
};

const base = {
  version: 1,
  workflowId: "workflow-1",
  workflowVersion: 1,
  createdAt: "2026-10-30T09:00:00.000Z",
};

const stoppedSchedule: WorkflowTrigger = {
  ...base,
  id: "trigger-stopped",
  kind: "schedule",
  owner: "me",
  principal: "me",
  enabled: true,
  config: {
    schedule: { cron: "0 9 * * 1-5", timeZone: "Europe/Berlin" },
    input: {},
    missedOccurrences: "coalesce",
  },
  nextAt: null,
  stopped: true,
};

const othersMail: WorkflowTrigger = {
  ...base,
  id: "trigger-mail",
  kind: "connector",
  owner: "someone-else",
  principal: "someone-else",
  enabled: true,
  config: {
    connection: { connectionId: "connection-ms" },
    event: "m365.mail.received",
    input: { fields: {}, defaults: {} },
  },
  nextAt: null,
  stopped: false,
};

const connection = (
  id: string,
  provider: string,
  accountName: string
): ListedConnection => ({
  id,
  source: "native",
  provider,
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "admin",
  connectedByName: "Admin",
  accountName,
  createdAt: "2026-10-01T09:00:00.000Z",
});

/**
 * The tab for `me` (a builder when `builder`), with Connect down when
 * `connectFails`: what core was asked to do.
 */
const shown = async (
  builder: boolean,
  connectFails = false
): Promise<unknown[]> => {
  const asked: unknown[] = [];
  const triggers = {
    list: async () => await Promise.resolve([stoppedSchedule, othersMail]),
    create: async (input: unknown) => {
      await Promise.resolve();
      asked.push({ create: input });
      return stoppedSchedule;
    },
    setEnabled: async (id: string, enabled: boolean) => {
      await Promise.resolve();
      asked.push({ setEnabled: id, enabled });
      return stoppedSchedule;
    },
    setVersion: async (id: string, version: number) => {
      await Promise.resolve();
      asked.push({ setVersion: id, version });
      return stoppedSchedule;
    },
    delete: async (id: string) => {
      await Promise.resolve();
      asked.push({ delete: id });
    },
  };
  const workflowResources = {
    triggers,
    versions: async () =>
      await Promise.resolve([{ version: 1 }, { version: 2 }]),
  };
  const connections = {
    list: async (): Promise<ListedConnection[]> => {
      await Promise.resolve();
      if (connectFails) {
        throw new Error("Connect isn't answering.");
      }
      return [
        connection("connection-ms", "microsoft", "invoices@acme.test"),
        connection("connection-google", "google", "drive@acme.test"),
      ];
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        workflowResources: typeof workflowResources;
        connections: typeof connections;
      }) => Promise<T>
    ): Promise<T> => await action({ workflowResources, connections }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <Tabs value="triggers">
        <TriggersTabContent builder={builder} me="me" workflow="workflow-1" />
      </Tabs>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
    context: { core },
  });
  await act(async () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
    await settled();
  });
  return asked;
};

/** The buttons whose text is `text`. */
const buttons = (text: string): HTMLButtonElement[] =>
  [...document.querySelectorAll("button")].filter(
    (each) => each.textContent.trim() === text
  );

/** Presses the `index`th button whose text is `text`, and lets it settle. */
const press = async (text: string, index = 0): Promise<void> => {
  await act(async () => {
    buttons(text)[index]?.click();
    await settled();
  });
};

/** The field labelled `label`. */
const field = (
  label: string
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null => {
  const labelled = [...document.querySelectorAll("label")].find(
    (each) => each.textContent.trim() === label
  );
  return labelled === undefined
    ? null
    : document.querySelector(`#${CSS.escape(labelled.htmlFor)}`);
};

/** Sets the field labelled `label` to `value`, as React hears a person do it. */
const fill = async (label: string, value: string): Promise<void> => {
  await act(async () => {
    const found = field(label);
    if (found !== null) {
      const prototype = Reflect.getPrototypeOf(found) ?? {};
      Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
        found,
        value
      );
      found.dispatchEvent(
        new Event(found instanceof HTMLSelectElement ? "change" : "input", {
          bubbles: true,
        })
      );
    }
    await settled();
  });
};

/** Submits the Add a trigger form. */
const submit = async (): Promise<void> => {
  await act(async () => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settled();
  });
};

describe("a workflow's Triggers tab", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says a schedule stopped, and lets its owner turn it on again", async () => {
    const asked = await shown(true);
    const says = document.body.textContent;
    await press("Turn on again");

    expect({
      stopped: says.includes("Stopped"),
      why: says.includes("Its runs kept failing to start"),
      asked,
    }).toStrictEqual({
      stopped: true,
      why: true,
      asked: [{ setEnabled: "trigger-stopped", enabled: true }],
    });
  });

  it("lets a builder turn another's trigger off, and delete it only once they confirm", async () => {
    const asked = await shown(true);
    // The other's trigger is the only one on and running.
    await press("Turn off");
    // The second trigger's Delete, then the dialog's.
    await press("Delete", 1);
    const beforeConfirming = asked.length;
    await press("Delete the trigger");

    expect({ beforeConfirming, asked }).toStrictEqual({
      beforeConfirming: 1,
      asked: [
        { setEnabled: "trigger-mail", enabled: false },
        { delete: "trigger-mail" },
      ],
    });
  });

  it("adds a schedule with exactly what the builder typed, for the version picked", async () => {
    const asked = await shown(true);
    await fill("Version it starts", "1");
    await fill("When, as a cron expression", "30 7 * * *");
    await fill("Time zone", "Europe/Amsterdam");
    await fill(
      "The input each run starts with, as JSON",
      '{"report": "daily"}'
    );
    await submit();

    expect(asked).toStrictEqual([
      {
        create: {
          kind: "schedule",
          workflowId: "workflow-1",
          version: 1,
          config: {
            schedule: { cron: "30 7 * * *", timeZone: "Europe/Amsterdam" },
            input: { report: "daily" },
            missedOccurrences: "coalesce",
          },
        },
      },
    ]);
  });

  it("adds a connection's event, offering only the connections that report it", async () => {
    const asked = await shown(true);
    await fill("What starts it", "connector");
    await fill("Event", "google.mail.received");
    const offered = [...(field("Connection")?.querySelectorAll("option") ?? [])]
      .map(({ value }) => value)
      .filter((value) => value !== "");
    await fill("Connection", "connection-google");
    await fill(
      "The run's input fields, each from the event as a JSON Pointer, as JSON",
      '{"subject": "/payload/subject"}'
    );
    await submit();

    expect({ offered, asked }).toStrictEqual({
      offered: ["connection-google"],
      asked: [
        {
          create: {
            kind: "connector",
            workflowId: "workflow-1",
            // The latest, as nothing else was picked.
            version: 2,
            config: {
              connection: { connectionId: "connection-google" },
              event: "google.mail.received",
              input: { fields: { subject: "/payload/subject" }, defaults: {} },
            },
          },
        },
      ],
    });
  });

  it("offers someone who doesn't build the workflow nothing to add, nor to change on another's trigger", async () => {
    await shown(false);

    expect({
      add: buttons("Add the trigger").length,
      turnOff: buttons("Turn off").length,
      // Their own stopped schedule they may still delete, but not turn on:
      // core runs it only for someone who builds the workflow.
      turnOnAgain: buttons("Turn on again").length,
      deletes: buttons("Delete").length,
    }).toStrictEqual({ add: 0, turnOff: 0, turnOnAgain: 0, deletes: 1 });
  });

  it("keeps what the builder typed to add while they change another trigger", async () => {
    const asked = await shown(true);
    await fill("When, as a cron expression", "30 7 * * *");
    await press("Turn off");

    expect({
      asked,
      cron: field("When, as a cron expression")?.value,
    }).toStrictEqual({
      asked: [{ setEnabled: "trigger-mail", enabled: false }],
      cron: "30 7 * * *",
    });
  });

  it("still shows the triggers when Connect can't name the accounts, by connection id", async () => {
    await shown(true, true);
    const says = document.body.textContent;

    expect({
      schedule: says.includes("0 9 * * 1-5"),
      mail: says.includes("connection-ms"),
      why: says.includes("Connect isn't answering."),
      turnOff: buttons("Turn off").length,
    }).toStrictEqual({ schedule: true, mail: true, why: true, turnOff: 1 });
  });
});
