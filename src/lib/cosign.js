// Two-signature actions across two devices.
// Party A signs first and gets a half-signed transaction; party B reviews it, adds the second
// signature and broadcasts. A signature covers every input and output (SIGHASH_ALL | UTXOS),
// so B cannot change where the money goes, and A's half is useless without B.
import {
  binToHex, hexToBin, decodeTransaction, encodeTransaction, hash256, secp256k1,
  generateSigningSerializationBch, SigningSerializationFlag, binToBase64, base64ToBin, utf8ToBin, binToUtf8, hash160,
} from '@bitauth/libauth';
import { ROLES, findMilestoneUtxo, findRetentionUtxos, encodeTerms, decodeTerms } from './escrow.js';

/** 65 non-zero bytes that keep the place of the second signature. */
export const SECOND_SLOT = new Uint8Array(65).fill(1);
export const SECOND_SLOT_HEX = binToHex(SECOND_SLOT);
export const ZERO_SIG_HEX = binToHex(new Uint8Array(65));
const HASH_TYPE = SigningSerializationFlag.allOutputs | SigningSerializationFlag.utxos | SigningSerializationFlag.forkId;

/** Schnorr signature for one input, the way BCH wallets sign dapp transactions. */
export function signInput({ transaction, sourceOutputs, inputIndex }, coveredBytecode, privateKey) {
  const preimage = generateSigningSerializationBch(
    { inputIndex, sourceOutputs, transaction },
    { coveredBytecode, signingSerializationType: new Uint8Array([HASH_TYPE]) },
  );
  const signature = secp256k1.signMessageHashSchnorr(privateKey, hash256(preimage));
  if (typeof signature === 'string') throw new Error(signature);
  return Uint8Array.from([...signature, HASH_TYPE]);
}

const b64url = {
  encode: (text) => binToBase64(utf8ToBin(text)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (s) => { const b = s.replace(/-/g, '+').replace(/_/g, '/'); return binToUtf8(base64ToBin(b + '='.repeat((4 - (b.length % 4)) % 4))); },
};

/** What travels in the co-sign link. */
export function encodeRequest({ terms, target, first, second, recipient, txHex }) {
  return b64url.encode(JSON.stringify({ t: encodeTerms(terms), g: target, a: first, b: second, r: recipient, x: txHex }));
}
export function decodeRequest(text) {
  const o = JSON.parse(b64url.decode(text));
  const request = { terms: decodeTerms(o.t), target: o.g, first: o.a, second: o.b, recipient: o.r, txHex: o.x };
  if (!ROLES.includes(request.first) || !ROLES.includes(request.second) || request.first === request.second) throw new Error('This co-sign link is damaged.');
  if (!/^([0-9a-f]{2})+$/.test(request.txHex)) throw new Error('This co-sign link is damaged.');
  return request;
}

const lockOf = (utxo) => hexToBin(utxo.lockingBytecode);
const tokenOf = (utxo) => (utxo.token ? {
  token: { category: hexToBin(utxo.token.category), amount: utxo.token.amount, ...(utxo.token.nft ? { nft: { capability: utxo.token.nft.capability, commitment: hexToBin(utxo.token.nft.commitment) } } : {}) },
} : {});

/**
 * Check a half-signed transaction against the chain and the terms, independently of whoever
 * sent the link. Returns everything needed to show it to the second signer and to sign it.
 */
export async function inspectRequest(escrow, request) {
  const { provider, terms } = escrow;
  const transaction = decodeTransaction(hexToBin(request.txHex));
  if (typeof transaction === 'string') throw new Error('This co-sign link is damaged.');
  const contract = request.target === 'retention' ? escrow.retention : escrow.milestones[Number(request.target)]?.contract;
  if (!contract) throw new Error('This co-sign link points to a stage that does not exist.');
  const locked = request.target === 'retention' ? await findRetentionUtxos(escrow) : [await findMilestoneUtxo(escrow, Number(request.target))].filter(Boolean);
  const byOutpoint = new Map(locked.map((u) => [`${u.txid}:${u.vout}`, u]));
  const redeemHex = contract.bytecode;
  const contractInputs = [];
  const sourceOutputs = [];
  for (const [index, input] of transaction.inputs.entries()) {
    const txid = binToHex(input.outpointTransactionHash);
    const utxo = byOutpoint.get(`${txid}:${input.outpointIndex}`);
    const base = { outpointIndex: input.outpointIndex, outpointTransactionHash: input.outpointTransactionHash, sequenceNumber: input.sequenceNumber, unlockingBytecode: input.unlockingBytecode };
    if (utxo) {
      const unlocking = binToHex(input.unlockingBytecode);
      if (!unlocking.endsWith(redeemHex) || unlocking.split(SECOND_SLOT_HEX).length !== 2) throw new Error('This request was not prepared by Veridom Escrow for this escrow.');
      contractInputs.push(index);
      sourceOutputs.push({ ...base, lockingBytecode: lockOf(utxo), valueSatoshis: utxo.satoshis, ...tokenOf(utxo) });
    } else {
      // a fee coin of the first signer: read what it is worth from the chain
      const source = decodeTransaction(hexToBin(await provider.getRawTransaction(txid)));
      const output = typeof source === 'string' ? undefined : source.outputs[input.outpointIndex];
      if (!output) throw new Error('A coin in this request could not be found on chain.');
      sourceOutputs.push({ ...base, lockingBytecode: output.lockingBytecode, valueSatoshis: output.valueSatoshis, ...(output.token ? { token: output.token } : {}) });
    }
  }
  if (!contractInputs.length) throw new Error('The money this request wants to move is no longer locked. It may already be settled.');

  // where does the money go? name every output we can recognise
  const roleLocks = Object.fromEntries(ROLES.map((r) => [binToHex(lockOfAddress(escrow, r)), r]));
  const category = terms.token?.category;
  const payouts = transaction.outputs.map((o) => ({
    role: roleLocks[binToHex(o.lockingBytecode)] ?? null,
    sats: o.valueSatoshis,
    tokens: o.token && binToHex(o.token.category) === category ? o.token.amount : 0n,
  }));
  const moved = contractInputs.reduce((sum, i) => sum + (terms.token ? sourceOutputs[i].token.amount : sourceOutputs[i].valueSatoshis), 0n);
  const toRecipient = payouts.filter((p) => p.role === request.recipient).reduce((sum, p) => sum + (terms.token ? p.tokens : p.sats), 0n);
  return { transaction, sourceOutputs, contractInputs, redeemScript: hexToBin(redeemHex), contractName: contract.artifact.contractName, payouts, moved, toRecipient, unknownOutputs: payouts.filter((p) => !p.role).length };
}

function lockOfAddress(escrow, role) {
  // P2PKH locking bytecode of a party: 76 a9 14 <hash160> 88 ac
  const pubkey = hexToBin(escrow.terms[role]);
  return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160(pubkey), 0x88, 0xac]);
}

/** Add the second signature with a local private key and return the final transaction hex. */
export function completeLocally(inspected, privateKey) {
  const { transaction, sourceOutputs, contractInputs, redeemScript } = inspected;
  for (const inputIndex of contractInputs) {
    const signature = signInput({ transaction, sourceOutputs, inputIndex }, redeemScript, privateKey);
    transaction.inputs[inputIndex].unlockingBytecode = hexToBin(
      binToHex(transaction.inputs[inputIndex].unlockingBytecode).replace(SECOND_SLOT_HEX, binToHex(signature)),
    );
  }
  return binToHex(encodeTransaction(transaction));
}
