/**
 * The sockets a test opened to `/rpc`, closed once it ends
 * (start-each-file.ts): a connection left open keeps its session recheck
 * running into the tests after it, on whatever clock they fake, and
 * against a session a later file's empty storage no longer holds.
 *
 * With the requests a test sent through the router that core hasn't
 * answered, they are what a test that timed out may have waited on, which
 * start-each-file.ts prints for it: a shard whose tests all timed out, in
 * three files that sign in and open `/rpc`, left nothing to say where
 * (November 2026).
 */
const open = new Map<WebSocket, number>();

/** The requests sent through the router still unanswered, and when each was sent. */
const unanswered = new Map<symbol, { what: string; sent: number }>();

/** Has `socket` closed once the running test ends. */
export const closeWhenTestEnds = (socket: WebSocket): void => {
  open.set(socket, Date.now());
};

/** `answer`, the response to `what` (its method and path), counted as unanswered until it settles. */
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

/**
 * A line for each request still unanswered and each socket the running
 * test opened that hasn't closed, its state and its age.
 */
export const waitingOnNow = (now = Date.now()): string[] => [
  ...[...unanswered.values()].map(
    ({ what, sent }) =>
      `unanswered: ${what}, sent ${secondsSince(sent, now)} ago`
  ),
  ...[...open]
    .filter(([socket]) => socket.readyState !== WebSocket.CLOSED)
    .map(
      ([socket, opened]) =>
        `socket: ${readyStates[socket.readyState] ?? socket.readyState}, opened ${secondsSince(opened, now)} ago`
    ),
];

/** Closes every socket the test opened and left open. */
export const closeOpenSockets = (): void => {
  for (const socket of open.keys()) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }
  open.clear();
};
