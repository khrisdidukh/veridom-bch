import { describe, it, expect } from 'vitest';
import { TransactionBuilder } from 'cashscript';
import { hexToBin } from '@bitauth/libauth';
import { setup, balance, WARRANTY_END, TUSD } from './helpers.js';

// cashscript wants { ...utxo, unlocker }
const flat = (list) => list.map(({ utxo, unlocker }) => ({ ...utxo, unlocker }));
// a covenant rejection, not an accident in the test itself
const REJECTED = /Milestone\.cash|Retention\.cash/;
import { buildFund, buildRelease, buildClaim, buildCosign, readState, findMilestoneUtxo, findRetentionUtxos } from '../src/lib/escrow.js';

async function fund(ctx) {
  const builder = await buildFund(ctx.escrow, {
    payerUtxos: await ctx.owner.utxos(ctx.provider), changeAddress: ctx.owner.address, tokenChangeAddress: ctx.owner.tokenAddress,
  });
  return ctx.owner.send(builder);
}
async function release(ctx, index, who = 'owner') {
  const party = ctx[who];
  const builder = await buildRelease(ctx.escrow, index, {
    approver: who, signature: party.signature(), feeUtxos: await party.utxos(ctx.provider), changeAddress: party.address,
  });
  return party.send(builder);
}

