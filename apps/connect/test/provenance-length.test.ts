import { provenanceSchema } from "@grasp-os/connector-kit/manifest";
import { describe, expect, it } from "vite-plus/test";

import { eventId, messageId, pdfAttachmentId } from "./fixtures/graph.ts";

// The IDs connectors name what they read by (`provenance`), at the lengths
// their providers really give them, against the connector kit's bound on
// one: a read whose provenance passes it fails as a result the connector
// doesn't declare. Pure logic: the shapes, not a call.

/** Graph's own example IDs (v1.0 "Get attachment"): 152 and 180 characters. */
const graphMessage =
  "AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAAAYbvZTAAA=";
const graphAttachment =
  "AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAAAYbvZTAAABEgAQAMkpJI_X-LBFgvrv1PlZYd8=";

/** A Gmail message ID (16 hex digits) and an attachment's MIME part ID. */
const gmailAttachment = "18c3d4e5f6a70b21/0.1";

const fits = (id: string): boolean => provenanceSchema.safeParse([id]).success;

describe("a read's provenance at its provider's real lengths", () => {
  it("fits the bound for each ID a connector names, and the tests' Graph IDs are as long as Graph's", () => {
    expect({
      graph: [graphMessage, graphAttachment].map(fits),
      gmailAttachment: fits(gmailAttachment),
      fixtures: [
        messageId("invoices@acme.test", 1),
        eventId("invoices@acme.test", 1),
        pdfAttachmentId,
      ].map((id) => id.length),
    }).toStrictEqual({
      graph: [true, true],
      gmailAttachment: true,
      fixtures: [
        graphMessage.length,
        graphMessage.length,
        graphAttachment.length,
      ],
    });
  });

  it("would not fit a Graph attachment named with its message, so Microsoft 365 names it alone", () => {
    expect(fits(`${graphMessage}/${graphAttachment}`)).toBeFalsy();
  });
});
