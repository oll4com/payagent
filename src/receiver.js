// Where customers pay. The owner's wallet is either an HD public key (one fresh address per task, the server holds no
// private key) or, as a fallback, one static receive address where each task gets a unique amount instead.
import { cashAddressToLockingBytecode, decodeCashAddress, decodeHdPublicKey, encodeCashAddress, hdPublicKeyToP2pkhCashAddress } from '@bitauth/libauth';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const NETWORK_OF = { chipnet: 'testnet', mainnet: 'mainnet' };
const bad = (message) => Object.assign(new Error(message), { status: 400 });

// `account`: the BIP44 account xpub m/44'/145'/0' (addresses at 0/i); `receive`: its receive chain m/44'/145'/0'/0, which
// is what a WizardConnect wallet shares (addresses at i). Both give the same addresses.
export function checkXpub(xpub, path, network) {
  if (!['account', 'receive'].includes(path)) throw bad('path must be account or receive');
  const decoded = decodeHdPublicKey(String(xpub ?? ''), { throwErrors: false });
  if (typeof decoded === 'string') throw bad(`not an HD public key: ${decoded}`);
  if (decoded.network !== NETWORK_OF[network]) throw bad(`this key is for ${decoded.network}, the server runs ${network}`);
  return { xpub: String(xpub), path };
}

export function checkAddress(address, prefix) {
  const value = String(address ?? '').trim();
  const decoded = cashAddressToLockingBytecode(value.includes(':') ? value : `${prefix}:${value}`);
  if (typeof decoded === 'string') throw bad(`not a cash address: ${decoded}`);
  if (decoded.prefix !== prefix) throw bad(`the address is for ${decoded.prefix}, the server uses ${prefix}`);
  return value.includes(':') ? value : `${prefix}:${value}`;
}

export function hdAddress({ xpub, path }, index, prefix) {
  return hdPublicKeyToP2pkhCashAddress({ hdPublicKey: xpub, addressIndex: index, prefix, publicDerivationPath: path === 'account' ? '0/i' : 'i' }).address;
}

// The owner's choice is kept in DATA_DIR/owner.json; HD_PUBLIC_KEY / RECEIVE_ADDRESS in the environment are the defaults.
export function createOwnerStore(path, config) {
  const read = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
  return {
    // The active receiver: a paired or configured xpub first, else the static address, else none.
    current() {
      const owner = read();
      if (owner.hd) return { mode: 'hd', ...owner.hd };
      if (config.hdPublicKey) return { mode: 'hd', xpub: config.hdPublicKey, path: config.hdPublicKeyPath };
      const address = owner.staticAddress ?? config.receiveAddress;
      return address ? { mode: 'static', address } : null;
    },
    save(update) { writeFileSync(path, JSON.stringify({ ...read(), ...update }, null, 2), { mode: 0o600 }); }
  };
}

// BLAZE's EMBER2026 votes are CashTokens: the same key's token-aware address (z…) receives them.
export function tokenAddress(address) {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string' || decoded.type !== 'p2pkh') return null;
  return encodeCashAddress({ prefix: decoded.prefix, type: 'p2pkhWithTokens', payload: decoded.payload }).address;
}
