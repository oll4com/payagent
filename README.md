# Pay-per-task Agent

An AI agent that is paid per finished task in Bitcoin Cash, with a human approval gate before every payment and an append-only
audit log of each step. You see a preview of the work first and pay only for the result you keep, from your own wallet, to an
address made for that task alone.

**BCH BLAZE 2026 entry, Mainnet track.** Built for BLAZE: development started on 27 October 2026; there is no earlier version.

| | |
|---|---|
| Live demo, chipnet (free test coins) | https://payagent.oll4.com:4951 |
| Presentation (Widget Factory template) | https://payagent.oll4.com:4951/presentation |
| Mainnet instance | https://payagent.oll4.com:4952 (planned, see [Mainnet](#mainnet)) |
| Licence | MIT |

## How it works
1. A customer describes a task and offers a price in satoshis.
2. A policy decides before anything runs: **AUTO** (run now), **APPROVE** (hold until the owner accepts it) or **REFUSE** (for
   example a request for keys or passwords, or a price outside the limits). The rule that decided is recorded (`src/policy.js`).
3. The agent does the work with any OpenAI-compatible model endpoint (`src/agent.js`).
4. The customer sees a preview, the rule that let the task run, and a payment request for an address made for this task alone.
5. The customer pays: with a WizardConnect wallet (Selene, Paytaca, …) by scanning a QR code, or from any wallet to the payment link.
6. As soon as the full amount is seen on chain, the full result unlocks. Every step lands in a hash-chained log at `/api/audit`.

## Architecture
```
 Customer browser                     Server (Node.js, no framework)                    Outside
 ┌──────────────────────┐   HTTPS    ┌──────────────────────────────────┐
 │ index.html / app.js  │──────────▶ │ server.js   routes, limits, CSP  │
 │ wallet.bundle.js     │            │ policy.js   AUTO/APPROVE/REFUSE  │──▶ model endpoint (OpenAI-compatible)
 │  (WizardConnect dapp)│            │ service.js  task flow, budget    │
 └──────────┬───────────┘            │ receiver.js per-task addresses   │──▶ Fulcrum (Electrum): balances,
            │ Nostr relays            │ payment-builder.js  unsigned tx  │    unspent coins, broadcast
            │ (end-to-end encrypted)  │ audit.js    hash-chained log     │
 ┌──────────▼───────────┐            └──────────────────────────────────┘
 │ Customer's wallet    │  signs the server-built transaction; the server checks it pays the task in full, then broadcasts it
 └──────────────────────┘
```
- **No private keys on the server.** Payments go to addresses derived from the owner's wallet public key (an xpub the owner shares
  by pairing their wallet on `/owner`), or to one static owner address. Only never-used addresses are handed out, within the BIP44
  gap limit of 20, so the owner's wallet restored from its seed still finds every payment.
- **WizardConnect payment.** The page pairs with the customer's wallet over WizardConnect's relays. The server builds the exact
  transaction from the customer's coins (it reads their xpubs, never a key); the wallet shows it and signs with
  SIGHASH_ALL | FORKID | UTXOS; the server checks the signed transaction pays the task's address the full amount, then broadcasts it.
- **Static-address fallback.** With one owner address instead of an xpub, each open task gets its own amount (price + 1–999 sats)
  and each on-chain output can settle only one task.
- **Audit log.** Each entry carries the hash of the previous one; an edited log refuses new entries. Tasks are named by a hash of
  their id (`ref`), because the id itself unlocks the paid result.

## A worked example (live demo, chipnet, 27 October 2026)
- **Task:** "Explain in three short bullet points why Bitcoin Cash fees suit paying an AI agent per task.", offered 1,500 sats.
- **Policy:** AUTO (`auto-small-task`), so the agent ran at once: 68 input and 80 output tokens, about 1.8 s.
- **Payment:** 1,500 sats to the task's own address, chipnet transaction
  `6aa04ea382fc72b0bea865956c8cd9bce607ee41a42a1b4f70e3a6bee69650b2`.
- **Result released** (audit ref `0ec45e1e1a2b82fe`):
  > - **Low fees:** Bitcoin Cash transactions typically cost very little, making small per-task payments economically practical.
  > - **Fast settlement:** Payments can confirm quickly, allowing an AI agent to receive compensation and continue working without long delays.
  > - **Permissionless automation:** An agent can send and receive BCH programmatically, enabling direct machine-to-machine payments without relying on traditional payment processors.

