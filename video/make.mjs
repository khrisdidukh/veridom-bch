// Turns the raw Playwright recording (video/raw/*.webm + marks.json) into the demo video:
// 1080p MP4 with burned-in English captions, plus a copy under 10 MB.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const raw = new URL('./raw/', import.meta.url).pathname;
const out = new URL('./out/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const webm = fs.readdirSync(raw).filter((f) => f.endsWith('.webm')).map((f) => raw + f).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const { marks } = JSON.parse(fs.readFileSync(`${raw}marks.json`, 'utf8'));
const CAPTIONS = {
  home: 'Veridom Escrow: pay your builder stage by stage on Bitcoin Cash.',
  wallet: 'Chipnet practice wallet with free test coins. On mainnet you connect\nCashonize or Paytaca through WizardConnect.',
  'funded-wallet': 'The homeowner sets the stages, prices, a 5% retention\nand the date the warranty ends.',
  form: 'The terms become one link. Every vault address is derived from them.',
  escrow: 'Lock the money: each stage gets its own covenant on chain.',
  locked: 'Approve stage 1. The covenant pays the builder 95%\nand moves 5% into the retention vault.',
  paid1: 'Stage 2 was never started: two of the three parties\nrefund it to the homeowner.',
  refund2: 'Warranty over: the vault can only pay the builder.\nNo signature needed, nobody can stall it.',
  claimed: 'Every step was a real transaction. Open source, no server,\nfees under a cent.',
};
const stamp = (t) => { const ms = Math.round(t * 1000); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
const srt = marks.slice(0, -1).map((m, i) => `${i + 1}\n${stamp(m.t + 0.1)} --> ${stamp(marks[i + 1].t)}\n${CAPTIONS[m.name] ?? ''}\n`).join('\n');
fs.writeFileSync(`${out}captions.srt`, srt);
const duration = marks.at(-1).t;
const style = "FontName=DejaVu Sans,FontSize=13,PrimaryColour=&H00FFFFFF,BackColour=&HC03D2114,BorderStyle=4,Outline=0,Shadow=0,MarginV=24,Alignment=2";
const vf = `scale=1920:1080:flags=lanczos,subtitles=${out}captions.srt:force_style='${style}'`;
const run = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
run(['-i', webm, '-t', String(duration), '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '25', '-movflags', '+faststart', '-an', `${out}veridom-escrow-demo-1080p.mp4`]);
const kbps = Math.floor((9.2 * 8 * 1024) / duration); // stay under 10 MB
run(['-i', `${out}veridom-escrow-demo-1080p.mp4`, '-vf', 'scale=1280:720', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${Math.min(kbps, 1800)}k`, '-maxrate', `${Math.min(kbps, 1800)}k`, '-bufsize', '3M', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', `${out}veridom-escrow-demo-small.mp4`]);
for (const f of ['veridom-escrow-demo-1080p.mp4', 'veridom-escrow-demo-small.mp4']) console.log(f, (fs.statSync(out + f).size / 1048576).toFixed(2), 'MB', `${duration.toFixed(0)} s`);
