/**
 * A connector served through a real MCP server, live: a built-in of the
 * release by its name, or one made from the server's URL (GRA-1375).
 * Skipped unless the environment names one. It runs connect's whole path
 * against the server itself: discovery and dynamic registration, the
 * person's sign-in in a real browser, the token in connect's vault, a read
 * the rules allow, a write held and then confirmed, and the disconnect
 * that revokes the grant.
 *
 * The sign-in returns to `MCP_LIVE_CALLBACK`, a page on this machine that
 * takes the authorization URL this test posts to it (`POST /authorize`),
 * shows it to the person, keeps what the browser brings back to
 * `/api/connections/callback`, and gives it to this test (`GET /answer`).
 * Any small local server does; the person signs in there within twenty
 * minutes. Then, from the repo root:
 *
 *   MCP_LIVE_CONNECTOR=linear \
 *   MCP_LIVE_CALLBACK=http://localhost:8976 \
 *   MCP_LIVE_READ=list_issues MCP_LIVE_READ_INPUT='{"limit":3}' \
 *   MCP_LIVE_WRITE=save_comment \
 *   MCP_LIVE_WRITE_INPUT='{"issueId":"<a test issue>","body":"..."}' \
 *   vp test run --project @grasp-os/connect test/mcp-connectors.live.test.ts
 *
 * The write really happens once confirmed: point it at a test issue or
 * page, never a client's.
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callAs, someone } from "./connect.ts";
import {
  chatAgent,
  confirmHeld,
  generatedConnector,
} from "./mcp-connectors-harness.ts";

const live = z
  .object({
    /** A built-in's name, or the URL of a server to add. */
    MCP_LIVE_CONNECTOR: z.string().min(1),
    MCP_LIVE_CALLBACK: z.url(),
    MCP_LIVE_READ: z.string().min(1),
    MCP_LIVE_READ_INPUT: z.string().default("{}"),
    MCP_LIVE_WRITE: z.string().min(1),
    MCP_LIVE_WRITE_INPUT: z.string().min(1),
  })
  .safeParse(env);

const jsonInputSchema = z.record(z.string(), z.json());

/** How long the person has to sign in. */
const signInMs = 20 * 60 * 1000;

/** What the browser brought back to the callback, once it has. */
const answerSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  iss: z.string().min(1).optional(),
});

/** Shows the sign-in to the person and waits for what the browser brings back. */
const signIn = async (
  callback: string,
  url: string
): Promise<z.infer<typeof answerSchema>> => {
  await fetch(`${callback}/authorize`, { method: "POST", body: url });
  const ends = Date.now() + signInMs;
  while (Date.now() < ends) {
    // oxlint-disable-next-line no-await-in-loop -- waiting on the person
    await scheduler.wait(2000);
    // oxlint-disable-next-line no-await-in-loop -- waiting on the person
    const response = await fetch(`${callback}/answer`);
    // oxlint-disable-next-line no-await-in-loop -- waiting on the person
    const answer = answerSchema.safeParse(await response.json()).data;
    if (answer !== undefined) {
      return answer;
    }
  }
  throw new Error("Nobody signed in in time");
};

describe.runIf(live.success)(
  "a connector served through an MCP server, live",
  () => {
    const config = live.data;

    it(
      "signs in, reads, holds a write until it is confirmed, and revokes on disconnect",
      async () => {
        const callback = config?.MCP_LIVE_CALLBACK ?? "";
        const admin = someone("admin");
        const named = config?.MCP_LIVE_CONNECTOR ?? "";
        const added = URL.canParse(named)
          ? await exports.default.addConnector(
              generatedConnector(
                admin,
                {
                  name: "Live",
                  url: named,
                  auth: { kind: "oauth" },
                },
                callback
              )
            )
          : { id: named };
        const connector = added.id;
        const { url } = await exports.default.startConnection({
          person: admin,
          provider: connector,
          scope: "personal",
          origin: callback,
          returnTo: "/connectors",
        });
        const { connectionId } = await exports.default.finishConnection({
          person: admin,
          ...(await signIn(callback, url)),
        });
        const agent = chatAgent(admin);
        const readAction = config?.MCP_LIVE_READ ?? "";
        const read = await callAs(agent, {
          connectionId,
          action: readAction,
          input: jsonInputSchema.parse(
            JSON.parse(config?.MCP_LIVE_READ_INPUT ?? "{}")
          ),
        });
        const writeAction = config?.MCP_LIVE_WRITE ?? "";
        const held = await callAs(agent, {
          connectionId,
          action: writeAction,
          input: jsonInputSchema.parse(
            JSON.parse(config?.MCP_LIVE_WRITE_INPUT ?? "{}")
          ),
        });
        const confirmed = await confirmHeld(admin, agent, {
          connectionId,
          action: writeAction,
        });
        const [owner] = await exports.default.connectionOwners([connectionId]);
        const { revoked } = await exports.default.disconnect({
          person: admin,
          connectionId,
        });
        console.log(
          JSON.stringify(
            {
              classes: owner?.toolClasses,
              read: read.output.slice(0, 2000),
              confirmed: confirmed.output.slice(0, 2000),
              revoked,
            },
            null,
            2
          )
        );

        expect({
          readClass: owner?.toolClasses?.[readAction]?.startsWith("read-"),
          read: read.pending === undefined,
          held: held.pending === undefined ? "ran" : "held",
          revoked,
        }).toStrictEqual({
          readClass: true,
          read: true,
          held: "held",
          revoked: true,
        });
      },
      signInMs + 120_000
    );
  }
);
