// Turns the raw Playwright recording (video/raw/*.webm + marks.json) into the demo video:
// intro card, the real app flow (long waits for the network sped up), outro card, burned-in
// English captions. Output: 1080p MP4 plus a copy under 10 MB.
//   python3 video/cards.py video/out && node video/make.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const raw = new URL('./raw/', import.meta.url).pathname;
const out = new URL('./out/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const webm = fs.readdirSync(raw).filter((f) => f.endsWith('.webm')).map((f) => raw + f).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const { marks } = JSON.parse(fs.readFileSync(`${raw}marks.json`, 'utf8'));
const run = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-threads', '2', ...args], { stdio: 'inherit' });
const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

// The recording starts when the browser opens; marks count from script start and the file ends
// right after the last mark, so the offset follows from the file length.
const total = probe(webm);
const offset = total - marks.at(-1).t - 0.3;
const at = (name) => marks.find((m) => m.name === name).t + offset;

const INTRO = 6;
const OUTRO = 6;
// [from mark, to mark, longest on-screen duration, caption]
const SEGMENTS = [
  ['home', 'wallet', 6, 'Mainnet: judges connect Cashonize or Paytaca through WizardConnect.\nThis recording uses the chipnet practice wallet with free test coins.'],
  ['wallet', 'funded-wallet', 3.5, 'Free test coins from the chipnet faucet (sped up).'],
  ['funded-wallet', 'form', 4, 'The homeowner sets the stages, prices, a 5% retention\nand the date the warranty ends.'],
  ['form', 'escrow', 6, 'The terms become one link. Every vault address is derived from them.'],
  ['escrow', 'locked', 7, 'Lock the money: each stage gets its own covenant on chain.'],
  ['locked', 'paid1', 8, 'Approve stage 1. The covenant pays the builder 95%\nand moves 5% into the retention vault.'],
  ['paid1', 'refund2', 8, 'Stage 2 was never started: two of the three parties\nrefund it to the homeowner.'],
  ['refund2', 'claimed', 8, 'Warranty over: the vault can only pay the builder.\nNo signature needed, nobody can stall it.'],
  ['claimed', null, 6, 'Every step was a real transaction on chain. Fees under a cent.'],
];

const parts = [];
const captions = [];
let clock = INTRO;
captions.push([0.2, INTRO - 0.2, 'BCH BLAZE 2026 · Veridom Escrow']);
for (const [from, to, max, text] of SEGMENTS) {
  const start = Math.max(0, at(from));
  const end = to ? at(to) : total - 0.1;
  const len = end - start;
  const speed = Math.max(1, len / max);
  const shown = len / speed;
  parts.push({ start, end, speed });
  captions.push([clock + 0.15, clock + shown - 0.1, text]);
  clock += shown;
}
captions.push([clock + 0.2, clock + OUTRO - 0.2, 'Try it on mainnet with your own wallet.']);
const duration = clock + OUTRO;

const stamp = (t) => { const ms = Math.round(t * 1000); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
fs.writeFileSync(`${out}captions.srt`, captions.map(([a, b, t], i) => `${i + 1}\n${stamp(a)} --> ${stamp(b)}\n${t}\n`).join('\n'));

// 1) cut and retime each piece on its own (low memory), then join and caption
const norm = 'scale=1920:1080:flags=lanczos,setsar=1,fps=25,format=yuv420p';
const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', '25', '-pix_fmt', 'yuv420p', '-an'];
const pieces = [];
const piece = (name, args) => { const f = `${out}piece-${name}.mp4`; run([...args, ...enc, f]); pieces.push(f); };
piece('intro', ['-loop', '1', '-t', String(INTRO), '-i', `${out}intro.png`, '-vf', norm]);
parts.forEach((p, i) => piece(String(i), ['-ss', p.start.toFixed(3), '-to', p.end.toFixed(3), '-i', webm, '-vf', `setpts=(PTS-STARTPTS)/${p.speed.toFixed(4)},${norm}`]));
piece('outro', ['-loop', '1', '-t', String(OUTRO), '-i', `${out}outro.png`, '-vf', norm]);
fs.writeFileSync(`${out}pieces.txt`, pieces.map((f) => `file '${f}'`).join('\n'));
const style = "FontName=Inter Medium,FontSize=10,PrimaryColour=&H00FFFFFF,BackColour=&H183D2114,BorderStyle=4,Outline=0,Shadow=0,MarginV=24,Alignment=2";
run(['-f', 'concat', '-safe', '0', '-i', `${out}pieces.txt`, '-vf', `subtitles=${out}captions.srt:force_style='${style}'`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
  `${out}veridom-escrow-demo-1080p.mp4`]);
pieces.forEach((f) => fs.rmSync(f));
// 2) small copy, under 10 MB
run(['-i', `${out}veridom-escrow-demo-1080p.mp4`, '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-preset', 'veryfast',
  '-crf', '24', '-maxrate', '1500k', '-bufsize', '3000k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', `${out}veridom-escrow-demo-small.mp4`]);
for (const f of ['veridom-escrow-demo-1080p.mp4', 'veridom-escrow-demo-small.mp4']) console.log(f, (fs.statSync(out + f).size / 1048576).toFixed(2), 'MB', `${probe(out + f).toFixed(1)} s`);
