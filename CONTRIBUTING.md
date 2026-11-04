# Contributing

Thanks for helping. This is the API and indexer of Stellar Treasury.

> This repository is a read-only mirror. The work happens in the Soroban-Treasury monorepo, in the `backend/` folder, and is split into this repository on every push. Open pull requests against the monorepo.

## Setup

```
npm install
npm run typecheck
npm test
npm run build
```

## Rules

- Treat all event data as untrusted input; decode defensively and skip what you do not know.
- Storing an event twice must change nothing (the audit log is keyed by event id).
- A failing notifier never stops indexing.
- New routes validate their parameters and have tests.
- Folders do not import each other by relative path; use declared dependencies.

## Open tasks

Marked in the code as `TODO(wave: ...)` or listed in the README under "Not built yet":

| Marker | Task |
|---|---|
| `api-1` | Email notifier |
| `api-2` | Slack and Discord notifier |
| medium | CSV audit export |
| trivial | OpenAPI spec |

## Pull requests

Describe what changed and why, list the tests you added, and keep a pull request to one change.

## Conduct

Be kind and be specific. See the [Code of Conduct](CODE_OF_CONDUCT.md).
