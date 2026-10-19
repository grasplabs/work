import type { VisionReading } from "../../../src/admin/onboarding-admin.ts";

/**
 * What Stephen read in each sample organization's first conversation. These are his own readings
 * of the transcripts in `admin-transcripts.ts`, made by the same reader the admin uses for a
 * transcript that is brought in: every quote is in its transcript, word for word, and a test
 * holds them to that. When a transcript changes, read it again and replace its reading here.
 */

export const NOORDKADE_READING: VisionReading = {
  minutes: 82,
  who: "the CEO, the COO and the CFO",
  on: "2026-09-16",
  fields: {
    business: {
      text: "The firm sells mortgage and lending advice to people buying a house, refinancing, or borrowing against the house they own. Advisors sit with clients and deal with lenders for them.",
      quote: "We do mortgage and lending advice.",
    },
    teams: {
      text: "The firm named client onboarding, mortgage advice, customer service, finance and compliance as the first teams to interview. Operations comes later, and IT is one admin plus a supplier under the COO.",
      quote:
        "Client onboarding, mortgage advice, customer service, finance and compliance.",
    },
    goals: {
      text: "Within twelve months, every client gets a clear answer within a working day, advisors spend their time on advice, and the board sees this week’s numbers on Monday morning. They act now because client numbers grew by a third in a year with no new hires, and the CEO heard at a dinner what peers did with AI in the back office.",
      quote:
        "In twelve months, every client gets a clear answer within a working day, advisors spend their time on advice, and the board sees this week’s numbers on Monday morning.",
    },
    success: {
      text: "Success means fewer client chasers, new client files complete within a day, more advice conversations per advisor each week, and the weekly report ready before the Monday meeting without late evenings. Finance confirms every measured result before it counts.",
      quote:
        "Fewer chasers from clients, and new clients have a complete file within a day.",
    },
    stakeholders: {
      text: "The COO approves new tools after an IT check, and anything that costs money also goes past the CFO. The CEO confirms the vision page, the COO is the main contact and tells each team first, and compliance will be strict about client data.",
      quote: "I do, after a check by IT.",
    },
    pain: {
      text: "The sponsor suspects time goes to chasing and handling documents, copying data between systems, and filling in lender portals in onboarding and mortgage advice. Other suspects are the shared customer service inbox, which is sorted by hand, and the weekly board report, which takes the controller most of Monday.",
      quote: "If I had to bet, I’d bet on onboarding and mortgage advice.",
    },
    limits: {
      text: "The advice itself stays with the advisor, and nothing goes to a client or into a file unchecked at the start. Only counts from the inbox may be used, never the email content, and operations is not in the first round of interviews.",
      quote:
        "The advisor signs the advice, the advisor explains it to the client.",
    },
    sensitivities: {
      text: "The customer service team has been under pressure for a year and may read this as criticism, and staff may fear job cuts. Past tool pilots faded or were switched off, and some staff already use unapproved AI tools.",
      quote: "The service desk is tired.",
    },
    systems: {
      text: "The tools named are Exact, the CRM, many Excel sheets, Microsoft 365, a shared inbox, a client portal, lender portals and a website chat.",
      quote: "Exact, the CRM, a whole set of Excel sheets.",
    },
  },
  ask: {
    languages:
      "Which languages do the teams work in, with each other and with clients?",
  },
  teams: [
    {
      name: "Client onboarding",
      does: "Brings in new clients and collects and checks their documents",
    },
    {
      name: "Mortgage advice",
      does: "Advises clients and submits data to lender portals",
    },
    {
      name: "Customer service",
      does: "Handles the shared inbox and client questions",
    },
    { name: "Finance", does: "Reporting, the bank, the weekly board report" },
    {
      name: "Compliance",
      does: "Sets the rules on client data and procedures",
    },
    {
      name: "Operations",
      does: "Touches all processes; to be interviewed later",
    },
    { name: "IT", does: "One admin and a supplier; checks new tools" },
  ],
};

