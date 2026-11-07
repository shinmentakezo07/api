// admin.js — admin API + single-page admin UI (accounts, usage, GitHub login flow)
import { config } from './config.js';
import { log } from './logger.js';
import { fingerprintHeaders } from './upstream.js';
import {
  listAccounts, addAccount, removeAccount, setEnabled, accountCount, mask, inFlightCount,
  exportAccounts, importAccounts,
} from './accounts.js';
import { accountStats, totals, recentRequests } from './usage.js';

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(req, url) {
  if (!config.adminKey) return true; // no key configured -> open (localhost only)
  const key = req.headers['x-admin-key'] ?? url.searchParams.get('key') ?? '';
  return key === config.adminKey;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

// ---- GitHub device login flow (same endpoints the free-pi CLI uses) --------
async function handleLoginStart(res) {
  // POST /auth/github/device {} -> {session_id, user_code, verification_uri, interval, expires_in?, verification_uri_complete?}
  const r = await fetch(`${config.base}/auth/github/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return json(res, 502, { error: `device flow start failed: HTTP ${r.status} ${detail.slice(0, 200)}` });
  }
  const d = await r.json();
  // The CLI submits consent for the device session before it starts polling
  // (POST /auth/consent {session_id, consent_version}) — otherwise the token
  // poll answers consent_required. Same sequence here.
  const consent = await fetch(`${config.base}/auth/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ session_id: d.session_id, consent_version: '4' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!consent.ok) {
    const detail = await consent.text().catch(() => '');
    return json(res, 502, { error: `consent submission failed: HTTP ${consent.status} ${detail.slice(0, 200)}` });
  }
  return json(res, 200, {
    flow_id: d.session_id,
    user_code: d.user_code,
    verification_uri: d.verification_uri,
    verification_uri_complete: d.verification_uri_complete ?? null,
    interval: d.interval ?? 5,
    expires_in: d.expires_in ?? 900,
  });
}

async function handleLoginPoll(req, res) {
  const body = await readJson(req);
  if (!body.flow_id) return json(res, 400, { error: 'flow_id required' });

  // POST /auth/token {session_id} -> pending {status,retry_after} | {token} | errors
  const r = await fetch(`${config.base}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ session_id: body.flow_id }),
    signal: AbortSignal.timeout(15_000),
  });
  const d = await r.json().catch(() => ({}));

  if (r.ok && typeof d.token === 'string') {
    // validate the fresh JWT and store it as a UI account (accounts.json)
    let me = null;
    try {
      const meRes = await fetch(`${config.base}/me`, {
        headers: { authorization: `Bearer ${d.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (meRes.ok) me = await meRes.json().catch(() => null);
    } catch {}
    const label = me?.name || me?.email || me?.login || 'github-login';
    const added = addAccount(d.token, label);
    if (added.error) return json(res, 409, { status: 'error', error: added.error });
    log.info('account added via github login flow', { id: added.account.id, label: added.account.label });
    return json(res, 200, { status: 'ok', id: added.account.id, label: added.account.label, tokenMask: mask(d.token), me: { name: me?.name ?? null, email: me?.email ?? null } });
  }

  if (res.status === 410 || d.message === 'expired_token') return json(res, 200, { status: 'expired' });
  if (res.status === 403 && d.code === 'denied') return json(res, 200, { status: 'denied' });
  if (d.status === 'pending') return json(res, 200, { status: 'pending', retry_after: d.retry_after });
  if (d.code === 'consent_required') return json(res, 200, { status: 'error', error: 'consent_required: approve consent on the GitHub page' });
  return json(res, 502, { status: 'error', error: d.message ?? `token poll failed: HTTP ${r.status}` });
}

// ---- router -------------------------------------------------------------------
export async function handleAdmin(req, res, urlOrCtx) {
  // The router passes (req, res, rid, ctx) — tolerate any 4th arg and build the
  // URL from the request itself.
  const url = urlOrCtx instanceof URL ? urlOrCtx : new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path === '/admin' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(ADMIN_HTML);
  }

  if (!authorized(req, url)) return json(res, 401, { error: 'invalid admin key' });

  if (path === '/admin/api/overview' && req.method === 'GET') {
    const accounts = listAccounts().map((a) => ({ ...a, usage: accountStats(a.id), inFlight: inFlightCount(a.id) }));
    return json(res, 200, {
      accounts,
      totals: totals(),
      recent: recentRequests(50),
      accountCount: accountCount(),
    });
  }

  if (path === '/admin/api/accounts' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.token || typeof body.token !== 'string' || body.token.length < 20) {
      return json(res, 400, { error: 'token required (the JWT from ~/.free-pi/agent/credentials.json of that account)' });
    }
    try {
      const r = await fetch(`${config.base}/me`, {
        headers: fingerprintHeaders({ token: body.token, sessionId: 'fpgw-validate' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return json(res, 400, { error: `token rejected by upstream (HTTP ${r.status})` });
      const me = await r.json().catch(() => ({}));
      const added = addAccount(body.token.trim(), body.label || me.name || me.email || undefined);
      if (added.error) return json(res, 409, { error: added.error });
      log.info('account added via admin ui (token paste)', { id: added.account.id, label: added.account.label });
      return json(res, 201, { ok: true, id: added.account.id, me: { name: me.name ?? null, email: me.email ?? null } });
    } catch (e) {
      return json(res, 502, { error: `validation failed: ${e.message}` });
    }
  }

  if (path === '/admin/api/accounts/login/start' && req.method === 'POST') {
    try { return await handleLoginStart(res); }
    catch (e) { return json(res, 502, { error: `login start failed: ${e.message}` }); }
  }

  if (path === '/admin/api/accounts/login/poll' && req.method === 'POST') {
    try { return await handleLoginPoll(req, res); }
    catch (e) { return json(res, 502, { status: 'error', error: `login poll failed: ${e.message}` }); }
  }

  const toggle = path.match(/^\/admin\/api\/accounts\/([^/]+)\/toggle$/);
  if (toggle && req.method === 'POST') {
    const body = await readJson(req).catch(() => ({}));
    const ok = setEnabled(toggle[1], body.enabled !== false);
    return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such account' });
  }

  const del = path.match(/^\/admin\/api\/accounts\/([^/]+)$/);
  if (del && req.method === 'DELETE') {
    const ok = removeAccount(del[1]);
    return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such account (env/cli accounts cannot be removed here)' });
  }

  // ---- export / import -------------------------------------------------------
  if (path === '/admin/api/accounts/export' && req.method === 'GET') {
    const payload = {
      format: 'free-pi-gateway-accounts/v1',
      exported_at: new Date().toISOString(),
      accounts: exportAccounts(),
    };
    log.info('accounts exported via admin ui', { count: payload.accounts.length });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="freepi-accounts-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    return res.end(JSON.stringify(payload, null, 2));
  }

  if (path === '/admin/api/accounts/import' && req.method === 'POST') {
    const body = await readJson(req);
    const list = Array.isArray(body) ? body : body.accounts;
    const result = importAccounts(list);
    if (result.error) return json(res, 400, { error: result.error });
    log.info('accounts imported via admin ui', { added: result.added, skipped: result.skipped, errors: result.errors });
    return json(res, 200, result);
  }

  return json(res, 404, { error: `no admin route ${req.method} ${path}` });
}

// ---------------------------------------------------------------------------
const ADMIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>free-pi gateway · admin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { background:#0b0d10; color:#d7dce2; font:14px/1.5 ui-monospace,Menlo,Consolas,monospace; margin:0; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; } h1 span{color:#7ee787;}
  .sub { color:#8a939e; font-size:12px; margin-bottom:20px; }
  .card { background:#12151a; border:1px solid #232a33; border-radius:10px; padding:16px; margin-bottom:20px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#9fb3c8; margin:0 0 12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:#8a939e; font-weight:500; border-bottom:1px solid #232a33; padding:6px 8px; }
  td { padding:6px 8px; border-bottom:1px solid #1a2027; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:11px; }
  .on { background:#12321c; color:#7ee787; } .off { background:#3a1d1d; color:#ff8f8f; }
  .env { background:#1d2a3a; color:#8ab8ff; } .ui { background:#2a2438; color:#c8a8ff; } .cli { background:#33321d; color:#ffe08a; }
  button { font:inherit; background:#1c232c; color:#d7dce2; border:1px solid #2c3540; border-radius:6px; padding:5px 10px; cursor:pointer; }
  button:hover { background:#232c37; }
  button.danger { color:#ff8f8f; } button.primary { background:#7ee78722; border-color:#7ee78755; color:#7ee787; }
  input { font:inherit; background:#0b0d10; border:1px solid #2c3540; color:#d7dce2; border-radius:6px; padding:6px 8px; }
  input.token { width:100%; }
  .row { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; }
  .row input[name=label] { flex:0 0 200px; } .row input[name=token] { flex:1 1 300px; }
  .kv { display:flex; gap:24px; flex-wrap:wrap; font-size:13px; }
  .kv b { display:block; font-size:18px; color:#7ee787; font-variant-numeric:tabular-nums; }
  .muted { color:#8a939e; } .err { color:#ff8f8f; }
  #login { max-width:380px; margin:10vh auto; text-align:center; }
  .code { font-size:26px; letter-spacing:.2em; color:#7ee787; background:#0b0d10; border:1px solid #2c3540; border-radius:8px; padding:10px 16px; display:inline-block; margin:10px 0; }
  a { color:#8ab8ff; }
  .spin { display:inline-block; animation:sp 1s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
</style></head>
<body>
<div id="login" class="card" style="display:none">
  <h2>Admin key</h2>
  <input id="keyin" class="token" placeholder="admin key" type="password">
  <div class="row"><button class="primary" data-action="saveKey">Unlock</button></div>
  <p class="muted" id="loginerr"></p>
</div>
<div id="app" style="display:none">
  <h1>free-pi gateway <span>// admin</span></h1>
  <div class="sub">OpenAI-compatible + Anthropic Messages proxy · api.freepi.ai</div>

  <div class="card"><h2>Totals</h2><div class="kv" id="totals"></div></div>

  <div class="card"><h2>Add account</h2>
    <button class="primary" id="loginBtn" data-action="startLogin">Sign in with GitHub</button>
    <span class="muted"> — or paste a token below</span>
    <div id="loginFlow" style="display:none; margin-top:12px;">
      <p>1. Open <a id="verifyLink" target="_blank" rel="noopener">github.com/login/device</a></p>
      <p>2. Enter code: <span class="code" id="userCode">····-····</span></p>
      <p id="loginStatus" class="muted"><span class="spin">◠</span> Waiting for GitHub…</p>
      <button data-action="cancelLogin">Cancel</button>
    </div>
    <p class="err" id="loginErr"></p>
    <div class="row">
      <input name="label" placeholder="label (optional)">
      <input name="token" class="token" placeholder="account JWT token">
      <button data-action="addAccount">Add account</button>
    </div>
    <p class="muted" id="adderr"></p>
    <div class="row">
      <button data-action="exportAccounts">Export accounts</button>
      <button data-action="importAccounts">Import accounts</button>
      <input type="file" id="importFile" accept="application/json,.json" style="display:none">
      <span class="muted" id="importResult"></span>
    </div>
    <p class="muted">GitHub login runs the same device flow as free-pi-cli: sign in with the GitHub account you want to add. Env accounts (FREEPI_TOKEN_*) are read-only. UI accounts are stored in accounts.json. Export/import uses a JSON file with full tokens — keep it secret.</p>
  </div>

  <div class="card"><h2>Accounts · round-robin</h2>
    <table id="accounts"><thead><tr>
      <th>label</th><th>source</th><th>token</th><th>state</th>
      <th class="num">req</th><th class="num">ok</th><th class="num">err</th>
      <th class="num">in tok</th><th class="num">out tok</th><th>last used</th><th></th>
    </tr></thead><tbody></tbody></table>
  </div>

  <div class="card"><h2>Recent requests</h2>
    <table id="recent"><thead><tr>
      <th>time</th><th>account</th><th>path</th><th>model</th><th class="num">status</th><th class="num">in</th><th class="num">out</th><th class="num">ms</th>
    </tr></thead><tbody></tbody></table>
  </div>
</div>
<script>
const K = () => localStorage.getItem('fpgw_admin_key') || '';
const H = () => ({ 'x-admin-key': K(), 'content-type': 'application/json' });
function fmt(n){ return (n??0).toLocaleString(); }
function ago(ts){ if(!ts) return '—'; const s=(Date.now()-ts)/1000; return s<60?Math.round(s)+'s':s<3600?Math.round(s/60)+'m':Math.round(s/3600)+'h'; }
async function api(path, opts){ const r = await fetch(path,{headers:H(),...opts}); if(r.status===401){showLogin();throw 0;} return r.json(); }
function showLogin(){ document.getElementById('login').style.display='block'; document.getElementById('app').style.display='none'; }
async function load(){
  let d;
  try { d = await api('/admin/api/overview'); } catch(e){ if(e!==0) document.getElementById('loginerr').textContent='cannot reach gateway'; return; }
  document.getElementById('login').style.display='none';
  document.getElementById('app').style.display='block';
  const t=d.totals;
  document.getElementById('totals').innerHTML =
    '<div><b>'+fmt(t.requests)+'</b>requests</div><div><b>'+fmt(t.ok)+'</b>ok</div>'+
    '<div><b>'+fmt(t.errors)+'</b>errors</div><div><b>'+fmt(t.inputTokens)+'</b>input tokens</div>'+
    '<div><b>'+fmt(t.outputTokens)+'</b>output tokens</div>';
  const tb=document.querySelector('#accounts tbody'); tb.innerHTML='';
  for(const a of d.accounts){
    const u=a.usage||{};
    const tr=document.createElement('tr');
    const warn=u.lastError?' <span class="err" title="'+u.lastError.message.replace(/"/g,'&quot;')+'">!</span>':'';
    const cells=[
      a.label,
      '<span class="pill '+a.source+'">'+a.source+'</span>',
      '<span class="muted">'+a.tokenMask+'</span>',
      '<span class="pill '+(a.enabled?'on':'off')+'">'+(a.enabled?'enabled':'disabled')+'</span>',
      fmt(u.requests), fmt(u.ok), fmt(u.errors), fmt(u.inputTokens), fmt(u.outputTokens),
      '<span class="muted">'+ago(u.lastUsedAt)+'</span>'+warn,
    ];
    tr.innerHTML = cells.map((c,i)=>'<td'+(i>=4&&i<=8?' class="num"':'')+'>'+c+'</td>').join('')
      + '<td><button data-action="toggle" data-id="'+a.id+'" data-on="'+(!a.enabled)+'">'
      + (a.enabled?'disable':'enable')+'</button> '
      + (a.source==='ui'?'<button class="danger" data-action="del" data-id="'+a.id+'">remove</button>':'')
      + '</td>';
    tb.appendChild(tr);
  }
  const rb=document.querySelector('#recent tbody'); rb.innerHTML='';
  for(const r of d.recent){
    rb.innerHTML += '<tr><td class="muted">'+new Date(r.ts).toLocaleTimeString()+'</td><td>'+r.accountId+'</td><td>'+r.path+'</td>'+
      '<td class="muted">'+(r.model||'')+'</td><td class="num '+(r.status>=400?'err':'')+'">'+r.status+'</td>'+
      '<td class="num">'+fmt(r.inputTokens)+'</td><td class="num">'+fmt(r.outputTokens)+'</td><td class="num">'+(r.ms??'—')+'</td></tr>';
  }
}
async function addAccount(){
  const f=document.querySelector('.card input[name=token]'), l=document.querySelector('.card input[name=label]');
  document.getElementById('adderr').textContent='';
  const r=await fetch('/admin/api/accounts',{method:'POST',headers:H(),body:JSON.stringify({token:f.value.trim(),label:l.value.trim()})});
  const d=await r.json();
  if(!r.ok){ document.getElementById('adderr').textContent=d.error||('HTTP '+r.status); return; }
  f.value=''; l.value=''; load();
}
// ---- GitHub device login flow ----
let login = null; // {flow_id, interval, deadline, timer}
function setLoginStatus(html){ document.getElementById('loginStatus').innerHTML = html; }
async function startLogin(){
  document.getElementById('loginErr').textContent='';
  const r = await fetch('/admin/api/accounts/login/start', { method:'POST', headers:H() });
  const d = await r.json();
  if(!r.ok){ document.getElementById('loginErr').textContent = d.error || ('HTTP '+r.status); return; }
  login = { flow_id: d.flow_id, interval: Math.max(2, d.interval||5), deadline: Date.now() + (d.expires_in||900)*1000 };
  const link = d.verification_uri_complete || (d.verification_uri + (d.verification_uri.includes('?')?'&':'?') + 'user_code=' + encodeURIComponent(d.user_code));
  document.getElementById('verifyLink').href = link;
  document.getElementById('verifyLink').textContent = d.verification_uri;
  document.getElementById('userCode').textContent = d.user_code;
  document.getElementById('loginFlow').style.display='block';
  document.getElementById('loginBtn').disabled = true;
  setLoginStatus('<span class="spin">◠</span> Waiting for GitHub…');
  pollLogin();
}
async function pollLogin(){
  if(!login) return;
  if(Date.now() > login.deadline){ endLogin('Code expired — start again.'); return; }
  try {
    const r = await fetch('/admin/api/accounts/login/poll', { method:'POST', headers:H(), body: JSON.stringify({flow_id: login.flow_id}) });
    const d = await r.json();
    if(d.status==='ok'){ endLogin(null); load(); document.getElementById('loginErr').textContent=''; return; }
    if(d.status==='expired'){ endLogin('Code expired — start again.'); return; }
    if(d.status==='denied'){ endLogin('Sign-in was denied on GitHub.'); return; }
    if(d.status==='error'){ endLogin(d.error || 'login failed'); return; }
  } catch(e){ /* transient network issue — keep polling */ }
  login.timer = setTimeout(pollLogin, login.interval*1000);
}
function endLogin(msg){
  if(login?.timer) clearTimeout(login.timer);
  login = null;
  document.getElementById('loginFlow').style.display='none';
  document.getElementById('loginBtn').disabled = false;
  if(msg) document.getElementById('loginErr').textContent = msg;
}
document.addEventListener('click', (e)=>{
  const b=e.target.closest('button[data-action]');
  if(!b) return;
  const a=b.dataset.action;
  if(a==='saveKey'){ localStorage.setItem('fpgw_admin_key', document.getElementById('keyin').value.trim()); load(); }
  if(a==='toggle'){ api('/admin/api/accounts/'+b.dataset.id+'/toggle',{method:'POST',body:JSON.stringify({enabled:b.dataset.on==='true'})}).then(load); }
  if(a==='del'){ if(confirm('remove account?')) api('/admin/api/accounts/'+b.dataset.id,{method:'DELETE'}).then(load); }
  if(a==='addAccount') addAccount();
  if(a==='startLogin') startLogin();
  if(a==='cancelLogin') endLogin(null);
  if(a==='exportAccounts') exportAccounts();
  if(a==='importAccounts') document.getElementById('importFile').click();
});
document.getElementById('importFile').addEventListener('change', async (e)=>{
  const file = e.target.files?.[0];
  e.target.value = '';
  if(!file) return;
  const out = document.getElementById('importResult');
  try {
    const parsed = JSON.parse(await file.text());
    const list = Array.isArray(parsed) ? parsed : parsed.accounts;
    const r = await fetch('/admin/api/accounts/import', { method:'POST', headers:H(), body: JSON.stringify({ accounts: list }) });
    const d = await r.json();
    if(!r.ok){ out.textContent = d.error || ('HTTP '+r.status); out.className='err'; return; }
    out.textContent = 'added '+d.added+', skipped '+d.skipped+', errors '+d.errors;
    out.className='muted';
    load();
  } catch(err){ out.textContent = 'import failed: '+err.message; out.className='err'; }
});
async function exportAccounts(){
  try {
    const r = await fetch('/admin/api/accounts/export', { headers: H() });
    if(!r.ok){ const d = await r.json().catch(()=>({})); document.getElementById('importResult').textContent = d.error || ('HTTP '+r.status); return; }
    const blob = new Blob([await r.text()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (r.headers.get('content-disposition')||'').match(/filename="?([^"]+)"?/)?.[1] || 'freepi-accounts.json';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch(err){ document.getElementById('importResult').textContent = 'export failed: '+err.message; }
}
load(); setInterval(()=>{ if(!login) load(); }, 5000);
</script></body></html>`;
