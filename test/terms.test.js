import { describe, it, expect } from 'vitest';
import { setup } from './helpers.js';
import { createEscrow, validateTerms, encodeTerms, decodeTerms, hashTerms, formatAmount, parseAmount } from '../src/lib/escrow.js';
import { binToHex } from '@bitauth/libauth';

describe('terms', () => {
  it('accepts a normal agreement', () => {
    expect(validateTerms(setup().terms)).toEqual([]);
  });
  it('explains what is wrong in plain language', () => {
    const { terms } = setup();
    expect(validateTerms({ ...terms, inspector: terms.owner })[0]).toMatch(/three different keys/);
    expect(validateTerms({ ...terms, retentionBps: 0 })[0]).toMatch(/between 1 % and 50 %/);
    expect(validateTerms({ ...terms, milestones: [{ name: 'Tiny', amount: '2000' }] })[0]).toMatch(/too small/);
    expect(validateTerms({ ...terms, milestones: [] })[0]).toMatch(/between 1 and 12/);
    expect(validateTerms({ ...terms, contractor: 'zz' })[0]).toMatch(/contractor key/);
    expect(validateTerms({ ...terms, warrantyEnd: 0 })[0]).toMatch(/warranty ends/);
  });
  it('survives the trip through a share link', () => {
    const { terms, escrow } = setup({ token: true });
    const again = decodeTerms(encodeTerms(terms));
    expect(binToHex(hashTerms(again))).toBe(escrow.termsHash);
  });
  it('rejects a damaged link', () => {
    expect(() => decodeTerms('not-a-link')).toThrow();
  });
  it('gives every milestone and the vault its own address', () => {
    const { escrow } = setup();
    const all = [...escrow.milestones.map((m) => m.contract.address), escrow.retention.address];
    expect(new Set(all).size).toBe(4);
    expect(all.every((a) => a.startsWith('bchtest:p'))).toBe(true);
  });
  it('derives the same addresses from the same terms, every time', () => {
    const { terms, provider, escrow } = setup();
    const again = createEscrow(JSON.parse(JSON.stringify(terms)), provider);
    expect(again.milestones.map((m) => m.contract.address)).toEqual(escrow.milestones.map((m) => m.contract.address));
    expect(again.retention.address).toBe(escrow.retention.address);
  });
  it('moves every address when any term changes', () => {
    const { terms, provider, escrow } = setup();
    const changes = [
      { retentionBps: 600 }, { warrantyEnd: terms.warrantyEnd + 1 }, { title: 'Other house' },
      { milestones: terms.milestones.map((m, i) => (i === 2 ? { ...m, amount: '50001' } : m)) },
    ];
    for (const change of changes) {
      const other = createEscrow({ ...terms, ...change }, provider);
      expect(other.milestones[0].contract.address).not.toBe(escrow.milestones[0].contract.address);
    }
  });
  it('refuses to open a chipnet escrow on another network', () => {
    const { terms, provider } = setup();
    expect(() => createEscrow({ ...terms, network: 'mainnet' }, provider)).toThrow(/lives on mainnet/);
  });
  it('formats and parses amounts', () => {
    const { terms } = setup({ token: true });
    expect(formatAmount(terms, 123456n)).toBe('1234.56 tUSD');
    expect(formatAmount({ ...terms, token: null }, 150000n)).toBe('0.00150000 tBCH');
    expect(parseAmount('12.5', 2)).toBe(1250n);
    expect(parseAmount('0,001', 8)).toBe(100000n);
    expect(() => parseAmount('1.234', 2)).toThrow();
    expect(() => parseAmount('abc', 2)).toThrow();
  });
});
