// @vitest-environment happy-dom
import type { ListedConnection } from "@grasp-os/shared/connect";
import type { HttpConnectionInput } from "@grasp-os/shared/http-connections";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useLoaderData,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { HttpConnections } from "./http-connections.tsx";

// The Integrations page's HTTP connections (http-connections.tsx), against
// core's `connections` as the page reaches it, faked: only an admin who
// isn't Grasp staff is offered the form and Revoke; what they type is
// exactly what core is asked to approve; the credential is never shown
// back, nor kept in the form; revoking asks first. Core and connect decide
// all of it again (connect's http-connections.test.ts).

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const takenDown = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

const credential = "sk_live_typed-once";

const billing: ListedConnection = {
  id: "connection-billing",
  source: "http",
  provider: "http",
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "admin",
  connectedByName: "Admin",
  accountName: null,
  createdAt: "2026-11-01T09:00:00.000Z",
  http: {
    name: "Billing API",
    origin: "https://billing.example.com",
    pathPrefixes: ["/v1/invoices"],
    methods: ["GET", "POST"],
    credentialHeader: "x-api-key",
  },
};

const identityOf = (role: Role, staff = false): Identity => ({
  userId: "me",
  email: "me@acme.test",
  name: "Me",
  role,
  teams: [],
  staff,
  expiresAt: "2026-11-04T09:00:00.000Z",
});

/** Lets every reply already on its way arrive, and the page read again. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** Lets a held add get core's answer (see `shown`). */
let answerAdd = (): void => undefined;

/** Why core refuses every change, when it does. */
const refusal = "Connect isn't answering.";

/**
 * The list for `viewer`, as core lists `listed` (undefined: not read),
 * read again after each change, with every change refused when `fails`,
 * and each add answered only once `answer` is called when `held`: what
 * core was asked to do.
 */
const shown = async (
  viewer: Identity,
  listed?: ListedConnection[],
  { fails = false, held = false } = {}
) => {
  const asked: unknown[] = [];
  const gate = Promise.withResolvers<boolean>();
  if (!held) {
    gate.resolve(true);
  }
  answerAdd = () => {
    gate.resolve(true);
  };
  const connections = {
    createHttp: async (input: HttpConnectionInput) => {
      asked.push({ createHttp: input });
      await gate.promise;
      if (fails) {
        throw new Error(refusal);
      }
      return { connectionId: "connection-new" };
    },
    disconnect: async (id: string) => {
      await Promise.resolve();
      asked.push({ disconnect: id });
      if (fails) {
        throw new Error(refusal);
      }
      return { revoked: true };
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { connections: typeof connections }) => Promise<T>
    ): Promise<T> => await action({ connections }),
  };
  const Page = () => {
    const read: ListedConnection[] | null = useLoaderData({ strict: false });
    return (
      <HttpConnections
        connections={read ?? undefined}
        identity={viewer}
        search={undefined}
      />
    );
  };
  const router = createRouter({
    routeTree: createRootRoute({
      loader: () => listed ?? null,
      component: Page,
    }),
    history: createMemoryHistory(),
    context: { core },
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
  return asked;
};

/** The names of the buttons on the page, dialogs included. */
const buttons = (): string[] =>
  [...document.querySelectorAll("button")].map((each) =>
    each.textContent.trim()
  );

const press = async (name: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent.trim() === name
  );
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
  await settled();
};

/** The field labelled `label`. */
const field = (
  label: string
): HTMLInputElement | HTMLTextAreaElement | null => {
  const labelled = [...document.querySelectorAll("label")].find(
    (each) => each.textContent.trim() === label
  );
  return labelled === undefined || labelled.htmlFor === ""
    ? null
    : document.querySelector(`#${CSS.escape(labelled.htmlFor)}`);
};

/** Types `value` into the field labelled `label`, as React hears a person type. */
const fill = async (label: string, value: string): Promise<void> => {
  await act(async () => {
    const found = field(label);
    if (found !== null) {
      const prototype = Reflect.getPrototypeOf(found) ?? {};
      Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
        found,
        value
      );
      found.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await Promise.resolve();
  });
};

