// Watch-only Bitcoin Cash: per-task receive addresses come from an HD public key (the server never holds a private key),
// and payments are read from an Electrum (Fulcrum) server.
import { hdPublicKeyToP2pkhCashAddress } from '@bitauth/libauth';
import { ElectrumClient } from '@electrum-cash/network';

export function taskAddress(hdPublicKey, index, prefix) {
  return hdPublicKeyToP2pkhCashAddress({ hdPublicKey, addressIndex: index, prefix }).address;
}

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
    close: () => client?.disconnect()
  };
}
