// Chain access. Default is a public Electrum (Fulcrum) server over WebSocket.
// The REST provider is a fallback for places where WebSockets on port 50004 are
// blocked (corporate networks, CI sandboxes); it talks to the public mainnet.cash API.
import { ElectrumNetworkProvider } from 'cashscript';
import { cashAddressToLockingBytecode, binToHex } from '@bitauth/libauth';

const REST_URL = 'https://rest-unstable.mainnet.cash';
const REST_NET = { mainnet: 'mainnet', chipnet: 'testnet' };
export const EXPLORER = {
  mainnet: 'https://explorer.salemkode.com/tx/',
  chipnet: 'https://chipnet.imaginary.cash/tx/',
};

async function rest(path, body) {
  const response = await fetch(`${REST_URL}/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message ?? `The chain service answered ${response.status}.`);
  return data;
}

export function restProvider(network) {
  const net = REST_NET[network];
  const watch = (address) => ({ walletId: `watch:${net}:${address}` });
  return {
    network,
    kind: 'rest',
    async getUtxos(address) {
      const lock = cashAddressToLockingBytecode(address);
      if (typeof lock === 'string') throw new Error(lock);
      const list = await rest('wallet/utxo', watch(address));
      return list.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        satoshis: BigInt(u.satoshis),
        lockingBytecode: binToHex(lock.bytecode),
        ...(u.token ? { token: { category: u.token.category, amount: BigInt(u.token.amount ?? 0), ...(u.token.nft ? { nft: u.token.nft } : {}) } } : {}),
      }));
    },
    async getUtxosForLockingBytecode() { throw new Error('Not supported by the REST provider.'); },
    async getBlockHeight() { throw new Error('Not supported by the REST provider.'); },
    async getRawTransaction(txid) {
      return (await rest('wallet/util/get_raw_transaction', { txHash: txid, network: net })).txHex;
    },
    async sendRawTransaction(txHex) {
      const anyAddress = network === 'mainnet' ? 'bitcoincash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfnhks603' : 'bchtest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqdpn3jdgd';
      const { txId } = await rest('wallet/submit_transaction', { ...watch(anyAddress), transactionHex: txHex, awaitPropagation: false });
      // The REST service answers with a transaction id even when the node refuses the
      // transaction, so confirm that the network really knows it before reporting success.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((r) => { setTimeout(r, 700 * (attempt + 1)); });
        try { if (await this.getRawTransaction(txId)) return txId; } catch { /* not there yet */ }
      }
      throw new Error('The network did not accept this transaction (it may be time-locked or its coins were already spent).');
    },
    async getHistoryCount(address) {
      return (await rest('wallet/get_history', { ...watch(address), count: 1 })).length;
    },
  };
}

export function electrumProvider(network) {
  const provider = new ElectrumNetworkProvider(network);
  provider.kind = 'electrum';
  provider.getHistoryCount = async (address) => (await provider.performRequest('blockchain.address.get_history', address)).length;
  return provider;
}

/** Electrum first; if it cannot connect within a few seconds, use REST. */
export async function connect(network, prefer) {
  if (prefer === 'rest') return restProvider(network);
  const provider = electrumProvider(network);
  try {
    await Promise.race([
      provider.getBlockHeight(),
      new Promise((_, reject) => { setTimeout(() => reject(new Error('timeout')), 6000); }),
    ]);
    return provider;
  } catch {
    return restProvider(network);
  }
}
