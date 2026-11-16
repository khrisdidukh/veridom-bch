// Two ways to sign:
//  - WizardConnect: the user's own BCH wallet (Cashonize, Paytaca, ...) signs. Keys never leave it.
//  - Practice wallet: throw-away keys kept in this browser, chipnet only, for trying the flow.
// Both expose the same small interface so the rest of the app does not care which one is used.
import { placeholderSignature, placeholderP2PKHUnlocker } from 'cashscript';
import { initiateDappRelay } from '@wizardconnect/core';
import { sourceOutputToRelay } from '@wizardconnect/core/hdwalletv1-serialize';
import { DappConnectionManager } from '@wizardconnect/dapp';
import {
  binToHex, hexToBin, generatePrivateKey, decodeTransaction, encodeTransaction,
} from '@bitauth/libauth';
import { localParty } from './party.js';
import { pubkeyToAddress } from './escrow.js';

export const SEATS = 3; // owner, contractor, inspector when one wallet plays every role
const SCAN = 6; // addresses scanned per chain for coins

import { SECOND_SLOT, SECOND_SLOT_HEX, ZERO_SIG_HEX, completeLocally } from './cosign.js';

// ---------------------------------------------------------------- practice wallet (chipnet)

const PRACTICE_KEY = 'veridom-practice-wallet-v1';

export function practiceWallet(storage = globalThis.localStorage) {
  const network = 'chipnet';
  let saved = null;
  try { saved = JSON.parse(storage.getItem(PRACTICE_KEY)); } catch { /* first visit */ }
  if (!Array.isArray(saved) || saved.length !== SEATS) {
    saved = Array.from({ length: SEATS }, () => binToHex(generatePrivateKey()));
    storage.setItem(PRACTICE_KEY, JSON.stringify(saved));
  }
  const parties = saved.map((key) => localParty(key, network));
  const byPubkey = (pubkey) => parties.find((p) => p.pubkey === pubkey);
  return {
    kind: 'practice',
    label: 'Practice wallet (test coins)',
    network,
    keys: parties.map((p) => p.pubkey),
    address: (seat) => parties[seat].address,
    tokenAddress: (seat) => parties[seat].tokenAddress,
    holds: (pubkey) => Boolean(byPubkey(pubkey)),
    /** our own keys sign right away; another party's signature gets a place-holder */
    signatureFor: (pubkey) => (byPubkey(pubkey) ? byPubkey(pubkey).signature() : SECOND_SLOT),
    /** first half of a two-device action: signed by us, not broadcast */
    async signPartial(builder) { return builder.build(); },
    /** second half: add our signature to a request prepared by another party */
    async complete(inspected, pubkey) { return completeLocally(inspected, hexToBin(saved[parties.indexOf(byPubkey(pubkey))])); },
    async coins(provider) {
      const lists = await Promise.all(parties.map((p) => p.utxos(provider)));
      return lists.flat();
    },
    async send(builder) {
      return (await builder.send()).txid;
    },
    disconnect() {},
  };
}

// ---------------------------------------------------------------- WizardConnect

const PATHS = [['receive', 0], ['change', 1]];

/**
 * Start pairing. Returns { uri, ready, cancel }.
 * Show `uri` as a QR code or link; `ready` resolves with the wallet once the user approved.
 */
export function connectWizard(network, { resume = false } = {}) {
  const manager = new DappConnectionManager('Veridom Escrow', `${globalThis.location?.origin ?? ''}${globalThis.location?.pathname ?? ''}icon.svg`);
  const stored = resume ? manager.loadStoredSession() : null;
  if (resume && !stored?.walletPublicKey) return null;
  let relay;
  try {
    relay = initiateDappRelay(
      (payload) => manager.updateConnection(payload.client, payload.status),
      stored ? { existingCredentials: { privateKey: stored.privateKey, secret: stored.secret, walletPublicKey: stored.walletPublicKey } } : undefined,
    );
  } catch (error) {
    manager.clearStoredSession();
    if (resume) return null;
    throw error;
  }
  manager.attachRelay(relay);

  const build = () => wizardWallet(network, manager, relay);
  const ready = new Promise((resolve, reject) => {
    if (stored?.paths?.length && manager.getPubkey(0, 0n)) resolve(build());
    manager.on('walletready', () => resolve(build()));
    manager.on('disconnect', (reason, message) => reject(new Error(message ?? `The wallet disconnected (${reason}).`)));
  });
  return {
    uri: relay.uri,
    ready,
    cancel() { manager.clearStoredSession(); relay.cleanup(); },
  };
}

function relaySourceOutput(so, contract) {
  return {
    ...sourceOutputToRelay(so),
    ...(contract ? { contract: {
      abiFunction: { name: contract.abiFunction.name },
      redeemScript: binToHex(contract.redeemScript),
      artifact: { contractName: contract.artifact.contractName },
    } } : {}),
  };
}

