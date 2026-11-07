// admin.js — admin API + single-page admin UI
import { config } from './config.js';
import { log } from './logger.js';
import { fingerprintHeaders, UpstreamError } from './upstream.js';
import {
  listAccounts, addAccount, removeAccount, setEnabled, accountCount,
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

export async function handleAdmin(req, res, url) {
  const path = url.pathname;

  if (path === '/admin' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(ADMIN_HTML);
  }

  if (!authorized(req, url)) return json(res, 401, { error: 'invalid admin key' });

  if (path === '/admin/api/overview' && req.method === 'GET') {
    const accounts = listAccounts().map((a) => ({ ...a, usage: accountStats(a.id) }));
    return json(res, 200, {
      accounts,
      totals: totals(),
      recent: recentRequests(50),
      sessionLimit: { note: 'each account allows 4 concurrent sessions; gateway auto-resets on concurrent_session' },
    });
  }

  if (path === '/admin/api/accounts' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body.token || typeof body.token !== 'string' || body.token.length < 20) {
      return json(res, 400, { error: 'token required (the JWT from ~/.free-pi/agent/credentials.json of that account)' });
    }
    // validate against upstream before storing
    try {
      const r = await fetch(`${config.base}/me`, {
        headers: fingerprintHeaders({ token: body.token, sessionId: 'fpgw-validate' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return json(res, 400, { error: `token rejected by upstream (HTTP ${r.status})` });
      const me = await r.json().catch(() => ({}));
      const added = addAccount(body.token.trim(), body.label || me.name || me.email || undefined);
      if (added.error) return json(res, 409, { error: added.error });
      log.info('account added via admin ui', { id: added.account.id, label: added.account.label });
      return json(res, 201, { ok: true, id: added.account.id, me: { name: me.name ?? null, email: me.email ?? null } });
    } catch (e) {
      return json(res, 502, { error: `validation failed: ${e.message}` });
    }
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

  return json(res, 404, { error: `no admin route ${req.method} ${path}` });
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
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
</style></head>
<body>
<div id="login" class="card" style="display:none">
  <h2>Admin key</h2>
  <input id="keyin" class="token" placeholder="admin key" type="password">
  <div class="row"><button class="primary" onclick="saveKey()">Unlock</button></div>
  <p class="muted" id="loginerr"></p>
</div>
<div id="app" style="display:none">
  <h1>free-pi gateway <span>// admin</span></h1>
  <div class="sub">OpenAI-compatible + Anthropic Messages proxy · api.freepi.ai</div>

  <div class="card"><h2>Totals</h2><div class="kv" id="totals"></div></div>

  <div class="card"><h2>Accounts · round-robin</h2>
    <table id="accounts"><thead><tr>
      <th>label</th><th>source</th><th>token</th><th>state</th>
      <th class="num">req</th><th class="num">ok</th><th class="num">err</th>
      <th class="num">in tok</th><th class="num">out tok</th><th>last used</th><th></th>
    </tr></thead><tbody></tbody></table>
    <div class="row">
      <input name="label" placeholder="label (optional)">
      <input name="token" class="token" placeholder="account JWT token">
      <button class="primary" onclick="addAccount()">Add account</button>
    </div>
    <p class="muted">Env accounts (FREEPI_TOKEN_1… in .env) are read-only here. UI accounts are saved to accounts.json. Tokens are validated against /me before storing.</p>
    <p class="err" id="adderr"></p>
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
function saveKey(){ localStorage.setItem('fpgw_admin_key', document.getElementById('keyin').value.trim()); load(); }
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
document.addEventListener('click', (e)=>{
  const b=e.target.closest('button[data-action]');
  if(!b) return;
  if(b.dataset.action==='toggle'){
    api('/admin/api/accounts/'+b.dataset.id+'/toggle',{method:'POST',body:JSON.stringify({enabled:b.dataset.on==='true'})}).then(load);
  }
  if(b.dataset.action==='del'){
    if(confirm('remove account?')) api('/admin/api/accounts/'+b.dataset.id,{method:'DELETE'}).then(load);
  }
});
load(); setInterval(load, 5000);
</script></body></html>`;
