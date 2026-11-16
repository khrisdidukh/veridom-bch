import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { generatePrivateKey, binToHex } from '@bitauth/libauth';
import { localParty } from '../src/lib/party.js';
import { createEscrow } from '../src/lib/escrow.js';

export const WARRANTY_END = 1900000000; // a unix timestamp in 2030
export const TUSD = 'aa'.repeat(32);

export function setup({ token = false, retentionBps = 500, amounts = ['100000', '200000', '50000'] } = {}) {
  const provider = new MockNetworkProvider();
  provider.network = 'chipnet';
  const [owner, contractor, inspector, stranger] = [0, 1, 2, 3].map(() => localParty(binToHex(generatePrivateKey()), 'chipnet'));
  const terms = {
    network: 'chipnet',
    title: 'Family house, Franzen',
    owner: owner.pubkey, contractor: contractor.pubkey, inspector: inspector.pubkey,
    retentionBps, warrantyEnd: WARRANTY_END,
    token: token ? { category: TUSD, symbol: 'tUSD', decimals: 2 } : null,
    milestones: amounts.map((amount, i) => ({ name: ['Foundation', 'Shell and roof', 'Interior'][i] ?? `Stage ${i + 1}`, amount })),
  };
  const escrow = createEscrow(terms, provider);
  // give everybody some plain BCH for fees, and the owner the project budget
  for (const p of [owner, contractor, inspector, stranger]) provider.addUtxo(p.address, randomUtxo({ satoshis: 50000n }));
  provider.addUtxo(owner.address, randomUtxo({ satoshis: 1000000n }));
  if (token) provider.addUtxo(owner.address, randomUtxo({ satoshis: 1000n, token: { category: TUSD, amount: 1000000n } }));
  return { provider, owner, contractor, inspector, stranger, terms, escrow };
}

export async function balance(provider, address, category) {
  const utxos = await provider.getUtxos(address);
  if (category) return utxos.filter((u) => u.token?.category === category).reduce((s, u) => s + u.token.amount, 0n);
  return utxos.filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);
}
