/**
 * The sockets a test opened to `/rpc`, closed once it ends
 * (start-each-file.ts): a connection left open keeps its session recheck
 * running into the tests after it, on whatever clock they fake, and
 * against a session a later file's empty storage no longer holds.
 */
const open = new Set<WebSocket>();

/** Has `socket` closed once the running test ends. */
export const closeWhenTestEnds = (socket: WebSocket): void => {
  open.add(socket);
};

/** Closes every socket the test opened and left open. */
export const closeOpenSockets = (): void => {
  for (const socket of open) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  }
  open.clear();
};
