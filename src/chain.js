// Reads and broadcasts on Bitcoin Cash through an Electrum (Fulcrum) server; it never holds a key.
import { ElectrumClient } from '@electrum-cash/network';

export function createElectrumChain(host) {
  let client;
  const connected = async () => {
    if (!client) {
      client = new ElectrumClient('pay-per-task-agent', '1.4.1', host);
      await client.connect();
    }
    return client;
  };
  return {
    // Confirmed plus mempool satoshis received on the address (BCH 0-conf is the accepted norm for small payments).
    async receivedSats(address) {
      const result = await (await connected()).request('blockchain.address.get_balance', address);
      if (result instanceof Error) throw result;
      return Number(result.confirmed ?? 0) + Number(result.unconfirmed ?? 0);
    },
    async tipHeight() {
      const tip = await (await connected()).request('blockchain.headers.get_tip');
      if (tip instanceof Error) throw tip;
      return tip.height;
    },
    async listUnspent(address) {
      const result = await (await connected()).request('blockchain.address.listunspent', address);
      if (result instanceof Error) throw result;
      return result;
    },
    async broadcast(hex) {
      const result = await (await connected()).request('blockchain.transaction.broadcast', hex);
      if (result instanceof Error) throw Object.assign(new Error(`broadcast refused: ${result.message}`), { status: 422 });
      return result;
    },
    close: () => client?.disconnect()
  };
}
