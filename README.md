# Pay-per-task Agent

An AI agent that is paid per finished task in Bitcoin Cash, with a human approval gate before every payment and an append-only
audit log of each step. Built for BCH BLAZE 2026 (Mainnet track).

## How it works
1. A customer describes a task and offers a price in satoshis.
2. A policy decides: run it now (AUTO), wait for a person to accept it (APPROVE), or refuse it (REFUSE). The rule that decided is
   recorded (`src/policy.js`).
3. The agent does the work (any OpenAI-compatible model endpoint, `src/agent.js`).
4. The customer sees a preview and a payment request for an address made for this task alone, derived from the receiving wallet's
   HD public key. The server holds no private key (`src/chain.js`).
5. When the full price has arrived on that address (read from a Fulcrum/Electrum server), the full result is released.
6. Every step is written to a hash-chained log (`src/audit.js`, `GET /api/audit` verifies it); an edited log refuses new entries.

## Run (chipnet, test coins only)
```
npm install
HD_PUBLIC_KEY=<tpub of a chipnet wallet> REVIEW_TOKEN=<long random secret> \
AGENT_API_URL=<https://.../v1> AGENT_API_KEY=<key> AGENT_MODEL=<model> npm start
```
Open http://localhost:8787. Reviewers accept held tasks with `POST /api/tasks/<id>/review` and header `x-review-token`.
`AGENT_MODE=echo` replaces the model with a test echo. `NETWORK=mainnet` switches to mainnet addresses and `bch.imaginary.cash`.

## Test
`npm test` (policy, audit chain tampering, the task flow against a fake chain, the HTTP reviewer gate);
`CHIPNET_LIVE=1 npm test` also reads a fresh address on chipnet.

## Not done yet
WizardConnect wallet connection, the hosted demo and the BLAZE banner (presentation, repository, CashTokens address).
