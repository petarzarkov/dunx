const STYLE = `*{box-sizing:border-box}
body{margin:0;font:14px ui-sans-serif,system-ui,sans-serif;display:flex;height:100vh}
nav{width:240px;background:#0f172a;color:#e2e8f0;padding:16px;overflow:auto;flex-shrink:0}
nav h1{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin:0 0 12px}
nav a{display:block;padding:8px 10px;border-radius:6px;color:#cbd5e1;text-decoration:none}
nav a:hover{background:#1e293b}nav a.active{background:#2563eb;color:#fff}
main{flex:1;display:flex;flex-direction:column;background:#f1f5f9;min-width:0}
header{padding:10px 16px;font:13px ui-monospace,monospace;color:#475569;border-bottom:1px solid #e2e8f0;display:flex;gap:16px;align-items:center}
header a{color:#2563eb}iframe{flex:1;border:0;background:#fff}
label{font-size:13px;color:#475569;cursor:pointer}`;

/**
 * Reloads the frame on a timer rather than over a socket. The server re-executes
 * the module on every request, so a poll is the whole of live reload and it
 * costs no watcher, no websocket and no client bundle.
 */
const SCRIPT = `const f=document.getElementById('frame'),live=document.getElementById('live');
setInterval(()=>{try{if(live.checked)f.contentWindow.location.reload()}catch{}},1500);`;

export const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );

/** The one page the preview server serves: a list, a frame and a reload box. */
export const page = (names: readonly string[], selected?: string): string => {
  const current = selected ?? names[0] ?? '';
  const links = names
    .map((name) => {
      const active = name === current ? ' class="active"' : '';
      return `<a href="/?tpl=${encodeURIComponent(name)}"${active}>${escapeHtml(name)}</a>`;
    })
    .join('');
  const query = `tpl=${encodeURIComponent(current)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Email preview</title><style>${STYLE}</style></head><body>
<nav><h1>Templates</h1>${links || '<em style="color:#64748b">no templates</em>'}</nav>
<main><header><strong>${escapeHtml(current)}</strong>
<label><input type="checkbox" id="live" checked> live reload</label>
<a href="/text?${query}" target="_blank" rel="noreferrer">plain text</a></header>
<iframe id="frame" src="/preview?${query}"></iframe></main>
<script>${SCRIPT}</script></body></html>`;
};
