import {
  sandboxCallIdHeader,
  sandboxCpuHeader,
} from "../src/sandbox-headers.ts";

// The test's own sandbox host: it takes a session and stops its call as
// its supervisor would, keeping the verdict for core to ask
// (platform-stops.test.ts, packages.test.ts).

/** How the test's sandbox host stops each call: a verdict, or no place. */
export type Stop = { verdict: string } | "busy";

/** A sandbox host that stops every call as `stop` says. Counts its sessions. */
export const sandboxStopping = (stop: Stop) => {
  let sessions = 0;
  const verdicts = new Map<string, string>();
  const host: Fetcher = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/verdict/")) {
        const verdict = verdicts.get(pathname.slice("/verdict/".length));
        return await Promise.resolve(
          Response.json(
            verdict === undefined
              ? { verdict: null, state: "ending" }
              : { verdict, message: `Stopped (${verdict}).` }
          )
        );
      }
      if (pathname !== "/session") {
        return await Promise.resolve(new Response("{}"));
      }
      if (stop === "busy") {
        return await Promise.resolve(new Response("{}", { status: 429 }));
      }
      sessions += 1;
      const id = request.headers.get(sandboxCallIdHeader) ?? "";
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      // Its process stopped once the call arrived, as the supervisor would.
      server.addEventListener(
        "message",
        () => {
          verdicts.set(id, stop.verdict);
          server.close(1011, "The process was stopped.");
        },
        { once: true }
      );
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: {
          [sandboxCpuHeader]: request.headers.get(sandboxCpuHeader) ?? "",
        },
      });
    },
    connect: () => {
      throw new Error("Not a socket host");
    },
  };
  return { host, sessions: () => sessions };
};
