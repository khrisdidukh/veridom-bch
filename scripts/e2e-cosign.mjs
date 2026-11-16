// End-to-end check on chipnet of two-signature actions across two "devices":
//   1. WizardConnect wallet (homeowner) signs first, a local key (inspector) co-signs from the link;
//   2. a local key (inspector) signs first, the WizardConnect wallet (homeowner) co-signs from the link.
import fs from 'node:fs';
import WS from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { hexToBin } from '@bitauth/libauth';

if (process.env.HTTPS_PROXY) {
  const agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
  globalThis.WebSocket = class extends WS { constructor(url, protocols) { super(url, protocols, { agent }); } };
}
const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
const quiet = console.log; console.log = (...a) => { if (!String(a[0]).startsWith('[')) quiet(...a); };

const { connectWizard } = await import('../src/lib/wallets.js');
const { startDevWallet } = await import('./dev-wallet.mjs');
const { restProvider, EXPLORER } = await import('../src/lib/providers.js');
const { localParty } = await import('../src/lib/party.js');
const { createEscrow, buildFund, buildCosign, readState } = await import('../src/lib/escrow.js');
const { SECOND_SLOT, encodeRequest, decodeRequest, inspectRequest, completeLocally } = await import('../src/lib/cosign.js');

const provider = restProvider('chipnet');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const keys = JSON.parse(fs.readFileSync(new URL('../keys/chipnet.json', import.meta.url), 'utf8'));
const inspector = localParty(keys.inspector.privateKeyHex, 'chipnet');
const contractor = localParty(keys.contractor.privateKeyHex, 'chipnet');
const proof = { network: 'chipnet', steps: {} };
const record = (name, txid, note) => { proof.steps[name] = { txid, explorer: EXPLORER.chipnet + txid, note }; console.log('ok', name, txid); };

const pairing = connectWizard('chipnet');
startDevWallet(pairing.uri);
const wallet = await Promise.race([pairing.ready, sleep(40000).then(() => { throw new Error('pairing timed out'); })]);
const coins = async () => (await wallet.coins(provider)).filter((c) => !c.utxo.token).reduce((s, c) => s + c.utxo.satoshis, 0n);
console.log('wallet holds', String(await coins()), 'sats');

const terms = {
  network: 'chipnet', title: 'Co-sign across devices e2e', owner: wallet.keys[0], contractor: contractor.pubkey, inspector: inspector.pubkey,
  retentionBps: 2000, warrantyEnd: 1900000001, token: null,
  milestones: [{ name: 'Stage 1', amount: '3000' }, { name: 'Stage 2', amount: '3000' }],
};
const escrow = createEscrow(terms, provider);
if ((await readState(escrow, provider.getHistory)).milestones.every((m) => m.status === 'unfunded')) {
  record('fund', await wallet.send(await buildFund(escrow, { payerUtxos: await wallet.coins(provider), changeAddress: wallet.address(0) }), { prompt: 'Lock funds' }), 'homeowner wallet locks 2 stages');
  await sleep(3000);
}

// 1. wallet signs first, local inspector completes
{
  const builder = await buildCosign(escrow, 0, {
    first: { role: 'owner', signature: wallet.signatureFor(terms.owner, 0) }, second: { role: 'inspector', signature: SECOND_SLOT }, recipient: 'owner',
  });
  const link = encodeRequest({ terms, target: 0, first: 'owner', second: 'inspector', recipient: 'owner', txHex: await wallet.signPartial(builder, { signers: [terms.owner], prompt: 'Propose refund of stage 1' }) });
  const request = decodeRequest(link);
  const inspected = await inspectRequest(createEscrow(request.terms, provider), request);
  record('refund-wallet-first', await provider.sendRawTransaction(completeLocally(inspected, hexToBin(keys.inspector.privateKeyHex))), `wallet signed first, inspector key co-signed; ${inspected.toRecipient} of ${inspected.moved} sats to the homeowner`);
  await sleep(3000);
}
// 2. local inspector signs first, wallet completes
{
  const builder = await buildCosign(escrow, 1, {
    first: { role: 'inspector', signature: inspector.signature() }, second: { role: 'owner', signature: SECOND_SLOT }, recipient: 'owner',
  });
  const link = encodeRequest({ terms, target: 1, first: 'inspector', second: 'owner', recipient: 'owner', txHex: builder.build() });
  const request = decodeRequest(link);
  const inspected = await inspectRequest(createEscrow(request.terms, provider), request);
  record('refund-wallet-second', await provider.sendRawTransaction(await wallet.complete(inspected, terms.owner, 'Co-sign refund of stage 2')), 'inspector key signed first, wallet co-signed from the link');
  await sleep(3000);
}
const state = await readState(escrow, provider.getHistory);
proof.finalState = state.milestones.map((m) => m.status);
console.log(proof.finalState);
if (proof.finalState.join() !== 'settled,settled') throw new Error('unexpected final state');
fs.writeFileSync(new URL('../proofs/cosign-e2e.json', import.meta.url), JSON.stringify(proof, null, 2) + '\n');
console.log('Cross-device co-sign end-to-end: PASS');
process.exit(0);
