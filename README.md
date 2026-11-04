# treasury-api

Backend for Stellar Treasury. It reads the treasury contract's events, keeps proposals in SQLite, serves them over HTTP, notifies approvers, and keeps an audit log.

## What it does

1. **Indexes events.** Polls Soroban RPC `getEvents` for each configured treasury and saves a cursor, so a restart picks up where it stopped.
2. **Stores proposals.** SQLite (`node:sqlite`, built into Node 22.13+, so no native build step).
3. **Serves an API** (below).
4. **Notifies.** Sends a webhook when a proposal is created, approved, ready to execute, or executed.
5. **Audit log.** Every contract event is kept, including spending-limit changes, with ledger, transaction hash and time. Events are stored once, even if the same page is read twice.

Events not known to this service are skipped, so adding a contract event won't break indexing.

## Run

```
npm install
npm run build
RPC_URL=https://soroban-testnet.stellar.org \
TREASURY_IDS=C...,C... \
npm start
```

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `RPC_URL` | yes | | Soroban RPC URL |
| `TREASURY_IDS` | yes | | Comma-separated treasury contract ids to index |
| `NETWORK_PASSPHRASE` | no | testnet | `Public Global Stellar Network ; September 2015` for mainnet |
| `DB_PATH` | no | `treasury.db` | SQLite file |
| `PORT` | no | `3000` | HTTP port |
| `POLL_INTERVAL_MS` | no | `5000` | Time between polls |
| `START_LEDGER` | no | about 1 day back | First ledger for a treasury with no cursor. RPC only keeps recent ledgers, so set this near the treasury's creation ledger |
| `WEBHOOK_URL` | no | | Where to POST notifications |
| `WEBHOOK_SECRET` | no | | Signs webhook bodies (HMAC-SHA256) |

## API

Only treasuries listed in `TREASURY_IDS` are served. Amounts are strings (token amounts can exceed JS numbers). Times are Unix seconds unless named `...At` (ISO).

| Route | |
|---|---|
| `GET /health` | `{ "status": "ok" }` |
| `GET /treasuries/:id/proposals?status=open\|executed\|expired&limit=50&offset=0` | Proposals, newest first. `limit` max 200 |
| `GET /treasuries/:id/proposals/:proposalId` | One proposal |
| `GET /treasuries/:id/audit-log?limit=50&offset=0` | Events, newest first |

A proposal:

```json
{
  "treasuryId": "C...", "id": 3, "proposer": "G...", "asset": "C...", "to": "G...",
  "amount": "5000000", "approvals": ["G...", "G..."], "executed": false,
  "expiresAt": 1793750000, "status": "open",
  "createdLedger": 123456, "createdAt": "2026-11-04T00:00:00Z",
  "executedAt": null, "executedTx": null
}
```

`status` is worked out when you ask: `executed`, `expired` (past `expiresAt` and not executed), or `open`.

## Webhook

`POST` with a JSON body:

```json
{
  "kind": "proposal_created",
  "treasuryId": "C...",
  "proposal": { "...": "as above" },
  "pendingApprovers": ["G...", "G..."],
  "threshold": 2
}
```

`kind` is one of `proposal_created`, `proposal_approved` (more approvals needed), `proposal_ready` (threshold met, an owner can execute), `proposal_executed`. `pendingApprovers` are owners who haven't approved yet.

If `WEBHOOK_SECRET` is set, check the `x-treasury-signature: sha256=<hex>` header: the HMAC-SHA256 of the raw body. Failed deliveries are retried 3 times with growing delays (not for 4xx errors other than 408 and 429). A notification that still fails is logged and skipped; it never stops indexing, and it isn't resent later.

## Develop

```
npm test
npm run typecheck
```

Tests use fake event sources and an in-memory database, so they need no network.

## Not built yet

Email and Slack/Discord notifiers (`TODO(wave: api-1)`, `api-2`), CSV audit export, OpenAPI spec.
