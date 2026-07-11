# n8n workflows as code

**Deploy and version-control n8n automations as idempotent code instead of clicking through the UI.**

Each workflow is defined in a plain Node.js script that talks to the n8n public API. Running the script `PUT`s the workflow definition, wires the credentials, and activates it — reproducibly, from a clean checkout, with no manual clicking.

## The problem

n8n is normally built by hand in a visual editor. That makes automations hard to review, impossible to diff, easy to break silently, and painful to reproduce on another instance. There is no single source of truth: the "code" lives inside a database behind a UI.

This project treats workflows as **infrastructure-as-code**: the definition lives in Git, deployment is a deterministic script, and the same run either produces the exact same live workflow or fails loudly.

## What it does

Two automations ship today, each deployed by its own self-contained script:

- **Daily Telegram weather** — pulls the Poznań forecast from the free [Open-Meteo](https://open-meteo.com/) API, formats a clean daily digest, and sends it to Telegram on a schedule.
- **Daily AI English B1 lesson** — an LLM chain (OpenAI `gpt-4.1-mini`) generates 10 B1-level English phrases with translations, example sentences, spoiler-hidden answers, and a short revision section, delivered to Telegram as formatted HTML.

## How it works

```
 deploy-*.mjs  ──reads──►  .env (gitignored, never committed)
      │                      │  N8N_URL, N8N_API_KEY, tokens
      │                      ▼
      ├──► n8n public API  ──►  create/update workflow  ──►  activate
      │        ▲
      │        └── credentials stored in n8n, referenced by ID only
      │
      └──reads/writes──►  .deploy-state.json  (workflow + credential IDs)
```

- **Idempotent create-then-reuse.** The first deploy creates the workflow and credential and records their IDs in a local `.deploy-state.json`. Every later deploy reuses those IDs (`PUT` + re-activate), so re-running is safe and never spawns duplicates.
- **Credentials by ID, never by token.** Secrets are read from a gitignored `.env` at deploy time and stored inside n8n. The workflow definition only references a credential **ID**, so no token is ever written into a committed file.
- **Single source of truth for logic.** The weather formatter lives once in `weather-format.mjs`. The deployer injects that exact function into the n8n Code node via `Function.prototype.toString()`, so the deployed node and the local proof scripts can never drift.
- **Hardened execution.** Network nodes use `retryOnFail` with backoff and `onError: continueRegularOutput`, plus a missing-data fallback, so a flaky upstream morning still delivers a message instead of failing silently.
- **A promote-and-deploy gate.** `promote-and-deploy.mjs` fast-forward-only merges a feature branch, runs `node --check` on every script, runs a content smoke test on the formatter, then runs every `deploy-*.mjs` — failing loudly with a non-zero exit at the first problem.

## Stack

- **Node.js** (ESM, zero runtime dependencies — native `fetch`, `fs`, `child_process`)
- **n8n** public REST API (`/api/v1`)
- **Open-Meteo** forecast API
- **Telegram** Bot API
- **OpenAI** `gpt-4.1-mini` via n8n's LangChain nodes

## Setup

```bash
# 1. Configure secrets (never committed)
cp .env.example .env
#    then fill in N8N_URL, N8N_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

# 2. Deploy the weather workflow (creates + activates it, records IDs)
node deploy-weather.mjs

# 3. Deploy the daily English lesson
#    (requires an OpenAI credential registered in n8n; its ID goes in .deploy-state.json)
node deploy-english-phrases.mjs

# Optional: prove content + credentials end-to-end before scheduling
node send-weather-now.mjs

# Optional: promote a feature branch through the full gate
node promote-and-deploy.mjs <feature-branch>
```

See [`.env.example`](./.env.example) for the exact variables. `.deploy-state.json` is created automatically on first deploy and is gitignored.

## Notable engineering

- **Idempotency via a state file** — deploys are safe to re-run; IDs are created once and reused forever.
- **No secret ever hits Git** — tokens live only in `.env` and inside n8n; definitions reference credential IDs.
- **One source of truth for shared logic**, injected into the Code node with `Function.toString()` so runtime and tests can't diverge.
- **Fail-loud deploy pipeline** — ff-only merge → syntax check → content smoke → deploy, with a non-zero exit on any failure.
- **Resilience baked into the workflow** — retries, continue-on-error, and a graceful fallback message.
