---
title: Example Apps
description: Four complete Apps to start from and copy, each with every file shown.
sidebar:
  order: 6
---

Four complete Apps ship with Grasp, written to be copied. Each passes every check Grasp runs on an App, and each is a blueprint: anyone who builds can create an App of their own from it. Their pages show every file in full.

Start from the one closest to what you build, and follow it:

- [Kanban board](/examples/kanban-board): cards moved between three columns. One table ordered by an index, mutations that check a revision, a form, and a component per column that reads its own query.
- [CRM](/examples/crm): contacts and the deals with each. A search index behind a data grid, a Page per contact (`/contacts/$contactId`), deal stages edited in place, money, and deals counted by stage with `group`.
- [Approvals](/examples/approvals): requests that the App's builders approve or reject. Row rules, so each person reads only their own requests; `ctx.auth.getUser()` to decide who may approve; and a notification to whoever asked.
- [Sales dashboard](/examples/dashboard): figures, a chart and the latest sales. Monthly totals kept in the same mutation that records a sale, so the dashboard reads a dozen records however many sales there are.
