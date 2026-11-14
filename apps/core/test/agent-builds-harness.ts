import { readDefinition } from "@grasp-os/runtime/definition";
import type { AppDefinition } from "@grasp-os/runtime/definition";
import { appErrors } from "@grasp-os/shared/apps";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { readDraft } from "../src/drafts.ts";
import { chatOf, setObjectEnv, toolStep } from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
import { testApp } from "./app-definitions.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { createIdp } from "./fake-idp.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi } from "./sign-in.ts";

// What agent-builds*.test.ts share: the IdP, the Ledger App the agent
// builds, and the chat that builds it. Each file has the IdP answer for
// its own tests (`mockIdpWith`).

export const idp = createIdp();

/** 300 lines of constants, about 8,000 characters, as file `at` of a write has them. */
export const lines = (at: number): string =>
  Array.from(
    { length: 300 },
    (_, line) => `export const value${at}x${line} = ${line};`
  ).join("\n");

/** File `at` of a write of rates, as the agent might write it: unformatted, a `var`, a body that only returns. */
export const rates = (at: number): string =>
  `var rate${at} = ${at}\nexport const total${at} = (n: number) => { return n*rate${at} }\n`;

export const appName = "Invoice desk";

/** The Ledger's definition, which its first version got: empty, as it has pages alone. */
export const ledgerDefinition = testApp({ name: "Ledger" });

/** A page whose button is restyled, which the design system's class checks refuse. */
export const restyled = `import { Button } from "@grasp-os/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";

const Desk = () => (
  <main className="flex flex-col gap-4 p-6">
    <Button className="rounded-full">Approve</Button>
  </main>
);

export const Route = createFileRoute("/")({ component: Desk });
`;

/** The same page with the button's own variant: what the lint asks for. */
export const fixed = restyled.replace(
  '<Button className="rounded-full">',
  '<Button variant="outline">'
);

/** The page with a parenthesis left open: it doesn't compile. */
export const unclosed = fixed.replace(
  "const Desk = () => (",
  "const Desk = () => (("
);

/** A workflow a builder wrote in an App's files, as Apps once held them. */
export const intake = {
  "workflows/intake.ts": `import { v, workflow } from "@grasp-os/sdk/workflow";

export default workflow("intake", { params: {}, input: v.object({ invoice: v.string() }) }, async (step, { input }) => {
  return await step.do("read", { description: "Read the invoice" }, async () => input.invoice);
});
`,
};

/** Code that finds the App the agent builds, by its name, as `app`. */
export const findApp = `const [app] = (await env.apps.list()).filter(({ name }) => name === ${JSON.stringify(appName)});`;

/** What a code step returned, as JSON. */
export const returned = (text: string | undefined): unknown =>
  z.unknown().parse(JSON.parse(text?.replace("Returned:\n", "") ?? "null"));

/** Code that makes each call in turn: what it returned, or its message. */
export const tryEach = (calls: Record<string, string>, before = ""): string =>
  `export default async (self, env) => {
    ${before}
    const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
    const results = {};
    ${Object.entries(calls)
      .map(
        ([name, call]) =>
          `results[${JSON.stringify(name)}] = await tried(async () => ${call});`
      )
      .join("\n    ")}
    return results;
  };`;

/**
 * A chat of `role`'s person (a builder unless another is given) answered
 * by `replies`, with an App a builder released so the Apps collection is
 * there, and `grant`: a permission of the agent's own on it, which
 * building doesn't need but whose revocation ends what the agent does.
 */
export const setUp = async (
  /** The model's replies, or those it gives about the released App. */
  replies: ProviderReply[] | ((existing: string) => ProviderReply[]),
  role: "admin" | "builder" | "user" = "builder",
  /**
   * Whether the person has made the App the agent builds ({@link appName},
   * as Build it makes one: the agent creates none), which `findApp` finds.
   */
  made = false
) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const { id: existing } = await builder.api.apps.create({ name: "Ledger" });
  await release(builder, existing, { "AGENTS.md": "# Ledger\n" });
  const others = { admin, builder };
  const person = role === "user" ? await signedInApi(idp, role) : others[role];
  if (made) {
    await person.api.apps.create({ name: appName });
  }
  const chat = await chatOf(
    person.userId,
    ...(typeof replies === "function" ? replies(existing) : replies)
  );
  const grant = async () => {
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "collection", collectionId: "apps" },
      actions: ["read"],
      binding: "APP_LIBRARY",
    });
  };
  return { admin, builder, person, existing, chat, grant };
};

