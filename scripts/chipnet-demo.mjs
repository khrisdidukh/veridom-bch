// Runs the whole escrow life cycle on chipnet with the test keys in keys/chipnet.json
// and records every transaction id in proofs/chipnet.json. Safe to run again: finished
// steps are skipped, so the warranty claim can be completed once the timelock has passed.
import fs from 'node:fs';
import { TransactionBuilder } from 'cashscript';
import { restProvider, EXPLORER } from '../src/lib/providers.js';
import { localParty } from '../src/lib/party.js';
import {
  createEscrow, encodeTerms, buildFund, buildRelease, buildClaim, buildCosign, readState, findRetentionUtxos,
} from '../src/lib/escrow.js';

const keys = JSON.parse(fs.readFileSync(new URL('../keys/chipnet.json', import.meta.url), 'utf8'));
const proofFile = new URL('../proofs/chipnet.json', import.meta.url);
const proof = fs.existsSync(proofFile) ? JSON.parse(fs.readFileSync(proofFile, 'utf8')) : { network: 'chipnet', steps: {} };
const save = () => fs.writeFileSync(proofFile, JSON.stringify(proof, null, 2) + '\n');
const provider = restProvider('chipnet');
const P = Object.fromEntries(Object.entries(keys).map(([role, k]) => [role, localParty(k.privateKeyHex, 'chipnet')]));
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const plain = async (party) => (await provider.getUtxos(party.address)).filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);

async function step(name, fn) {
  if (proof.steps[name]?.txid) { console.log('done  ', name, proof.steps[name].txid); return proof.steps[name]; }
  try {
    const result = await fn();
    proof.steps[name] = { ...result, explorer: EXPLORER.chipnet + result.txid, at: new Date().toISOString() };
    save();
    console.log('ok    ', name, result.txid);
    await sleep(2500); // let the indexer see the new coins
    return proof.steps[name];
  } catch (error) {
    console.log('FAILED', name, '-', String(error.message).split('\n')[0].slice(0, 200));
    throw error;
  }
}

/** Make sure a party has enough plain test BCH; other test parties chip in if needed. */
async function ensure(role, need) {
  if (await plain(P[role]) >= need) return;
  for (const other of Object.keys(P).filter((r) => r !== role)) {
    const spare = await plain(P[other]) - 3000n;
    const missing = need - await plain(P[role]);
    if (missing <= 0n) return;
    if (spare < missing + 800n) continue;
    const b = new TransactionBuilder({ provider });
    for (const { utxo, unlocker } of await P[other].utxos(provider)) if (!utxo.token) b.addInput(utxo, unlocker);
    b.addOutput({ to: P[role].address, amount: missing + 300n }).addBchChangeOutputIfNeeded({ to: P[other].address, feeRate: 1.1 });
    console.log('top-up', other, '->', role, (await b.send()).txid);
    await sleep(2500);
  }
  if (await plain(P[role]) < need) throw new Error(`${role} needs ${need} sats of chipnet BCH at ${P[role].address}`);
}

const base = () => ({
  network: 'chipnet', owner: P.owner.pubkey, contractor: P.contractor.pubkey, inspector: P.inspector.pubkey,
});
const fee = async (role) => ({ feeUtxos: await P[role].utxos(provider), changeAddress: P[role].address });

// ---- 0. a test stablecoin, so the token path is proven without touching real PUSD
const genesis = await step('token-genesis', async () => {
  const utxo = (await provider.getUtxos(P.owner.address)).find((u) => u.vout === 0 && !u.token);
  if (!utxo) throw new Error('Token genesis needs a coin with output index 0 at the owner address.');
  const b = new TransactionBuilder({ provider })
    .addInput(utxo, P.owner.signature().unlockP2PKH())
    .addOutput({ to: P.owner.tokenAddress, amount: 1000n, token: { category: utxo.txid, amount: 1000000n } })
    .addBchChangeOutputIfNeeded({ to: P.owner.address, feeRate: 1.1 });
  return { txid: (await b.send()).txid, category: utxo.txid, note: 'tUSD test stablecoin, 2 decimals, supply 10,000.00' };
});

