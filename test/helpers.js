import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateHdPrivateNode, deriveHdPublicNode, encodeHdPublicKey } from '@bitauth/libauth';
import { createAuditLog } from '../src/audit.js';
import { createService } from '../src/service.js';
import { loadConfig } from '../src/config.js';

// A throwaway chipnet key made per test run; never funded, never stored.
export const testHdPublicKey = () =>
  encodeHdPublicKey({ network: 'testnet', node: deriveHdPublicNode(generateHdPrivateNode().hdPrivateNode) }).hdPublicKey;

export function setup({ agent = async (d) => `done: ${d}`, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ppta-'));
  const config = loadConfig({ HD_PUBLIC_KEY: testHdPublicKey(), REVIEW_TOKEN: 'reviewer-secret', DATA_DIR: dir, ...env });
  const received = new Map();
  const chain = { receivedSats: async (address) => received.get(address) ?? 0 };
  const audit = createAuditLog(join(dir, 'audit.jsonl'));
  const service = createService({ config, audit, chain, agent, storePath: join(dir, 'tasks.json') });
  return { dir, config, audit, service, pay: (address, sats) => received.set(address, (received.get(address) ?? 0) + sats) };
}
