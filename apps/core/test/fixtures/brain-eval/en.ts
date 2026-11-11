import { absent, answer, hidden } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Groenhaven in English, its group language: finance, IT, travel and
// sales across the sites (company.ts).

export const enSources: readonly BrainEvalSource[] = [
  {
    key: "en-expenses",
    language: "en",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Expense policy

Submit expense claims within 30 days in the expense tool, using form EXP-12. Attach a receipt for every amount above EUR 25.

Meals while travelling abroad are reimbursed up to EUR 45 per day. Your cost-centre manager approves claims; anything above EUR 500 also needs the finance director's approval.`,
  },
  {
    key: "en-laptops",
    language: "en",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Laptops and software

Laptops are replaced every four years. Request a replacement through the IT service desk portal.

A lost or stolen laptop must be reported within 24 hours to the IT service desk and your manager, so the device can be locked remotely.

Do not install software yourself; ask for anything that isn't on the approved software list in the portal.`,
  },
  {
    key: "en-security",
    language: "en",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Information security basics

Report a suspicious email with the Report Phishing button in your mail; never forward it. Never share a one-time code, not even with IT.

Visitors sign in at reception and are accompanied at all times. Lock your screen when you leave your desk and keep a clean desk at the end of the day.`,
  },
  {
    key: "en-travel",
    language: "en",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Business travel

Book flights through the travel desk at least 14 days before departure. Fly economy class on flights under six hours.

Hotels: up to EUR 150 per night in Europe, and up to EUR 220 per night in London and Paris. Book trains instead of flights for trips under four hours.`,
  },
  {
    key: "en-month-end",
    language: "en",
    kind: "meeting",
    readers: { team: "finance" },
    text: `Finance team meeting, 3 November

1. Month-end close moves from working day 5 to working day 4 from January.
2. Intercompany invoices between Duisburg and Utrecht must be booked by working day 2.
3. Action Sophie: update the close calendar and share it with the site controllers.`,
  },
  {
    key: "en-erp-import",
    language: "en",
    kind: "ticket",
    readers: { team: "planning" },
    text: `INC-40417 · ERP order import · In progress

Orders with more than 250 lines fail to import into the ERP and stay in the error queue. Workaround: split the order into parts of at most 250 lines before importing. A fix is planned for ERP release 26.12.`,
  },
  {
    key: "en-credit-facility",
    language: "en",
    kind: "email",
    readers: { owner: "sophie" },
    text: `From: relationship manager, corporate banking
To: Sophie Turner
Subject: Credit facility renewal

Dear Sophie,

As discussed, the renewal of Groenhaven's credit facility is due on 31 January. The bank will keep the current covenant: net debt to EBITDA must stay below 2.5. Please send the Q4 figures by 20 January.

Kind regards`,
  },
  {
    key: "en-suppliers",
    language: "en",
    kind: "handbook",
    readers: { team: "finance" },
    text: `New suppliers

Every new supplier is set up with supplier form SUP-01. Bank details are verified by calling the supplier on a number we already know, never one from the email that sent them. Standard payment terms are 45 days after the invoice date.`,
  },
  {
    key: "en-price-increase",
    language: "en",
    kind: "meeting",
    readers: { team: "sales" },
    text: `Sales meeting, 28 October

Decided: a price increase of 4.5% on all garden furniture from 1 February. Customers are told by 1 December. Key accounts keep the old prices until 1 March.`,
  },
  {
    key: "en-budget-2027",
    language: "en",
    kind: "email",
    readers: { team: "finance" },
    text: `From: Sophie Turner
To: Finance
Subject: Budget 2027, draft

The draft budget for 2027 cuts the marketing budget by 18% to EUR 640,000. Office roles are frozen until June; warehouse hiring for the spring peak continues as planned.`,
  },
];

