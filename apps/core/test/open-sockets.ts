/**
 * The sockets a test opened to `/rpc`, closed once it ends
 * (start-each-file.ts): a connection left open keeps its session recheck
 * running into the tests after it, on whatever clock they fake, and
 * against a session a later file's empty storage no longer holds.
 *
 * With the requests a test sent through the router that core hasn't
 * answered, the D1 statements still running (d1-calls.ts) and the modules
 * still loading, they are what a test that timed out may have waited on,
 * which start-each-file.ts prints for it: a shard whose tests all timed
 * out, in three files that sign in and open `/rpc`, left nothing to say
 * where (November 2026).
 */
import { runnerOf } from "./background-calls.ts";

const open = new Map<WebSocket, number>();

/** The requests and D1 statements still unanswered, and when each was sent. */
const unanswered = new Map<symbol, { what: string; sent: number }>();

/** Forgets every request and statement still unanswered: none of them will be. */
export const forgetUnanswered = (): void => {
  unanswered.clear();
};

/** Has `socket` closed once the running test ends. */
export const closeWhenTestEnds = (socket: WebSocket): void => {
  open.set(socket, Date.now());
};

/** `answer`, the response to `what` (a request's method and path, say), counted as unanswered until it settles. */
export const untilAnswered = async <T>(
  what: string,
  answer: Promise<T>
): Promise<T> => {
  const id = Symbol(what);
  unanswered.set(id, { what, sent: Date.now() });
  try {
    return await answer;
  } finally {
    unanswered.delete(id);
  }
};

const readyStates = ["connecting", "open", "closing", "closed"] as const;

const secondsSince = (at: number, now: number): string =>
  `${Math.round((now - at) / 1000)}s`;

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

/**
 * The modules the test pool's module runner is still loading: those it is
 * still asking about (Vite's `concurrentModuleNodePromises`) and those
 * still evaluating (an `evaluatedModules` entry with a promise, not yet
 * evaluated). The runner keeps one promise per module for every later
 * import in the runtime, so a module whose first load never ends holds
 * every request that imports it after (start-each-file.ts). Read off
 * Vite's runner, which has no API for it: nothing when that changes.
 */
const loadingModules = (): string[] => {
  const runner = runnerOf();
  if (runner === undefined) {
    return [];
  }
  const loading = new Set<string>();
  const asking: unknown = Reflect.get(runner, "concurrentModuleNodePromises");
  if (asking instanceof Map) {
    for (const url of asking.keys()) {
      loading.add(String(url));
    }
  }
  const evaluated: unknown = Reflect.get(runner, "evaluatedModules");
  const byId: unknown = isObject(evaluated)
    ? Reflect.get(evaluated, "idToModuleMap")
    : undefined;
  if (byId instanceof Map) {
    for (const [id, module] of byId) {
      if (
        isObject(module) &&
        Reflect.get(module, "promise") !== undefined &&
        Reflect.get(module, "evaluated") === false
      ) {
        loading.add(String(id));
      }
    }
  }
  return [...loading];
};

/**
 * A line for each request still unanswered, each module still loading,
 * and each socket the running test opened that hasn't closed, its state
 * and its age.
 */
export const waitingOnNow = (now = Date.now()): string[] => [
  ...[...unanswered.values()].map(
    ({ what, sent }) =>
      `unanswered: ${what}, sent ${secondsSince(sent, now)} ago`
  ),
  ...loadingModules().map((module) => `module still loading: ${module}`),
  ...[...open]
    .filter(([socket]) => socket.readyState !== WebSocket.CLOSED)
    .map(
      ([socket, opened]) =>
        `socket: ${readyStates[socket.readyState] ?? socket.readyState}, opened ${secondsSince(opened, now)} ago`
    ),
];

/**
 * Ends the running test's share: closes every socket it opened and left
 * open, and forgets its requests still unanswered, so what the next test
 * is said to wait on is its own. A request a timed-out test left going
 * may never settle.
 */
export const endTest = (): void => {
  for (const socket of open.keys()) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }
  open.clear();
  forgetUnanswered();
};
