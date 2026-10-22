import type { Page } from "@playwright/test";

type Message = string | Buffer;

/**
 * The messages that make a call, which Cap'n Web numbers in the order
 * they're sent on a connection, from 1: core answers each by its number.
 */
const makesCall = /^\["(?:push|stream)",/u;

/** The number of the call `message` resolves, if it's core's answer to one. */
const resolved = (message: Message): number | undefined => {
  const parsed: unknown = JSON.parse(String(message));
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const fields: unknown[] = parsed;
  const [kind, id] = fields;
  return kind === "resolve" && typeof id === "number" ? id : undefined;
};

/** A plain value as Cap'n Web writes it: an array wrapped in one more. */
const encoded = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return [items.map(encoded)];
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, encoded(each)])
    );
  }
  return value;
};

/**
 * Answers the page's calls that name a method (as Cap'n Web writes its
 * path, such as `["onboardingStaff","aiUse"]`) with `answers`' value for
 * it, in place of core's. The calls still reach core, which checks who
 * makes them; only a call core answered gets the seeded answer, so one
 * core refuses stays refused. For what the local stack can't come to
 * hold: interviews need a link only an email carries, and AI use a model
 * it can't reach.
 */
export const seededCalls = async (
  page: Page,
  answers: Record<string, unknown>
): Promise<void> => {
  await page.routeWebSocket("**/rpc", (socket) => {
    const server = socket.connectToServer();
    const seeded = new Map<number, unknown>();
    let calls = 0;
    socket.onMessage((message) => {
      const text = String(message);
      if (makesCall.test(text)) {
        calls += 1;
        const call = Object.keys(answers).find((each) => text.includes(each));
        if (call !== undefined) {
          seeded.set(calls, answers[call]);
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const id = resolved(message);
      if (id !== undefined && seeded.has(id)) {
        socket.send(JSON.stringify(["resolve", id, encoded(seeded.get(id))]));
        return;
      }
      socket.send(message);
    });
  });
};
