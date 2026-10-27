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
`npm test`: policy, audit chain tampering, address allocation (gap limit, reuse, static fallback), the payment builder, a
WizardConnect-style signature checked by the BCH virtual machine, the HTTP and owner routes.
Opt-in, with network: `RELAY_E2E=1` pairs and pays over the public WizardConnect relays; `CHIPNET_E2E=1` does the whole payment on
chipnet with a test-only wallet whose seed stays in `data/` (first passed 27/10/2026, txid
112d9b7577f80d8c291063a46cd85458095a3cbe0969dbd8b01abc1114805935); `CHIPNET_LIVE=1` reads a fresh address on chipnet.

## Receiving wallet
Open `/owner` with the reviewer token and pair a WizardConnect wallet (it shares only its receive xpub), or set one receive address
as a fallback (each task then gets a unique amount). `HD_PUBLIC_KEY` (+ `HD_PUBLIC_KEY_PATH=account|receive`) or `RECEIVE_ADDRESS`
set the same from the environment.

## Not done yet
The hosted demo and the BLAZE banner (presentation, repository, CashTokens address).
