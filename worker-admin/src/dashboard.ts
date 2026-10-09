/**
 * Single-page admin dashboard. Served at GET /admin.
 * Zero dependencies, inline CSS/JS, token-in-sessionStorage.
 * All names are escaped at render time (textContent, not innerHTML).
 */

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>moderant admin</title>
<style>
  :root {
    --bg: #0f1419; --fg: #e6edf3; --muted: #7d8590; --accent: #ffa657;
    --severe: #f85149; --mild: #d29922; --ok: #3fb950; --card: #161b22;
    --border: #30363d;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
    background: var(--bg); color: var(--fg);
  }
  header {
    padding: 12px 20px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 16px;
  }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  header .status { color: var(--muted); font-size: 12px; margin-left: auto; }
  main { padding: 16px 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
  .card h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; color: var(--muted); letter-spacing: .5px; }
  .controls { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
  input, select, button {
    background: #0d1117; color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 6px 10px; font: inherit;
  }
  input[type="text"], input[type="password"] { min-width: 180px; }
  button { cursor: pointer; }
  button.primary { background: var(--accent); color: #000; border-color: var(--accent); font-weight: 600; }
  button.danger { background: var(--severe); color: #fff; border-color: var(--severe); }
  button.subtle { background: transparent; color: var(--muted); }
  button:hover:not(:disabled) { filter: brightness(1.15); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; }
  tr.watch { background: rgba(210, 153, 34, .07); }
  tr.muted-row { background: rgba(248, 81, 73, .08); }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 11px; }
  .pill.watch { background: var(--mild); color: #000; }
  .pill.muted-pill { background: var(--severe); color: #fff; }
  .pill.ok { background: var(--ok); color: #000; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .right { text-align: right; }
  .empty { color: var(--muted); padding: 12px; text-align: center; font-style: italic; }
  .error { color: var(--severe); font-size: 12px; margin: 4px 0; }
  .user-detail { grid-column: 1 / -1; }
  .violations { max-height: 320px; overflow: auto; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>moderant admin</h1>
  <span class="status" id="status">not authenticated</span>
  <button class="subtle" id="btn-logout" style="display:none">logout</button>
</header>
<main>
  <section class="card" id="auth-card" style="grid-column: 1/-1">
    <h2>Authenticate</h2>
    <div class="controls">
      <input type="password" id="token" placeholder="admin bearer token" autocomplete="off" />
      <button class="primary" id="btn-auth">connect</button>
    </div>
    <div class="error" id="auth-error"></div>
  </section>

  <section class="card" id="offenders-card" style="display:none">
    <h2>Top offenders</h2>
    <div class="controls">
      <select id="order">
        <option value="avg">avg score</option>
        <option value="strikes">current strikes</option>
        <option value="blocks">severe blocks</option>
      </select>
      <input type="text" id="min-msgs" value="20" style="width: 70px" title="min messages" />
      <button id="btn-refresh-offenders">refresh</button>
    </div>
    <div id="offenders"><div class="empty">load to view</div></div>
  </section>

  <section class="card" id="room-card" style="display:none">
    <h2>Room roster</h2>
    <div class="controls">
      <input type="text" id="matchid" placeholder="matchId" />
      <button id="btn-load-room">load</button>
    </div>
    <div id="room"><div class="empty">enter a matchId</div></div>
  </section>

  <section class="card user-detail" id="user-card" style="display:none">
    <h2>User detail: <span id="user-title" class="mono"></span></h2>
    <div id="user-summary"></div>
    <h3 style="font-size:12px;color:var(--muted);margin:14px 0 6px;text-transform:uppercase">Violations (last 50)</h3>
    <div class="violations" id="user-violations"></div>
  </section>
</main>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; };
  const fmtTime = (t) => t ? new Date(t).toISOString().replace("T"," ").slice(0,19) : "-";
  const fmtDur = (ms) => {
    if (!ms || ms < 0) return "-";
    const s = Math.round(ms/1000);
    if (s < 60) return s + "s";
    const m = Math.round(s/60);
    if (m < 60) return m + "m";
    const h = Math.round(m/60);
    return h + "h";
  };
  const fmtScore = (s) => (s === null || s === undefined) ? "-" : Number(s).toFixed(3);
  const token = () => sessionStorage.getItem("moderant_admin_token") || "";

  async function api(path, opts) {
    const t = token();
    if (!t) throw new Error("no token");
    const r = await fetch(path, {
      ...opts,
      headers: { ...(opts && opts.headers || {}), "authorization": "Bearer " + t },
    });
    if (r.status === 401) { logout(); throw new Error("unauthorized"); }
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  }

  function showAuthed(authed) {
    $("auth-card").style.display = authed ? "none" : "";
    $("offenders-card").style.display = authed ? "" : "none";
    $("room-card").style.display = authed ? "" : "none";
    $("btn-logout").style.display = authed ? "" : "none";
    $("status").textContent = authed ? "connected" : "not authenticated";
  }

  function logout() {
    sessionStorage.removeItem("moderant_admin_token");
    $("user-card").style.display = "none";
    $("offenders").innerHTML = '<div class="empty">load to view</div>';
    $("room").innerHTML = '<div class="empty">enter a matchId</div>';
    showAuthed(false);
  }

  $("btn-logout").onclick = logout;

  $("btn-auth").onclick = async () => {
    const tok = $("token").value.trim();
    $("auth-error").textContent = "";
    if (!tok) { $("auth-error").textContent = "token required"; return; }
    sessionStorage.setItem("moderant_admin_token", tok);
    try {
      await api("/admin/api/offenders?order=avg&min_msgs=0&limit=1");
      $("token").value = "";
      showAuthed(true);
      loadOffenders();
    } catch (e) {
      sessionStorage.removeItem("moderant_admin_token");
      $("auth-error").textContent = "auth failed: " + e.message;
    }
  };

  async function loadOffenders() {
    const order = $("order").value;
    const min = Math.max(0, parseInt($("min-msgs").value || "0", 10));
    try {
      const data = await api("/admin/api/offenders?order=" + order + "&min_msgs=" + min + "&limit=50");
      renderOffenders(data.offenders || []);
    } catch (e) {
      $("offenders").innerHTML = '<div class="error">' + esc(e.message) + '</div>';
    }
  }
  $("btn-refresh-offenders").onclick = loadOffenders;
  $("order").onchange = loadOffenders;

  function renderOffenders(rows) {
    if (rows.length === 0) { $("offenders").innerHTML = '<div class="empty">no data yet</div>'; return; }
    const now = Date.now();
    let h = '<table><thead><tr><th>#</th><th>user</th><th class="right">msgs</th><th class="right">avg</th><th class="right">mild</th><th class="right">severe</th><th class="right">strikes</th><th>state</th></tr></thead><tbody>';
    for (const o of rows) {
      const muted = o.mutedUntil > now;
      const cls = muted ? "muted-row" : (o.strikes >= 3 ? "watch" : "");
      const stateHtml = muted
        ? '<span class="pill muted-pill">muted ' + esc(fmtDur(o.mutedUntil - now)) + '</span>'
        : (o.strikes >= 3 ? '<span class="pill watch">watch</span>' : '<span class="pill ok">clean</span>');
      h += '<tr class="' + cls + '"><td>' + o.rank + '</td>' +
           '<td class="mono"><a href="#" data-iss="' + esc(o.iss) + '" data-sub="' + esc(o.sub) + '" style="color:var(--fg);">' + esc(o.name || o.sub) + '</a> <span style="color:var(--muted)">· ' + esc(o.iss) + '</span></td>' +
           '<td class="right">' + o.msgs + '</td>' +
           '<td class="right mono">' + fmtScore(o.avgScore) + '</td>' +
           '<td class="right">' + o.blocksMild + '</td>' +
           '<td class="right">' + o.blocksSevere + '</td>' +
           '<td class="right">' + Math.round(o.strikes) + '</td>' +
           '<td>' + stateHtml + '</td></tr>';
    }
    h += '</tbody></table>';
    $("offenders").innerHTML = h;
    for (const a of $("offenders").querySelectorAll("a[data-sub]")) {
      a.onclick = (ev) => { ev.preventDefault(); loadUser(a.dataset.iss, a.dataset.sub, null); };
    }
  }

  $("btn-load-room").onclick = loadRoom;
  async function loadRoom() {
    const m = $("matchid").value.trim();
    if (!m) return;
    try {
      const data = await api("/admin/api/rooms/" + encodeURIComponent(m));
      renderRoom(m, data.roster || []);
    } catch (e) {
      $("room").innerHTML = '<div class="error">' + esc(e.message) + '</div>';
    }
  }

  function renderRoom(matchId, rows) {
    if (rows.length === 0) { $("room").innerHTML = '<div class="empty">room empty or not open</div>'; return; }
    const now = Date.now();
    let h = '<table><thead><tr><th>user</th><th class="right">session msgs</th><th class="right">session avg</th><th class="right">lifetime avg</th><th class="right">strikes</th><th>state</th><th></th></tr></thead><tbody>';
    for (const r of rows) {
      const s = r.standing;
      const muted = s.mutedUntil > now;
      const cls = muted ? "muted-row" : (s.watch ? "watch" : "");
      const stateHtml = muted
        ? '<span class="pill muted-pill">muted ' + esc(fmtDur(s.mutedUntil - now)) + '</span>'
        : (s.watch ? '<span class="pill watch">watch</span>' : '<span class="pill ok">clean</span>');
      const sessAvg = s.msgs > 0 ? fmtScore(s.scoreSum / s.msgs) : "-";
      h += '<tr class="' + cls + '">' +
           '<td class="mono"><a href="#" data-iss="' + esc(r.iss) + '" data-sub="' + esc(r.sub) + '">' + esc(r.name) + '</a></td>' +
           '<td class="right">' + s.msgs + '</td>' +
           '<td class="right mono">' + sessAvg + '</td>' +
           '<td class="right mono">' + fmtScore(s.avgScore) + '</td>' +
           '<td class="right">' + s.strikes + '</td>' +
           '<td>' + stateHtml + '</td>' +
           '<td class="right">' +
             '<button data-action="pardon" data-iss="' + esc(r.iss) + '" data-sub="' + esc(r.sub) + '" data-match="' + esc(matchId) + '">pardon</button> ' +
             '<button class="danger" data-action="mute" data-iss="' + esc(r.iss) + '" data-sub="' + esc(r.sub) + '" data-match="' + esc(matchId) + '">mute 5m</button>' +
           '</td></tr>';
    }
    h += '</tbody></table>';
    $("room").innerHTML = h;
    for (const a of $("room").querySelectorAll("a[data-sub]")) {
      a.onclick = (ev) => { ev.preventDefault(); loadUser(a.dataset.iss, a.dataset.sub, matchId); };
    }
    for (const b of $("room").querySelectorAll("button[data-action]")) {
      b.onclick = () => doAction(b.dataset.action, b.dataset.iss, b.dataset.sub, b.dataset.match);
    }
  }

  async function doAction(action, iss, sub, matchId) {
    try {
      const body = { matchId };
      if (action === "mute") body.durationMs = 5 * 60 * 1000;
      await api("/admin/api/users/" + encodeURIComponent(iss) + "/" + encodeURIComponent(sub) + "/" + action, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await loadRoom();
      await loadOffenders();
    } catch (e) {
      alert("failed: " + e.message);
    }
  }

  async function loadUser(iss, sub, matchId) {
    try {
      const data = await api("/admin/api/users/" + encodeURIComponent(iss) + "/" + encodeURIComponent(sub));
      renderUser(iss, sub, matchId, data);
    } catch (e) {
      alert("load user failed: " + e.message);
    }
  }

  function renderUser(iss, sub, matchId, data) {
    $("user-card").style.display = "";
    $("user-title").textContent = (data.standing.name || sub) + " @ " + iss;
    const s = data.standing;
    const now = Date.now();
    const muted = s.mutedUntil > now;
    let h = '<table><tbody>' +
      '<tr><th>messages</th><td class="right">' + s.msgs + '</td>' +
      '<th>avg score</th><td class="right mono">' + fmtScore(s.avgScore) + '</td></tr>' +
      '<tr><th>mild blocks</th><td class="right">' + s.blocksMild + '</td>' +
      '<th>severe blocks</th><td class="right">' + s.blocksSevere + '</td></tr>' +
      '<tr><th>current strikes</th><td class="right">' + Math.round(s.strikes) + '</td>' +
      '<th>mutes</th><td class="right">' + s.mutes + '</td></tr>' +
      '<tr><th>muted until</th><td colspan="3">' + (muted ? esc(fmtTime(s.mutedUntil)) + ' (' + esc(fmtDur(s.mutedUntil - now)) + ')' : '-') + '</td></tr>' +
      '<tr><th>last seen</th><td colspan="3">' + esc(fmtTime(s.lastSeen)) + '</td></tr>' +
      '</tbody></table>' +
      '<div style="margin-top:10px;display:flex;gap:8px">' +
        '<button data-action="pardon">pardon</button>' +
        '<button class="danger" data-action="mute" data-dur="300000">mute 5m</button>' +
        '<button class="danger" data-action="mute" data-dur="1800000">mute 30m</button>' +
        '<button class="danger" data-action="mute" data-dur="86400000">mute 24h</button>' +
      '</div>';
    $("user-summary").innerHTML = h;
    for (const b of $("user-summary").querySelectorAll("button[data-action]")) {
      b.onclick = async () => {
        const body = {};
        if (matchId) body.matchId = matchId;
        if (b.dataset.action === "mute") body.durationMs = Number(b.dataset.dur);
        try {
          await api("/admin/api/users/" + encodeURIComponent(iss) + "/" + encodeURIComponent(sub) + "/" + b.dataset.action, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          await loadUser(iss, sub, matchId);
          await loadOffenders();
          if (matchId) await loadRoom();
        } catch (e) { alert("failed: " + e.message); }
      };
    }

    // Violations
    const vs = data.violations || [];
    if (vs.length === 0) {
      $("user-violations").innerHTML = '<div class="empty">no violations recorded</div>';
    } else {
      let v = '<table><thead><tr><th>when</th><th>match</th><th>layer</th><th>severity</th><th class="right">score</th><th class="right">weight</th><th>matched</th></tr></thead><tbody>';
      for (const r of vs) {
        v += '<tr><td class="mono">' + esc(fmtTime(r.at)) + '</td>' +
             '<td class="mono">' + esc(r.matchId) + '</td>' +
             '<td>' + esc(r.layer) + '</td>' +
             '<td>' + esc(r.severity || "-") + '</td>' +
             '<td class="right mono">' + fmtScore(r.score) + '</td>' +
             '<td class="right">' + r.weight + '</td>' +
             '<td class="mono">' + esc(r.matched || "-") + '</td></tr>';
      }
      v += '</tbody></table>';
      $("user-violations").innerHTML = v;
    }
  }

  // Auto-restore if token present.
  if (token()) {
    (async () => {
      try {
        await api("/admin/api/offenders?order=avg&min_msgs=0&limit=1");
        showAuthed(true);
        loadOffenders();
      } catch { logout(); }
    })();
  }
})();
</script>
</body>
</html>`;