/**
 * The definition App `app`'s draft holds, as core keeps it beside the
 * draft's files: the one the definition tools change.
 */
export const draftDefinitionOf = async (
  app: string
): Promise<AppDefinition> => {
  const draft = await readDraft(env, { kind: "app", id: app });
  return readDefinition(JSON.parse(draft.definition ?? "null"));
};

/**
 * Runs `during` with the object's code runs limited to a second, and the
 * calls to core's files `slowed` picks (every read, unless told otherwise)
 * two seconds slow: a call let in at once outlives its run while it waits
 * on them. Set back however it ends.
 */
export const slowFilesDuring = async (
  stub: WorkspaceStub,
  during: () => Promise<void>,
  slowed: (method: string, key: unknown) => boolean = (method) =>
    method === "get"
): Promise<void> => {
  const { FILES: files } = env;
  const slow = new Proxy(files, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof property === "string" && typeof value === "function") {
        return async (...args: unknown[]): Promise<unknown> => {
          if (slowed(property, args[0])) {
            await scheduler.wait(2000);
          }
          return await Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "1000" });
  env.FILES = slow;
  try {
    await during();
  } finally {
    env.FILES = files;
    await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "" });
  }
};

/** A gate one read of core's files waits at (`gatedFilesDuring`). */
export interface FilesGate {
  /** Set once the read reached the gate. */
  reached: boolean;
  /** The read goes on once this is set. */
  released: boolean;
}

/**
 * Runs `during` with the first read of core's files whose key `gated`
 * picks held at `gate` until it is released; every other read goes
 * straight through. Plain flags, each side polling the other's: the read
 * runs in another request's context, where a promise this test resolves
 * would never settle. Set back however it ends.
 */
export const gatedFilesDuring = async (
  gated: (key: string) => boolean,
  gate: FilesGate,
  during: () => Promise<void>
): Promise<void> => {
  const { FILES: files } = env;
  const held = new Proxy(files, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property === "get" && typeof value === "function") {
        return async (...args: unknown[]): Promise<unknown> => {
          const [key] = args;
          if (!gate.reached && typeof key === "string" && gated(key)) {
            gate.reached = true;
            while (!gate.released) {
              // oxlint-disable-next-line no-await-in-loop -- polls the gate
              await scheduler.wait(20);
            }
          }
          return await Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  env.FILES = held;
  try {
    await during();
  } finally {
    gate.released = true;
    env.FILES = files;
  }
};

/** The methods of the chat's calls refused because their run had ended. */
export const endedRefusals = async (chatId: string): Promise<unknown[]> => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, detail }) =>
        action === "agent.call" &&
        detail.chat === chatId &&
        detail.reason === "agent.run_ended"
    )
    .map(({ detail }) => detail.method);
};

/** The App the agent created, as the person's session finds it. */
export const createdApp = async (
  api: Awaited<ReturnType<typeof signedInApi>>["api"]
) => {
  const listed = await api.apps.list();
  const app = listed.find(({ name }) => name === appName);
  if (app === undefined) {
    throw new Error("No App named as the one the agent builds");
  }
  return app;
};

/** Code that writes `changes` into the draft of `app`. */
export const writing = (changes: Record<string, string>): string =>
  `await env.build.write(app.id, ${JSON.stringify(changes)}, { revision: (await env.build.files(app.id)).revision })`;

/** A write or a create refused for the workflows it would add, naming them. */
export const noWorkflows = (issues: string[]) => ({
  message: appErrors.create("app.no_workflows").message,
  issues,
});

/** The model renames the Ledger in its AGENTS.md, with `editFile`. */
export const editing = (app: string) =>
  toolStep("editFile", {
    app,
    path: "AGENTS.md",
    oldText: "# Ledger",
    newText: "# Ledger desk",
  });
