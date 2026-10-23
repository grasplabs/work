/**
 * A stand-in for Grasp's Rooms' read-only service route
 * (grasplabs/rooms, worker/service-read.ts) at the tests' `ROOMS_ORIGIN`:
 * only the token it was made with gets in, it answers each room it holds
 * as Rooms does, and it counts every request and every one not a GET, so a
 * test can say the admin only ever read.
 *
 * Any other request goes to the stand-in for `fetch` set up before it, as
 * test/stripe-mcp.ts chains.
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

export const roomsOrigin = "https://rooms.grasp.test";

/** A room and its signature requests, as Rooms answers them. */
export interface FakeRoom {
  project: Record<string, unknown>;
  signing: { available: boolean; checkedAt: number; requests: unknown[] };
}

export const fakeRooms = (token: string) => {
  const state = {
    rooms: new Map<string, FakeRoom>(),
    requests: 0,
    writes: 0,
  };
  const route = /^\/api\/service\/projects\/(?<id>[^/]+)$/u;

  const answer = (request: Request): Response => {
    state.requests += 1;
    if (request.method !== "GET") {
      state.writes += 1;
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    if (request.headers.get("authorization") !== `Bearer ${token}`) {
      return Response.json(
        { error: "Service access required." },
        { status: 401 }
      );
    }
    const id = route.exec(new URL(request.url).pathname)?.groups?.id ?? "";
    const room = state.rooms.get(id);
    return room === undefined
      ? Response.json({ error: "Project not found." }, { status: 404 })
      : Response.json(room);
  };

  beforeEach(() => {
    const earlier = vi.isMockFunction(globalThis.fetch)
      ? vi.mocked(globalThis.fetch).getMockImplementation()
      : undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith(`${roomsOrigin}/`)) {
        return answer(request);
      }
      if (earlier === undefined) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      return await earlier(input, init);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    state.rooms.clear();
    state.requests = 0;
    state.writes = 0;
  });

  return state;
};