// ---- terms are created once and then reused on every run
if (!proof.terms) {
  const warrantyEnd = Math.floor(Date.now() / 1000) + 600;
  proof.terms = {
    bch: { ...base(), title: 'Chipnet demo A - garden house (BCH)', retentionBps: 2000, warrantyEnd, token: null,
      milestones: [{ name: 'Foundation', amount: '3000' }, { name: 'Shell and roof', amount: '3000' }] },
    token: { ...base(), title: 'Chipnet demo B - bathroom refit (tUSD)', retentionBps: 1000, warrantyEnd,
      token: { category: genesis.category, symbol: 'tUSD', decimals: 2 },
      milestones: [{ name: 'Plumbing', amount: '150000' }, { name: 'Tiling', amount: '250000' }] },
  };
  save();
}
const A = createEscrow(proof.terms.bch, provider);
const B = createEscrow(proof.terms.token, provider);
proof.escrows = Object.fromEntries([['bch', A], ['token', B]].map(([k, e]) => [k, {
  termsHash: e.termsHash, link: `#${encodeTerms(e.terms)}`,
  milestones: e.milestones.map((m) => m.contract.address), retentionVault: e.retention.address,
}]));
proof.parties = Object.fromEntries(Object.entries(P).map(([r, p]) => [r, p.address]));
save();

// ---- A. BCH escrow
await ensure('owner', 7000n);
await step('A1-fund', async () => ({ txid: await P.owner.send(await buildFund(A, { payerUtxos: await P.owner.utxos(provider), changeAddress: P.owner.address })), note: 'homeowner locks 2 milestones x 3000 sats' }));
await ensure('owner', 700n);
await step('A2-release-by-owner', async () => ({ txid: await P.owner.send(await buildRelease(A, 0, { approver: 'owner', signature: P.owner.signature(), ...(await fee('owner')) })), note: 'covenant pays 2400 to contractor, 600 to the retention vault' }));
await step('A3-release-by-inspector', async () => ({ txid: await P.inspector.send(await buildRelease(A, 1, { approver: 'inspector', signature: P.inspector.signature(), ...(await fee('inspector')) })), note: 'inspector certifies the stage, same enforced split' }));

// ---- B. stablecoin escrow
await ensure('owner', 7200n);
await step('B1-fund', async () => ({ txid: await P.owner.send(await buildFund(B, { payerUtxos: await P.owner.utxos(provider), changeAddress: P.owner.address, tokenChangeAddress: P.owner.tokenAddress })), note: 'homeowner locks 1500.00 + 2500.00 tUSD' }));
await ensure('owner', 700n);
await step('B2-release-by-owner', async () => ({ txid: await P.owner.send(await buildRelease(B, 0, { approver: 'owner', signature: P.owner.signature(), ...(await fee('owner')) })), note: '1350.00 tUSD to contractor, 150.00 tUSD to the vault' }));
await step('B3-refund-by-owner-and-inspector', async () => ({ txid: await P.owner.send(await buildCosign(B, 1, {
  first: { role: 'owner', signature: P.owner.signature() }, second: { role: 'inspector', signature: P.inspector.signature() },
  recipient: 'owner', ...(await fee('owner')),
})), note: 'dispute path: 2 of 3 return the unstarted milestone (2500.00 tUSD) to the homeowner' }));

// ---- warranty: the node itself must refuse an early claim, then accept it later
await ensure('contractor', 1500n);
for (const [name, escrow] of [['A4-claim-retention', A], ['B4-claim-retention', B]]) {
  if (proof.steps[name]?.txid) { console.log('done  ', name, proof.steps[name].txid); continue; }
  if (!(await findRetentionUtxos(escrow)).length) { console.log('skip  ', name, '(vault empty)'); continue; }
  const builder = await buildClaim(escrow, await fee('contractor'));
  try {
    const txid = await provider.sendRawTransaction(builder.build());
    proof.steps[name] = { txid, explorer: EXPLORER.chipnet + txid, at: new Date().toISOString(), note: 'warranty over: vault pays the contractor, no signature needed' };
    console.log('ok    ', name, txid);
    await sleep(2500);
  } catch (error) {
    const message = String(error.message).split('\n')[0].slice(0, 240);
    proof.earlyClaimRejections ??= {};
    proof.earlyClaimRejections[name] ??= { at: new Date().toISOString(), nodeMessage: message, warrantyEnd: escrow.terms.warrantyEnd };
    console.log('wait  ', name, '- node refused the early claim:', message);
  }
  save();
}
for (const [k, e] of [['bch', A], ['token', B]]) {
  const s = await readState(e, provider.getHistory);
  console.log(k, s.milestones.map((m) => m.status).join(','), '| vault', s.retention.status, String(s.retention.held));
}
for (const r of Object.keys(P)) console.log(r, 'plain sats left', String(await plain(P[r])));