function wizardWallet(network, manager, relay) {
  const derive = (child, index) => {
    const pubkey = manager.getPubkey(child, BigInt(index));
    if (!pubkey) throw new Error('The wallet did not share its public keys.');
    return binToHex(pubkey);
  };
  const keys = Array.from({ length: SEATS }, (_, i) => derive(0, i));
  // every address we may spend from, with the path the wallet needs to sign for it
  const known = PATHS.flatMap(([name, child]) => Array.from({ length: SCAN }, (_, index) => {
    const pubkey = derive(child, index);
    return { pubkey, path: [name, index], address: pubkeyToAddress(pubkey, network) };
  }));
  const pathOfPubkey = (pubkey) => known.find((k) => k.pubkey === pubkey)?.path;
  const pathOfLock = new Map();

  async function sign(request, inputPaths) {
    const response = await manager.signTransaction({ transaction: request, inputPaths });
    if (response.error) throw new Error(`The wallet did not sign: ${response.error}`);
    return response.signedTransaction;
  }

  return {
    kind: 'wizard',
    label: manager.walletName ?? 'Wallet',
    network,
    keys,
    address: (seat) => pubkeyToAddress(keys[seat], network),
    tokenAddress: (seat) => pubkeyToAddress(keys[seat], network, true),
    holds: (pubkey) => Boolean(pathOfPubkey(pubkey)),
    /** slot 0 is signed first; slot 1 (two-party actions) is signed in a second request. */
    signatureFor: (pubkey, slot = 0) => (slot === 0 ? placeholderSignature() : SECOND_SLOT),
    async coins(provider) {
      const lists = await Promise.all(known.map(async (k) => {
        const utxos = await provider.getUtxos(k.address);
        return utxos.map((utxo) => {
          pathOfLock.set(utxo.lockingBytecode, k.path);
          return { utxo, unlocker: placeholderP2PKHUnlocker(k.address) };
        });
      }));
      return lists.flat();
    },
    /**
     * `signers` = public keys that sign the covenant input(s), in slot order.
     * The wallet shows the transaction to the user; nothing is broadcast without approval.
     */
    async send(builder, { signers = [], prompt } = {}) {
      let signedHex = await this.signPartial(builder, { signers, prompt });
      if (signers[1] && pathOfPubkey(signers[1])) {
        // second signature of a two-party action, from another key of the same wallet
        const tx = decodeTransaction(hexToBin(signedHex));
        if (typeof tx === 'string') throw new Error(tx);
        const sourceOutputs = builder.generateWcTransactionObject().sourceOutputs.map((so, i) => ({ ...so, unlockingBytecode: tx.inputs[i].unlockingBytecode }));
        const contractInputs = sourceOutputs.map((so, i) => (so.contract ? i : -1)).filter((i) => i >= 0);
        const first = sourceOutputs[contractInputs[0]].contract;
        signedHex = await this.complete({
          transaction: tx, sourceOutputs, contractInputs, redeemScript: first.redeemScript, contractName: first.artifact.contractName,
        }, signers[1], `${prompt ?? 'Co-sign'} (second signature)`);
      }
      if (signedHex.includes(ZERO_SIG_HEX) || signedHex.includes(SECOND_SLOT_HEX)) {
        throw new Error('This action needs a second signature from another party.');
      }
      return builder.provider.sendRawTransaction(signedHex);
    },
    /** Ask the wallet for our signature(s); returns the transaction hex without broadcasting. */
    async signPartial(builder, { signers = [], prompt } = {}) {
      const object = builder.generateWcTransactionObject({ broadcast: false, userPrompt: prompt });
      const firstPath = signers[0] ? pathOfPubkey(signers[0]) : undefined;
      const inputPaths = [];
      const sourceOutputs = object.sourceOutputs.map((so, i) => {
        if (so.contract) {
          if (binToHex(so.unlockingBytecode).includes(ZERO_SIG_HEX)) {
            if (!firstPath) throw new Error('This wallet does not hold the key that has to sign here.');
            inputPaths.push([i, ...firstPath]);
          }
        } else {
          const path = pathOfLock.get(binToHex(so.lockingBytecode));
          if (!path) throw new Error('A coin in this transaction does not belong to the connected wallet.');
          inputPaths.push([i, ...path]);
        }
        return relaySourceOutput(so, so.contract);
      });
      return sign({ transaction: binToHex(encodeTransaction(object.transaction)), sourceOutputs, broadcast: false, userPrompt: prompt }, inputPaths);
    },
    /** Add our signature to a half-signed two-party transaction (ours or another party's). */
    async complete(inspected, pubkey, prompt = 'Co-sign') {
      const path = pathOfPubkey(pubkey);
      if (!path) throw new Error('This wallet does not hold the key that has to co-sign.');
      const { transaction, contractInputs } = inspected;
      const contract = { abiFunction: { name: 'cosign' }, redeemScript: inspected.redeemScript, artifact: { contractName: inspected.contractName } };
      for (const i of contractInputs) {
        transaction.inputs[i].unlockingBytecode = hexToBin(binToHex(transaction.inputs[i].unlockingBytecode).replace(SECOND_SLOT_HEX, ZERO_SIG_HEX));
      }
      const sourceOutputs = inspected.sourceOutputs.map((so, i) => relaySourceOutput(
        { ...so, unlockingBytecode: transaction.inputs[i].unlockingBytecode },
        contractInputs.includes(i) ? contract : undefined,
      ));
      return sign({ transaction: binToHex(encodeTransaction(transaction)), sourceOutputs, broadcast: false, userPrompt: prompt }, contractInputs.map((i) => [i, ...path]));
    },
    async disconnect() {
      manager.clearStoredSession();
      try { await manager.sendDisconnect('Disconnected in Veridom Escrow'); } catch { /* wallet may be offline */ }
      relay.cleanup();
    },
  };
}
