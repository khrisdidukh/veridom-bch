// A headless WizardConnect wallet for development and end-to-end tests (chipnet only).
// It follows the hdwalletv1 signing rules the same way real wallets do: P2PKH inputs listed in
// inputPaths are signed, and in covenant inputs the first zero-filled signature placeholder is
// replaced. The seed lives in keys/dev-wallet.json (gitignored). Never use it for real money.
import fs from 'node:fs';
import { WalletConnectionManager } from '@wizardconnect/wallet';
import { generateKeyExchangeCredentials, toUint8Array, toBigInt } from '@wizardconnect/core';
import {
  deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPrivateNodeChild, deriveHdPublicNode, encodeHdPublicKey,
  secp256k1, hash256, hexToBin, binToHex, decodeTransaction, encodeTransaction, encodeDataPush,
  generateSigningSerializationBch, SigningSerializationFlag, generateRandomBytes,
} from '@bitauth/libauth';

const file = new URL('../keys/dev-wallet.json', import.meta.url);
if (!fs.existsSync(file)) {
  fs.writeFileSync(file, JSON.stringify({ seedHex: binToHex(generateRandomBytes(32)), relayKeyHex: generateKeyExchangeCredentials().privateKey }), { mode: 0o600 });
}
const secrets = JSON.parse(fs.readFileSync(file, 'utf8'));
const master = deriveHdPrivateNodeFromSeed(hexToBin(secrets.seedHex));
const CHILD = { receive: 0, change: 1, defi: 7 };
const chain = (child) => deriveHdPath(master, `m/44'/145'/0'/${child}`);
const keyAt = (child, index) => deriveHdPrivateNodeChild(chain(child), Number(index)).privateKey;
const hashType = SigningSerializationFlag.allOutputs | SigningSerializationFlag.utxos | SigningSerializationFlag.forkId;

function signInput(context, coveredBytecode, privateKey) {
  const preimage = generateSigningSerializationBch(context, { coveredBytecode, signingSerializationType: new Uint8Array([hashType]) });
  return Uint8Array.from([...secp256k1.signMessageHashSchnorr(privateKey, hash256(preimage)), hashType]);
}

const parseToken = (t) => (t ? {
  category: toUint8Array(t.category), amount: toBigInt(t.amount ?? 0),
  ...(t.nft ? { nft: { capability: t.nft.capability ?? 'none', commitment: toUint8Array(t.nft.commitment ?? '') } } : {}),
} : undefined);

export function signRequest(request) {
  const { transaction: txItem, sourceOutputs: rawOutputs } = request.transaction;
  const transaction = decodeTransaction(hexToBin(txItem));
  if (typeof transaction === 'string') throw new Error(transaction);
  const sourceOutputs = rawOutputs.map((so) => ({
    outpointIndex: so.outpointIndex, outpointTransactionHash: toUint8Array(so.outpointTransactionHash), sequenceNumber: so.sequenceNumber,
    unlockingBytecode: toUint8Array(so.unlockingBytecode), lockingBytecode: toUint8Array(so.lockingBytecode),
    valueSatoshis: toBigInt(so.valueSatoshis), ...(so.token ? { token: parseToken(so.token) } : {}),
    contract: so.contract ? { redeemScript: toUint8Array(so.contract.redeemScript) } : undefined,
  }));
  const keys = new Map(request.inputPaths.map(([i, name, index]) => [i, keyAt(CHILD[name], index)]));
  transaction.inputs.forEach((input, index) => {
    const so = sourceOutputs[index];
    const key = keys.get(index);
    const context = { inputIndex: index, sourceOutputs, transaction };
    if (so.contract) {
      let hex = binToHex(so.unlockingBytecode);
      const placeholder = `41${'00'.repeat(65)}`;
      if (hex.includes(placeholder)) {
        if (!key) throw new Error(`No key for contract input ${index}`);
        hex = hex.replace(placeholder, `41${binToHex(signInput(context, so.contract.redeemScript, key))}`);
      }
      input.unlockingBytecode = hexToBin(hex);
    } else if (key) {
      input.unlockingBytecode = Uint8Array.from([...encodeDataPush(signInput(context, so.lockingBytecode, key)), ...encodeDataPush(secp256k1.derivePublicKeyCompressed(key))]);
    }
  });
  return binToHex(encodeTransaction(transaction));
}

/** Connect to a dapp pairing URI and approve every sign request automatically. */
export function startDevWallet(uri, log = () => {}) {
  const adapter = {
    walletName: 'Veridom dev wallet (chipnet)',
    walletIcon: '',
    getRelayPrivateKey: () => hexToBin(secrets.relayKeyHex),
    getPublicKey: (path, index) => secp256k1.derivePublicKeyCompressed(keyAt(Number(path), index)),
    getXpub: (path) => encodeHdPublicKey({ node: deriveHdPublicNode(chain(Number(path))), network: 'mainnet' }).hdPublicKey,
    async signTransaction(request) { return { signedTransaction: signRequest(request) }; },
  };
  const manager = new WalletConnectionManager(adapter);
  manager.on('pendingSignRequest', ({ connectionId, request }) => {
    log(`sign request #${request.sequence}: ${request.transaction.userPrompt ?? ''} (${request.inputPaths.length} input(s) to sign)`);
    try {
      manager.sendSignResponse(connectionId, request.sequence, signRequest(request)).catch((e) => log(`send failed: ${e.message}`));
    } catch (error) {
      manager.sendSignError(connectionId, request.sequence, error.message).catch(() => {});
    }
  });
  manager.connect(uri);
  return manager;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv[2]) { console.error('usage: node scripts/dev-wallet.mjs "<wizardconnect uri>"'); process.exit(1); }
  startDevWallet(process.argv[2], console.log);
  console.log('dev wallet connected; approving sign requests automatically. Ctrl+C to stop.');
}
