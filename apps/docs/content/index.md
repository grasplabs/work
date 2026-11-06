---
title: Introduction
description: Build Apps and workflows that run inside your company's Grasp.
---

Grasp runs your company's Apps and workflows in its own deployment. You write an App as a small TypeScript project on `@grasp-os/sdk`, and Grasp hosts it: it stores the App's data, runs its server code, renders its Pages and checks every call against the access you declared.

An App has four parts:

- **A definition**: what the App is, as data: the tables it keeps, with a type for every field, who may read and write them, and its permissions. Grasp changes it with its definition tools and generates the App's config and schema from it. See [An App's project](/guides/project) and [Data](/guides/data).
- **Server functions**: queries that read, mutations that write and actions that reach outside the App. See [Server functions](/guides/server-functions).
- **Pages**: React components people open in Grasp, which call the server functions and stay up to date as data changes. See [Pages](/guides/pages).
- **Permissions**: everything the App reaches beyond its own data, such as the workflows it starts. An App starts with access to nothing; an admin grants each permission. See [Workflows](/guides/workflows).

Start with [An App's project](/guides/project), which builds a small Tasks App that the other guides extend.

## These docs and your deployment

These docs ship with Grasp. Each deployment serves the docs of the release it runs, at `/docs`, so what you read here is what your deployment runs. The [API reference](/reference) is generated from the SDK's own types on every release.

Agents read the same docs: [llms.txt](/llms.txt) lists every page, and any page's Markdown is at its address with `.md` added.
