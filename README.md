# Pay-per-task Agent

An AI agent that is paid per finished task in Bitcoin Cash, with a human approval gate before every payment and an append-only
audit log of each step.

- **Live demo (chipnet, test coins only):** https://payagent.oll4.com:4951 · presentation: https://payagent.oll4.com:4951/presentation
- **BCH BLAZE 2026 entry** (Mainnet track). Built for BLAZE: development started on 27 October 2026; there is no earlier version.
- Pay with any WizardConnect wallet (for example Selene or Paytaca): scan the QR code, approve the payment in the wallet.

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
Node 22 or newer:
```
npm install
REVIEW_TOKEN=<random secret, 24+ characters> AGENT_MODE=echo npm start
```
Open http://localhost:8787/owner, enter the token and pair a chipnet wallet (or set one receive address), then use
http://localhost:8787. For a real model set `AGENT_API_URL` (an OpenAI-compatible `/v1` base), `AGENT_API_KEY` and `AGENT_MODEL`
instead of `AGENT_MODE=echo`. Reviewers accept held tasks with `POST /api/tasks/<id>/review` and header `x-review-token`.
`NETWORK=mainnet` switches to mainnet addresses and `bch.imaginary.cash`. A container: `docker build -t pay-per-task-agent .`
(runs as a non-root user, data in the `/data` volume).

## Test
`npm test`: policy, audit chain tampering, address allocation (gap limit, reuse, static fallback), the payment builder, a
WizardConnect-style signature checked by the BCH virtual machine, the HTTP and owner routes.
Opt-in, with network: `BROWSER_E2E=1` drives the real pages in headless Chrome (system Chrome, `CHROME_PATH` to override) with
their Content-Security-Policy on chipnet: the owner pairs a shop wallet on `/owner`, a customer pays a task with the WizardConnect
button; `RELAY_E2E=1` pairs and pays over the public WizardConnect relays; `CHIPNET_E2E=1` does the whole payment on
chipnet with a test-only wallet whose seed stays in `data/` (first passed 27/10/2026, txid
112d9b7577f80d8c291063a46cd85458095a3cbe0969dbd8b01abc1114805935); `CHIPNET_LIVE=1` reads a fresh address on chipnet.

## Security
Strict Content-Security-Policy (own scripts only; WebAssembly for the signing library; the two WizardConnect relays), no inline
scripts, `nosniff`, no referrer, no framing. The public audit log names tasks only by a hash of their id (`ref` in the task view),
because a task id unlocks its paid result. New tasks are limited per client per hour and per day, and chain reads per task to one
every 3 s. The model's spending has a daily token budget (`AGENT_DAILY_TOKENS`, counted from the usage the endpoint reports);
answers are kept short by instruction and `AGENT_REASONING_EFFORT`, because some backends ignore every length parameter. On mainnet the echo test agent refuses to start.

## Receiving wallet
Open `/owner` with the reviewer token and pair a WizardConnect wallet (it shares only its receive xpub), or set one receive address
as a fallback (each task then gets a unique amount). `HD_PUBLIC_KEY` (+ `HD_PUBLIC_KEY_PATH=account|receive`) or `RECEIVE_ADDRESS`
set the same from the environment.

## Not done yet
The hosted demo and the BLAZE banner (presentation, repository, CashTokens address).
