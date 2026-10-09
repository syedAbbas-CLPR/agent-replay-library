#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const host = '127.0.0.1';
const port = Number(process.argv[2] || 7331);
const home = os.homedir();
const theme = path.join(home, '.config/claude-replay/high-contrast.json');
const cacheDir = path.join(os.tmpdir(), 'agent-replay-library-cache');
const rendererVersion = 'library-ui-16';
fs.mkdirSync(cacheDir, { recursive: true });
let sessionMap = new Map();
let buildJobs = new Map();
const metadataCache = new Map();

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}
function walk(root, out = []) {
  if (!fs.existsSync(root)) return out;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}
function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function withoutContext(value) {
  return String(value || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
    .replace(/<permissions[^>]*>[\s\S]*?<\/permissions>/gi, ' ')
    .replace(/<developer>[\s\S]*?<\/developer>/gi, ' ')
    .trim();
}
function shortTitle(text, fallback) {
  const cleaned = cleanText(withoutContext(text)).replace(/^## My request for Codex:\s*/i, '');
  if (!cleaned) return fallback;
  return cleaned.length > 88 ? cleaned.slice(0, 85) + '...' : cleaned;
}
function readTail(file, maxBytes = 2 * 1024 * 1024) {
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, size, stat.size - size);
    fs.closeSync(fd);
    let text = buffer.toString('utf8');
    if (stat.size > size) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch { return ''; }
}
function isSyntheticPrompt(value) {
  const text = cleanText(value);
  return !text
    || /^\/(?:resume|clear)\b/i.test(text)
    || /^(?:ok(?:ay)?[,.! ]*)?(?:yeah[,.! ]*)?(?:please )?(?:continue(?: ahead)?|go ahead|resume|keep going|great|cool|thanks)[.! ]*$/i.test(text)
    || /^This conversation is from a different directory\. To resume, run:/i.test(text)
    || /^Here is a list of plugins that are available but not installed\./i.test(text)
    || /^# AGENTS\.md instructions for /i.test(text)
    || /^Repo: \/.*Inspect /i.test(text)
    || (/toolu_[a-zA-Z0-9]+/.test(text) && text.includes('/private/tmp/claude-'));
}
function latestUserMessage(file, agent) {
  const lines = readTail(file, 16 * 1024 * 1024).split('\n');
  let fallback = '';
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].trim()) continue;
    if (agent === 'claude' && !lines[index].includes('"type":"last-prompt"') && !lines[index].includes('"type":"user"')) continue;
    if (agent === 'codex' && !lines[index].includes('"user_message"') && !lines[index].includes('"role":"user"')) continue;
    let obj;
    try { obj = JSON.parse(lines[index]); } catch { continue; }
    let candidate = '';
    if (agent === 'claude') {
      if (obj.type === 'last-prompt') candidate = obj.lastPrompt || '';
      else if (obj.type === 'user' && obj.message?.content) {
        candidate = Array.isArray(obj.message.content)
          ? obj.message.content.filter(value => value.type === 'text').map(value => value.text || '').join(' ')
          : obj.message.content;
      }
    } else {
      if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') candidate = obj.payload.message || '';
      else if (obj.type === 'response_item' && obj.payload?.type === 'message' && obj.payload?.role === 'user') {
        candidate = (obj.payload.content || []).filter(value => value.type === 'input_text').map(value => value.text || '').join(' ');
      }
    }
    candidate = withoutContext(candidate);
    if (!isSyntheticPrompt(candidate) && !candidate.includes('<command-name>/clear</command-name>') && !candidate.includes('<local-command-caveat>')) {
      if (!fallback) fallback = candidate;
      const plain = cleanText(candidate);
      if (plain.length >= 24 || plain.split(/\s+/).length >= 4) return candidate;
    }
  }
  return fallback;
}
function inspectSession(file, agent, stat) {
  let sample = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    sample = buffer.subarray(0, read).toString('utf8');
  } catch {}
  let cwd = '';
  let prompt = '';
  let explicitTitle = '';
  let started = 0;
  const headLines = sample.split('\n').slice(0, 24);
  let startsWithClear = agent === 'claude' && headLines.some(line => line.includes('<command-name>/clear</command-name>'));
  let isWorker = false;
  let sessionKey = path.basename(file, '.jsonl').replace(/^rollout-/, '');
  for (const line of sample.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const rowTime = Date.parse(obj.timestamp || obj.created_at || obj.message?.timestamp || '') || 0;
    if (rowTime && (!started || rowTime < started)) started = rowTime;
    if (agent === 'codex') {
      if (obj.type === 'session_meta') {
        cwd = obj.payload?.cwd || obj.cwd || cwd;
        sessionKey = obj.payload?.id || obj.payload?.session_id || obj.session_id || sessionKey;
        isWorker = obj.payload?.thread_source === 'subagent' || Boolean(obj.payload?.source && typeof obj.payload.source === 'object' && obj.payload.source.subagent);
      }
      if (!prompt && obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
        const candidate = withoutContext(obj.payload.message || '');
        if (cleanText(candidate)) prompt = candidate;
      }
      if (!prompt && obj.type === 'response_item' && obj.payload?.type === 'message' && obj.payload?.role === 'user') {
        const candidate = withoutContext((obj.payload.content || []).filter(x => x.type === 'input_text').map(x => x.text || '').join(' '));
        if (cleanText(candidate)) prompt = candidate;
      }
    } else {
      cwd = obj.cwd || cwd;
      sessionKey = obj.sessionId || sessionKey;
      if (obj.type === 'custom-title') explicitTitle = obj.customTitle || explicitTitle;
      if (obj.type === 'ai-title') explicitTitle = obj.aiTitle || explicitTitle;
      if (!prompt && obj.type === 'user' && obj.message?.content) {
        const candidate = Array.isArray(obj.message.content)
          ? obj.message.content.filter(x => x.type === 'text').map(x => x.text || '').join(' ')
          : obj.message.content;
        const stripped = withoutContext(candidate);
        if (cleanText(stripped)) prompt = stripped;
      }
    }
    if ((prompt || explicitTitle) && cwd) break;
  }
  const project = cwd ? path.basename(cwd) : path.basename(path.dirname(file));
  const fallback = agent === 'codex' ? path.basename(file, '.jsonl').replace(/^rollout-/, '') : path.basename(file, '.jsonl');
  return {
    id: hash(file), agent, file, files: [file], sessionKey, isWorker,
    title: shortTitle(explicitTitle || prompt, fallback), lastMessage: latestUserMessage(file, agent),
    project: project || 'unknown project',
    cwd, started: started || stat.birthtimeMs || stat.mtimeMs, startsWithClear,
    modified: stat.mtimeMs,
    size: stat.size,
    active: Date.now() - stat.mtimeMs < 5 * 60 * 1000
  };
}
function readClaudeClearLinks(clearStartedIds) {
  const history = path.join(home, '.claude/history.jsonl');
  const links = new Map();
  if (!fs.existsSync(history)) return links;
  const rows = [];
  try {
    for (const line of fs.readFileSync(history, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
  } catch { return links; }
  for (let index = 0; index < rows.length; index++) {
    const clear = rows[index];
    if (String(clear.display || '').trim() !== '/clear' || !clear.sessionId) continue;
    for (let next = index + 1; next < Math.min(rows.length, index + 80); next++) {
      const candidate = rows[next];
      const gap = Number(candidate.timestamp || 0) - Number(clear.timestamp || 0);
      if (gap > 5 * 60 * 1000) break;
      if (candidate.project !== clear.project || candidate.sessionId === clear.sessionId) continue;
      if (clearStartedIds.has(candidate.sessionId)) {
        links.set(candidate.sessionId, clear.sessionId);
        break;
      }
    }
  }
  return links;
}
function terminalFallbackTitle(item) {
  const date = new Date(item.started || item.modified);
  const when = date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${item.project} · ${item.agent === 'claude' ? 'Claude' : 'Codex'} terminal · ${when}`;
}
function scanSessions() {
  const segments = [];
  for (const [agent, root] of [
    ['codex', path.join(home, '.codex/sessions')],
    ['claude', path.join(home, '.claude/projects')]
  ]) {
    const candidates = walk(root).filter(file => agent !== 'claude' || !file.includes(path.sep + 'subagents' + path.sep));
    for (const file of candidates) {
      try {
        const mainStat = fs.statSync(file);
        let files = [file];
        if (agent === 'claude') {
          const sessionId = path.basename(file, '.jsonl');
          const subagentRoot = path.join(path.dirname(file), sessionId, 'subagents');
          files = files.concat(walk(subagentRoot).filter(child => path.basename(child).startsWith('agent-')));
        }
        const stats = files.map(child => fs.statSync(child));
        const stat = {
          mtimeMs: Math.max(...stats.map(value => value.mtimeMs)),
          size: stats.reduce((sum, value) => sum + value.size, 0)
        };
        const stamp = stat.mtimeMs + ':' + stat.size + ':' + files.length;
        let item = metadataCache.get(file);
        if (!item || item.stamp !== stamp) {
          const value = inspectSession(file, agent, mainStat);
          value.files = files;
          value.modified = stat.mtimeMs;
          value.size = stat.size;
          value.workerLogs = files.length - 1;
          item = { stamp, value };
          metadataCache.set(file, item);
        }
        if (!item.value.isWorker) segments.push({ ...item.value, active: Date.now() - stat.mtimeMs < 5 * 60 * 1000 });
      } catch {}
    }
  }
  const byKey = new Map(segments.map(item => [item.sessionKey, item]));
  const parentByChild = readClaudeClearLinks(new Set(segments.filter(item => item.agent === 'claude' && item.startsWithClear).map(item => item.sessionKey)));
  function rootFor(item) {
    let key = item.sessionKey;
    const seen = new Set();
    while (parentByChild.has(key) && !seen.has(key)) {
      seen.add(key);
      const parent = parentByChild.get(key);
      if (!byKey.has(parent)) break;
      key = parent;
    }
    return key;
  }
  const grouped = new Map();
  for (const item of segments) {
    const root = item.agent === 'claude' ? rootFor(item) : item.sessionKey;
    const groupKey = item.agent + ':' + root;
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(item);
  }
  const found = [];
  for (const members of grouped.values()) {
    members.sort((a, b) => a.started - b.started);
    const first = members[0];
    const files = members.flatMap(item => item.files);
    const mainFiles = members.map(item => item.file);
    const value = {
      ...first,
      id: hash(first.agent + ':terminal:' + first.sessionKey),
      file: first.file,
      files,
      mainFiles,
      aliases: members.map(item => item.id),
      segmentCount: members.length,
      clears: Math.max(0, members.length - 1),
      workerLogs: members.reduce((sum, item) => sum + (item.workerLogs || 0), 0),
      modified: Math.max(...members.map(item => item.modified)),
      size: members.reduce((sum, item) => sum + item.size, 0),
      active: members.some(item => item.active)
    };
    value.resumeKey = members[members.length - 1].sessionKey;
    value.cwd = members[members.length - 1].cwd || first.cwd;
    value.title = shortTitle(members[members.length - 1].lastMessage, terminalFallbackTitle(value));
    found.push(value);
  }
  found.sort((a, b) => b.modified - a.modified);
  sessionMap = new Map();
  for (const item of found) {
    sessionMap.set(item.id, item);
    for (const alias of item.aliases || []) sessionMap.set(alias, item);
  }
  return found;
}

function mergeClaudeSession(session, stamp) {
  if (session.agent !== 'claude' || session.files.length === 1) return session.file;
  const merged = path.join(cacheDir, session.id + '-' + stamp + '-merged.jsonl');
  if (fs.existsSync(merged)) return merged;
  const rows = [];
  const seen = new Set();
  session.files.forEach((file, sourceIndex) => {
    let lineIndex = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      lineIndex++;
      if (!line.trim() || seen.has(line)) continue;
      seen.add(line);
      let timestamp = 0;
      try {
        const obj = JSON.parse(line);
        timestamp = Date.parse(obj.timestamp || obj.created_at || obj.message?.timestamp || '') || 0;
      } catch {}
      rows.push({ line, timestamp, sourceIndex, lineIndex });
    }
  });
  rows.sort((a, b) => a.timestamp - b.timestamp || a.sourceIndex - b.sourceIndex || a.lineIndex - b.lineIndex);
  fs.writeFileSync(merged, rows.map(row => row.line).join('\n') + '\n');
  return merged;
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function liveScript(session) {
  const endpoint = JSON.stringify('/api/version?id=' + encodeURIComponent(session.id));
  const stamp = JSON.stringify(session.modified + ':' + session.size);
  return `<script>(function(){
    var endpoint=${endpoint}, version=${stamp}, latest=null, timer=null, reading=false;
    function nearBottom(){return innerHeight+scrollY>=document.documentElement.scrollHeight-140}
    function button(){var b=document.getElementById('library-new-activity');if(b)return b;b=document.createElement('button');b.id='library-new-activity';b.textContent='NEW ACTIVITY  LOAD UPDATE';b.style.cssText='position:fixed;right:18px;top:70px;z-index:99999;padding:10px 14px;background:#fff;color:#000;border:2px solid #fff;border-radius:4px;font:800 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.8px;cursor:pointer;box-shadow:0 8px 30px rgba(0,0,0,.65)';b.onclick=function(){reload(false)};document.body.appendChild(b);return b}
    function reload(follow){clearTimeout(timer);window.replayReadingPaused=!follow;if(window.captureReplayLiveState)window.captureReplayLiveState();location.hash='turn=999999'+(follow?'r':'');location.reload()}
    document.addEventListener('click',function(e){if(e.target.closest('.tool-header,.tool-group-header,.turn-header,.thinking-header,.collapsible-toggle,.file-entry,.replay-notes,.activity-legend')){reading=true;window.replayReadingPaused=true}},true);
    addEventListener('wheel',function(e){if(e.deltaY<0){reading=true;window.replayReadingPaused=true}},{passive:true});
    setInterval(function(){fetch(endpoint).then(r=>r.json()).then(d=>{if(d.version!==version){version=d.version;latest=d;if(reading||window.replayReadingPaused||!nearBottom()){clearTimeout(timer);button()}else{clearTimeout(timer);timer=setTimeout(()=>reload(true),1400)}}}).catch(()=>{})},1200);
  })();</script>`;
}
function buildReplay(session) {
  const stamp = rendererVersion + '-' + session.modified + '-' + session.size;
  const output = path.join(cacheDir, session.id + '-' + stamp + '.html');
  if (fs.existsSync(output)) return Promise.resolve(fs.readFileSync(output, 'utf8'));
  const jobKey = session.id + ':' + stamp;
  if (buildJobs.has(jobKey)) return buildJobs.get(jobKey);
  const job = new Promise((resolve, reject) => {
    const replayInput = mergeClaudeSession(session, stamp);
    const args = [replayInput, '-o', output, '--theme-file', theme, '--no-minify', '--title', 'Replay — ' + session.project];
    execFile('claude-replay', args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (error) => {
      buildJobs.delete(jobKey);
      if (error) return reject(error);
      try {
        let html = fs.readFileSync(output, 'utf8');
        html = html.replace('</body>', liveScript(session) + '</body>');
        resolve(html);
      } catch (e) { reject(e); }
    });
  });
  buildJobs.set(jobKey, job);
  return job;
}
const shell = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Replay Library</title><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;color:#fff;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.app{display:grid;grid-template-columns:330px 1fr;height:100vh}.rail{display:flex;flex-direction:column;min-width:0;background:#050505;border-right:1px solid #262626}.head{padding:16px 14px 12px;border-bottom:1px solid #222}.brand{font-size:14px;font-weight:900;letter-spacing:1.2px}.sub{margin-top:3px;color:#777;font-size:10px}.search{width:100%;margin-top:12px;padding:9px 10px;background:#000;color:#fff;border:1px solid #333;border-radius:5px;outline:none}.search:focus{border-color:#fff}.tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:9px}.tab{padding:7px 5px;background:#0b0b0b;color:#999;border:1px solid #292929;border-radius:4px;cursor:pointer;font:inherit}.tab.on{background:#fff;color:#000;border-color:#fff;font-weight:900}.count{padding:8px 14px;color:#666;border-bottom:1px solid #171717;font-size:10px}.sessions{flex:1;overflow:auto;padding:6px}.session{position:relative;padding:10px 10px 9px;margin:2px 0;border:1px solid transparent;border-radius:6px;cursor:pointer}.session:hover{background:#0e0e0e;border-color:#292929}.session.on{background:#101010;border-color:#fff}.session-title{padding-right:12px;color:#eee;font-weight:700;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.session-meta{display:flex;gap:7px;margin-top:6px;color:#777;font-size:9px}.agent{font-weight:900;letter-spacing:.6px}.agent.codex{color:#5eead4}.agent.claude{color:#fbbf24}.live{position:absolute;right:9px;top:11px;width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px #22c55e}.empty{padding:20px;color:#777}.main{position:relative;min-width:0;background:#000}.viewer{width:100%;height:100%;border:0;background:#000}.placeholder{position:absolute;inset:0;display:grid;place-items:center;color:#666;letter-spacing:.6px}.loading{position:absolute;right:18px;top:16px;padding:7px 10px;background:#fff;color:#000;font-weight:900;border-radius:4px;display:none;z-index:2}@media(max-width:800px){.app{grid-template-columns:250px 1fr}}
</style></head><body><div class="app"><aside class="rail"><div class="head"><div class="brand">AGENT REPLAY</div><div class="sub">One timeline for every terminal run</div><input id="search" class="search" placeholder="Search terminals or projects"><div class="tabs"><button class="tab on" data-filter="all">ALL</button><button class="tab" data-filter="codex">CODEX</button><button class="tab" data-filter="claude">CLAUDE</button></div></div><div id="count" class="count">Scanning terminals...</div><div id="sessions" class="sessions"></div></aside><main class="main"><div id="placeholder" class="placeholder">SELECT A TERMINAL</div><div id="loading" class="loading">LOADING TERMINAL</div><iframe id="viewer" class="viewer" scrolling="yes" tabindex="0" hidden></iframe></main></div><script>
const list=document.getElementById('sessions'),viewer=document.getElementById('viewer'),loading=document.getElementById('loading'),placeholder=document.getElementById('placeholder'),search=document.getElementById('search'),count=document.getElementById('count');let sessions=[],filter='all',selected=localStorage.getItem('agent-replay-library-selected')||'';
function ago(ms){const s=Math.max(0,Date.now()-ms),m=Math.floor(s/60000),h=Math.floor(m/60),d=Math.floor(h/24);return m<1?'now':m<60?m+'m':h<24?h+'h':d<30?d+'d':new Date(ms).toLocaleDateString()}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function render(){const q=search.value.trim().toLowerCase();const shown=sessions.filter(s=>(filter==='all'||s.agent===filter)&&(!q||(s.title+' '+s.project+' '+s.agent).toLowerCase().includes(q)));count.textContent=shown.length+' OF '+sessions.length+' TERMINALS';list.innerHTML=shown.length?shown.map(s=>'<div class="session '+(s.id===selected?'on':'')+'" data-id="'+s.id+'">'+(s.active?'<span class="live"></span>':'')+'<div class="session-title">'+esc(s.title)+'</div><div class="session-meta"><span class="agent '+s.agent+'">'+s.agent.toUpperCase()+'</span>'+(s.clears?'<span>'+s.clears+' CLEAR'+(s.clears===1?'':'S')+'</span>':'')+'<span>'+ago(s.modified)+'</span></div></div>').join(''):'<div class="empty">No matching terminals</div>'}
function wireReplayScrolling(){const win=viewer.contentWindow,doc=viewer.contentDocument;if(!win||!doc)return;doc.documentElement.style.setProperty('overflow-y','auto','important');doc.body.style.setProperty('overflow-y','auto','important');doc.addEventListener('wheel',e=>{if(Math.abs(e.deltaY)<=Math.abs(e.deltaX))return;e.preventDefault();win.scrollBy(0,e.deltaY)},{passive:false,capture:true});doc.addEventListener('keydown',e=>{const amount=Math.max(120,win.innerHeight*.82);if(e.key==='PageDown'||e.key===' '){e.preventDefault();win.scrollBy(0,amount)}else if(e.key==='PageUp'){e.preventDefault();win.scrollBy(0,-amount)}else if(e.key==='ArrowDown'){e.preventDefault();win.scrollBy(0,70)}else if(e.key==='ArrowUp'){e.preventDefault();win.scrollBy(0,-70)}},true);viewer.focus()}
function openSession(id){const s=sessions.find(x=>x.id===id);if(!s)return;selected=id;localStorage.setItem('agent-replay-library-selected',id);render();loading.style.display='block';placeholder.hidden=true;viewer.hidden=false;viewer.onload=()=>{loading.style.display='none';wireReplayScrolling()};viewer.src='/replay?id='+encodeURIComponent(id)+'#turn=999999r'}
list.onclick=e=>{const row=e.target.closest('.session');if(row)openSession(row.dataset.id)};search.oninput=render;document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));b.classList.add('on');filter=b.dataset.filter;render()});
async function refresh(){try{const r=await fetch('/api/sessions');sessions=await r.json();const target=sessions.find(s=>s.id===selected||s.aliases&&s.aliases.includes(selected));if(target&&target.id!==selected)selected=target.id;render();if(!viewer.src||!sessions.some(s=>s.id===selected)){if(target||sessions[0])openSession((target||sessions[0]).id)}}catch(e){count.textContent='SERVER UNAVAILABLE'}}refresh();setInterval(refresh,5000);
</script></body></html>`;

const rootShell = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Replay Library</title><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#000;color:#fff;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}</style></head><body>LOADING TERMINAL LIBRARY<script>fetch('/api/sessions').then(r=>r.json()).then(s=>{const remembered=localStorage.getItem('agent-replay-library-selected');const target=s.find(x=>x.id===remembered||x.aliases&&x.aliases.includes(remembered))||s[0];if(target)location.replace('/view?id='+encodeURIComponent(target.id)+'#turn=999999r');else document.body.textContent='NO TERMINALS FOUND'}).catch(()=>document.body.textContent='TERMINAL SERVER UNAVAILABLE')</script></body></html>`;

function libraryChrome(selectedId) {
  const selected = JSON.stringify(selectedId);
  return `<style>
    body{padding-left:330px!important}
    body>.container{width:100%!important;max-width:none!important;margin:0!important}
    body>.container>.controls{left:calc(50% + 165px)!important;max-width:calc(100vw - 330px)!important}
    body>.container>.activity-legend{left:342px!important}
    .library-rail{position:fixed;left:0;top:0;bottom:0;width:330px;z-index:10000;display:flex;flex-direction:column;background:#050505;border-right:1px solid #262626;color:#fff;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .library-head{padding:16px 14px 12px;border-bottom:1px solid #222}.library-brand{font-size:14px;font-weight:900;letter-spacing:1.2px}.library-sub{margin-top:3px;color:#777;font-size:10px}
    .library-search{box-sizing:border-box;width:100%;margin-top:12px;padding:9px 10px;background:#000;color:#fff;border:1px solid #333;border-radius:5px;outline:none}.library-search:focus{border-color:#fff}
    .library-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:9px}.library-tab{padding:7px 5px;background:#0b0b0b;color:#999;border:1px solid #292929;border-radius:4px;cursor:pointer;font:inherit}.library-tab.on{background:#fff;color:#000;border-color:#fff;font-weight:900}
    .library-count{padding:8px 14px;color:#666;border-bottom:1px solid #171717;font-size:10px}.library-sessions{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:6px}.library-session{position:relative;padding:10px 10px 9px;margin:2px 0;border:1px solid transparent;border-radius:6px;cursor:pointer}.library-session:hover{background:#0e0e0e;border-color:#292929}.library-session.on{background:#101010;border-color:#fff}
    .library-session-title{padding-right:30px;color:#eee;font-weight:700;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.library-session-folder{margin-top:6px;padding-right:4px;color:#8a8a8a;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.library-session-meta{display:flex;gap:7px;margin-top:4px;padding-right:76px;color:#666;font-size:9px}.library-agent{font-weight:900;letter-spacing:.6px}.library-agent.codex{color:#5eead4}.library-agent.claude{color:#fbbf24}.library-live{position:absolute;right:9px;top:11px;width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px #22c55e}.library-note-plus,.library-resume{position:absolute;bottom:7px;height:20px;padding:0;border:1px solid #444;border-radius:4px;background:#090909;color:#ddd;font:900 10px/18px ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer}.library-note-plus{right:7px;width:20px;font-size:13px}.library-resume{right:32px;width:54px}.library-note-plus:hover,.library-resume:hover{background:#fff;color:#000}.library-note-plus.has-note{background:#facc15;color:#000;border-color:#facc15}
    @media(max-width:900px){body{padding-left:250px!important}.library-rail{width:250px}body>.container>.controls{left:calc(50% + 125px)!important;max-width:calc(100vw - 250px)!important}body>.container>.activity-legend{left:258px!important}}
  </style><aside class="library-rail"><div class="library-head"><div class="library-brand">AGENT REPLAY</div><div class="library-sub">One timeline for every terminal run</div><input id="librarySearch" class="library-search" placeholder="Search terminals or projects"><div class="library-tabs"><button class="library-tab on" data-filter="all">ALL</button><button class="library-tab" data-filter="codex">CODEX</button><button class="library-tab" data-filter="claude">CLAUDE</button></div></div><div id="libraryCount" class="library-count">SCANNING TERMINALS</div><div id="librarySessions" class="library-sessions"></div></aside><script>(function(){
    var selected=${selected},sessions=[],filter='all',list=document.getElementById('librarySessions'),search=document.getElementById('librarySearch'),count=document.getElementById('libraryCount');window.AGENT_REPLAY_SESSION_ID=selected;
    function esc(s){return String(s||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
    function ago(ms){var m=Math.floor(Math.max(0,Date.now()-ms)/60000),h=Math.floor(m/60),d=Math.floor(h/24);return m<1?'now':m<60?m+'m':h<24?h+'h':d<30?d+'d':new Date(ms).toLocaleDateString()}
    function tabNotes(){try{return JSON.parse(localStorage.getItem('agent-replay-tab-notes')||'{}')||{}}catch(_){return{}}}
    function render(){var notes=tabNotes(),q=search.value.trim().toLowerCase(),shown=sessions.filter(function(s){return(filter==='all'||s.agent===filter)&&(!q||(s.title+' '+s.project+' '+s.cwd+' '+s.agent).toLowerCase().includes(q))});count.textContent=shown.length+' OF '+sessions.length+' TERMINALS';list.innerHTML=shown.map(function(s){return'<div class="library-session '+(s.id===selected?'on':'')+'" data-id="'+s.id+'">'+(s.active?'<span class="library-live"></span>':'')+'<div class="library-session-title">'+esc(s.title)+'</div><div class="library-session-folder" title="'+esc(s.cwd)+'">'+esc(s.cwd)+'</div><div class="library-session-meta"><span class="library-agent '+s.agent+'">'+s.agent.toUpperCase()+'</span>'+(s.clears?'<span>'+s.clears+' CLEAR'+(s.clears===1?'':'S')+'</span>':'')+'<span>'+ago(s.modified)+'</span></div><button class="library-resume" title="Resume this terminal">RESUME</button><button class="library-note-plus '+(notes[s.id]?'has-note':'')+'" title="Add a terminal note">+</button></div>'}).join('')}
    function load(){fetch('/api/sessions').then(function(r){return r.json()}).then(function(value){sessions=value;var match=sessions.find(function(s){return s.id===selected||s.aliases&&s.aliases.indexOf(selected)>=0});if(match&&match.id!==selected){var notes=tabNotes();if(notes[selected]&&!notes[match.id])notes[match.id]=notes[selected];selected=match.id;localStorage.setItem('agent-replay-library-selected',selected);localStorage.setItem('agent-replay-tab-notes',JSON.stringify(notes))}render()}).catch(function(){count.textContent='SERVER UNAVAILABLE'})}
    list.addEventListener('click',function(e){var row=e.target.closest('.library-session');if(!row)return;if(e.target.closest('.library-resume')){e.preventDefault();e.stopPropagation();var button=e.target.closest('.library-resume');button.textContent='OPEN';fetch('/api/resume',{method:'POST',headers:{'content-type':'application/json','x-agent-replay-action':'resume'},body:JSON.stringify({sessionId:row.dataset.id})}).then(function(r){if(!r.ok)throw new Error();button.textContent='OPENED';setTimeout(function(){button.textContent='RESUME'},1400)}).catch(function(){button.textContent='FAILED';setTimeout(function(){button.textContent='RESUME'},1800)});return}if(e.target.closest('.library-note-plus')){e.preventDefault();e.stopPropagation();var notes=tabNotes(),old=notes[row.dataset.id]||'',next=prompt('Terminal note',old);if(next===null)return;if(next.trim())notes[row.dataset.id]=next.trim();else delete notes[row.dataset.id];localStorage.setItem('agent-replay-tab-notes',JSON.stringify(notes));render();return}if(row.dataset.id===selected)return;if(window.captureReplayLiveState)window.captureReplayLiveState();localStorage.setItem('agent-replay-library-selected',row.dataset.id);location.href='/view?id='+encodeURIComponent(row.dataset.id)+'#turn=999999r'});
    search.addEventListener('input',render);document.querySelectorAll('.library-tab').forEach(function(button){button.addEventListener('click',function(){document.querySelectorAll('.library-tab').forEach(function(x){x.classList.remove('on')});button.classList.add('on');filter=button.dataset.filter;render()})});
    localStorage.setItem('agent-replay-library-selected',selected);load();setInterval(load,5000);
  })();</script>`;
}

function safeName(value) {
  return String(value || 'session').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session';
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}
function commentsMarkdown(session, payload) {
  const lines = ['# Terminal comments', '', 'Terminal: ' + session.title, 'Agent: ' + session.agent, 'Project: ' + session.project, 'Clear boundaries: ' + session.clears, 'Exported: ' + new Date().toISOString(), ''];
  if (payload.tabNote) lines.push('## Sidebar note', '', String(payload.tabNote), '');
  if (payload.sessionNote?.text) lines.push('## Session note', '', String(payload.sessionNote.text), '');
  if (payload.sessionNote?.marker) lines.push('## Saved place', '', 'Turn: ' + payload.sessionNote.marker.turn, 'Block: ' + (payload.sessionNote.marker.block ?? 'whole turn'), '');
  const entries = Object.entries(payload.sectionNotes || {});
  if (entries.length) {
    lines.push('## Section notes', '');
    for (const [key, note] of entries) lines.push('### ' + (note.label || key), '', 'Anchor: ' + key, '', String(note.text || ''), '');
  }
  return lines.join('\n') + '\n';
}
function commentsHtml(session, payload) {
  const notes = [];
  if (payload.tabNote) notes.push(['Sidebar note', payload.tabNote]);
  if (payload.sessionNote?.text) notes.push(['Session note', payload.sessionNote.text]);
  for (const [key, note] of Object.entries(payload.sectionNotes || {})) notes.push([note.label || key, note.text || '']);
  if (!notes.length) return '';
  return `<section style="margin:20px;padding:18px;background:#080808;border:1px solid #facc15;border-radius:8px;color:#fff;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace"><h1 style="margin:0 0 12px;color:#facc15;font-size:15px">YOUR COMMENTS</h1>${notes.map(([label,text]) => `<article style="margin:10px 0;padding:10px;background:#000;border-left:3px solid #facc15"><strong>${escapeHtml(label)}</strong><div style="margin-top:5px;white-space:pre-wrap">${escapeHtml(text)}</div></article>`).join('')}</section>`;
}
function readRequestJson(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}
function runFile(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, error => error ? reject(error) : resolve()));
}
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}
async function resumeTerminal(session) {
  const cwd = session.cwd && path.isAbsolute(session.cwd) && fs.existsSync(session.cwd) ? session.cwd : home;
  const command = session.agent === 'claude'
    ? `cd ${shellQuote(cwd)} && claude --resume ${shellQuote(session.resumeKey)}`
    : `cd ${shellQuote(cwd)} && codex resume ${shellQuote(session.resumeKey)}`;
  const appleCommand = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Terminal"\nactivate\ndo script "${appleCommand}"\nend tell`;
  await runFile('/usr/bin/osascript', ['-e', script]);
}
async function createSessionExport(session, payload) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-replay-export-'));
  const folderName = safeName(session.agent + '-' + session.project + '-' + new Date(session.modified).toISOString().slice(0,10));
  const folder = path.join(tempRoot, folderName);
  fs.mkdirSync(path.join(folder, 'transcripts'), { recursive: true });
  let replay = await buildReplay(session);
  replay = replay.replace('<body>', '<body>' + commentsHtml(session, payload));
  fs.writeFileSync(path.join(folder, 'replay.html'), replay);
  fs.writeFileSync(path.join(folder, 'COMMENTS.md'), commentsMarkdown(session, payload));
  fs.writeFileSync(path.join(folder, 'comments.json'), JSON.stringify({ session: { id: session.id, title: session.title, agent: session.agent, project: session.project }, ...payload }, null, 2));
  const mains = new Set(session.mainFiles || [session.file]);
  let segmentIndex = 0, workerIndex = 0;
  session.files.forEach(source => {
    const prefix = mains.has(source)
      ? 'segment-' + String(++segmentIndex).padStart(3, '0') + '-'
      : 'worker-' + String(++workerIndex).padStart(3, '0') + '-';
    fs.copyFileSync(source, path.join(folder, 'transcripts', prefix + path.basename(source)));
  });
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ exportedAt: new Date().toISOString(), agent: session.agent, project: session.project, title: session.title, terminalSegments: session.segmentCount || 1, clearBoundaries: session.clears || 0, transcriptFiles: session.files.length, workerLogs: session.workerLogs || 0 }, null, 2));
  const zipPath = path.join(tempRoot, folderName + '.zip');
  await runFile('/usr/bin/ditto', ['-c', '-k', '--keepParent', folder, zipPath]);
  return { tempRoot, zipPath, filename: folderName + '.zip' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(rootShell);
  }
  if (url.pathname === '/api/sessions') return json(res, 200, scanSessions().map(({file, files, mainFiles, startsWithClear, sessionKey, resumeKey, lastMessage, isWorker, ...safe}) => safe));
  if (url.pathname === '/api/resume' && req.method === 'POST') {
    if (req.headers['x-agent-replay-action'] !== 'resume') return json(res, 403, { error: 'missing local action header' });
    try {
      const payload = await readRequestJson(req, 64 * 1024);
      scanSessions(); const session = sessionMap.get(payload.sessionId);
      if (!session) return json(res, 404, { error: 'terminal not found' });
      await resumeTerminal(session);
      return json(res, 200, { ok: true, agent: session.agent, folder: session.cwd });
    } catch (error) { return json(res, 500, { error: error.message }); }
  }
  if (url.pathname === '/api/export' && req.method === 'POST') {
    try {
      const payload = await readRequestJson(req);
      scanSessions(); const session = sessionMap.get(payload.sessionId);
      if (!session) return json(res, 404, { error: 'session not found' });
      const exported = await createSessionExport(session, payload);
      const archive = fs.readFileSync(exported.zipPath);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${exported.filename}"`, 'content-length': archive.length, 'cache-control': 'no-store' });
      res.end(archive, () => { try { fs.rmSync(exported.tempRoot, { recursive: true, force: true }); } catch {} });
      return;
    } catch (error) { return json(res, 500, { error: error.message }); }
  }
  if (url.pathname === '/api/version') {
    scanSessions(); const session = sessionMap.get(url.searchParams.get('id'));
    if (!session) return json(res, 404, { error: 'session not found' });
    return json(res, 200, { version: session.modified + ':' + session.size, active: session.active });
  }
  if (url.pathname === '/replay' || url.pathname === '/view') {
    scanSessions(); const session = sessionMap.get(url.searchParams.get('id'));
    if (!session) return json(res, 404, { error: 'session not found' });
    try {
      let html = await buildReplay(session);
      if (url.pathname === '/view') html = html.replace('<body>', '<body>' + libraryChrome(session.id));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Could not build replay\n\n' + error.message);
    }
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(port, host, () => console.log('Agent Replay Library: http://' + host + ':' + port));
