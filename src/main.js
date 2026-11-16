import './style.css';
import QRCode from 'qrcode';
import { TransactionBuilder } from 'cashscript';
import {
  createEscrow, validateTerms, encodeTerms, decodeTerms, readState, buildFund, buildRelease, buildClaim, buildCosign,
  formatAmount, parseAmount, FEE_RATE, ROLES,
} from './lib/escrow.js';
import { connect, EXPLORER } from './lib/providers.js';
import { practiceWallet, connectWizard } from './lib/wallets.js';
import { SECOND_SLOT, encodeRequest, decodeRequest, inspectRequest } from './lib/cosign.js';
import { REPO_URL, PRESENTATION_URL, EMBER_ADDRESS, PUSD, FAUCET_URL } from './config.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(key, fallback = null) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};
const ROLE_NAME = { owner: 'Homeowner', contractor: 'Builder', inspector: 'Inspector' };
const params = new URLSearchParams(location.search);

const S = {
  network: store.get('veridom-network', 'mainnet'),
  providers: {},
  wallet: null,
  coins: [],
  escrow: null,
  chain: null,
  busy: '',
  form: null,
  request: null, // a co-sign request opened from a link
  inspected: null,
};

// ------------------------------------------------------------------ helpers

function toast(html, bad = false) {
  const el = $('toast');
  el.innerHTML = html;
  el.className = `toast${bad ? ' bad' : ''}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, bad ? 9000 : 6000);
}
const txLink = (txid) => `<a href="${EXPLORER[S.network]}${txid}" target="_blank" rel="noopener">view transaction</a>`;
const short = (s, n = 10) => (s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const dateText = (unix) => new Date(unix * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function provider() {
  S.providers[S.network] ??= connect(S.network, params.get('provider'));
  return S.providers[S.network];
}

function friendly(error) {
  const text = String(error?.message ?? error);
  if (/Milestone\.cash|Retention\.cash/.test(text)) return 'The escrow rules do not allow this transaction.';
  if (/time-locked|non-final|not accept/i.test(text)) return `${text.split('\n')[0]} If the warranty date has just passed, wait about an hour: the network clock runs behind.`;
  if (/AbortError|rejected|cancel/i.test(text)) return 'Cancelled in the wallet. Nothing was sent.';
  return text.split('\n')[0].slice(0, 220);
}

/** Runs one user action with a busy state and readable errors. */
async function run(label, fn) {
  if (S.busy) return;
  S.busy = label;
  render();
  try { await fn(); } catch (error) { console.error(error); toast(esc(friendly(error)), true); }
  S.busy = '';
  render();
}

async function loadCoins() {
  S.coins = S.wallet ? await S.wallet.coins(await provider()) : [];
}
const plainBalance = () => S.coins.filter((c) => !c.utxo.token).reduce((s, c) => s + c.utxo.satoshis, 0n);
const tokenBalance = (category) => S.coins.filter((c) => c.utxo.token?.category === category && !c.utxo.token.nft).reduce((s, c) => s + c.utxo.token.amount, 0n);

function logKey() { return `veridom-log-${S.escrow.termsHash}`; }
function addLog(label, txid) { store.set(logKey(), [{ label, txid, at: Date.now() }, ...store.get(logKey(), [])].slice(0, 30)); }

async function refreshEscrow({ expectChange = false } = {}) {
  const p = await provider();
  const before = JSON.stringify(S.chain, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  for (let i = 0; i < (expectChange ? 6 : 1); i += 1) {
    if (expectChange) await sleep(1500);
    S.chain = await readState(S.escrow, p.getHistory);
    if (!expectChange || JSON.stringify(S.chain, (k, v) => (typeof v === 'bigint' ? String(v) : v)) !== before) break;
  }
  await loadCoins();
}

// ------------------------------------------------------------------ wallet

function setWallet(wallet) {
  S.wallet = wallet;
  store.set('veridom-wallet-kind', wallet ? wallet.kind : null);
  $('modal').hidden = true;
}

async function openWalletModal() {
  const modal = $('modal');
  if (S.wallet) {
    modal.innerHTML = `<div class="sheet">
      <h2>${esc(S.wallet.label)}</h2>
      <div class="wallet-box">
        <div class="wallet-line"><span class="muted">Balance</span><b class="mono">${formatAmount({ network: S.network, token: null }, plainBalance())}</b></div>
        <div><span class="muted">Your Veridom key (give it to the other parties)</span><div class="mono" id="my-key">${S.wallet.keys[0]}</div></div>
        <div><span class="muted">Receiving address</span><div class="mono">${S.wallet.address(0)}</div></div>
      </div>
      <button class="btn ghost" data-action="copy" data-copy="${S.wallet.keys[0]}">Copy my key</button>
      ${S.network === 'chipnet' ? '<button class="btn go" data-action="faucet">Get free test coins</button>' : ''}
      <button class="btn ghost" data-action="disconnect">Disconnect</button>
      <button class="btn link" data-action="close">Close</button></div>`;
    modal.hidden = false;
    return;
  }
  let pairing = null;
  try { pairing = connectWizard(S.network); } catch (error) { console.error(error); }
  const qr = pairing ? await QRCode.toDataURL(pairing.uri, { margin: 1, width: 520, color: { dark: '#14213d' } }) : '';
  modal.innerHTML = `<div class="sheet">
    <h2>Connect your BCH wallet</h2>
    ${pairing ? `<img class="qr" src="${qr}" alt="WizardConnect QR code" width="260" height="260">
    <ol><li>Open <b>Cashonize</b>, <b>Paytaca</b> or another WizardConnect wallet${S.network === 'chipnet' ? ' and switch it to chipnet' : ''}.</li>
    <li>Choose "Connect to dapp" and scan this code, or paste the link.</li><li>Approve the connection in the wallet.</li></ol>
    <button class="btn ghost" data-action="copy" data-copy="${esc(pairing.uri)}" id="copy-uri">Copy connection link</button>
    <p class="fine">Your keys stay in your wallet. Every payment is shown there for approval first.</p>` : '<p class="notice">The WizardConnect relay could not be reached. Check your connection and try again.</p>'}
    ${S.network === 'chipnet' ? '<p class="or">or, to just try it</p><button class="btn go" data-action="practice">Use a practice wallet (no install)</button><p class="fine">Throw-away keys kept in this browser, test coins only.</p>'
    : '<p class="or">no wallet at hand?</p><button class="btn ghost" data-action="to-chipnet">Try it on chipnet with free test coins</button>'}
    <button class="btn link" data-action="close">Close</button></div>`;
  modal.hidden = false;
  openWalletModal.cancel = pairing?.cancel;
  pairing?.ready.then(async (wallet) => {
    if (S.wallet) return;
    openWalletModal.cancel = null;
    setWallet(wallet);
    toast(`Connected to ${esc(wallet.label)}.`);
    await afterWalletChange();
  }).catch((error) => { if (!modal.hidden && !S.wallet) toast(esc(friendly(error)), true); });
}

async function afterWalletChange() {
  try { await loadCoins(); } catch (error) { console.error(error); }
  render();
}

async function resumeWallet() {
  const kind = store.get('veridom-wallet-kind');
  if (kind === 'practice' && S.network === 'chipnet') { S.wallet = practiceWallet(); return; }
  if (kind === 'wizard') {
    const pairing = connectWizard(S.network, { resume: true });
    if (!pairing) return;
    const wallet = await Promise.race([pairing.ready, sleep(2500).then(() => null)]).catch(() => null);
    if (wallet) S.wallet = wallet; else pairing.ready.then((w) => { if (!S.wallet) { S.wallet = w; afterWalletChange(); } }).catch(() => {});
  }
}

// ------------------------------------------------------------------ create form

function defaultForm() {
  return {
    title: 'Family house - ground floor',
    solo: true,
    contractor: '',
    inspector: '',
    currency: 'bch',
    customCategory: '',
    retention: '5',
    warranty: '3y',
    warrantyDate: '',
    milestones: [
      { name: 'Foundation', amount: '0.00012' },
      { name: 'Shell and roof', amount: '0.00012' },
    ],
    problems: [],
  };
}

function formToken(f) {
  if (f.currency === 'pusd') return PUSD;
  if (f.currency === 'test') return store.get('veridom-test-token');
  if (f.currency === 'custom') return { category: f.customCategory.trim(), symbol: 'TOKEN', decimals: 0 };
  return null;
}

function formTerms(f) {
  const token = formToken(f);
  const decimals = token ? token.decimals : 8;
  const now = Math.floor(Date.now() / 1000);
  const warrantyEnd = { '3y': now + 3 * 31557600, '1y': now + 31557600, past: now - 3 * 3600 }[f.warranty]
    ?? Math.floor(new Date(`${f.warrantyDate}T12:00:00`).getTime() / 1000);
  const keys = S.wallet?.keys ?? [];
  return {
    network: S.network,
    title: f.title,
    owner: keys[0] ?? '',
    contractor: f.solo ? keys[1] ?? '' : f.contractor.trim(),
    inspector: f.solo ? keys[2] ?? '' : f.inspector.trim(),
    retentionBps: Math.round(Number(f.retention.replace(',', '.')) * 100),
    warrantyEnd,
    token,
    milestones: f.milestones.map((m) => ({ name: m.name, amount: parseAmount(m.amount, decimals).toString() })),
  };
}

function renderHome() {
  S.form ??= defaultForm();
  const f = S.form;
  const chip = S.network === 'chipnet';
  const testToken = store.get('veridom-test-token');
  const unit = { bch: chip ? 'tBCH' : 'BCH', pusd: 'PUSD', test: 'tUSD', custom: 'units' }[f.currency];
  const warrantyChips = [['3y', 'In 3 years'], ['1y', 'In 1 year'], ['past', 'Already ended (test the payout now)'], ['date', 'Pick a date']];
  return `
  <section class="hero">
    <h1>Pay your builder stage by stage. The chain holds the money, not a promise.</h1>
    <p>Lock the price of each building stage on Bitcoin Cash. Approve a stage and the builder is paid in seconds, while a retention stays locked until the warranty ends. No bank, no notary account, fees under a cent.</p>
    <div class="hero-actions">
      ${S.wallet ? '' : '<button class="btn go" data-action="wallet">Connect wallet to start</button>'}
      ${chip ? '' : '<button class="btn ghost" data-action="to-chipnet">Try with free test coins</button>'}
    </div>
    ${chip ? '' : '<p class="judge"><b>Judges, 2-minute mainnet test:</b> connect Cashonize or Paytaca, keep "I am trying it alone", pick "Already ended", then lock, approve, refund and claim. About 0.0003 BCH is used and all of it lands back in your own wallet, minus fees under a cent.</p>'}
  </section>
  <ol class="how">
    <li><b>Agree</b> Stages, prices, retention and warranty date become one shareable link.</li>
    <li><b>Lock</b> The homeowner locks the money. Each stage gets its own on-chain vault.</li>
    <li><b>Approve</b> Homeowner or inspector approves a stage. The covenant pays the builder and sets the retention aside.</li>
    <li><b>Warranty</b> When it ends, the retention can only go to the builder. Nobody can stall it.</li>
  </ol>
  <section class="card" id="create">
    <h2>New escrow</h2>
    <p class="lead">${S.wallet ? `You are the homeowner. Connected: ${esc(S.wallet.label)}.` : 'Connect a wallet first: its key identifies you as the homeowner.'}</p>
    <label class="field"><span>Project</span><input data-f="title" value="${esc(f.title)}" maxlength="80"></label>
    <label class="check"><input type="checkbox" data-f="solo" ${f.solo ? 'checked' : ''}><span><b>I am trying it alone</b><br><small class="muted">Your wallet plays homeowner, builder and inspector with three of its own keys. Untick to enter the real builder and inspector.</small></span></label>
    ${f.solo ? '' : `<div class="row">
      <label class="field"><span>Builder's Veridom key</span><input class="mono" data-f="contractor" value="${esc(f.contractor)}" placeholder="02… or 03… (66 characters)"></label>
      <label class="field"><span>Inspector's Veridom key</span><input class="mono" data-f="inspector" value="${esc(f.inspector)}" placeholder="02… or 03… (66 characters)"></label>
    </div><p class="fine" style="margin:-6px 0 14px">Each party connects their wallet on this page and copies "my key" from the wallet menu. The inspector is an independent site supervisor both sides trust.</p>`}
    <div class="row">
      <label class="field"><span>Pay in</span>
        <select data-f="currency">
          <option value="bch" ${f.currency === 'bch' ? 'selected' : ''}>${chip ? 'tBCH (test Bitcoin Cash)' : 'Bitcoin Cash (BCH)'}</option>
          ${chip ? `<option value="test" ${f.currency === 'test' ? 'selected' : ''}>tUSD test stablecoin (CashToken)</option>` : `<option value="pusd" ${f.currency === 'pusd' ? 'selected' : ''}>ParyonUSD stablecoin (PUSD)</option>`}
          <option value="custom" ${f.currency === 'custom' ? 'selected' : ''}>Another CashToken</option>
        </select></label>
      <label class="field"><span>Retention, %</span><input data-f="retention" inputmode="decimal" value="${esc(f.retention)}"><small>Held back from every stage until the warranty ends.</small></label>
    </div>
    ${f.currency === 'custom' ? `<label class="field"><span>Token category</span><input class="mono" data-f="customCategory" value="${esc(f.customCategory)}" placeholder="64 hex characters"><small>Amounts are entered in the token's smallest unit.</small></label>` : ''}
    ${f.currency === 'test' && !testToken ? '<div class="notice">You need test stablecoins first. <button class="btn small" data-action="mint">Mint 10,000 tUSD</button></div>' : ''}
    ${f.currency === 'test' && testToken && S.wallet ? `<div class="notice ok">Your wallet holds ${formatAmount({ token: testToken }, tokenBalance(testToken.category))}.</div>` : ''}
    <div class="field"><span>Warranty ends</span>
      <div class="chips">${warrantyChips.map(([v, label]) => `<button type="button" class="chip" data-action="warranty" data-v="${v}" aria-pressed="${f.warranty === v}">${label}</button>`).join('')}</div>
      ${f.warranty === 'date' ? `<input type="date" data-f="warrantyDate" value="${esc(f.warrantyDate)}">` : ''}
    </div>
    <div class="field"><span>Stages and prices (${unit})</span>
      ${f.milestones.map((m, i) => `<div class="ms-row">
        <input data-m="${i}" data-k="name" value="${esc(m.name)}" placeholder="Stage name" aria-label="Stage ${i + 1} name">
        <input data-m="${i}" data-k="amount" value="${esc(m.amount)}" inputmode="decimal" aria-label="Stage ${i + 1} price">
        <button class="x" data-action="del-ms" data-i="${i}" aria-label="Remove stage ${i + 1}" ${f.milestones.length < 2 ? 'disabled' : ''}>×</button></div>`).join('')}
      <button class="btn link" data-action="add-ms">+ Add a stage</button>
    </div>
    <button class="btn go" data-action="create" ${S.wallet ? '' : 'disabled'}>Create escrow</button>
    ${f.problems.length ? `<ul class="problems">${f.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

// ------------------------------------------------------------------ escrow page

function myRoles() {
  if (!S.wallet || !S.escrow) return [];
  return ROLES.filter((r) => S.wallet.holds(S.escrow.terms[r]));
}

function renderEscrow() {
  const { terms } = S.escrow;
  const chain = S.chain;
  const mine = myRoles();
  const fmt = (v) => formatAmount(terms, v);
  const now = Math.floor(Date.now() / 1000);
  const warrantyOver = now >= terms.warrantyEnd;
  const canApprove = mine.includes('owner') || mine.includes('inspector');
  const canCosign = mine.length >= 2;
  const total = S.escrow.milestones.reduce((s, m) => s + m.amount, 0n);
  let locked = 0n; let paid = 0n;
  S.escrow.milestones.forEach((m) => {
    const st = chain?.milestones[m.index];
    if (st?.status === 'locked') locked += st.locked;
    if (st?.status === 'paid') paid += m.payout;
  });
  const unfunded = chain ? S.escrow.milestones.filter((m) => chain.milestones[m.index].status === 'unfunded') : [];
  const needFund = unfunded.reduce((s, m) => s + m.amount, 0n);
  const pct = terms.retentionBps / 100;
  const log = store.get(logKey(), []);
  const busy = (label, text) => (S.busy === label ? `<span class="spinner"></span>Waiting…` : text);

  return `
  <section class="card">
    <p class="fine">Escrow on ${terms.network === 'mainnet' ? 'Bitcoin Cash mainnet' : 'chipnet (test network)'}</p>
    <h2 style="font-size:1.7rem">${esc(terms.title || 'Building project')}</h2>
    <div class="roles">${ROLES.map((r) => `<span class="tag ${mine.includes(r) ? 'me' : ''}">${ROLE_NAME[r]}${mine.includes(r) ? ' · you' : ''}</span>`).join('')}
      ${S.wallet ? '' : '<button class="btn small" data-action="wallet">Connect wallet to act</button>'}</div>
    <div class="summary">
      <div class="locked"><span>Locked</span><b>${chain ? fmt(locked) : '…'}</b></div>
      <div class="paid"><span>Paid to builder</span><b>${chain ? fmt(paid) : '…'}</b></div>
      <div class="held"><span>Retention held</span><b>${chain ? fmt(chain.retention.held) : '…'}</b></div>
    </div>
    <div class="stage-actions">
      <button class="btn ghost small" data-action="copy" data-copy="${esc(location.href)}">Copy escrow link</button>
      <button class="btn link" data-action="refresh">${busy('refresh', 'Refresh')}</button>
    </div>
    <p class="fine" style="margin-top:8px">This link is the agreement. Anyone who opens it recomputes the vault addresses from the terms, so the page cannot show you a fake escrow.</p>
  </section>

  ${chain && unfunded.length && mine.includes('owner') ? `<section class="card">
    <h2>Lock the money</h2>
    <p class="lead">${unfunded.length} stage${unfunded.length > 1 ? 's' : ''} waiting for funds: ${fmt(needFund)} in total (contract price ${fmt(total)}).</p>
    <button class="btn go" data-action="fund">${busy('fund', `Lock ${fmt(needFund)} in escrow`)}</button>
    <p class="fine" style="margin-top:8px">Wallet balance: ${formatAmount({ network: S.network, token: null }, plainBalance())}${terms.token ? ` and ${fmt(tokenBalance(terms.token.category))}` : ''}.
      ${S.network === 'chipnet' ? '<button class="btn link" data-action="faucet">Get free test coins</button>' : ''}</p>
  </section>` : ''}
  ${chain && unfunded.length && !mine.includes('owner') ? '<p class="notice">Waiting for the homeowner to lock the money.</p>' : ''}

  <ol class="stages">
    ${S.escrow.milestones.map((m) => {
    const st = chain?.milestones[m.index] ?? { status: 'loading' };
    const label = { unfunded: 'Awaiting funds', locked: 'Locked', paid: 'Paid', settled: 'Settled by 2 signatures', loading: '…' }[st.status];
    return `<li class="stage ${st.status}">
      <div class="stage-head"><h3>${m.index + 1}. ${esc(m.name)}</h3><span class="stage-amount">${fmt(m.amount)}</span></div>
      <span class="status ${st.status}">${label}</span>
      <div class="split" aria-hidden="true"><i style="width:${100 - pct}%"></i><i style="width:${pct}%"></i></div>
      <div class="split-legend"><span>Builder gets ${fmt(m.payout)} on approval</span><span>${fmt(m.retained)} held until ${dateText(terms.warrantyEnd)}</span></div>
      ${st.status === 'locked' ? `<div class="stage-actions">
        ${canApprove ? `<button class="btn go" data-action="release" data-i="${m.index}">${busy(`release${m.index}`, 'Approve and pay builder')}</button>` : '<span class="fine">Only the homeowner or the inspector can approve this stage.</span>'}
        ${canCosign ? `<button class="btn link" data-action="refund" data-i="${m.index}">${busy(`refund${m.index}`, 'Refund to homeowner (2 signatures)')}</button>` : ''}
        ${mine.length === 1 ? `<button class="btn link" data-action="propose" data-target="${m.index}">Propose a refund (needs a second signature)</button>` : ''}
      </div>` : ''}
    </li>`;
  }).join('')}
    <li class="stage vault">
      <div class="stage-head"><h3>Retention vault</h3><span class="stage-amount">${chain ? fmt(chain.retention.held) : '…'}</span></div>
      <span class="status ${chain?.retention.status === 'held' ? 'held' : chain?.retention.status === 'paid' ? 'paid' : ''}">${{ held: 'Held for warranty', paid: 'Paid to builder', settled: 'Settled by 2 signatures', empty: 'Empty' }[chain?.retention.status] ?? '…'}</span>
      <p class="fine" style="margin-top:8px">${warrantyOver ? `The warranty ended on ${dateText(terms.warrantyEnd)}. The vault can now only pay the builder.` : `Locked until ${dateText(terms.warrantyEnd)}. After that date anyone can trigger the payout, and it can only go to the builder.`}</p>
      ${chain?.retention.status === 'held' ? `<div class="stage-actions">
        <button class="btn go" data-action="claim" ${warrantyOver && S.wallet ? '' : 'disabled'}>${busy('claim', 'Pay retention to builder')}</button>
        ${canCosign ? `<button class="btn link" data-action="defect">${busy('defect', 'Use for a defect (2 signatures)')}</button>` : ''}
        ${mine.length === 1 ? '<button class="btn link" data-action="propose" data-target="retention">Propose using it for a defect (needs a second signature)</button>' : ''}
      </div>` : ''}
    </li>
  </ol>

  ${log.length ? `<section class="card"><h2>Activity</h2><ul class="log" style="margin-top:10px">${log.map((e) => `<li><span>${esc(e.label)}</span><a class="mono" href="${EXPLORER[terms.network]}${e.txid}" target="_blank" rel="noopener">${short(e.txid, 8)}</a></li>`).join('')}</ul></section>` : ''}

  <section class="card">
    <h2>The terms</h2>
    <dl class="kv" style="margin-top:12px">
      <dt>Retention</dt><dd>${pct}% of every stage</dd>
      <dt>Warranty ends</dt><dd>${dateText(terms.warrantyEnd)}</dd>
      <dt>Currency</dt><dd>${terms.token ? `${esc(terms.token.symbol)} (CashToken <span class="mono">${short(terms.token.category, 8)}</span>)` : 'Bitcoin Cash'}</dd>
      <dt>Terms fingerprint</dt><dd class="mono">${S.escrow.termsHash}</dd>
    </dl>
    <details><summary>Vault addresses and keys</summary>
      <dl class="kv" style="margin-top:10px">
        ${S.escrow.milestones.map((m) => `<dt>Stage ${m.index + 1}</dt><dd class="mono">${m.contract.address}</dd>`).join('')}
        <dt>Retention</dt><dd class="mono">${S.escrow.retention.address}</dd>
        ${ROLES.map((r) => `<dt>${ROLE_NAME[r]}</dt><dd class="mono">${S.escrow.addresses[r].plain}</dd>`).join('')}
      </dl>
    </details>
    <details><summary>What if we disagree?</summary>
      <p class="fine" style="margin-top:8px">Any two of the three parties can move locked money together: homeowner and inspector can refund an abandoned stage or use the retention to fix a defect; homeowner and builder can settle early. One party alone can never take the money. The first party signs and sends a link; the money moves only when the second party has checked it and signed too.</p>
    </details>
  </section>`;
}

function renderRequest() {
  const { terms } = S.escrow;
  const r = S.request;
  const ins = S.inspected;
  const fmt = (v) => formatAmount(terms, v);
  const what = r.target === 'retention' ? 'Use the retention vault' : `Refund stage ${Number(r.target) + 1}: ${esc(S.escrow.milestones[Number(r.target)].name)}`;
  const holds = S.wallet?.holds(terms[r.second]);
  const short_ = ins && ins.toRecipient * 100n < ins.moved * 95n;
  return `<section class="card">
    <p class="fine">Co-sign request · ${esc(terms.title)}</p>
    <h2 style="font-size:1.6rem">${ROLE_NAME[r.first]} asks the ${ROLE_NAME[r.second].toLowerCase()} to co-sign</h2>
    <p class="lead" style="margin-top:6px">${what}</p>
    ${ins ? `<dl class="kv">
      <dt>Money moved</dt><dd class="mono">${fmt(ins.moved)}</dd>
      <dt>Goes to the ${ROLE_NAME[r.recipient].toLowerCase()}</dt><dd class="mono">${fmt(ins.toRecipient)}</dd>
      <dt>Already signed by</dt><dd>${ROLE_NAME[r.first]}</dd>
    </dl>
    ${ins.unknownOutputs ? '<p class="notice" style="margin-top:12px"><b>Careful:</b> part of this money would go to an address that is not one of the three parties. Do not sign unless you know why.</p>' : ''}
    ${short_ && !ins.unknownOutputs ? '<p class="notice" style="margin-top:12px"><b>Careful:</b> noticeably less arrives than is moved. Check with the other party before signing.</p>' : ''}
    <div class="stage-actions">
      <button class="btn go" data-action="cosign-send" ${holds ? '' : 'disabled'}>${S.busy === 'cosign' ? '<span class="spinner"></span>Waiting…' : 'Co-sign and send'}</button>
      <a class="btn ghost" href="#e/${encodeTerms(terms)}" style="text-decoration:none">Open the escrow</a>
    </div>
    ${holds ? '' : `<p class="fine" style="margin-top:10px">${S.wallet ? `The connected wallet is not the ${ROLE_NAME[r.second].toLowerCase()} of this escrow.` : `Connect the ${ROLE_NAME[r.second].toLowerCase()}'s wallet to sign.`}</p>`}
    <p class="fine" style="margin-top:10px">These numbers are read from the transaction itself and from the chain, not from the sender's description. Your signature cannot be reused for anything else.</p>`
    : '<p class="notice">This request can no longer be signed. The money may already be settled.</p>'}
  </section>`;
}

// ------------------------------------------------------------------ actions

async function act(label, logLabel, build, signers, prompt) {
  await run(label, async () => {
    await loadCoins();
    const builder = await build();
    const txid = await S.wallet.send(builder, { signers, prompt });
    addLog(logLabel, txid);
    toast(`${esc(logLabel)} - ${txLink(txid)}`);
    await refreshEscrow({ expectChange: true });
  });
}

function twoSigners() {
  const mine = myRoles();
  const pair = mine.includes('owner') && mine.includes('inspector') ? ['owner', 'inspector'] : mine.slice(0, 2);
  const { terms } = S.escrow;
  return {
    first: { role: pair[0], signature: S.wallet.signatureFor(terms[pair[0]], 0) },
    second: { role: pair[1], signature: S.wallet.signatureFor(terms[pair[1]], 1) },
    signers: [terms[pair[0]], terms[pair[1]]],
  };
}

const actions = {
  wallet: () => openWalletModal(),
  close: () => { openWalletModal.cancel?.(); openWalletModal.cancel = null; $('modal').hidden = true; },
  async practice() { openWalletModal.cancel?.(); setWallet(practiceWallet()); await afterWalletChange(); toast('Practice wallet ready. Get free test coins from the wallet menu.'); },
  async disconnect() { await S.wallet?.disconnect(); setWallet(null); S.coins = []; S.form = null; render(); },
  async 'to-chipnet'() { openWalletModal.cancel?.(); $('modal').hidden = true; await switchNetwork('chipnet'); if (!S.wallet) await actions.practice(); },
  async copy(el) {
    try { await navigator.clipboard.writeText(el.dataset.copy); toast('Copied.'); } catch { toast('Copy failed - select the text and copy it by hand.', true); }
  },
  async faucet() {
    await run('faucet', async () => {
      // the public faucet tops each address up to 10,000 sats, so ask for all three seats
      let data = {};
      for (let seat = 0; seat < S.wallet.keys.length; seat += 1) {
        const response = await fetch(FAUCET_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cashaddr: S.wallet.address(seat) }) });
        const answer = await response.json().catch(() => ({}));
        if (response.ok && answer.txId) data = answer;
      }
      if (!data.txId) throw new Error('The faucet did not send coins (it tops an address up to 10,000 sats). Try again later.');
      await sleep(2500);
      await loadCoins();
      $('modal').hidden = true;
      toast(`Test coins are on the way - ${txLink(data.txId)}`);
    });
  },
  async mint() {
    await run('mint', async () => {
      if (!S.wallet) throw new Error('Connect a wallet first.');
      await loadCoins();
      const coin = S.coins.find((c) => !c.utxo.token && c.utxo.vout === 0 && c.utxo.satoshis >= 2000n);
      if (!coin) throw new Error('Minting needs a fresh coin. Get free test coins first, then try again.');
      const builder = new TransactionBuilder({ provider: await provider() })
        .addInput(coin.utxo, coin.unlocker)
        .addOutput({ to: S.wallet.tokenAddress(0), amount: 1000n, token: { category: coin.utxo.txid, amount: 1000000n } })
        .addBchChangeOutputIfNeeded({ to: S.wallet.address(0), feeRate: FEE_RATE });
      const txid = await S.wallet.send(builder, { prompt: 'Mint 10,000 tUSD test stablecoin' });
      store.set('veridom-test-token', { category: coin.utxo.txid, symbol: 'tUSD', decimals: 2 });
      S.form.milestones = [{ name: 'Foundation', amount: '1500.00' }, { name: 'Shell and roof', amount: '2500.00' }];
      await sleep(2500);
      await loadCoins();
      toast(`Minted 10,000 tUSD - ${txLink(txid)}`);
    });
  },
  warranty(el) { S.form.warranty = el.dataset.v; render(); },
  'add-ms': () => { S.form.milestones.push({ name: '', amount: S.form.milestones.at(-1)?.amount ?? '' }); render(); },
  'del-ms': (el) => { S.form.milestones.splice(Number(el.dataset.i), 1); render(); },
  create() {
    const f = S.form;
    try {
      const terms = formTerms(f);
      f.problems = validateTerms(terms);
      if (f.currency === 'test' && !terms.token) f.problems = ['Mint the test stablecoin first.'];
      if (!f.problems.length) { location.hash = `e/${encodeTerms(terms)}`; return; }
    } catch (error) { f.problems = [friendly(error)]; }
    render();
  },
  refresh: () => run('refresh', () => refreshEscrow()),
  fund: () => act('fund', 'Money locked in escrow', async () => buildFund(S.escrow, {
    payerUtxos: S.coins, changeAddress: S.wallet.address(0), tokenChangeAddress: S.wallet.tokenAddress(0),
  }), [], `Lock funds for "${S.escrow.terms.title}"`),
  release(el) {
    const i = Number(el.dataset.i);
    const approver = myRoles().includes('owner') ? 'owner' : 'inspector';
    const key = S.escrow.terms[approver];
    return act(`release${i}`, `Stage ${i + 1} approved, builder paid`, async () => buildRelease(S.escrow, i, {
      approver, signature: S.wallet.signatureFor(key, 0), feeUtxos: S.coins, changeAddress: S.wallet.address(0),
    }), [key], `Approve stage ${i + 1}: ${S.escrow.milestones[i].name}`);
  },
  refund(el) {
    const i = Number(el.dataset.i);
    const two = twoSigners();
    return act(`refund${i}`, `Stage ${i + 1} refunded to homeowner`, async () => buildCosign(S.escrow, i, {
      ...two, recipient: 'owner', feeUtxos: S.coins, changeAddress: S.wallet.address(0),
    }), two.signers, `Refund stage ${i + 1} to the homeowner`);
  },
  defect() {
    const two = twoSigners();
    return act('defect', 'Retention used for a defect', async () => buildCosign(S.escrow, 'retention', {
      ...two, recipient: 'owner', feeUtxos: S.coins, changeAddress: S.wallet.address(0),
    }), two.signers, 'Use the retention to fix a defect');
  },
  propose(el) {
    const { target } = el.dataset;
    const me = myRoles()[0];
    $('modal').innerHTML = `<div class="sheet"><h2>Who will co-sign?</h2>
      <p class="muted">You sign first. The money moves only after the second party has checked the request and signed too.</p>
      ${ROLES.filter((r) => r !== me).map((r) => `<button class="btn" data-action="propose-go" data-target="${target}" data-second="${r}">${ROLE_NAME[r]}</button>`).join('')}
      <button class="btn link" data-action="close">Cancel</button></div>`;
    $('modal').hidden = false;
  },
  async 'propose-go'(el) {
    const target = el.dataset.target === 'retention' ? 'retention' : Number(el.dataset.target);
    const first = myRoles()[0];
    const { second } = el.dataset;
    const { terms } = S.escrow;
    $('modal').hidden = true;
    await run('propose', async () => {
      await loadCoins();
      const builder = await buildCosign(S.escrow, target, {
        first: { role: first, signature: S.wallet.signatureFor(terms[first], 0) },
        second: { role: second, signature: SECOND_SLOT },
        recipient: 'owner', feeUtxos: S.coins, changeAddress: S.wallet.address(0),
      });
      const txHex = await S.wallet.signPartial(builder, { signers: [terms[first]], prompt: target === 'retention' ? 'Propose: use the retention for a defect' : `Propose: refund stage ${target + 1}` });
      const link = `${location.origin}${location.pathname}${location.search}#s/${encodeRequest({ terms, target, first, second, recipient: 'owner', txHex })}`;
      $('modal').innerHTML = `<div class="sheet"><h2>Send this link to the ${ROLE_NAME[second].toLowerCase()}</h2>
        <p class="muted">Your signature is inside. Nothing moves until the ${ROLE_NAME[second].toLowerCase()} opens the link, checks the amounts and co-signs.</p>
        <textarea class="mono" rows="4" readonly id="cosign-link">${esc(link)}</textarea>
        <button class="btn go" data-action="copy" data-copy="${esc(link)}">Copy link</button>
        <button class="btn link" data-action="close">Done</button></div>`;
      $('modal').hidden = false;
    });
  },
  'cosign-send': () => run('cosign', async () => {
    const r = S.request;
    const hex = await S.wallet.complete(S.inspected, S.escrow.terms[r.second], r.target === 'retention' ? 'Co-sign: use the retention' : `Co-sign: refund stage ${Number(r.target) + 1}`);
    S.inspected = null; // one use only: signing changes it
    const txid = await (await provider()).sendRawTransaction(hex);
    addLog(r.target === 'retention' ? 'Retention settled by two signatures' : `Stage ${Number(r.target) + 1} refunded by two signatures`, txid);
    toast(`Co-signed and sent - ${txLink(txid)}`);
    location.hash = `e/${encodeTerms(S.escrow.terms)}`;
  }),
  claim: () => act('claim', 'Retention paid to builder', async () => buildClaim(S.escrow, { feeUtxos: S.coins, changeAddress: S.wallet.address(0) }), [], 'Pay the retention to the builder'),
};

