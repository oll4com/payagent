// A chipnet-only test wallet for the end-to-end test: its seed lives in data/test-wallet.json (mode 600, never committed,
// never used for real funds). It answers WizardConnect sign requests the way the protocol requires (SIGHASH_ALL|FORKID|UTXOS).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  binToHex, decodeTransaction, deriveHdPath, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeDataPush,
  encodeHdPublicKey, encodeTransaction, generateRandomBytes, generateSigningSerializationBCH, hash256, hdPublicKeyToP2pkhCashAddress,
  hexToBin, secp256k1, SigningSerializationTypeBCH
} from '@bitauth/libauth';
import { WalletConnectionManager } from '@wizardconnect/wallet';

const SEED_FILE = new URL('../data/test-wallet.json', import.meta.url);
const FLAG = SigningSerializationTypeBCH.allOutputsAllUtxos;

export function loadTestWallet() {
  if (!existsSync(SEED_FILE)) {
    mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
    writeFileSync(SEED_FILE, JSON.stringify({ seed: binToHex(generateRandomBytes(32)), note: 'chipnet test wallet only' }), { mode: 0o600 });
  }
  const master = deriveHdPrivateNodeFromSeed(hexToBin(JSON.parse(readFileSync(SEED_FILE, 'utf8')).seed));
  const chain = (path) => deriveHdPath(master, path);
  const xpub = (path) => encodeHdPublicKey({ network: 'testnet', node: deriveHdPublicNode(chain(path)) }).hdPublicKey;
  const paths = { receive: "m/44'/145'/0'/0", change: "m/44'/145'/0'/1" };
  return {
    // Account 0 pays (the customer); account 1's receive chain is the shop's receiving xpub.
    customerPaths: Object.entries(paths).map(([name, path]) => ({ name, xpub: xpub(path) })),
    shopReceiveXpub: xpub("m/44'/145'/1'/0"),
    fundingAddress: hdPublicKeyToP2pkhCashAddress({ hdPublicKey: xpub(paths.receive), addressIndex: 0, prefix: 'bchtest' }).address,
    sign(request, inputPaths) {
      const bytes = (v) => (typeof v === 'string' ? hexToBin(v) : v);
      const transaction = typeof request.transaction === 'string' ? decodeTransaction(hexToBin(request.transaction)) : request.transaction;
      const sourceOutputs = request.sourceOutputs.map((o) => ({
        ...o, lockingBytecode: bytes(o.lockingBytecode), unlockingBytecode: bytes(o.unlockingBytecode),
        outpointTransactionHash: bytes(o.outpointTransactionHash), valueSatoshis: BigInt(String(o.valueSatoshis).replace(/\D/g, ''))
      }));
      for (const [inputIndex, pathName, addressIndex] of inputPaths) {
        const key = deriveHdPath(master, `${paths[pathName]}/${addressIndex}`).privateKey;
        const context = { inputIndex, sourceOutputs, transaction };
        const serialization = generateSigningSerializationBCH(context, { coveredBytecode: sourceOutputs[inputIndex].lockingBytecode, signingSerializationType: Uint8Array.of(FLAG) });
        const signature = secp256k1.signMessageHashSchnorr(key, hash256(serialization));
        const publicKey = secp256k1.derivePublicKeyCompressed(key);
        transaction.inputs[inputIndex].unlockingBytecode = Uint8Array.from([...encodeDataPush(Uint8Array.from([...signature, FLAG])), ...encodeDataPush(publicKey)]);
      }
      return binToHex(encodeTransaction(transaction));
    }
  };
}

// The wallet side of WizardConnect, answering every sign request with the test wallet's signature.
export function connectTestWallet(wallet, uri) {
  const notUsed = () => { throw new Error('not used by the test wallet'); };
  const manager = new WalletConnectionManager({
    walletName: 'Chipnet test wallet', walletIcon: '',
    getRelayPrivateKey: (() => { const k = generateRandomBytes(32); return () => k; })(),
    getPublicKey: notUsed,
    getXpub: (path) => wallet.customerPaths[path === 1 ? 1 : 0].xpub,
    signTransaction: notUsed
  });
  manager.on('pendingSignRequest', ({ connectionId, request }) => {
    try {
      manager.sendSignResponse(connectionId, request.sequence, wallet.sign(request.transaction, request.inputPaths));
    } catch (error) {
      manager.sendSignError(connectionId, request.sequence, error.message);
    }
  });
  manager.connect(uri);
  return manager;
}
