/**
 * A stand-in for Attio's REST API (`https://api.attio.com/v2`): only the key
 * it was made with gets in, it answers the companies, people and deals it
 * holds as Attio's record endpoints do, and its workspace members, and it
 * counts every request and every one not a GET, so a test can say the
 * console only ever read.
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

/** Each object the fake holds records of, by the name in its path. */
const objects: Record<string, AttioObject> = {
  companies: "companies",
  people: "people",
  deals: "deals",
};

export const fakeAttio = (key: string) => {
  const members: FakeMember[] = [];
  const paths: string[] = [];
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
    requests: 0,
    writes: 0,
    /** Every path asked for. */
    paths,
  };
  const recordRoute =
    /^\/v2\/objects\/(?<object>companies|people|deals)\/records\/(?<id>[^/]+)$/u;

  const answer = (request: Request): Response => {
    state.requests += 1;
    const { pathname } = new URL(request.url);
    state.paths.push(pathname);
    if (request.method !== "GET") {
      state.writes += 1;
    }
    if (request.headers.get("authorization") !== `Bearer ${key}`) {
      return Response.json(
        { status_code: 401, type: "auth_error", code: "unauthorized" },
        { status: 401 }
      );
    }
    if (request.method !== "GET") {
      return Response.json(
        { status_code: 403, type: "auth_error", code: "missing_scope" },
        { status: 403 }
      );
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
      return Response.json(
        { status_code: 404, type: "invalid_request_error", code: "not_found" },
        { status: 404 }
      );
    }
    const recordId = state.swapped.get(id) ?? id;
    return Response.json({
      data: {
        id: {
          workspace_id: "workspace",
          object_id: object,
          record_id: recordId,
        },
        created_at: "2026-09-01T09:00:00.000Z",
        web_url: `https://app.attio.com/grasp/${object === "companies" ? "company" : object.slice(0, -1)}/${recordId}/overview`,
        values,
      },
    });
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
  status: (title: string) =>
    active("status", {
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