describe('BCH escrow', () => {
  it('locks every milestone in one funding transaction', async () => {
    const ctx = setup();
    await fund(ctx);
    const state = await readState(ctx.escrow);
    expect(state.milestones.map((m) => [m.status, m.locked])).toEqual([['locked', 100000n], ['locked', 200000n], ['locked', 50000n]]);
    expect(state.retention.status).toBe('empty');
  });

  it('pays the contractor and holds back the retention when the homeowner approves', async () => {
    const ctx = setup();
    await fund(ctx);
    const before = await balance(ctx.provider, ctx.contractor.address);
    await release(ctx, 0);
    expect(await balance(ctx.provider, ctx.contractor.address) - before).toBe(95000n);
    expect(await balance(ctx.provider, ctx.escrow.retention.address)).toBe(5000n);
    expect(await findMilestoneUtxo(ctx.escrow, 0)).toBeUndefined();
  });

  it('lets the inspector certify a stage when the homeowner is silent', async () => {
    const ctx = setup();
    await fund(ctx);
    await release(ctx, 1, 'inspector');
    expect(await balance(ctx.provider, ctx.escrow.retention.address)).toBe(10000n);
  });

  it('does not let the contractor approve their own work', async () => {
    const ctx = setup();
    await fund(ctx);
    const utxo = await findMilestoneUtxo(ctx.escrow, 0);
    const m = ctx.escrow.milestones[0];
    const builder = new TransactionBuilder({ provider: ctx.provider })
      .addInput(utxo, m.contract.unlock.release(hexToBin(ctx.contractor.pubkey), ctx.contractor.signature()))
      .addInputs(flat(await ctx.contractor.utxos(ctx.provider)))
      .addOutput({ to: ctx.contractor.address, amount: 95000n })
      .addOutput({ to: ctx.escrow.retention.address, amount: 5000n });
    await expect(builder.send()).rejects.toThrow(REJECTED);
  });

  it('does not accept a signature from a stranger', async () => {
    const ctx = setup();
    await fund(ctx);
    const utxo = await findMilestoneUtxo(ctx.escrow, 0);
    const m = ctx.escrow.milestones[0];
    const builder = new TransactionBuilder({ provider: ctx.provider })
      .addInput(utxo, m.contract.unlock.release(hexToBin(ctx.owner.pubkey), ctx.stranger.signature()))
      .addInputs(flat(await ctx.stranger.utxos(ctx.provider)))
      .addOutput({ to: ctx.contractor.address, amount: 95000n })
      .addOutput({ to: ctx.escrow.retention.address, amount: 5000n });
    await expect(builder.send()).rejects.toThrow(REJECTED);
  });

  it('stops the homeowner from sending the stage money back to themselves', async () => {
    const ctx = setup();
    await fund(ctx);
    const utxo = await findMilestoneUtxo(ctx.escrow, 0);
    const m = ctx.escrow.milestones[0];
    const builder = new TransactionBuilder({ provider: ctx.provider })
      .addInput(utxo, m.contract.unlock.release(hexToBin(ctx.owner.pubkey), ctx.owner.signature()))
      .addInputs(flat(await ctx.owner.utxos(ctx.provider)))
      .addOutput({ to: ctx.owner.address, amount: 95000n })
      .addOutput({ to: ctx.escrow.retention.address, amount: 5000n });
    await expect(builder.send()).rejects.toThrow(REJECTED);
  });

  it('stops anyone from skipping or shrinking the retention', async () => {
    const ctx = setup();
    await fund(ctx);
    const utxo = await findMilestoneUtxo(ctx.escrow, 0);
    const m = ctx.escrow.milestones[0];
    for (const [pay, keep, vault] of [[99000n, 1000n, ctx.escrow.retention.address], [95000n, 5000n, ctx.owner.address]]) {
      const builder = new TransactionBuilder({ provider: ctx.provider })
        .addInput(utxo, m.contract.unlock.release(hexToBin(ctx.owner.pubkey), ctx.owner.signature()))
        .addInputs(flat(await ctx.owner.utxos(ctx.provider)))
        .addOutput({ to: ctx.contractor.address, amount: pay })
        .addOutput({ to: vault, amount: keep });
      await expect(builder.send()).rejects.toThrow(REJECTED);
    }
  });

  it('keeps the retention locked until the warranty ends', async () => {
    const ctx = setup();
    await fund(ctx);
    await release(ctx, 0);
    const builder = await buildClaim(ctx.escrow, { feeUtxos: await ctx.contractor.utxos(ctx.provider), changeAddress: ctx.contractor.address });
    builder.setLocktime(WARRANTY_END - 1);
    await expect(builder.send()).rejects.toThrow(REJECTED);
  });

  it('pays the whole vault to the contractor after the warranty, with nobody signing', async () => {
    const ctx = setup();
    await fund(ctx);
    await release(ctx, 0);
    await release(ctx, 1);
    await release(ctx, 2, 'inspector');
    const before = await balance(ctx.provider, ctx.contractor.address);
    // a stranger pays the fee and triggers the payout; the money still goes to the contractor
    const builder = await buildClaim(ctx.escrow, { feeUtxos: await ctx.stranger.utxos(ctx.provider), changeAddress: ctx.stranger.address });
    expect(builder.locktime).toBe(WARRANTY_END);
    await ctx.stranger.send(builder);
    expect(await balance(ctx.provider, ctx.contractor.address) - before).toBe(17500n);
    expect(await findRetentionUtxos(ctx.escrow)).toEqual([]);
  });

  it('does not let the vault pay anyone but the contractor', async () => {
    const ctx = setup();
    await fund(ctx);
    await release(ctx, 0);
    const [utxo] = await findRetentionUtxos(ctx.escrow);
    const builder = new TransactionBuilder({ provider: ctx.provider })
      .addInput(utxo, ctx.escrow.retention.unlock.claim())
      .addInputs(flat(await ctx.owner.utxos(ctx.provider)))
      .addOutput({ to: ctx.owner.address, amount: 5000n })
      .setLocktime(WARRANTY_END);
    await expect(builder.send()).rejects.toThrow(REJECTED);
  });

  it('refunds an abandoned milestone when homeowner and inspector agree', async () => {
    const ctx = setup();
    await fund(ctx);
    const before = await balance(ctx.provider, ctx.owner.address);
    const builder = await buildCosign(ctx.escrow, 2, {
      first: { role: 'owner', signature: ctx.owner.signature() },
      second: { role: 'inspector', signature: ctx.inspector.signature() },
      recipient: 'owner',
    });
    await ctx.owner.send(builder);
    const refunded = await balance(ctx.provider, ctx.owner.address) - before;
    expect(refunded > 49000n && refunded < 50000n).toBe(true);
  });

  it('lets homeowner and inspector use the retention for a defect during the warranty', async () => {
    const ctx = setup();
    await fund(ctx);
    await release(ctx, 1);
    const before = await balance(ctx.provider, ctx.owner.address);
    const builder = await buildCosign(ctx.escrow, 'retention', {
      first: { role: 'inspector', signature: ctx.inspector.signature() },
      second: { role: 'owner', signature: ctx.owner.signature() },
      recipient: 'owner',
    });
    await ctx.owner.send(builder);
    expect(await balance(ctx.provider, ctx.owner.address) - before > 9000n).toBe(true);
  });

  it('never lets one party sign twice or a stranger co-sign', async () => {
    const ctx = setup();
    await fund(ctx);
    const utxo = await findMilestoneUtxo(ctx.escrow, 0);
    const c = ctx.escrow.milestones[0].contract;
    const pk = (p) => hexToBin(p.pubkey);
    const attempts = [
      c.unlock.cosign(pk(ctx.owner), ctx.owner.signature(), pk(ctx.owner), ctx.owner.signature()),
      c.unlock.cosign(pk(ctx.owner), ctx.owner.signature(), pk(ctx.stranger), ctx.stranger.signature()),
      c.unlock.cosign(pk(ctx.owner), ctx.owner.signature(), pk(ctx.inspector), ctx.stranger.signature()),
    ];
    for (const unlocker of attempts) {
      const builder = new TransactionBuilder({ provider: ctx.provider }).addInput(utxo, unlocker).addOutput({ to: ctx.owner.address, amount: 99000n });
      await expect(builder.send()).rejects.toThrow(REJECTED);
    }
  });

  it('tells paid, refunded and unfunded stages apart from the chain history', async () => {
    const ctx = setup();
    const history = {};
    const note = async (txid, ...addresses) => { for (const a of addresses) (history[a] ??= []).push(txid); };
    const [m0, m1, m2] = ctx.escrow.milestones.map((m) => m.contract.address);
    const vault = ctx.escrow.retention.address;
    const getHistory = async (address) => history[address] ?? [];
    expect((await readState(ctx.escrow, getHistory)).milestones.map((m) => m.status)).toEqual(['unfunded', 'unfunded', 'unfunded']);
    await note(await fund(ctx), m0, m1, m2);
    await note(await release(ctx, 0), m0, vault);
    const refund = await buildCosign(ctx.escrow, 2, {
      first: { role: 'owner', signature: ctx.owner.signature() }, second: { role: 'inspector', signature: ctx.inspector.signature() }, recipient: 'owner',
    });
    await note(await ctx.owner.send(refund), m2);
    let state = await readState(ctx.escrow, getHistory);
    expect(state.milestones.map((m) => m.status)).toEqual(['paid', 'locked', 'settled']);
    expect(state.retention).toMatchObject({ status: 'held', held: 5000n });
    await note(await release(ctx, 1, 'inspector'), m1, vault);
    const claim = await buildClaim(ctx.escrow, { feeUtxos: await ctx.contractor.utxos(ctx.provider), changeAddress: ctx.contractor.address });
    await note(await ctx.contractor.send(claim), vault);
    state = await readState(ctx.escrow, getHistory);
    expect(state.retention.status).toBe('paid');
  });

  it('marks the vault as settled when the retention was used for a defect', async () => {
    const ctx = setup({ amounts: ['100000'] });
    const history = {};
    const getHistory = async (address) => history[address] ?? [];
    const m0 = ctx.escrow.milestones[0].contract.address;
    const vault = ctx.escrow.retention.address;
    history[m0] = [await fund(ctx)];
    const paid = await release(ctx, 0);
    history[m0].push(paid); history[vault] = [paid];
    const defect = await buildCosign(ctx.escrow, 'retention', {
      first: { role: 'owner', signature: ctx.owner.signature() }, second: { role: 'inspector', signature: ctx.inspector.signature() }, recipient: 'owner',
    });
    history[vault].push(await ctx.owner.send(defect));
    expect((await readState(ctx.escrow, getHistory)).retention.status).toBe('settled');
  });

  it('gives a clear message when there is nothing to release or fund', async () => {
    const ctx = setup();
    await expect(release(ctx, 0)).rejects.toThrow(/no money locked/);
    await fund(ctx);
    await expect(fund(ctx)).rejects.toThrow(/already funded/);
  });
});

