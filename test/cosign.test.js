import { describe, it, expect } from 'vitest';
import { hexToBin, binToHex, decodeTransaction, encodeTransaction } from '@bitauth/libauth';
import { setup, balance, TUSD } from './helpers.js';
import { buildFund, buildCosign, createEscrow, findMilestoneUtxo } from '../src/lib/escrow.js';
import { SECOND_SLOT, encodeRequest, decodeRequest, inspectRequest, completeLocally } from '../src/lib/cosign.js';

async function fund(ctx) {
  const builder = await buildFund(ctx.escrow, { payerUtxos: await ctx.owner.utxos(ctx.provider), changeAddress: ctx.owner.address, tokenChangeAddress: ctx.owner.tokenAddress });
  return ctx.owner.send(builder);
}

/** Homeowner signs first on "their device" and produces the link text for the inspector. */
async function ownerProposesRefund(ctx, target = 1) {
  const builder = await buildCosign(ctx.escrow, target, {
    first: { role: 'owner', signature: ctx.owner.signature() },
    second: { role: 'inspector', signature: SECOND_SLOT },
    recipient: 'owner', feeUtxos: await ctx.owner.utxos(ctx.provider), changeAddress: ctx.owner.address,
  });
  return encodeRequest({ terms: ctx.terms, target, first: 'owner', second: 'inspector', recipient: 'owner', txHex: builder.build() });
}

/** The inspector opens the link on "another device": nothing is shared but the link text. */
async function open(ctx, link) {
  const request = decodeRequest(link);
  const escrow = createEscrow(request.terms, ctx.provider);
  return { request, escrow, inspected: await inspectRequest(escrow, request) };
}

describe('two-signature actions across two devices', () => {
  it('a half-signed refund is not valid on its own', async () => {
    const ctx = setup();
    await fund(ctx);
    const { request } = await open(ctx, await ownerProposesRefund(ctx));
    await expect(ctx.provider.sendRawTransaction(request.txHex)).rejects.toThrow();
    expect(await findMilestoneUtxo(ctx.escrow, 1)).toBeDefined();
  });

  it('the second party sees where the money goes, co-signs, and the refund goes through', async () => {
    const ctx = setup();
    await fund(ctx);
    const before = await balance(ctx.provider, ctx.owner.address);
    const { inspected, request } = await open(ctx, await ownerProposesRefund(ctx));
    expect(inspected.moved).toBe(200000n);
    expect(inspected.unknownOutputs).toBe(0);
    expect(inspected.toRecipient > 199000n).toBe(true);
    expect(request.recipient).toBe('owner');
    await ctx.provider.sendRawTransaction(completeLocally(inspected, hexToBin(ctx.keys.inspector)));
    expect(await findMilestoneUtxo(ctx.escrow, 1)).toBeUndefined();
    expect(await balance(ctx.provider, ctx.owner.address) - before > 199000n).toBe(true);
  });

  it('a co-signature from the wrong key is rejected', async () => {
    const ctx = setup();
    await fund(ctx);
    const { inspected } = await open(ctx, await ownerProposesRefund(ctx));
    await expect(ctx.provider.sendRawTransaction(completeLocally(inspected, hexToBin(ctx.keys.stranger)))).rejects.toThrow();
  });

  it('the second party cannot redirect the money after the first signature', async () => {
    const ctx = setup();
    await fund(ctx);
    const { inspected } = await open(ctx, await ownerProposesRefund(ctx));
    inspected.transaction.outputs[0].lockingBytecode = hexToBin(`76a914${'11'.repeat(20)}88ac`);
    await expect(ctx.provider.sendRawTransaction(completeLocally(inspected, hexToBin(ctx.keys.inspector)))).rejects.toThrow();
  });

  it('flags outputs that go to somebody outside the agreement', async () => {
    const ctx = setup();
    await fund(ctx);
    const request = decodeRequest(await ownerProposesRefund(ctx));
    const tx = decodeTransaction(hexToBin(request.txHex));
    tx.outputs[0].lockingBytecode = hexToBin(`76a914${'22'.repeat(20)}88ac`);
    const inspected = await inspectRequest(ctx.escrow, { ...request, txHex: binToHex(encodeTransaction(tx)) });
    expect(inspected.unknownOutputs).toBe(1);
    expect(inspected.toRecipient).toBe(0n);
  });

  it('refuses a request for money that is no longer locked, or for another escrow', async () => {
    const ctx = setup();
    await fund(ctx);
    const link = await ownerProposesRefund(ctx);
    const { inspected } = await open(ctx, link);
    await ctx.provider.sendRawTransaction(completeLocally(inspected, hexToBin(ctx.keys.inspector)));
    await expect(open(ctx, link)).rejects.toThrow(/no longer locked/);
    expect(() => decodeRequest('garbage')).toThrow();
  });

  it('works for stablecoin stages, with the first signer paying the fee', async () => {
    const ctx = setup({ token: true, retentionBps: 1000, amounts: ['150000', '250000'] });
    await fund(ctx);
    const { inspected } = await open(ctx, await ownerProposesRefund(ctx));
    expect(inspected.moved).toBe(250000n);
    expect(inspected.toRecipient).toBe(250000n);
    await ctx.provider.sendRawTransaction(completeLocally(inspected, hexToBin(ctx.keys.inspector)));
    expect(await balance(ctx.provider, ctx.owner.address, TUSD)).toBe(850000n);
  });
});
