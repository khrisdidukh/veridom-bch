// Veridom Escrow core: terms, covenant addresses and transaction builders.
// Pure library - works in Node (tests, chipnet script) and in the browser.
import { Contract, TransactionBuilder } from 'cashscript';
import {
  sha256, hash160, binToHex, hexToBin, utf8ToBin, binToUtf8,
  encodeCashAddress, cashAddressToLockingBytecode, binToBase64, base64ToBin,
} from '@bitauth/libauth';
import milestoneArtifact from '../artifacts/Milestone.json' with { type: 'json' };
import retentionArtifact from '../artifacts/Retention.json' with { type: 'json' };

export const DUST = 576n; // smallest output the network relays to a covenant (P2SH32) address
export const TOKEN_CARRIER = 1000n; // sats that travel with each token output
export const FEE_RATE = 1.1; // sats per byte, a little above the 1 sat/byte minimum
export const PREFIX = { mainnet: 'bitcoincash', chipnet: 'bchtest' };
export const ROLES = ['owner', 'contractor', 'inspector'];

const isHex = (s, bytes) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(s);

/** Bring user input into one canonical shape. Amounts are strings of base units. */
export function normalizeTerms(t) {
  return {
    v: 1,
    network: t.network,
    title: String(t.title ?? '').trim().slice(0, 80),
    owner: String(t.owner ?? '').toLowerCase(),
    contractor: String(t.contractor ?? '').toLowerCase(),
    inspector: String(t.inspector ?? '').toLowerCase(),
    retentionBps: Number(t.retentionBps),
    warrantyEnd: Number(t.warrantyEnd),
    token: t.token ? {
      category: String(t.token.category).toLowerCase(),
      symbol: String(t.token.symbol ?? 'TOKEN').slice(0, 12),
      decimals: Number(t.token.decimals ?? 0),
    } : null,
    milestones: (t.milestones ?? []).map((m) => ({
      name: String(m.name ?? '').trim().slice(0, 60),
      amount: BigInt(m.amount).toString(),
    })),
  };
}

/** Returns a list of plain-language problems; empty list means the terms are usable. */
export function validateTerms(input) {
  const problems = [];
  let t;
  try { t = normalizeTerms(input); } catch { return ['Every milestone needs a whole-number amount.']; }
  if (!PREFIX[t.network]) problems.push('Choose a network: mainnet or chipnet.');
  for (const role of ROLES) {
    if (!isHex(t[role], 33) || !/^0[23]/.test(t[role])) problems.push(`The ${role} key is missing or not a valid public key.`);
  }
  if (new Set(ROLES.map((r) => t[r])).size !== 3) problems.push('Homeowner, contractor and inspector must be three different keys.');
  if (!Number.isInteger(t.retentionBps) || t.retentionBps < 100 || t.retentionBps > 5000) {
    problems.push('Retention must be between 1 % and 50 %.');
  }
  if (!Number.isInteger(t.warrantyEnd) || t.warrantyEnd < 500000000 || t.warrantyEnd > 4294967295) {
    problems.push('Set the date when the warranty ends.');
  }
  if (t.token && !isHex(t.token.category, 32)) problems.push('The token category must be 64 hex characters.');
  if (t.milestones.length < 1 || t.milestones.length > 12) problems.push('Add between 1 and 12 milestones.');
  t.milestones.forEach((m, i) => {
    const amount = BigInt(m.amount);
    const retained = (amount * BigInt(t.retentionBps || 0)) / 10000n;
    if (!m.name) problems.push(`Milestone ${i + 1} needs a name.`);
    if (t.token) {
      if (retained < 1n || amount - retained < 1n) problems.push(`Milestone ${i + 1} is too small to split into payment and retention.`);
    } else if (retained < DUST || amount - retained < DUST) {
      problems.push(`Milestone ${i + 1} is too small: both the payment and the retention must be at least ${DUST} sats.`);
    }
  });
  return problems;
}

/** sha256 over the canonical JSON of the terms. This hash is baked into every covenant. */
export function hashTerms(terms) {
  return sha256.hash(utf8ToBin(JSON.stringify(normalizeTerms(terms))));
}

