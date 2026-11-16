// A party that signs with a local private key. Used by the tests, the chipnet
// script and the in-browser practice wallet (chipnet only).
import { SignatureTemplate } from 'cashscript';
import { secp256k1, binToHex, hexToBin } from '@bitauth/libauth';
import { pubkeyToAddress } from './escrow.js';

export function localParty(privateKeyHex, network) {
  const template = new SignatureTemplate(hexToBin(privateKeyHex));
  const pubkey = binToHex(secp256k1.derivePublicKeyCompressed(hexToBin(privateKeyHex)));
  const address = pubkeyToAddress(pubkey, network);
  return {
    kind: 'local',
    pubkey,
    address,
    tokenAddress: pubkeyToAddress(pubkey, network, true),
    signature: () => template,
    /** All coins of this party, paired with the unlocker that spends them. */
    async utxos(provider) {
      return (await provider.getUtxos(address)).map((utxo) => ({ utxo, unlocker: template.unlockP2PKH() }));
    },
    /** Sign locally and broadcast. Returns the transaction id. */
    async send(builder) {
      const details = await builder.send();
      return details.txid;
    },
  };
}
