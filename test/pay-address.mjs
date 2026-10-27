// Manual chipnet check: pay <address> <sats> from the chipnet test wallet (account 0) the way a WizardConnect wallet would,
// and broadcast it. Used to test the deployed demo, which this host cannot open (no hairpin NAT). Usage: node test/pay-address.mjs bchtest:... 1500
import { buildPaymentRequest } from '../src/payment-builder.js';
import { createElectrumChain } from '../src/chain.js';
import { loadTestWallet } from './test-wallet.js';

const [address, sats] = process.argv.slice(2);
if (!/^bchtest:q[0-9a-z]{41}$/.test(address ?? '') || !(Number(sats) > 0)) throw new Error('usage: pay-address.mjs <bchtest address> <sats>');
const wallet = loadTestWallet();
const chain = createElectrumChain('chipnet.imaginary.cash');
try {
  const xpubs = Object.fromEntries(wallet.customerPaths.map((p) => [p.name, p.xpub]));
  const request = await buildPaymentRequest({ xpubs, task: { id: 'manual-check', address, amountSats: Number(sats) }, chain, prefix: 'bchtest' });
  const txid = await chain.broadcast(wallet.sign({ transaction: request.transaction, sourceOutputs: request.sourceOutputs }, request.inputPaths));
  console.log(JSON.stringify({ txid }));
} finally {
  await chain.close();
  process.exit(0);
}
