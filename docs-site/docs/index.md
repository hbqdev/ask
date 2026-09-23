---
layout: home
title: Home
hero:
  name: Ask
  text: Architecture & Handover
  tagline: How the self-hosted answer engine is built, deployed and operated — written so an engineer can run and extend it alone.
  actions:
    - theme: brand
      text: Start here
      link: /getting-started/overview
    - theme: alt
      text: Follow a chat turn
      link: /request-lifecycle/chat-turn
    - theme: alt
      text: Runbooks
      link: /operations/runbooks
features:
  - title: Getting started
    details: The product, the stack, the mental model, and how to run each environment locally.
    link: /getting-started/overview
    linkText: Overview
  - title: Operations
    details: Lab → staging → prod, deploys and rollback, incident runbooks, testing and telemetry.
    link: /operations/environments
    linkText: Environments
  - title: Request lifecycle
    details: One chat turn end-to-end — classifier, research agent, search, streaming and persistence.
    link: /request-lifecycle/chat-turn
    linkText: Chat turn
  - title: Reference
    details: Generated from the code — every env flag, API route, database table and compose service.
    link: /reference/env-flags
    linkText: Env flags
  - title: Decisions
    details: Why things are the way they are, including the experiments that failed and must not be retried.
    link: /history/decisions
    linkText: Decision records
---

## What Ask is

Ask is a self-hosted, Perplexity-style answer engine: a user asks a question, a research agent searches the web (and the user's own documents and past conversations), reads and reranks the sources, and streams back a cited answer. It is a Next.js 16 application (a fork of Morphic) backed by Postgres with row-level security and Redis, and it runs on a small home GPU fleet that hosts its crawler, reranker, embedder, speech and local-LLM services, with the answering models served through Ollama Cloud. Three copies run side by side — **lab** for experiments, **staging** for validation, and **prod** at the public URL — from separate git worktrees of one repository.

## System map

Every box is a real process or service. Hover for what it does and which port it listens on; click to open its documentation.

<SystemMap />

## How to use this site

- **New to the codebase?** Read [Overview](/getting-started/overview), then [Repo tour](/getting-started/repo-tour), then walk through [a chat turn](/request-lifecycle/chat-turn).
- **Something is broken?** Go straight to [Runbooks](/operations/runbooks) and [Known issues](/history/known-issues).
- **Changing a knob?** Look it up in [Env flags](/reference/env-flags) and check [Decisions](/history/decisions) before re-running an old experiment.
- **Search** (top bar, or press <kbd>/</kbd>) covers every page.
