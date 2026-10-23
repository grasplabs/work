import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { consentCode, documentsControlUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";
import { testBinding } from "./test-env.ts";
import { wordFile } from "./word-file.ts";

// Documents picked where they live (GRA-370), in core: the admin connects
// SharePoint and OneDrive from the onboarding's documents step and comes
// back to it, browses a place, and picks a file, which core fetches
// through connect and reads as it reads a dropped one. Graph, SharePoint
// and the model gateway are fakes. The ways it could go wrong come first:
// a picked file read otherwise than a dropped one, someone other than the
// client's admin browsing or fetching the client's files, a fetch without
// a trace. Connect's own threat model (a token that writes or reads mail,
// a file of another drive, planted names, a flood) is tried in connect's
// test/document-places.test.ts.

const idp = mockIdp();

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** What the admin's OneDrive holds at its top, from now on. */
const oneDriveHolds = async (
  files: { id: string; name: string; bytes: Uint8Array }[]
): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  await providers.fetch(documentsControlUrl, {
    method: "POST",
    body: JSON.stringify({
      files: files.map(({ id, name, bytes }) => ({
        id,
        name,
        base64: btoa(String.fromCodePoint(...bytes)),
      })),
    }),
  });
};

/** A 2019 draft of how claims are handled. */
const draft = wordFile([
  "DRAFT – Claims procedure, March 2019",
  "Claims come in by email and are typed into ClaimsPro by the Ops team.",
  "A claim above 5,000 euros goes to a manager for approval.",
]);

/** What the model answers about `draft`. */
const reading = {
  about: "How claims are handled, from the email they come in by to approval.",
  tools: ["ClaimsPro"],
  teams: ["Ops"],
  unclear: ["How long a claim waits for a manager."],
  question: "Is this 2019 draft still how claims go today?",
  options: ["Yes, still current", "No, it changed"],
};

const answer: GatewayReply = {
  text: JSON.stringify(reading),
  inputTokens: 1200,
  outputTokens: 150,
};

/** What `run` returns while the gateway answers with `replies`, and what it was sent. */
const answering = async <T>(replies: GatewayReply[], run: () => Promise<T>) => {
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  try {
    return { requests: fake.requests, result: await run() };
  } finally {
    spy.mockRestore();
  }
};

/** Where the documents step sends the browser back to. */
const documentsStep = "/setup?step=documents";

/**
 * An admin who connected SharePoint and OneDrive from the documents step:
 * their API, and where the browser came back to.
 */
const connected = async () => {
  const admin = await signedInApi(idp, "admin");
  const { url } = await admin.api.onboarding.connectDocumentPlaces(
    "microsoft",
    documentsStep
  );
  const authorization = new URL(url);
  const response = await routed(
    `/api/connections/callback?${new URLSearchParams({
      code: consentCode(
        authorization,
        acmeTenant,
        `documents-${crypto.randomUUID()}`
      ),
      state: authorization.searchParams.get("state") ?? "",
    }).toString()}`,
    { headers: { cookie: admin.session } }
  );
  return {
    admin,
    authorization,
    back: new URL(response.headers.get("location") ?? ""),
  };
};

const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

const top = { place: "me", folder: null, query: null, cursor: null };

