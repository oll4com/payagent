// Browser side of a WizardConnect payment: pair with the customer's wallet by QR, let the server build the payment from
// the wallet's xpubs, have the wallet sign it, hand the signed transaction back to the server to check and broadcast.
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { hexToBin } from '@bitauth/libauth';
import qrcode from 'qrcode-generator';

const post = async (path, body) => {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `request failed (${response.status})`);
  return value;
};

// The server sends bytes as hex and satoshis as decimal strings; libauth wants Uint8Array and bigint.
const reviveSourceOutput = (o) => ({
  ...o,
  outpointTransactionHash: hexToBin(o.outpointTransactionHash),
  lockingBytecode: hexToBin(o.lockingBytecode),
  unlockingBytecode: hexToBin(o.unlockingBytecode),
  valueSatoshis: BigInt(o.valueSatoshis)
});

export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Alphanumeric');
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

export async function payWithWallet(taskId, { onPairing, onStatus }) {
  const manager = new DappConnectionManager('Pay-per-task Agent', undefined, { session: false });
  const relay = initiateDappRelay((payload) => manager.updateConnection(payload.client, payload.status), {});
  manager.attachRelay(relay);
  onPairing(relay.uri, relay.qrUri);
  try {
    await new Promise((resolve, reject) => {
      manager.on('walletready', resolve);
      manager.on('disconnect', (_, message) => reject(new Error(message ?? 'the wallet disconnected')));
    });
    onStatus(`Connected to ${manager.walletName ?? 'your wallet'}. Preparing the payment…`);
    const request = await post(`/api/tasks/${taskId}/payment-request`, { paths: manager.getSessionPaths() });
    onStatus('Approve the payment in your wallet.');
    const signed = await manager.signTransaction({
      transaction: {
        transaction: request.transaction,
        sourceOutputs: request.sourceOutputs.map(reviveSourceOutput),
        userPrompt: request.userPrompt,
        broadcast: false
      },
      inputPaths: request.inputPaths
    });
    if (signed.error) throw new Error(signed.error);
    onStatus('Sending the payment…');
    return await post(`/api/tasks/${taskId}/payment`, { signedTransaction: signed.signedTransaction });
  } finally {
    manager.sendDisconnect('payment finished').catch(() => {});
    relay.cleanup();
    manager.destroy();
  }
}
