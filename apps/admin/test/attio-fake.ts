/**
 * A stand-in for Attio's REST API (`https://api.attio.com/v2`): only the key
 * it was made with gets in, it answers the companies, people and deals it
 * holds as Attio's record endpoints do, and its workspace members, and it
 * counts every request and every one not a GET, so a test can say the
 * admin only ever read.
 *
 * Any other request goes to the stand-in for `fetch` set up before it, as
 * test/rooms-fake.ts chains.
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

export const attioOrigin = "https://api.attio.com";

type AttioObject = "companies" | "people" | "deals";

/** A record's attribute values, by slug, as Attio answers them. */
export type FakeValues = Record<string, unknown[]>;

/** A workspace member, as Attio answers them. */
export interface FakeMember {
  id: string;
  firstName: string;
  lastName: string;
}

/** A meeting, as Attio answers them: when it started, who was in it, and the records it is linked to. */
export interface FakeMeeting {
  title: string;
  start: string;
  participants: string[];
  companyIds: string[];
}

/** A note on a company, as Attio answers them. */
export interface FakeNote {
  title: string;
  createdAt: string;
  companyId: string;
}

/** Each object the fake holds records of, by the name in its path. */
const objects: Record<string, AttioObject> = {
  companies: "companies",
  people: "people",
  deals: "deals",
};

/** What Attio answers for something it doesn't have. */
const notFound = () =>
  Response.json(
    { status_code: 404, type: "invalid_request_error", code: "not_found" },
    { status: 404 }
  );

export const fakeAttio = (key: string) => {
  const members: FakeMember[] = [];
  const paths: string[] = [];
  const meetings: FakeMeeting[] = [];
  const notes: FakeNote[] = [];
  const state = {
    records: {
      companies: new Map<string, FakeValues>(),
      people: new Map<string, FakeValues>(),
      deals: new Map<string, FakeValues>(),
    } satisfies Record<AttioObject, Map<string, FakeValues>>,
    /**
     * Records answered under another id than the one asked for, by the id
     * asked for: a broken or hostile answer.
     */
    swapped: new Map<string, string>(),
    members,
    meetings,
    notes,
    /** Whether the workspace has Attio's meetings to list; without, `/meetings` answers 404. */
    hasMeetings: true,
    requests: 0,
    /** Requests that would change something: anything not a GET, but the deals' one reading query. */
    writes: 0,
    /** Every path asked for. */
    paths,
  };
  const recordRoute =
    /^\/v2\/objects\/(?<object>companies|people|deals)\/records\/(?<id>[^/]+)$/u;

  /** A record as Attio answers one, under the id `swapped` gives it. */
  const recordOf = (object: AttioObject, id: string, values: FakeValues) => {
    const recordId = state.swapped.get(id) ?? id;
    return {
      id: {
        workspace_id: "workspace",
        object_id: object,
        record_id: recordId,
      },
      created_at: "2026-09-01T09:00:00.000Z",
      web_url: `https://app.attio.com/grasp/${object === "companies" ? "company" : object.slice(0, -1)}/${recordId}/overview`,
      values,
    };
  };

  const answer = (request: Request): Response => {
    state.requests += 1;
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    state.paths.push(pathname);
    const query =
      request.method === "POST" &&
      pathname === "/v2/objects/deals/records/query";
    if (request.method !== "GET" && !query) {
      state.writes += 1;
    }
    if (request.headers.get("authorization") !== `Bearer ${key}`) {
      return Response.json(
        { status_code: 401, type: "auth_error", code: "unauthorized" },
        { status: 401 }
      );
    }
    if (query) {
      return Response.json({
        data: [...state.records.deals].map(([id, values]) =>
          recordOf("deals", id, values)
        ),
      });
    }
    if (request.method !== "GET") {
      return Response.json(
        { status_code: 403, type: "auth_error", code: "missing_scope" },
        { status: 403 }
      );
    }
    if (pathname === "/v2/meetings") {
      if (!state.hasMeetings) {
        return notFound();
      }
      const companyId = searchParams.get("linked_record_id");
      return Response.json({
        data: state.meetings
          .filter(
            (meeting) =>
              searchParams.get("linked_object") === "companies" &&
              companyId !== null &&
              meeting.companyIds.includes(companyId)
          )
          .map((meeting) => ({
            id: { workspace_id: "workspace", meeting_id: crypto.randomUUID() },
            title: meeting.title,
            description: "",
            is_all_day: false,
            start: { datetime: meeting.start, timezone: "Europe/Amsterdam" },
            end: { datetime: meeting.start, timezone: "Europe/Amsterdam" },
            participants: meeting.participants.map((email, index) => ({
              email_address: email,
              is_organizer: index === 0,
              status: "accepted",
            })),
            linked_records: meeting.companyIds.map((id) => ({
              object_slug: "companies",
              object_id: "companies",
              record_id: id,
            })),
            created_at: meeting.start,
          })),
        pagination: { next_cursor: null },
      });
    }
    if (pathname === "/v2/notes") {
      const companyId = searchParams.get("parent_record_id");
      return Response.json({
        data: state.notes
          .filter(
            (note) =>
              searchParams.get("parent_object") === "companies" &&
              note.companyId === companyId
          )
          .map((note) => ({
            id: { workspace_id: "workspace", note_id: crypto.randomUUID() },
            parent_object: "companies",
            parent_record_id: note.companyId,
            title: note.title,
            content_plaintext: "",
            created_at: note.createdAt,
          })),
      });
    }
    if (pathname === "/v2/workspace_members") {
      return Response.json({
        data: state.members.map((member) => ({
          id: {
            workspace_id: "workspace",
            workspace_member_id: member.id,
          },
          first_name: member.firstName,
          last_name: member.lastName,
          email_address: `${member.firstName.toLowerCase()}@grasp.test`,
          access_level: "member",
        })),
      });
    }
    const match = recordRoute.exec(pathname)?.groups;
    const object = objects[match?.object ?? ""];
    const id = decodeURIComponent(match?.id ?? "");
    const values =
      object === undefined ? undefined : state.records[object].get(id);
    if (object === undefined || values === undefined) {
      return notFound();
    }
    return Response.json({ data: recordOf(object, id, values) });
  };

  beforeEach(() => {
    const earlier = vi.isMockFunction(globalThis.fetch)
      ? vi.mocked(globalThis.fetch).getMockImplementation()
      : undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith(`${attioOrigin}/`)) {
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
    for (const records of Object.values(state.records)) {
      records.clear();
    }
    state.swapped.clear();
    state.members.length = 0;
    state.meetings.length = 0;
    state.notes.length = 0;
    state.hasMeetings = true;
    state.requests = 0;
    state.writes = 0;
    state.paths.length = 0;
  });

  return state;
};