export const enQuestions: readonly BrainEvalQuestion[] = [
  {
    id: "en-hotel-london",
    language: "en",
    question: "What is the hotel limit per night in London?",
    expects: answer("words", "en-travel", "EUR 220 per night"),
  },
  {
    id: "en-laptop-replaced",
    language: "en",
    question: "How often are laptops replaced?",
    expects: answer("words", "en-laptops", "replaced every four years"),
  },
  {
    id: "en-intercompany",
    language: "en",
    question: "When must intercompany invoices be booked?",
    expects: answer("words", "en-month-end", "booked by working day 2"),
  },
  {
    id: "en-payment-terms",
    language: "en",
    question: "What are the payment terms for a new supplier?",
    expects: answer("words", "en-suppliers", "45 days after the invoice date"),
  },
  {
    id: "en-price-increase",
    language: "en",
    question: "How large is the price increase on garden furniture?",
    expects: answer("words", "en-price-increase", "price increase of 4.5%"),
  },
  {
    id: "en-closing-moved",
    language: "en",
    question: "When is the monthly closing moving to?",
    expects: answer("forms", "en-month-end", "to working day 4 from January"),
  },
  {
    id: "en-receipts",
    language: "en",
    question: "Do I need receipts for small expenses?",
    expects: answer(
      "forms",
      "en-expenses",
      "receipt for every amount above EUR 25"
    ),
  },
  {
    id: "en-visitor",
    language: "en",
    question: "What happens when a visitor arrives?",
    expects: answer("forms", "en-security", "Visitors sign in at reception"),
  },
  {
    id: "en-inc-40417",
    language: "en",
    question: "What is INC-40417 about?",
    expects: answer(
      "exact",
      "en-erp-import",
      "more than 250 lines fail to import"
    ),
  },
  {
    id: "en-exp-12",
    language: "en",
    question: "Where do I fill in EXP-12?",
    expects: answer(
      "exact",
      "en-expenses",
      "in the expense tool, using form EXP-12"
    ),
  },
  {
    id: "en-sup-01",
    language: "en",
    question: "What is SUP-01 for?",
    expects: answer("exact", "en-suppliers", "supplier form SUP-01"),
  },
  {
    id: "en-credit-renewal",
    language: "en",
    asker: "sophie",
    question: "When is the credit facility renewal due?",
    expects: answer("words", "en-credit-facility", "due on 31 January"),
  },
  {
    id: "en-computer-taken",
    language: "en",
    question: "Someone took my computer on the train, who do I tell?",
    expects: answer(
      "paraphrase",
      "en-laptops",
      "reported within 24 hours to the IT service desk and your manager"
    ),
  },
  {
    id: "en-business-class",
    language: "en",
    question: "Can I fly business to Madrid?",
    expects: answer(
      "paraphrase",
      "en-travel",
      "Fly economy class on flights under six hours"
    ),
  },
  {
    id: "en-big-orders",
    language: "en",
    question: "Large orders won't load into the system, what can I do?",
    expects: answer(
      "paraphrase",
      "en-erp-import",
      "split the order into parts"
    ),
  },
  {
    id: "en-dinner-abroad",
    language: "en",
    question: "How much can I spend on dinner on a trip to Spain?",
    expects: answer("paraphrase", "en-expenses", "up to EUR 45 per day"),
  },
  {
    id: "en-gym",
    language: "en",
    question: "Is there a gym discount for employees?",
    expects: absent,
  },
  {
    id: "en-pets",
    language: "en",
    question: "May I bring my dog to the office?",
    expects: absent,
  },
  {
    id: "en-marketing-budget",
    language: "en",
    asker: "camille",
    question: "What is the marketing budget for 2027?",
    expects: hidden("en-budget-2027", "640,000", "by 18%"),
  },
  {
    id: "en-bank-covenant",
    language: "en",
    asker: "daan",
    question: "What did the bank say about the credit facility renewal?",
    expects: hidden("en-credit-facility", "below 2.5", "due on 31 January"),
  },
];
