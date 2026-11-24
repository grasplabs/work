import { strToU8, zipSync } from "fflate";

// Recorded shapes of Graph's answers for Word documents, Planner, OneNote
// and a SharePoint list that is written to, as the Microsoft 365
// connector's tools read them.

/** A supplier contract, as Word saves one: runs split mid-word, a tab, a line break, a table. */
const contractXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body>
<w:p w:rsidR="00A1"><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Supply agree</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>ment</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Between Northwind Supplies &amp; Acme B.V.</w:t></w:r></w:p>
<w:p/>
<w:p><w:r><w:t>Term:</w:t></w:r><w:r><w:tab/><w:t>24 months</w:t></w:r><w:r><w:br/><w:t>Notice: 3 months &lt;in writing&gt;</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Price per unit</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>&#8364; 12,40</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Signed in Utrecht</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`;

/** The contract's text, as a person reads it. */
export const contractText = [
  "Supply agreement",
  "Between Northwind Supplies & Acme B.V.",
  "",
  "Term:\t24 months\nNotice: 3 months <in writing>",
  "Price per unit",
  "€ 12,40",
  "Signed in Utrecht",
].join("\n");

const zipTime = new Date("2026-09-01T00:00:00Z");

export const contractDocx = zipSync({
  "[Content_Types].xml": [
    strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
    ),
    { mtime: zipTime },
  ],
  "word/document.xml": [strToU8(contractXml), { mtime: zipTime }],
});

/** Planner plans: Finance's, whose group the person is in, and HR's, whose they aren't. */
export const planIds = {
  finance: "xqQg5FS2LkCp935s-FIFm2QAFkHM",
  hr: "CLKbuGwbaEuVfZ8BzHK7b2QAGrRX",
} as const;

/** A Planner task, as Graph answers for it. */
export const plannerTask = (
  plan: string,
  n: number,
  overrides: Record<string, unknown> = {}
) => ({
  "@odata.etag": `W/"JzEtVGFzayAgQEBAQEBAQEBAQEBAQEBAWCc="`,
  planId: plan,
  bucketId: "hsOf2dhOJkqyYYZEtdzDe2QAIUCR",
  title: `Reconcile supplier statement ${n}`,
  orderHint: "8585269235419181201",
  percentComplete: n === 2 ? 100 : 0,
  priority: 5,
  startDateTime: null,
  dueDateTime: "2026-10-30T12:00:00Z",
  createdDateTime: `2026-10-0${n}T08:00:00Z`,
  completedDateTime: n === 2 ? "2026-10-20T09:00:00Z" : null,
  hasDescription: false,
  previewType: "automatic",
  referenceCount: 0,
  checklistItemCount: 0,
  activeChecklistItemCount: 0,
  conversationThreadId: null,
  id: `01gzSlKkIUSUl6DF_EilrmQAKDhh${n}`,
  createdBy: { user: { id: "6463a5ce-2119-4198-9f2a-628761df4a62" } },
  appliedCategories: {},
  assignments:
    n === 1
      ? {
          "fbab97d0-4932-4511-b675-204639209557": {
            "@odata.type": "#microsoft.graph.plannerAssignment",
            assignedDateTime: "2026-10-01T08:00:00Z",
            orderHint: "8585269235419181201",
            assignedBy: {
              user: { id: "6463a5ce-2119-4198-9f2a-628761df4a62" },
            },
          },
        }
      : {},
  ...overrides,
});

/** OneNote notebooks, by whose they are. */
export const notebooks = {
  own: {
    id: "0-816F7725BBF9E5!2155",
    displayName: "Work notes",
    isShared: false,
    userRole: "Owner",
  },
  sharedByThem: {
    id: "0-816F7725BBF9E5!2301",
    displayName: "Team handbook",
    isShared: true,
    userRole: "Owner",
  },
  sharedWithThem: {
    id: "0-3C1E9B2A7F04D6!118",
    displayName: "Board minutes",
    isShared: true,
    userRole: "Contributor",
  },
} as const;

/** A section of each notebook. */
export const sectionIds = {
  own: "0-816F7725BBF9E5!2160",
  sharedByThem: "0-816F7725BBF9E5!2310",
  sharedWithThem: "0-3C1E9B2A7F04D6!120",
} as const;

/** The page already in the person's own section, as OneNote serves its HTML. */
export const meetingPage = {
  id: "0-6d0d1ec4c5b84e5d9e3a2f1b0c9d8e7f!13-816F7725BBF9E5!2160",
  title: "Northwind call",
  html: `<html lang="en-US"><head><title>Northwind call</title><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /><meta name="created" content="2026-10-20T09:00:00.0000000" /><style>p{margin:0}</style></head><body data-absolute-enabled="true" style="font-family:Calibri;font-size:11pt"><div style="position:absolute;left:48px;top:115px;width:624px"><h1>Northwind call</h1><p>Agreed &amp; minuted:</p><ul><li>Send the signed contract by <span style="font-weight:bold">Friday</span></li><li>Price &lt;stays&gt; at &#8364;12,40</li></ul><table><tr><td>Owner</td><td>Due</td></tr><tr><td>Sam</td><td>30 Oct</td></tr></table><img src="https://graph.microsoft.com/v1.0/users('x')/onenote/resources/0-1/$value" alt="whiteboard" /></div></body></html>`,
};

/** The meeting page's text, as a person reads it. */
export const meetingText = [
  "Northwind call",
  "Agreed & minuted:",
  "Send the signed contract by Friday",
  "Price <stays> at €12,40",
  "Owner\tDue",
  "Sam\t30 Oct",
].join("\n");

/** A list the finance site keeps suppliers in, which tools write to. */
export const suppliersList = "a5c1f2e4-7b8d-4c3e-9f10-2b6d8e4a1c37";