// ------------------------------------------------------------------ routing and render

async function switchNetwork(network) {
  if (network === S.network) return;
  await S.wallet?.disconnect();
  S.wallet = null; S.coins = []; S.form = null;
  S.network = network;
  store.set('veridom-network', network);
  $('network').value = network;
  await resumeWallet();
  await afterWalletChange();
}

async function route() {
  const hash = location.hash.replace(/^#/, '');
  S.escrow = null; S.chain = null; S.request = null; S.inspected = null;
  if (hash.startsWith('s/')) {
    try {
      const request = decodeRequest(hash.slice(2));
      if (request.terms.network !== S.network) await switchNetwork(request.terms.network);
      S.escrow = createEscrow(request.terms, await provider());
      S.request = request;
      render();
      S.inspected = await inspectRequest(S.escrow, request).catch((error) => { console.error(error); toast(esc(friendly(error)), true); return null; });
    } catch (error) {
      console.error(error);
      toast(esc(friendly(error)), true);
      location.hash = '';
    }
  } else if (hash.startsWith('e/')) {
    try {
      const terms = decodeTerms(hash.slice(2));
      if (terms.network !== S.network) await switchNetwork(terms.network);
      S.escrow = createEscrow(terms, await provider());
      render();
      await refreshEscrow();
    } catch (error) {
      console.error(error);
      toast(esc(friendly(error)), true);
      location.hash = '';
    }
  }
  render();
  window.scrollTo(0, 0);
}

function render() {
  $('app').innerHTML = S.request ? renderRequest() : S.escrow ? renderEscrow() : renderHome();
  $('app').classList.toggle('busy', false);
  $('wallet-button').textContent = S.wallet ? `${S.wallet.kind === 'practice' ? 'Practice wallet' : S.wallet.label} · ${formatAmount({ network: S.network, token: null }, plainBalance())}` : 'Connect wallet';
  $('network').value = S.network;
}

function renderBanner() {
  $('blaze').innerHTML = `<span><b>BCH BLAZE 2026</b> entry</span>
    <a href="${PRESENTATION_URL}" target="_blank" rel="noopener">Presentation</a>
    <a href="${REPO_URL}" target="_blank" rel="noopener">Source code</a>
    <span>EMBER2026 votes: ${EMBER_ADDRESS ? `<span class="ember">${esc(EMBER_ADDRESS)}</span>` : '<span class="todo">address to be added</span>'}</span>`;
}

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el || el.disabled) return;
  event.preventDefault();
  Promise.resolve(actions[el.dataset.action]?.(el)).catch((error) => { console.error(error); toast(esc(friendly(error)), true); });
});
document.addEventListener('input', (event) => {
  const el = event.target;
  if (!S.form) return;
  if (el.dataset.f) {
    S.form[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'checkbox' || el.tagName === 'SELECT') {
      if (el.dataset.f === 'currency') {
        const stable = el.value === 'pusd' || el.value === 'test';
        S.form.milestones = stable ? [{ name: 'Foundation', amount: '1500.00' }, { name: 'Shell and roof', amount: '2500.00' }] : defaultForm().milestones;
        if (el.value === 'custom') S.form.milestones = [{ name: 'Foundation', amount: '1000' }];
      }
      render();
    }
  } else if (el.dataset.m) {
    S.form.milestones[Number(el.dataset.m)][el.dataset.k] = el.value;
  }
});
$('network').addEventListener('change', async (event) => { location.hash = ''; await switchNetwork(event.target.value); });
$('modal').addEventListener('click', (event) => { if (event.target === $('modal')) actions.close(); });
window.addEventListener('hashchange', route);

renderBanner();
// a shared link decides the network before anything else
try {
  if (location.hash.startsWith('#e/')) S.network = decodeTerms(location.hash.slice(3)).network;
  if (location.hash.startsWith('#s/')) S.network = decodeRequest(location.hash.slice(3)).terms.network;
  store.set('veridom-network', S.network);
} catch { /* handled in route() */ }
render();
resumeWallet().then(afterWalletChange).then(route);
