import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createAuditLog, verifyChain } from './audit.js';
import { createElectrumChain } from './chain.js';
import { createAgent } from './agent.js';
import { createService } from './service.js';
import { checkAddress, checkXpub, createOwnerStore, tokenAddress } from './receiver.js';

const MAX_BODY = 256 * 1024; // a signed transaction with many inputs

// The pages run only their own scripts; the wallet code needs WebAssembly (libauth's secp256k1) and the two WizardConnect relays.
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
    "connect-src 'self' wss://relay.riften.net wss://relay.cauldron.quest", "object-src 'none'", "base-uri 'none'",
    "form-action 'none'", "frame-ancestors 'none'"
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/presentation': ['presentation.html', 'text/html; charset=utf-8'],
  '/owner': ['owner.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/owner.js': ['owner.js', 'text/javascript; charset=utf-8'],
  '/deck.js': ['deck.js', 'text/javascript; charset=utf-8'],
  '/wallet.bundle.js': ['wallet.bundle.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon.svg', 'image/svg+xml']
};

// Fixed windows kept in memory: a restart forgets them, which only ever lets a few extra tasks through.
export function createTaskLimiter({ tasksPerIpHour, tasksPerDay }, now = () => Date.now()) {
  const perIp = new Map();
  let day = { start: 0, count: 0 };
  return (ip) => {
    const t = now();
    if (t - day.start >= 86_400_000) day = { start: t, count: 0 };
    const recent = (perIp.get(ip) ?? []).filter((at) => t - at < 3_600_000);
    if (recent.length >= tasksPerIpHour) return 'too many tasks from your address this hour; try again later';
    if (day.count >= tasksPerDay) return 'the demo has reached its task limit for today; try again tomorrow';
    recent.push(t);
    perIp.set(ip, recent);
    day.count += 1;
    return null;
  };
}

// A paying customer on mainnet must never get the test agent's echo by accident.
export function refuseEchoOnMainnet(config, env) {
  if (config.network === 'mainnet' && env.AGENT_MODE === 'echo' && env.ALLOW_ECHO_ON_MAINNET !== '1') {
    throw new Error('AGENT_MODE=echo is refused on mainnet (set ALLOW_ECHO_ON_MAINNET=1 only for a private test)');
  }
}

