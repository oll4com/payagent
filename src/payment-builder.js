// Builds the customer's payment for a WizardConnect wallet to sign. The wallet shared only its path xpubs (`receive`,
// `change`); we find its coins, spend just enough to pay the task address, and send change back to the wallet.
import {
  binToHex, cashAddressToLockingBytecode, decodeTransaction, encodeTransaction, hexToBin, hdPublicKeyToP2pkhCashAddress
} from '@bitauth/libauth';

const SCAN = 20; // shortcut: reads the first 20 addresses of each path; use a real gap-limit scan if wallets report misses.
const DUST = 546n;
const FEE_PER_BYTE = 1n;
const sizeOf = (inputs, outputs) => BigInt(10 + 148 * inputs + 34 * outputs);
const lockingBytecode = (address) => {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw Object.assign(new Error(`bad address: ${decoded}`), { status: 400 });
  return decoded.bytecode;
};

export function pathXpubs(paths) {
  const byName = Object.fromEntries((Array.isArray(paths) ? paths : []).map((p) => [p?.name, p?.xpub]));
  if (typeof byName.receive !== 'string' || typeof byName.change !== 'string') {
    throw Object.assign(new Error('wallet must share its receive and change xpubs'), { status: 400 });
  }
  return { receive: byName.receive, change: byName.change };
}

export async function buildPaymentRequest({ xpubs, task, chain, prefix }) {
  const coins = [];
  for (const path of ['receive', 'change']) {
    for (let index = 0; index < SCAN; index += 1) {
      const address = hdPublicKeyToP2pkhCashAddress({ hdPublicKey: xpubs[path], addressIndex: index, prefix }).address;
      for (const utxo of await chain.listUnspent(address)) {
        if (utxo.token_data) continue; // never spend CashTokens by accident
        coins.push({ path, index, address, txid: utxo.tx_hash, vout: utxo.tx_pos, value: BigInt(utxo.value) });
      }
    }
  }
  coins.sort((a, b) => (b.value > a.value ? 1 : -1));
  const price = BigInt(task.amountSats);
  const chosen = [];
  let total = 0n;
  for (const coin of coins) {
    chosen.push(coin);
    total += coin.value;
    if (total >= price + sizeOf(chosen.length, 2) * FEE_PER_BYTE) break;
  }
  const feeWithChange = sizeOf(chosen.length, 2) * FEE_PER_BYTE;
  const feeNoChange = sizeOf(chosen.length, 1) * FEE_PER_BYTE;
  if (total < price + feeNoChange) throw Object.assign(new Error('wallet balance is too low for this payment'), { status: 402 });

  const outputs = [{ lockingBytecode: lockingBytecode(task.address), valueSatoshis: price }];
  const change = total - price - feeWithChange;
  if (change >= DUST) {
    const changeAddress = hdPublicKeyToP2pkhCashAddress({ hdPublicKey: xpubs.change, addressIndex: 0, prefix }).address;
    outputs.push({ lockingBytecode: lockingBytecode(changeAddress), valueSatoshis: change });
  }
  const inputs = chosen.map((c) => ({ outpointTransactionHash: hexToBin(c.txid), outpointIndex: c.vout, sequenceNumber: 0, unlockingBytecode: Uint8Array.of() }));
  const sourceOutputs = chosen.map((c, i) => ({ ...inputs[i], lockingBytecode: lockingBytecode(c.address), valueSatoshis: c.value }));
  return {
    transaction: binToHex(encodeTransaction({ version: 2, inputs, outputs, locktime: 0 })),
    sourceOutputs,
    inputPaths: chosen.map((c, i) => [i, c.path, c.index]),
    userPrompt: `Pay ${task.amountSats} satoshis for task ${task.id.slice(0, 8)}`
  };
}

// The signed transaction must pay the task address at least the full price before we broadcast it.
export function paysTask(signedHex, task) {
  const tx = decodeTransaction(hexToBin(signedHex));
  if (typeof tx === 'string') return false;
  const target = binToHex(lockingBytecode(task.address));
  return tx.outputs.some((o) => binToHex(o.lockingBytecode) === target && o.valueSatoshis >= BigInt(task.amountSats));
}
