# Security policy

This repository holds the Stellar Treasury API and indexer. It handles transactions that move funds, so reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Open a private report with GitHub's "Report a vulnerability" button on the Security tab of this repository. Include what you did, what happened and what you expected, and please give us time to fix the problem before you share details.

## In scope

The service in `src/`: event decoding, storage, HTTP API, webhook signing, notifications.

## Out of scope

The contract, SDK and app; report those in their own repositories.

The treasury contract has its own policy and an internal pre-audit: see the contract repository.
