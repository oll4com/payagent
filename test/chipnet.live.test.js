// Opt-in: CHIPNET_LIVE=1 npm test reads a fresh address on the real chipnet Electrum server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElectrumChain } from '../src/chain.js';
import { hdAddress } from '../src/receiver.js';
import { testHdPublicKey } from './helpers.js';

test('chipnet: a fresh task address has received nothing', { skip: process.env.CHIPNET_LIVE !== '1' }, async () => {
  const chain = createElectrumChain('chipnet.imaginary.cash');
  try {
    assert.equal(await chain.receivedSats(hdAddress({ xpub: testHdPublicKey(), path: 'account' }, 0, 'bchtest')), 0);
  } finally {
    await chain.close();
  }
});
