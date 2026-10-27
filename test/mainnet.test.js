import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateHdPrivateNode, deriveHdPublicNode, encodeHdPublicKey } from '@bitauth/libauth';
import { loadConfig } from '../src/config.js';
import { checkAddress, checkXpub, hdAddress, tokenAddress } from '../src/receiver.js';
import { refuseEchoOnMainnet } from '../src/server.js';

const mainnetXpub = () => encodeHdPublicKey({ network: 'mainnet', node: deriveHdPublicNode(generateHdPrivateNode().hdPrivateNode) }).hdPublicKey;

test('mainnet config: bitcoincash addresses, the mainnet Fulcrum, only mainnet keys and addresses', () => {
  const config = loadConfig({ NETWORK: 'mainnet' });
  assert.equal(config.addressPrefix, 'bitcoincash');
  assert.equal(config.electrumHost, 'bch.imaginary.cash');
  const xpub = mainnetXpub();
  assert.deepEqual(checkXpub(xpub, 'account', 'mainnet'), { xpub, path: 'account' });
  const address = hdAddress({ xpub, path: 'account' }, 0, 'bitcoincash');
  assert.match(address, /^bitcoincash:q/);
  assert.equal(checkAddress(address.slice('bitcoincash:'.length), 'bitcoincash'), address, 'prefix added when missing');
  assert.throws(() => checkAddress(hdAddress({ xpub, path: 'account' }, 0, 'bchtest'), 'bitcoincash'), /bchtest/);
  assert.throws(() => checkXpub(xpub, 'account', 'chipnet'), /mainnet/);
  assert.match(tokenAddress(address), /^bitcoincash:z/);
});

test('the echo test agent is refused on mainnet unless explicitly allowed', () => {
  const mainnet = loadConfig({ NETWORK: 'mainnet' });
  assert.throws(() => refuseEchoOnMainnet(mainnet, { AGENT_MODE: 'echo' }), /refused on mainnet/);
  assert.doesNotThrow(() => refuseEchoOnMainnet(mainnet, { AGENT_MODE: 'echo', ALLOW_ECHO_ON_MAINNET: '1' }));
  assert.doesNotThrow(() => refuseEchoOnMainnet(mainnet, {}));
  assert.doesNotThrow(() => refuseEchoOnMainnet(loadConfig({}), { AGENT_MODE: 'echo' }));
});