describe('stablecoin (CashToken) escrow', () => {
  const opts = { token: true, retentionBps: 1000, amounts: ['150000', '250000'] };

  it('locks tokens per milestone and returns the token change', async () => {
    const ctx = setup(opts);
    await fund(ctx);
    const state = await readState(ctx.escrow);
    expect(state.milestones.map((m) => m.locked)).toEqual([150000n, 250000n]);
    expect(await balance(ctx.provider, ctx.owner.address, TUSD)).toBe(600000n);
  });

  it('splits the tokens between contractor and vault on approval', async () => {
    const ctx = setup(opts);
    await fund(ctx);
    await release(ctx, 0);
    expect(await balance(ctx.provider, ctx.contractor.address, TUSD)).toBe(135000n);
    expect(await balance(ctx.provider, ctx.escrow.retention.address, TUSD)).toBe(15000n);
  });

  it('rejects a wrong token split and a token swap', async () => {
    const ctx = setup(opts);
    await fund(ctx);
    const utxo = await findMilestoneUtxo(ctx.escrow, 0);
    const m = ctx.escrow.milestones[0];
    const unlock = () => m.contract.unlock.release(hexToBin(ctx.owner.pubkey), ctx.owner.signature());
    const fee = (await ctx.owner.utxos(ctx.provider)).filter((u) => !u.utxo.token);
    const wrongSplit = new TransactionBuilder({ provider: ctx.provider, allowImplicitFungibleTokenBurn: true })
      .addInput(utxo, unlock()).addInputs(flat(fee))
      .addOutput({ to: ctx.contractor.tokenAddress, amount: 1000n, token: { category: TUSD, amount: 149000n } })
      .addOutput({ to: ctx.escrow.retention.tokenAddress, amount: 1000n, token: { category: TUSD, amount: 1000n } });
    await expect(wrongSplit.send()).rejects.toThrow(REJECTED);
    const toOwner = new TransactionBuilder({ provider: ctx.provider })
      .addInput(utxo, unlock()).addInputs(flat(fee))
      .addOutput({ to: ctx.owner.tokenAddress, amount: 1000n, token: { category: TUSD, amount: 135000n } })
      .addOutput({ to: ctx.escrow.retention.tokenAddress, amount: 1000n, token: { category: TUSD, amount: 15000n } });
    await expect(toOwner.send()).rejects.toThrow(REJECTED);
  });

  it('pays the token retention to the contractor after the warranty', async () => {
    const ctx = setup(opts);
    await fund(ctx);
    await release(ctx, 0);
    await release(ctx, 1, 'inspector');
    const builder = await buildClaim(ctx.escrow, { feeUtxos: await ctx.contractor.utxos(ctx.provider), changeAddress: ctx.contractor.address });
    await ctx.contractor.send(builder);
    expect(await balance(ctx.provider, ctx.contractor.address, TUSD)).toBe(400000n);
  });

  it('does not let the vault keep or redirect tokens on claim', async () => {
    const ctx = setup(opts);
    await fund(ctx);
    await release(ctx, 0);
    const [utxo] = await findRetentionUtxos(ctx.escrow);
    const builder = new TransactionBuilder({ provider: ctx.provider, allowImplicitFungibleTokenBurn: true })
      .addInput(utxo, ctx.escrow.retention.unlock.claim())
      .addInputs(flat(await ctx.stranger.utxos(ctx.provider)))
      .addOutput({ to: ctx.contractor.tokenAddress, amount: 1000n, token: { category: TUSD, amount: 1n } })
      .addOutput({ to: ctx.stranger.tokenAddress, amount: 1000n, token: { category: TUSD, amount: 14999n } })
      .setLocktime(WARRANTY_END);
    await expect(builder.send()).rejects.toThrow(REJECTED);
  });

  it('refunds tokens when two parties agree', async () => {
    const ctx = setup(opts);
    await fund(ctx);
    const builder = await buildCosign(ctx.escrow, 1, {
      first: { role: 'owner', signature: ctx.owner.signature() },
      second: { role: 'contractor', signature: ctx.contractor.signature() },
      recipient: 'owner', feeUtxos: await ctx.owner.utxos(ctx.provider), changeAddress: ctx.owner.address,
    });
    await ctx.owner.send(builder);
    expect(await balance(ctx.provider, ctx.owner.address, TUSD)).toBe(850000n);
  });

  it('never spends the payer\'s tokens as fees', async () => {
    const ctx = setup(opts);
    await fund(ctx);
    await release(ctx, 0);
    expect(await balance(ctx.provider, ctx.owner.address, TUSD)).toBe(600000n);
  });
});