/** A value as Attio wraps each: when it became active, and its type. */
const active = (attributeType: string, value: Record<string, unknown>) => ({
  active_from: "2026-09-01T09:00:00.000Z",
  active_until: null,
  created_by_actor: { type: "workspace-member", id: "member" },
  attribute_type: attributeType,
  ...value,
});

/** Attio's values for its standard attributes, built as Attio sends them. */
export const attioValue = {
  text: (value: string) => active("text", { value }),
  domain: (domain: string) => active("domain", { domain, root_domain: domain }),
  option: (title: string) =>
    active("select", {
      option: {
        id: { option_id: crypto.randomUUID() },
        title,
        is_archived: false,
      },
    }),
  status: (title: string, since = "2026-09-01T09:00:00.000Z") =>
    active("status", {
      active_from: since,
      status: {
        id: { status_id: crypto.randomUUID() },
        title,
        is_archived: false,
      },
    }),
  personalName: (first: string, last: string) =>
    active("personal-name", {
      first_name: first,
      last_name: last,
      full_name: `${first} ${last}`,
    }),
  email: (address: string) =>
    active("email-address", {
      email_address: address,
      original_email_address: address,
      email_domain: address.split("@")[1],
    }),
  currency: (amount: number, code: string) =>
    active("currency", { currency_value: amount, currency_code: code }),
  member: (id: string) =>
    active("actor-reference", {
      referenced_actor_type: "workspace-member",
      referenced_actor_id: id,
    }),
  reference: (object: AttioObject, id: string) =>
    active("record-reference", {
      target_object: object,
      target_record_id: id,
    }),
};
