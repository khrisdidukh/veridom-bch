// Generates fresh chipnet-only test keys into keys/chipnet.json (gitignored, chmod 600).
// Prints public addresses only. Never prints private keys.
import { generatePrivateKey, secp256k1, hash160, encodeCashAddress, binToHex } from '@bitauth/libauth';
import fs from 'node:fs';
const file = new URL('../keys/chipnet.json', import.meta.url);
if (fs.existsSync(file)) { console.error('keys/chipnet.json already exists; not overwriting'); }
else {
  const out = {};
  for (const role of ['owner', 'contractor', 'inspector']) {
    const priv = generatePrivateKey();
    out[role] = { privateKeyHex: binToHex(priv) };
  }
  fs.mkdirSync(new URL('../keys/', import.meta.url), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
}
const keys = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const [role, k] of Object.entries(keys)) {
  const pub = secp256k1.derivePublicKeyCompressed(Uint8Array.from(Buffer.from(k.privateKeyHex, 'hex')));
  const pkh = hash160(pub);
  const a = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address;
  const t = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address;
  console.log(role.padEnd(11), a, '| token-aware:', t);
}
