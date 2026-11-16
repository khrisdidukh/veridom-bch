// End-to-end check of the WizardConnect path on chipnet:
// app-side wallet code (src/lib/wallets.js) <-> real relay <-> headless dev wallet.
// Proves that funding, approving and the two-signature refund work with wallet-side signing.
import fs from 'node:fs';
import WS from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { TransactionBuilder } from 'cashscript';

if (process.env.HTTPS_PROXY) { // sandboxed CI: route the relay WebSocket through the proxy
  const agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
  globalThis.WebSocket = class extends WS { constructor(url, protocols) { super(url, protocols, { agent }); } };
}
const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };

const { connectWizard } = await import('../src/lib/wallets.js');
const { startDevWallet } = await import('./dev-wallet.mjs');
const { restProvider, EXPLORER } = await import('../src/lib/providers.js');
const { localParty } = await import('../src/lib/party.js');
const { createEscrow, buildFund, buildRelease, buildCosign, readState } = await import('../src/lib/escrow.js');

const provider = restProvider('chipnet');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const proofFile = new URL('../proofs/wizardconnect-e2e.json', import.meta.url);
const proof = { network: 'chipnet', relay: 'relay.riften.net', steps: {} };
const record = (name, txid, note) => { proof.steps[name] = { txid, explorer: EXPLORER.chipnet + txid, note }; console.log('ok', name, txid); };

const pairing = connectWizard('chipnet');
startDevWallet(pairing.uri, (m) => console.log('  wallet:', m));
const wallet = await Promise.race([pairing.ready, sleep(40000).then(() => { throw new Error('pairing timed out'); })]);
console.log('paired with', wallet.label, '| seat addresses', wallet.address(0), wallet.address(1), wallet.address(2));

// chipnet coins for the wallet's first address: public API faucet first, test keys as a fallback
const coins = async () => (await wallet.coins(provider)).filter((c) => !c.utxo.token).reduce((s, c) => s + c.utxo.satoshis, 0n);
if (await coins() < 6800n) {
  await fetch('https://rest-unstable.mainnet.cash/faucet/get_testnet_bch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cashaddr: wallet.address(0) }) });
  await sleep(4000);
}
if (await coins() < 6800n) {
  const keys = JSON.parse(fs.readFileSync(new URL('../keys/chipnet.json', import.meta.url), 'utf8'));
  const donor = localParty(keys.owner.privateKeyHex, 'chipnet');
  const b = new TransactionBuilder({ provider });
  for (const { utxo, unlocker } of await donor.utxos(provider)) if (!utxo.token) b.addInput(utxo, unlocker);
  b.addOutput({ to: wallet.address(0), amount: 6800n - await coins() + 300n }).addBchChangeOutputIfNeeded({ to: donor.address, feeRate: 1.1 });
  console.log('top-up', (await b.send()).txid);
  await sleep(3000);
}
console.log('wallet holds', String(await coins()), 'sats');

const escrow = createEscrow({
  network: 'chipnet', title: 'WizardConnect e2e', owner: wallet.keys[0], contractor: wallet.keys[1], inspector: wallet.keys[2],
  retentionBps: 2000, warrantyEnd: 1900000000, token: null,
  milestones: [{ name: 'Stage 1', amount: '3000' }, { name: 'Stage 2', amount: '3000' }],
}, provider);

const before = await readState(escrow, provider.getHistory);
if (before.milestones.every((m) => m.status === 'unfunded')) record('fund', await wallet.send(
  await buildFund(escrow, { payerUtxos: await wallet.coins(provider), changeAddress: wallet.address(0) }),
  { prompt: 'Lock funds for 2 milestones' },
), 'P2PKH inputs signed by the wallet');
await sleep(3000);

record('release', await wallet.send(
  await buildRelease(escrow, 0, { approver: 'owner', signature: wallet.signatureFor(wallet.keys[0]), feeUtxos: await wallet.coins(provider), changeAddress: wallet.address(0) }),
  { signers: [wallet.keys[0]], prompt: 'Approve milestone 1' },
), 'covenant input: wallet fills the signature placeholder');
await sleep(3000);

record('refund-2-of-3', await wallet.send(
  await buildCosign(escrow, 1, {
    first: { role: 'owner', signature: wallet.signatureFor(wallet.keys[0], 0) },
    second: { role: 'inspector', signature: wallet.signatureFor(wallet.keys[2], 1) },
    recipient: 'owner',
  }),
  { signers: [wallet.keys[0], wallet.keys[2]], prompt: 'Refund milestone 2' },
), 'two signatures collected in two wallet requests');
await sleep(3000);

const state = await readState(escrow, provider.getHistory);
proof.finalState = { milestones: state.milestones.map((m) => m.status), retentionHeld: String(state.retention.held) };
console.log(proof.finalState);
if (proof.finalState.milestones.join() !== 'paid,settled' || state.retention.held !== 600n) throw new Error('unexpected final state');
fs.writeFileSync(proofFile, JSON.stringify(proof, null, 2) + '\n');
console.log('WizardConnect end-to-end: PASS');
process.exit(0);