export function createApp({ config, service, audit, owner }) {
  const files = new Map();
  const file = (name) => {
    if (!files.has(name)) files.set(name, readFileSync(new URL(`../public/${name}`, import.meta.url)));
    return files.get(name);
  };
  const limitTask = createTaskLimiter(config);
  // Behind a reverse proxy (TRUST_PROXY=1, the port reachable only by the proxy) the client is the last X-Forwarded-For entry.
  const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for']?.split(',').pop().trim()) || req.socket.remoteAddress;
  const isReviewer = (req) => {
    const given = Buffer.from(String(req.headers['x-review-token'] ?? ''));
    const want = Buffer.from(config.reviewToken);
    return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
  };
  const body = (req) => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) reject(Object.assign(new Error('body too large'), { status: 413 }));
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
  });

  return createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' });
      // Wallet requests carry bytes and satoshi bigints: bytes go as hex, bigints as decimal strings.
      res.end(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)));
    };
    try {
      const { pathname } = new URL(req.url, 'http://local');
      const [, api, resource, id, action] = pathname.split('/');
      if (req.method === 'GET' && Object.hasOwn(STATIC, pathname)) {
        const [name, type] = STATIC[pathname];
        const content = file(name);
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type });
        return res.end(content);
      }
      if (api !== 'api') return send(404, { error: 'not found' });
      if (resource === 'config' && req.method === 'GET') {
        // Donations (BLAZE community votes) go to the owner's static address in its token-aware form until one is set explicitly.
        const r = owner.current();
        const donation = config.donationAddress || (r?.mode === 'static' ? tokenAddress(r.address) : null);
        return send(200, {
          network: config.network, minPriceSats: config.minPriceSats, autoMaxSats: config.autoMaxSats, maxPriceSats: config.maxPriceSats,
          repoUrl: config.repoUrl || null, donationAddress: donation
        });
      }
      if (resource === 'audit' && req.method === 'GET') {
        const entries = audit.read();
        return send(200, { verified: verifyChain(entries), entries });
      }
      // The owner sets where payments go: a wallet paired over WizardConnect (its receive xpub) or one static address.
      if (resource === 'owner') {
        if (!isReviewer(req)) return send(403, { error: 'owner token required' });
        if (!id && req.method === 'GET') {
          const r = owner.current();
          return send(200, { receiver: r && { mode: r.mode, path: r.path, xpub: r.xpub && `${r.xpub.slice(0, 12)}…${r.xpub.slice(-6)}`, address: r.address } });
        }
        if (id === 'wallet' && req.method === 'POST') {
          const { xpub, path = 'receive' } = await body(req);
          owner.save({ hd: checkXpub(xpub, path, config.network) });
          audit.append({ status: 'OWNER_WALLET_SET', path });
          return send(200, { ok: true });
        }
        if (id === 'wallet' && req.method === 'DELETE') {
          owner.save({ hd: null });
          audit.append({ status: 'OWNER_WALLET_REMOVED' });
          return send(200, { ok: true });
        }
        if (id === 'static-address' && req.method === 'POST') {
          owner.save({ staticAddress: checkAddress((await body(req)).address, config.addressPrefix) });
          audit.append({ status: 'OWNER_STATIC_ADDRESS_SET' });
          return send(200, { ok: true });
        }
        return send(404, { error: 'not found' });
      }
      if (resource !== 'tasks') return send(404, { error: 'not found' });
      // The list hands out task ids, and an id unlocks a paid result: reviewers only.
      if (!id && req.method === 'GET') return isReviewer(req) ? send(200, service.list()) : send(403, { error: 'reviewer token required' });
      if (!id && req.method === 'POST') {
        const limited = limitTask(clientIp(req));
        if (limited) return send(429, { error: limited });
        return send(201, await service.submit(await body(req)));
      }
      if (id && !action && req.method === 'GET') return send(200, service.view(id));
      if (action === 'check' && req.method === 'POST') return send(200, await service.checkPayment(id));
      if (action === 'payment-request' && req.method === 'POST') return send(200, await service.paymentRequest(id, (await body(req)).paths));
      if (action === 'payment' && req.method === 'POST') return send(200, await service.submitPayment(id, (await body(req)).signedTransaction));
      if (action === 'review' && req.method === 'POST') {
        if (!isReviewer(req)) return send(403, { error: 'reviewer token required' });
        const { approve, reviewer = 'reviewer' } = await body(req);
        return send(200, await service.review(id, approve === true, String(reviewer).slice(0, 80)));
      }
      return send(404, { error: 'not found' });
    } catch (error) {
      send(error.status ?? 500, { error: error.status ? error.message : 'internal error' });
      if (!error.status) console.error(error);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  refuseEchoOnMainnet(config, process.env);
  if (config.hdPublicKey) checkXpub(config.hdPublicKey, config.hdPublicKeyPath, config.network);
  if (config.receiveAddress) config.receiveAddress = checkAddress(config.receiveAddress, config.addressPrefix);
  if (!config.reviewToken || config.reviewToken.length < 24) throw new Error('set REVIEW_TOKEN to a random secret of 24+ characters');
  mkdirSync(config.dataDir, { recursive: true });
  const audit = createAuditLog(join(config.dataDir, 'audit.jsonl'));
  const owner = createOwnerStore(join(config.dataDir, 'owner.json'), config);
  const service = createService({
    config, audit, owner, chain: createElectrumChain(config.electrumHost), agent: createAgent(process.env, config.agentMaxTokens),
    storePath: join(config.dataDir, 'tasks.json')
  });
  createApp({ config, service, audit, owner }).listen(config.port, () => console.log(`pay-per-task agent on :${config.port} (${config.network})`));
}