describe("documents picked where they live", { timeout: 60_000 }, () => {
  it("are connected by the client's admin from the documents step, which the browser comes back to, and browsed by them alone", async () => {
    const before = await signedInApi(idp, "admin");
    const unconnected = {
      places: await before.api.onboarding.documentPlaces(),
      list: await outcome(before.api.onboarding.listDocumentPlaces()),
    };
    const id = `item-${crypto.randomUUID()}`;
    await oneDriveHolds([{ id, name: "Claims procedure.docx", bytes: draft }]);
    const { admin, authorization, back } = await connected();
    const member = await signedInApi(idp, "user");
    const staff = await asStaff();
    const { items } = await admin.api.onboarding.placeItems(top);
    expect({
      unconnected,
      client: authorization.searchParams.get("client_id"),
      scopes: authorization.searchParams.get("scope"),
      back: `${back.pathname}?step=${back.searchParams.get("step") ?? ""}`,
      connection: back.searchParams.has("connection"),
      connected: await admin.api.onboarding.documentPlaces(),
      places: await admin.api.onboarding.listDocumentPlaces(),
      items,
      memberPlaces: await outcome(member.api.onboarding.documentPlaces()),
      memberItems: await outcome(member.api.onboarding.placeItems(top)),
      memberConnect: await outcome(
        member.api.onboarding.connectDocumentPlaces("microsoft", documentsStep)
      ),
      staffList: await outcome(staff.onboarding.listDocumentPlaces()),
      staffItems: await outcome(staff.onboarding.placeItems(top)),
      staffConnect: await outcome(
        staff.onboarding.connectDocumentPlaces("microsoft", documentsStep)
      ),
      elsewhere: await outcome(
        admin.api.onboarding.connectDocumentPlaces(
          "microsoft",
          "//evil.test/setup"
        )
      ),
      otherSuite: await outcome(
        admin.api.onboarding.connectDocumentPlaces(
          // @ts-expect-error -- a suite there are no places of
          "dropbox",
          documentsStep
        )
      ),
    }).toStrictEqual({
      unconnected: { places: null, list: "place.not_connected" },
      client: "grasp-documents-entra",
      scopes:
        "openid profile email offline_access User.Read Files.Read.All Sites.Read.All",
      back: documentsStep,
      connection: true,
      connected: { suite: "microsoft", status: "active" },
      places: [{ id: "me", name: "OneDrive", kind: "onedrive" }],
      items: [
        {
          id,
          name: "Claims procedure.docx",
          kind: "file",
          size: draft.byteLength,
          modifiedAt: "2026-10-01T09:00:00Z",
        },
      ],
      memberPlaces: "role.forbidden",
      memberItems: "role.forbidden",
      memberConnect: "role.forbidden",
      staffList: "role.forbidden",
      staffItems: "role.forbidden",
      staffConnect: "role.forbidden",
      elsewhere: "connection.invalid",
      otherSuite: "place.invalid",
    });
  });

  it("are read with the same result as the same file dropped, each fetched on the record", async () => {
    const name = `claims-${crypto.randomUUID()}.docx`;
    const id = `item-${crypto.randomUUID()}`;
    await oneDriveHolds([{ id, name, bytes: draft }]);
    const { admin } = await connected();
    const dropped = await answering(
      [answer],
      async () =>
        await admin.api.onboarding.shareDocument({
          locale: "en",
          name,
          bytes: draft,
        })
    );
    let picked: Awaited<typeof dropped> | undefined;
    const events = await auditedDuring(async () => {
      picked = await answering(
        [answer],
        async () =>
          await admin.api.onboarding.sharePlaceFile({
            locale: "en",
            place: "me",
            item: id,
          })
      );
    });
    const staff = await asStaff();
    const documents = await admin.api.onboarding.documents();
    expect({
      reading: picked?.result.reading,
      name: picked?.result.name,
      sent: picked?.requests.map(({ body }) => body),
      kept: documents.filter((each) => each.name === name).length,
      recorded: events
        .filter(({ action }) => action === "onboarding.document_fetched")
        .map(({ target, detail }) => ({ target: target?.type, detail })),
      staff: await outcome(
        staff.onboarding.sharePlaceFile({ locale: "en", place: "me", item: id })
      ),
      missing: await outcome(
        admin.api.onboarding.sharePlaceFile({
          locale: "en",
          place: "me",
          item: "item-gone",
        })
      ),
    }).toStrictEqual({
      reading: dropped.result.reading,
      name,
      sent: dropped.requests.map(({ body }) => body),
      kept: 2,
      recorded: [{ target: "connection", detail: { place: "me", item: id } }],
      staff: "role.forbidden",
      missing: "place.no_item",
    });
  });

  it("refuse an old Office file as a dropped one is, with the way out", async () => {
    const id = `item-${crypto.randomUUID()}`;
    await oneDriveHolds([
      {
        id,
        name: "procedure.doc",
        bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
      },
    ]);
    const { admin } = await connected();
    const { requests, result } = await answering(
      [],
      async () =>
        await outcome(
          admin.api.onboarding.sharePlaceFile({
            locale: "en",
            place: "me",
            item: id,
          })
        )
    );
    expect({ result, sent: requests.length }).toStrictEqual({
      result: "document.old_format",
      sent: 0,
    });
  });
});