/** Terms <-> shareable text (goes into the URL after #). No server involved. */
export function encodeTerms(terms) {
  const b64 = binToBase64(utf8ToBin(JSON.stringify(normalizeTerms(terms))));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeTerms(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const terms = normalizeTerms(JSON.parse(binToUtf8(base64ToBin(padded))));
  const problems = validateTerms(terms);
  if (problems.length) throw new Error(`This escrow link is not valid: ${problems[0]}`);
  return terms;
}

export function pubkeyToAddress(pubkeyHex, network, tokenAware = false) {
  return encodeCashAddress({
    prefix: PREFIX[network],
    type: tokenAware ? 'p2pkhWithTokens' : 'p2pkh',
    payload: hash160(hexToBin(pubkeyHex)),
  }).address;
}

function lockingBytecodeOf(address) {
  const result = cashAddressToLockingBytecode(address);
  if (typeof result === 'string') throw new Error(result);
  return result.bytecode;
}

/**
 * Rebuild every covenant from the terms. Anybody holding the terms derives the
 * same addresses, so a shared link cannot lie about where the money sits.
 */
export function createEscrow(input, provider) {
  const problems = validateTerms(input);
  if (problems.length) throw new Error(problems[0]);
  const terms = normalizeTerms(input);
  if (provider.network !== terms.network) throw new Error(`This escrow lives on ${terms.network}, but the app is connected to ${provider.network}.`);
  const termsHash = hashTerms(terms);
  const keys = ROLES.map((r) => hexToBin(terms[r]));
  const retention = new Contract(retentionArtifact, [...keys, BigInt(terms.warrantyEnd), termsHash], { provider });
  const retentionLock = lockingBytecodeOf(retention.address);
  const milestones = terms.milestones.map((m, index) => {
    const contract = new Contract(
      milestoneArtifact,
      [...keys, retentionLock, BigInt(terms.retentionBps), termsHash, BigInt(index)],
      { provider },
    );
    const amount = BigInt(m.amount);
    const retained = (amount * BigInt(terms.retentionBps)) / 10000n;
    return { index, name: m.name, amount, retained, payout: amount - retained, contract };
  });
  const addresses = Object.fromEntries(ROLES.map((r) => [r, {
    plain: pubkeyToAddress(terms[r], terms.network),
    token: pubkeyToAddress(terms[r], terms.network, true),
  }]));
  return { terms, termsHash: binToHex(termsHash), retention, milestones, addresses, provider };
}

const isPlain = (utxo) => !utxo.token;
const matchesToken = (utxo, category) => utxo.token && utxo.token.category === category && !utxo.token.nft;

/** Money currently locked in one milestone covenant (first UTXO of the right kind). */
export async function findMilestoneUtxo(escrow, index) {
  const { terms } = escrow;
  const utxos = await escrow.milestones[index].contract.getUtxos();
  return utxos.find((u) => (terms.token ? matchesToken(u, terms.token.category) : isPlain(u)));
}

export async function findRetentionUtxos(escrow) {
  const { terms } = escrow;
  const utxos = await escrow.retention.getUtxos();
  return utxos.filter((u) => (terms.token ? matchesToken(u, terms.token.category) : isPlain(u)));
}

const unitsOf = (escrow, utxo) => (escrow.terms.token ? utxo.token.amount : utxo.satoshis);

/**
 * What is on chain right now. `getHistoryCount(address)` is optional; with it we
 * can tell "not funded yet" apart from "already paid out".
 */
export async function readState(escrow, getHistoryCount) {
  const milestones = await Promise.all(escrow.milestones.map(async (m) => {
    const utxo = await findMilestoneUtxo(escrow, m.index);
    if (utxo) return { index: m.index, status: 'locked', locked: unitsOf(escrow, utxo) };
    const seen = getHistoryCount ? await getHistoryCount(m.contract.address) : 0;
    return { index: m.index, status: seen > 0 ? 'paid' : 'unfunded', locked: 0n };
  }));
  const vault = await findRetentionUtxos(escrow);
  const held = vault.reduce((sum, u) => sum + unitsOf(escrow, u), 0n);
  const vaultSeen = getHistoryCount ? await getHistoryCount(escrow.retention.address) : 0;
  const allDone = milestones.every((m) => m.status === 'paid');
  let retention = 'empty';
  if (held > 0n) retention = 'held';
  else if (vaultSeen > 0 && allDone) retention = 'paid';
  return { milestones, retention: { status: retention, held, count: vault.length } };
}

function addFeeInputs(builder, feeUtxos, need) {
  let total = 0n;
  for (const { utxo, unlocker } of feeUtxos) {
    if (!isPlain(utxo)) continue; // never touch the payer's tokens for fees
    builder.addInput(utxo, unlocker);
    total += utxo.satoshis;
    if (total >= need) return total;
  }
  throw new Error(`The paying wallet needs about ${need} sats of plain BCH for this step, it has ${total}.`);
}

/**
 * Homeowner locks money for every milestone that is not funded yet.
 * `payerUtxos` = [{ utxo, unlocker }] from the homeowner's wallet.
 */
export async function buildFund(escrow, { payerUtxos, changeAddress, tokenChangeAddress, only }) {
  const { terms, provider } = escrow;
  const state = await readState(escrow);
  const todo = escrow.milestones.filter((m) => state.milestones[m.index].status !== 'locked' && (!only || only.includes(m.index)));
  if (!todo.length) throw new Error('Every milestone is already funded.');
  const builder = new TransactionBuilder({ provider });
  let needSats = 700n; // fee head-room
  if (terms.token) {
    const needTokens = todo.reduce((s, m) => s + m.amount, 0n);
    let got = 0n;
    for (const { utxo, unlocker } of payerUtxos) {
      if (got >= needTokens) break;
      if (!matchesToken(utxo, terms.token.category)) continue;
      builder.addInput(utxo, unlocker);
      got += utxo.token.amount;
      needSats -= utxo.satoshis;
    }
    if (got < needTokens) throw new Error(`The wallet holds ${got} ${terms.token.symbol} base units, the milestones need ${needTokens}.`);
    for (const m of todo) {
      builder.addOutput({ to: m.contract.tokenAddress, amount: 2n * TOKEN_CARRIER, token: { category: terms.token.category, amount: m.amount } });
      needSats += 2n * TOKEN_CARRIER;
    }
    needSats += TOKEN_CARRIER; // possible token change output
  } else {
    for (const m of todo) {
      builder.addOutput({ to: m.contract.address, amount: m.amount });
      needSats += m.amount;
    }
  }
  if (needSats > 0n) addFeeInputs(builder, payerUtxos, needSats);
  if (terms.token) builder.addTokenChangeOutputIfNeeded({ category: terms.token.category, to: tokenChangeAddress });
  builder.addBchChangeOutputIfNeeded({ to: changeAddress, feeRate: FEE_RATE });
  return builder;
}

/**
 * Pay one milestone: contractor gets the stage price minus retention, the
 * retention goes to the vault. `approver` is 'owner' or 'inspector'.
 */
export async function buildRelease(escrow, index, { approver, signature, feeUtxos, changeAddress }) {
  if (approver !== 'owner' && approver !== 'inspector') throw new Error('Only the homeowner or the inspector can approve a milestone.');
  const { terms, provider } = escrow;
  const m = escrow.milestones[index];
  const utxo = await findMilestoneUtxo(escrow, index);
  if (!utxo) throw new Error(`Milestone ${index + 1} has no money locked.`);
  const builder = new TransactionBuilder({ provider });
  builder.addInput(utxo, m.contract.unlock.release(hexToBin(terms[approver]), signature));
  const bps = BigInt(terms.retentionBps);
  if (terms.token) {
    const tokens = utxo.token.amount;
    const retained = (tokens * bps) / 10000n;
    builder.addOutput({ to: escrow.addresses.contractor.token, amount: TOKEN_CARRIER, token: { category: terms.token.category, amount: tokens - retained } });
    builder.addOutput({ to: escrow.retention.tokenAddress, amount: TOKEN_CARRIER, token: { category: terms.token.category, amount: retained } });
    const shortfall = 2n * TOKEN_CARRIER > utxo.satoshis ? 2n * TOKEN_CARRIER - utxo.satoshis : 0n;
    addFeeInputs(builder, feeUtxos, shortfall + 600n);
  } else {
    const retained = (utxo.satoshis * bps) / 10000n;
    builder.addOutput({ to: escrow.addresses.contractor.plain, amount: utxo.satoshis - retained });
    builder.addOutput({ to: escrow.retention.address, amount: retained });
    addFeeInputs(builder, feeUtxos, 600n);
  }
  builder.addBchChangeOutputIfNeeded({ to: changeAddress, feeRate: FEE_RATE });
  return builder;
}

/** Warranty is over: sweep the whole retention vault to the contractor. Needs no approval. */
export async function buildClaim(escrow, { feeUtxos, changeAddress }) {
  const { terms, provider } = escrow;
  const utxos = await findRetentionUtxos(escrow);
  if (!utxos.length) throw new Error('The retention vault is empty.');
  const builder = new TransactionBuilder({ provider });
  for (const utxo of utxos) {
    builder.addInput(utxo, escrow.retention.unlock.claim());
    builder.addOutput(terms.token
      ? { to: escrow.addresses.contractor.token, amount: utxo.satoshis, token: { category: terms.token.category, amount: utxo.token.amount } }
      : { to: escrow.addresses.contractor.plain, amount: utxo.satoshis });
  }
  addFeeInputs(builder, feeUtxos, 400n + 200n * BigInt(utxos.length));
  builder.addBchChangeOutputIfNeeded({ to: changeAddress, feeRate: FEE_RATE });
  builder.setLocktime(terms.warrantyEnd);
  return builder;
}

/**
 * Two of the three parties move money out of a milestone (`target` = index) or
 * out of the retention vault (`target` = 'retention') to `recipient` (a role).
 * Used for refunds, defect claims and early settlements.
 */
export async function buildCosign(escrow, target, { first, second, recipient, feeUtxos = [], changeAddress }) {
  const { terms, provider } = escrow;
  if (first.role === second.role) throw new Error('Two different parties must sign.');
  const contract = target === 'retention' ? escrow.retention : escrow.milestones[target].contract;
  const utxos = target === 'retention' ? await findRetentionUtxos(escrow) : [await findMilestoneUtxo(escrow, target)].filter(Boolean);
  if (!utxos.length) throw new Error('There is no money locked there.');
  const builder = new TransactionBuilder({ provider });
  const unlocker = contract.unlock.cosign(hexToBin(terms[first.role]), first.signature, hexToBin(terms[second.role]), second.signature);
  let sats = 0n;
  let tokens = 0n;
  for (const utxo of utxos) {
    builder.addInput(utxo, unlocker);
    sats += utxo.satoshis;
    if (terms.token) tokens += utxo.token.amount;
  }
  if (terms.token) {
    builder.addOutput({ to: escrow.addresses[recipient].token, amount: TOKEN_CARRIER, token: { category: terms.token.category, amount: tokens } });
    if (sats < TOKEN_CARRIER + 700n) addFeeInputs(builder, feeUtxos, TOKEN_CARRIER + 700n - sats);
    builder.addBchChangeOutputIfNeeded({ to: changeAddress ?? escrow.addresses[recipient].plain, feeRate: FEE_RATE });
  } else {
    // The network fee is taken from the money being moved; the rest goes to the recipient.
    builder.addBchChangeOutputIfNeeded({ to: escrow.addresses[recipient].plain, feeRate: FEE_RATE });
  }
  return builder;
}

/** Human-readable amount, e.g. 12.50 PUSD or 0.00150000 BCH. */
export function formatAmount(terms, units) {
  const decimals = terms.token ? terms.token.decimals : 8;
  const symbol = terms.token ? terms.token.symbol : (terms.network === 'mainnet' ? 'BCH' : 'tBCH');
  const s = BigInt(units).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? `.${s.slice(-decimals)}` : '';
  return `${whole}${frac} ${symbol}`;
}

export function parseAmount(text, decimals) {
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(String(text).trim());
  if (!m) throw new Error('Enter a number like 1500 or 0.25');
  const frac = (m[2] ?? '').padEnd(decimals, '0');
  if (frac.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  return BigInt(m[1] + frac);
}
