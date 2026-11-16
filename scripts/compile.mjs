// Compiles contracts/*.cash into src/artifacts/*.json
import { compileFile } from 'cashc';
import fs from 'node:fs';
const dir = new URL('../contracts/', import.meta.url);
const out = new URL('../src/artifacts/', import.meta.url);
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.cash'))) {
  const artifact = compileFile(new URL(f, dir));
  delete artifact.updatedAt; // keep builds reproducible
  fs.writeFileSync(new URL(f.replace('.cash', '.json'), out), JSON.stringify(artifact, null, 2) + '\n');
  console.log('compiled', f, '-', artifact.bytecode.split(' ').length, 'ops');
}