export const VELDKAMP_READING: VisionReading = {
  minutes: 7,
  who: "the managing director and the head of operations",
  on: "2026-09-22",
  fields: {
    business: {
      text: "They maintain and replace heating and cooling in rented homes: boilers, heat pumps and ventilation. They work on contract for nine housing associations, mostly in the east.",
      quote: "We maintain and replace heating and cooling in rented homes.",
    },
    teams: {
      text: "About forty mechanics, trainees included, do the work on the road. A service desk plans them and takes calls, Projects replaces whole blocks, the warehouse orders parts and stocks vans, the office handles invoices and suppliers, and there is management.",
      quote: "Then the service desk that plans them and takes the calls.",
    },
    goals: {
      text: "They won a contract for six thousand homes and cannot hire forty more mechanics. So they want to plan more visits with the same mechanics, and stop losing days between a repair and its invoice.",
      quote: "So I want to plan more visits with the same mechanics.",
    },
    success: {
      text: "Success means an invoice within two days of the visit and fewer second visits.",
      quote: "An invoice within two days of the visit.",
    },
    stakeholders: {
      text: "The managing director decides. The works council must agree before anyone is asked anything, and it meets on the first Thursday of the month.",
      quote:
        "But the works council has to agree before anyone is asked anything.",
    },
    pain: {
      text: "Work orders come back without parts or time on them, which delays invoices. Mechanics also drive to announced visits where nobody is at home.",
      quote:
        "Work orders that come back without parts or without time on them.",
    },
    limits: {
      text: "Stephen must not touch the time registration of the mechanics, which is being negotiated with the union.",
      quote: "Not the time registration of the mechanics.",
    },
    sensitivities: {
      text: "Time registration is under negotiation with the union. The collective labour agreement is renewed this autumn, so anything about pay and hours is touchy.",
      quote: "The collective labour agreement is renewed this autumn.",
    },
    systems: {
      text: "They use a planning system for visits, tablets in the vans, an accounting system in the office, and a lot of Excel in between.",
      quote: "A planning system for the visits.",
    },
    languages: {
      text: "The teams work in Dutch. A few mechanics speak mostly Polish and find long talks in Dutch hard.",
      quote: "A few of the mechanics speak mostly Polish.",
    },
  },
  ask: {},
  teams: [
    {
      name: "Mechanics",
      does: "Repair and maintain installations on the road",
      people: 40,
    },
    { name: "Service desk", does: "Plans the mechanics and takes calls" },
    {
      name: "Projects",
      does: "Replace installations for a whole block at once",
    },
    { name: "Warehouse", does: "Orders parts and stocks the vans" },
    { name: "Office", does: "Handles invoices and suppliers" },
    { name: "Management", does: "Runs the company" },
  ],
};

export const VANRIJN_READING: VisionReading = {
  minutes: 4,
  who: "the managing partner",
  on: "2026-10-01",
  fields: {
    business: {
      text: "The firm does annual accounts, tax returns and payroll for about six hundred small companies around Arnhem. Clients include bakers, contractors and many self-employed people.",
      quote:
        "We do the annual accounts, the tax returns and the payroll for about six hundred small companies around Arnhem.",
    },
    teams: {
      text: "The firm has 38 people. Twelve make annual accounts, and there are tax, payroll and office teams, plus four partners who review the work.",
      quote:
        "There is tax, there is payroll, the office, and we are four partners who review the work.",
    },
    goals: {
      text: "The managing partner turns clients away and wants to take on more clients without hiring, because there are no people to find. The partners want to advise, not check.",
      quote:
        "I want to take on more clients without more people, there are none to find.",
    },
    stakeholders: {
      text: "The managing partner decides. Each other partner can block it for their own clients, which stops it for that part of the firm.",
      quote:
        "But each of the other partners can block it for their own clients.",
    },
    pain: {
      text: "Chasing clients for their papers takes much time, often waiting for a shoebox of receipts. A partner also reviews every set of accounts line by line.",
      quote: "Chasing clients for their papers.",
    },
    limits: {
      text: "No client name or figure may leave the firm, because the firm is bound to secrecy. Stephen asks how the work goes, never about a client, and does not write down client names.",
      quote: "No client name or figure leaves the firm.",
    },
    systems: {
      text: "The firm uses accounts software, payroll software, a practice system for the hours, and the tax office portal.",
      quote:
        "The accounts software, the payroll software, a practice system for the hours, and the portal of the tax office.",
    },
    languages: {
      text: "The teams work in Dutch.",
      quote: "Dutch. All of us.",
    },
  },
  ask: {
    success: "What result in hours or pieces of work would count as success?",
    sensitivities:
      "Is anything sensitive right now, such as staff changes or a recent incident?",
  },
  teams: [
    { name: "Annual accounts", does: "Make the annual accounts", people: 12 },
    { name: "Tax", does: "Tax returns" },
    { name: "Payroll", does: "Payroll for clients" },
    { name: "The office", does: "Takes on new clients and sends the invoices" },
    { name: "Partners", does: "Review the work", people: 4 },
  ],
};