describe(HttpConnections, () => {
  afterEach(takenDown);

  it("offers the form and Revoke to admins only, never to Grasp staff", async () => {
    const seen: Record<string, string[]> = {};
    for (const [who, viewer] of [
      ["admin", identityOf("admin")],
      ["staff", identityOf("admin", true)],
      ["builder", identityOf("builder")],
      ["user", identityOf("user")],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await shown(viewer, [billing]);
      seen[who] = buttons();
      takenDown();
    }

    expect(seen).toStrictEqual({
      admin: ["Add HTTP connection", "Revoke"],
      staff: [],
      builder: [],
      user: [],
    });
  });

  it("lists a connection's origin and scope, and the credential's header, never the credential", async () => {
    await shown(identityOf("user"), [billing]);
    const says = document.body.textContent;

    expect({
      name: says.includes("Billing API"),
      origin: says.includes("https://billing.example.com"),
      paths: says.includes("/v1/invoices"),
      methods: says.includes("GET, POST") || says.includes("GET and POST"),
      header: says.includes("x-api-key"),
    }).toStrictEqual({
      name: true,
      origin: true,
      paths: true,
      methods: true,
      header: true,
    });
  });

  it("shows someone who isn't an admin nothing while there are none", async () => {
    await shown(identityOf("builder"), []);

    expect(document.body.textContent).not.toContain("HTTP connections");
  });

  it("asks core to approve exactly what the admin typed, and forgets the credential", async () => {
    const asked = await shown(identityOf("admin"), []);
    await press("Add HTTP connection");
    await fill("Name", "Billing API");
    await fill("Origin", "https://billing.example.com");
    await fill(
      "Path prefixes it allows, one per line",
      "/v1/invoices\n/v1/customers"
    );
    await fill("Header name", "X-Api-Key");
    await fill("Secret", credential);
    await press("Add the connection");
    // Opened again: nothing of the last one is left in it.
    await press("Add HTTP connection");

    expect({
      asked,
      secretLeft: field("Secret")?.value,
      shown: document.body.textContent.includes(credential),
    }).toStrictEqual({
      asked: [
        {
          createHttp: {
            name: "Billing API",
            origin: "https://billing.example.com",
            methods: ["GET"],
            pathPrefixes: ["/v1/invoices", "/v1/customers"],
            credential: {
              kind: "header",
              header: "X-Api-Key",
              secret: credential,
            },
          },
        },
      ],
      secretLeft: "",
      shown: false,
    });
  });

  it("says which field is wrong, and asks core nothing, for an origin that isn't one", async () => {
    const asked = await shown(identityOf("admin"), []);
    await press("Add HTTP connection");
    await fill("Name", "Billing API");
    await fill("Origin", "http://10.0.0.1/api");
    await fill("Secret", credential);
    await press("Add the connection");

    expect({
      asked,
      said: document.body.textContent.includes("The origin is https://"),
    }).toStrictEqual({ asked: [], said: true });
  });

  it("refuses a credential shorter than connect takes, saying how long it must be, and asks core nothing", async () => {
    const asked = await shown(identityOf("admin"), []);
    await press("Add HTTP connection");
    await fill("Name", "Billing API");
    await fill("Origin", "https://billing.example.com");
    // One short of the 16 characters connect takes.
    await fill("Secret", "sk_live_shortxx");
    await press("Add the connection");

    expect({
      asked,
      said: document.body.textContent.includes(
        "a secret of at least 16 plain ASCII characters"
      ),
    }).toStrictEqual({ asked: [], said: true });
  });

  it("revokes a connection only once the admin confirms", async () => {
    const asked = await shown(identityOf("admin"), [billing]);
    await press("Revoke");
    const beforeConfirming = asked.length;
    await press("Revoke the connection");

    expect({
      beforeConfirming,
      asked,
      // Closed as confirmed: nothing left to press a second time.
      stillAsking: buttons().includes("Revoke the connection"),
    }).toStrictEqual({
      beforeConfirming: 0,
      asked: [{ disconnect: "connection-billing" }],
      stillAsking: false,
    });
  });

  it("closes the confirmation and says why when the revoke fails", async () => {
    await shown(identityOf("admin"), [billing], { fails: true });
    await press("Revoke");
    await press("Revoke the connection");

    expect({
      stillAsking: buttons().includes("Revoke the connection"),
      said: document.body.textContent.includes(refusal),
    }).toStrictEqual({ stillAsking: false, said: true });
  });

  it("names each Revoke apart, by when it was added, when two connections share a name", async () => {
    // Changing a credential: the new connection is added beside the old.
    await shown(identityOf("admin"), [
      billing,
      {
        ...billing,
        id: "connection-billing-new",
        createdAt: "2026-11-03T15:30:00.000Z",
      },
    ]);
    const names = [...document.querySelectorAll("button")]
      .filter((button) => button.textContent.trim() === "Revoke")
      .map((button) => button.getAttribute("aria-label"));

    expect({
      count: names.length,
      distinct: new Set(names).size,
      named: names.every(
        (name) => name?.startsWith("Revoke Billing API, added") === true
      ),
    }).toStrictEqual({ count: 2, distinct: 2, named: true });
  });

  it("keeps the form open when an add the admin cancelled ends after they opened it again", async () => {
    const asked = await shown(identityOf("admin"), [], { held: true });
    await press("Add HTTP connection");
    await fill("Name", "Billing API");
    await fill("Origin", "https://billing.example.com");
    await fill("Secret", credential);
    await press("Add the connection");
    await press("Cancel");
    await press("Add HTTP connection");
    await fill("Name", "Ledger API");
    // Core answers the first add only now, while the second form is open.
    answerAdd();
    await settled();

    expect({
      added: asked.length,
      stillOpen: field("Name")?.value,
    }).toStrictEqual({ added: 1, stillOpen: "Ledger API" });
  });

  it("closes the form once its own add went through", async () => {
    await shown(identityOf("admin"), [], { held: true });
    await press("Add HTTP connection");
    await fill("Name", "Billing API");
    await fill("Origin", "https://billing.example.com");
    await fill("Secret", credential);
    await press("Add the connection");
    const whileAdding = field("Name")?.value;
    answerAdd();
    await settled();

    expect({ whileAdding, afterwards: field("Name") }).toStrictEqual({
      whileAdding: "Billing API",
      afterwards: null,
    });
  });

  it("forgets the credential and a failed add once the admin cancels", async () => {
    await shown(identityOf("admin"), [], { fails: true });
    await press("Add HTTP connection");
    await fill("Name", "Billing API");
    await fill("Origin", "https://billing.example.com");
    await fill("Secret", credential);
    await press("Add the connection");
    const failed = document.body.textContent.includes(refusal);
    await press("Cancel");
    await press("Add HTTP connection");

    expect({
      failed,
      secretLeft: field("Secret")?.value,
      failureLeft: document.body.textContent.includes(refusal),
    }).toStrictEqual({ failed: true, secretLeft: "", failureLeft: false });
  });

  it("counts the connections only once they are read", async () => {
    await shown(identityOf("admin"));
    const whileUnread =
      document.querySelector("#integrations-http")?.textContent;
    takenDown();
    await shown(identityOf("admin"), [billing]);

    expect({
      whileUnread,
      read: document.querySelector("#integrations-http")?.textContent,
    }).toStrictEqual({
      whileUnread: "HTTP connections",
      read: "HTTP connections1",
    });
  });
});