Try it yourself on chipnet: get test coins (for example from the community faucet at tbch.googol.cash, network "chipnet"), submit a
task, and pay it either with a WizardConnect wallet that has a chipnet mode or by sending the exact amount to the payment link.

## Run it
Node 22 or newer:
```
npm install
npm run build        # bundles the WizardConnect wallet code for the browser
REVIEW_TOKEN=<random secret, 24+ characters> AGENT_MODE=echo node src/server.js
```
Open http://localhost:8787/owner, enter the token and pair a chipnet wallet (or set one receive address), then use
http://localhost:8787. `AGENT_MODE=echo` answers with a test echo; for a real model set `AGENT_API_URL` (an OpenAI-compatible
`/v1` base), `AGENT_API_KEY`, `AGENT_MODEL` and optionally `AGENT_REASONING_EFFORT`. The owner accepts held tasks with
`POST /api/tasks/<id>/review` and the header `x-review-token`.

Settings (environment): `NETWORK` (`chipnet` default, `mainnet`), `HD_PUBLIC_KEY` + `HD_PUBLIC_KEY_PATH` (`account` for
m/44'/145'/0', `receive` for its /0 chain) or `RECEIVE_ADDRESS`, `MIN_PRICE_SATS`, `AUTO_MAX_SATS`, `MAX_PRICE_SATS`,
`PAYMENT_WINDOW_HOURS`, `TASKS_PER_IP_HOUR`, `TASKS_PER_DAY`, `AGENT_DAILY_TOKENS`, `TRUST_PROXY=1` behind a reverse proxy,
`DATA_DIR`, `PORT`.

Container: `docker build -t pay-per-task-agent .` (runs as a non-root user, read-only friendly, data in the `/data` volume).

## Mainnet
A second instance of the same image runs with `NETWORK=mainnet` on https://payagent.oll4.com:4952 (planned; it goes live with the
owner's wallet):
- payments go to the owner's own wallet: one static receive address first, a paired wallet later;
- small limits for real money: 1,000 to 100,000 sats per task, anything above 20,000 waits for the owner, 3 new tasks per client
  per hour, 50 per day;
- the echo test agent refuses to start on mainnet, so a paying customer always gets the real model;
- the chipnet demo stays open for anyone who wants to try it without real money.

## Spend controls
- **Before the model runs:** the policy refuses or holds tasks by price and content; new tasks are limited per client per hour
  (`TASKS_PER_IP_HOUR`) and per day overall (`TASKS_PER_DAY`); task text is at most 4,000 characters.
- **The model's budget:** every answer's token count comes from the endpoint's own usage report and is stored with the task; once
  the day's total reaches `AGENT_DAILY_TOKENS`, new tasks are refused until 00:00 UTC. The count survives restarts.
- **Answer length:** kept short by instruction (under 300 words, never over 600) and a low reasoning effort. A length parameter is
  sent too, but some backends ignore every length parameter (we measured one that did), so the budget above is the real limit.
- **The demo's key** also has its own daily spending cap at the model gateway, as a last backstop.
- **Chain reads:** each task's address is read at most once every 3 seconds, however often a page polls.

## Security
Strict Content-Security-Policy (own scripts only; WebAssembly for the signing library; the two WizardConnect relays), no inline
scripts, `nosniff`, no referrer, no framing. The owner routes and the task list need the owner token (compared in constant time).
The audit log names tasks only by a hash of their id. Inputs are validated at the boundary; request bodies are size-capped.

## Tests
`npm test`: policy, audit tampering and the hash-only log, address allocation (gap limit, reuse, late payments, static fallback),
the payment builder, a WizardConnect-style signature checked by the BCH virtual machine, the daily token budget, rate limits,
mainnet settings, the HTTP and owner routes and the security headers.
Opt-in, with network:
- `BROWSER_E2E=1`: the real pages in headless Chrome (system Chrome, `CHROME_PATH` to override) under their CSP, on chipnet: the
  owner pairs a shop wallet on `/owner`, a customer pays a task with the WizardConnect button.
- `RELAY_E2E=1`: owner pairing and payment over the public WizardConnect relays.
- `CHIPNET_E2E=1`: a whole payment on chipnet with a test-only wallet whose seed stays in `data/` (never committed).
- `CHIPNET_LIVE=1`: reads a fresh address on chipnet.