export const HARTOG_READING: VisionReading = {
  minutes: 6,
  who: "the managing director and the operations director",
  on: "2026-03-24",
  fields: {
    business: {
      text: "Hartog sells tools and fasteners to the building trade: contractors, installers and carpenters. Customers order today and get it tomorrow, from one warehouse in Deventer.",
      quote: "We sell tools and fasteners to the building trade.",
    },
    teams: {
      text: "It has 112 people, 44 of them in the warehouse. The sales office takes orders and makes quotes, customer service answers customers and handles returns, purchasing orders from suppliers, and there is finance and a small group for the webshop, IT and HR.",
      quote: "The sales office takes the orders and makes the quotes.",
    },
    goals: {
      text: "Half of the orders still come in by email and are typed over. The director wants to grow by a fifth without a bigger sales office, and every order that comes in before four to leave the same day.",
      quote: "I want to grow by a fifth without a bigger sales office.",
    },
    success: {
      text: "An order from an email is in the system within ten minutes without anyone typing it. Today that can take half a day.",
      quote:
        "An order from an email is in the system within ten minutes, without anyone typing it.",
    },
    stakeholders: {
      text: "The managing director decides. The works council has to agree, and the warehouse manager has to be on board or the warehouse will not take part.",
      quote:
        "The works council has to agree, and the warehouse manager has to be on board, or the warehouse will not take part.",
    },
    pain: {
      text: "Apart from typing over orders: returns, customers who call to ask where their order is, and the price lists of suppliers, which take purchasing days.",
      quote: "And customers who call to ask where their order is.",
    },
    limits: {
      text: "Stephen stays away from the margins and from what Hartog pays its suppliers. He may ask how a price list is handled, not what is on it.",
      quote: "He can ask how a price list is handled, not what is on it.",
    },
    sensitivities: {
      text: "The warehouse moves to a new warehouse system next year, and people there are nervous about it. This must not sound as if it is part of that.",
      quote: "We move to a new warehouse system next year.",
    },
    systems: {
      text: "An ERP for orders and stock, scanners in the warehouse, Exact for the books, Shopify for the webshop and Zendesk for customer service.",
      quote:
        "The webshop runs on Shopify, and customer service works in Zendesk.",
    },
    languages: {
      text: "Dutch in the office. Dutch and English in the warehouse, where some colleagues do not speak Dutch.",
      quote:
        "In the warehouse it is Dutch and English, we have a number of colleagues who do not speak Dutch.",
    },
  },
  ask: {},
  teams: [
    { name: "Warehouse", does: "Receives, picks and ships", people: 44 },
    { name: "Sales office", does: "Takes the orders and makes the quotes" },
    {
      name: "Customer service",
      does: "Answers the customers and handles the returns",
    },
    { name: "Purchasing", does: "Orders from the suppliers" },
    { name: "Finance", does: "The books" },
    { name: "Webshop, IT and HR", does: "A small group" },
  ],
};
