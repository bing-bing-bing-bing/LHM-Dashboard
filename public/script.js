/* =====================================================================
   CONFIG
   ===================================================================== */
const API_URL       = 'http://192.168.2.99:8085/data.json';
const CONFIG_URL    = '/api/dashboard-config';
const HISTORY_LEN   = 60;   // data points per sensor
const POLL_INTERVAL = 1000; // ms

/* =====================================================================
   STATE
   ===================================================================== */
const sensorHistory = {};   // id -> { label, unit, path, values:[{t,v}] }
let allSensors      = [];   // flat list of leaf sensors
let rawTree         = null;
let chartInstances  = {};
let firstRender     = true;

// Dashboard selection state — ordered arrays so drag order is preserved
let kpiIds   = [];
let chartIds = [];

// SortableJS instances for the dashboard grids
let sortableKpi   = null;
let sortableChart = null;

/* =====================================================================
   DASHBOARD CONFIG — SERVER PERSISTENCE
   ===================================================================== */
async function loadDashboardConfig() {
  try {
    const res  = await fetch(CONFIG_URL);
    const data = await res.json();
    kpiIds   = data.kpiIds   || [];
    chartIds = data.chartIds || [];
  } catch {
    kpiIds   = [];
    chartIds = [];
  }
}

async function saveDashboardConfig() {
  await fetch(CONFIG_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ kpiIds, chartIds }),
  });
}

/* =====================================================================
   FETCH & PARSE
   ===================================================================== */
async function fetchData() {
  try {
    const res  = await fetch(API_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rawTree    = await res.json();
    allSensors = [];
    flattenNode(rawTree, []);

    const now = Date.now();
    allSensors.forEach(s => {
      if (!sensorHistory[s.id]) {
        sensorHistory[s.id] = { label: s.label, unit: s.unit, path: s.path, values: [] };
      }
      const h = sensorHistory[s.id];
      h.label = s.label; h.unit = s.unit;
      h.values.push({ t: now, v: s.value });
      if (h.values.length > HISTORY_LEN) h.values.shift();
    });

    convertNetworkSpeeds();

    setStatus(true);
    renderAll();
  } catch(e) {
    setStatus(false, e.message);
  }
}

/* LHM tree is: { Children:[{Text, Value, Min, Max, id, Children:[...]}] } */
function flattenNode(node, path) {
  const myPath = [...path, node.Text];
  if (node.Children && node.Children.length) {
    node.Children.forEach(c => flattenNode(c, myPath));
  } else {
    const val = parseFloat((node.Value||'').replace(/[^0-9.\-]/g,''));
    const min = parseFloat((node.Min  ||'').replace(/[^0-9.\-]/g,''));
    const max = parseFloat((node.Max  ||'').replace(/[^0-9.\-]/g,''));
    allSensors.push({
      id:    String(node.id || myPath.join('/')),
      label: node.Text,
      value: isNaN(val) ? null : val,
      min:   isNaN(min) ? null : min,
      max:   isNaN(max) ? null : max,
      unit:  extractUnit(node.Value||''),
      path:  myPath,
    });
  }
}

function extractUnit(str) {
  const m = str.match(/([°%A-Za-z/]+)$/);
  return m ? m[1].trim() : '';
}

function convertNetworkSpeeds() {
  allSensors.forEach(s => {
    if (s.unit === 'KB/s') {
      s.value = s.value / 1024;
      s.unit  = 'MB/s';
    }
  });
}

/* =====================================================================
   STATUS
   ===================================================================== */
function setStatus(ok, msg) {
  document.getElementById('status-dot').className   = 'dot' + (ok ? '' : ' error');
  document.getElementById('status-text').textContent = ok ? 'LIVE' : 'ERROR';
  document.getElementById('last-update').textContent  =
    ok ? new Date().toLocaleTimeString() : (msg||'').slice(0,50);
}

/* =====================================================================
   CLASSIFICATION HELPERS
   ===================================================================== */
function tempClass(celsius) {
  if (celsius >= 90) return 'crit';
  if (celsius >= 70) return 'hot';
  return 'ok';
}
function loadClass(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'hot';
  return '';
}
function sensorClass(s) {
  if (s.value === null) return '';
  const u = s.unit;
  if (u === '°C') return tempClass(s.value);
  if (u === '°F') return tempClass((s.value-32)*5/9);
  if (u === '%')  return loadClass(s.value);
  return '';
}
function toCardClass(cls) {
  if (cls === 'crit') return 'danger';
  if (cls === 'hot')  return 'warn';
  if (cls === 'ok')   return 'ok';
  return '';
}

/* Return a chart color for a given unit */
function colorForUnit(unit) {
  if (unit === '°C' || unit === '°F') return '#39ff14';
  if (unit === '%')    return '#00d4ff';
  if (unit === 'W')    return '#ff9900';
  if (unit === 'MHz' || unit === 'GHz') return '#c084fc';
  if (unit === 'RPM')  return '#00ffcc';
  if (unit === 'V')    return '#ffdd00';
  if (unit === 'MB/s' || unit === 'KB/s') return '#ff00b7';
  return '#00d4ff';
}

/* yMax heuristic for a given unit */
function yMaxForUnit(unit) {
  if (unit === '%')    return 100;
  if (unit === '°C')   return 110;
  if (unit === '°F')   return 230;
  return undefined; // auto
}

/* Value display precision */
function dispValue(v, unit) {
  if (v === null) return '—';
  const decimals = ['MHz','RPM','GB','KB/s','MB/s'].includes(unit) ? 0 : 1;
  return v.toFixed(decimals);
}

/* Safe HTML element id from arbitrary sensor id string */
function safeId(id) {
  // btoa(encodeURIComponent()) gives a base64 string safe for use in HTML id attributes
  return 'sid-' + btoa(unescape(encodeURIComponent(id))).replace(/[^A-Za-z0-9]/g, '_');
}

/* =====================================================================
   RENDER ALL
   ===================================================================== */
function renderAll() {
  if (firstRender) {
    firstRender = false;
    try { renderKPIs(); }    catch(e) { console.error('renderKPIs:', e); }
    try { renderCharts(); }  catch(e) { console.error('renderCharts:', e); }
    try { renderSensorTable(); expandAllGroups(); } catch(e) { console.error('renderSensorTable:', e); }
  } else {
    try { updateKPIs(); }               catch(e) { console.error('updateKPIs:', e); }
    try { updateCharts(); }             catch(e) { console.error('updateCharts:', e); }
    try { updateSensorTableValues(); }  catch(e) { console.error('updateSensorTableValues:', e); }
  }
}

/* =====================================================================
   KPI CARDS  (dynamic — driven by kpiIds)
   ===================================================================== */
function renderKPIs() {
  const container = document.getElementById('kpi-container');
  const pinned = kpiIds.map(id => allSensors.find(s => s.id === id)).filter(Boolean);

  if (!pinned.length) {
    container.innerHTML =
      `<div class="empty-hint">☆ Pin sensors as <strong>KPI</strong> in the All Sensors tab to show them here.</div>`;
    return;
  }

  let html = '<div class="kpi-grid">';
  pinned.forEach(s => {
    const cls  = toCardClass(sensorClass(s));
    const pct  = s.unit === '%' ? s.value : null;
    const disp = dispValue(s.value, s.unit);
    html += `<div class="kpi-card ${cls}" data-kpi="${s.id}">
      <div class="kpi-drag-handle" title="Drag to reorder">⠿</div>
      <div class="kpi-label">${s.label}</div>
      <div><span class="kpi-value">${disp}</span><span class="kpi-unit">${s.unit}</span></div>
      ${pct !== null ? `<div class="kpi-bar"><div class="kpi-bar-fill" style="width:${Math.min(pct,100).toFixed(1)}%"></div></div>` : ''}
    </div>`;
  });
  html += '</div>';
  container.innerHTML = html;
  initSortableKpi();
}

function updateKPIs() {
  kpiIds.forEach(id => {
    const s    = allSensors.find(x => x.id === id);
    const card = document.querySelector(`.kpi-card[data-kpi="${CSS.escape(id)}"]`);
    if (!s || !card) return;
    card.className = `kpi-card ${toCardClass(sensorClass(s))}`;
    card.querySelector('.kpi-value').textContent = dispValue(s.value, s.unit);
    const bar = card.querySelector('.kpi-bar-fill');
    if (bar && s.unit === '%') bar.style.width = Math.min(s.value, 100).toFixed(1) + '%';
  });
}

/* =====================================================================
   CHARTS  (dynamic — driven by chartIds)
   ===================================================================== */
function renderCharts() {
  const container = document.getElementById('charts-container');
  const pinned = chartIds.map(id => allSensors.find(s => s.id === id)).filter(Boolean);

  if (!pinned.length) {
    container.innerHTML =
      `<div class="empty-hint">📈 Pin sensors as <strong>Chart</strong> in the All Sensors tab to show live graphs here.</div>`;
    return;
  }

  let html = '<div class="charts-grid">';
  pinned.forEach(s => {
    const h    = sensorHistory[s.id];
    const last = h && h.values.length ? h.values[h.values.length-1].v : s.value;
    html += `<div class="chart-card" data-chart="${s.id}">
      <div class="chart-title">
        <span class="chart-drag-handle" title="Drag to reorder">⠿</span>
        <span>${s.label}</span>
        <span class="chart-current" id="chart-cur-${safeId(s.id)}">${last !== null ? last.toFixed(1) : '—'} ${s.unit}</span>
      </div>
      <div class="chart-wrap"><canvas id="chart-cv-${safeId(s.id)}"></canvas></div>
    </div>`;
  });
  html += '</div>';
  container.innerHTML = html;

  pinned.forEach(s => {
    const h   = sensorHistory[s.id];
    const pts = h ? h.values : [{ t: Date.now(), v: s.value }];
    buildChart(s.id, pts, colorForUnit(s.unit), s.unit, yMaxForUnit(s.unit));
  });
  initSortableChart();
}

function buildChart(id, pts, color, unit, yMax) {
  const ctx    = document.getElementById(`chart-cv-${safeId(id)}`);
  if (!ctx) return;
  if (chartInstances[id]) chartInstances[id].destroy();

  const scaleY = { min: 0, grid: { color: '#1a2535' }, border: { color: '#1a2535' },
    ticks: { color: '#4a6070', font: { family: 'Share Tech Mono', size: 9 }, maxTicksLimit: 4 } };
  if (yMax !== undefined) scaleY.max = yMax;

  chartInstances[id] = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels:   pts.map(p => new Date(p.t).toLocaleTimeString()),
      datasets: [{ data: pts.map(p => p.v), borderColor: color, backgroundColor: color + '18',
                   borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: c => `${c.parsed.y.toFixed(1)} ${unit}` },
          backgroundColor: '#0d1218', borderColor: color, borderWidth: 1,
          titleColor: '#4a6070', bodyColor: color,
          titleFont: { family: 'Share Tech Mono', size: 10 },
          bodyFont:  { family: 'Share Tech Mono', size: 11 }
        }
      },
      scales: { x: { display: false }, y: scaleY }
    }
  });
}

function updateCharts() {
  chartIds.forEach(id => {
    const s    = allSensors.find(x => x.id === id);
    const inst = chartInstances[id];
    if (!s || !inst) return;
    const h = sensorHistory[s.id];
    if (!h) return;
    inst.data.labels           = h.values.map(p => new Date(p.t).toLocaleTimeString());
    inst.data.datasets[0].data = h.values.map(p => p.v);
    inst.update('none');
    const cur = document.getElementById(`chart-cur-${safeId(id)}`);
    if (cur && h.values.length) cur.textContent = `${h.values[h.values.length-1].v.toFixed(1)} ${s.unit}`;
  });
}

/* =====================================================================
   TOGGLE HANDLERS (called from sensor table buttons)
   ===================================================================== */
async function toggleKpi(id) {
  const idx = kpiIds.indexOf(id);
  if (idx >= 0) kpiIds.splice(idx, 1); else kpiIds.push(id);
  await saveDashboardConfig();
  refreshPinButtons(id);
  renderKPIs();
}

async function toggleChart(id) {
  const idx = chartIds.indexOf(id);
  if (idx >= 0) {
    chartIds.splice(idx, 1);
    if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
  } else {
    chartIds.push(id);
  }
  await saveDashboardConfig();
  refreshPinButtons(id);
  renderCharts();
}

function refreshPinButtons(id) {
  const row  = document.querySelector(`tr[data-sid="${CSS.escape(id)}"]`);
  if (!row) return;
  const kBtn = row.querySelector('.toggle-btn.kpi-btn');
  const cBtn = row.querySelector('.toggle-btn.chart-btn');
  if (kBtn) kBtn.classList.toggle('active', kpiIds.includes(id));
  if (cBtn) cBtn.classList.toggle('active', chartIds.includes(id));
  row.classList.toggle('pinned-row', kpiIds.includes(id) || chartIds.includes(id));
}

/* =====================================================================
   SORTABLE DRAG-AND-DROP
   ===================================================================== */
function initSortableKpi() {
  if (sortableKpi) { sortableKpi.destroy(); sortableKpi = null; }
  const grid = document.querySelector('.kpi-grid');
  if (!grid || !window.Sortable) return;
  sortableKpi = new Sortable(grid, {
    animation: 200,
    handle: '.kpi-drag-handle',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd: () => {
      kpiIds = [...document.querySelectorAll('.kpi-card[data-kpi]')].map(c => c.dataset.kpi);
      saveDashboardConfig();
    }
  });
}

function initSortableChart() {
  if (sortableChart) { sortableChart.destroy(); sortableChart = null; }
  const grid = document.querySelector('.charts-grid');
  if (!grid || !window.Sortable) return;
  sortableChart = new Sortable(grid, {
    animation: 200,
    handle: '.chart-drag-handle',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    onEnd: () => {
      chartIds = [...document.querySelectorAll('.chart-card[data-chart]')].map(c => c.dataset.chart);
      saveDashboardConfig();
    }
  });
}

/* =====================================================================
   SENSOR TABLE
   ===================================================================== */
const GROUPS = {
  'Temperature': s => s.unit==='°C' || s.unit==='°F' || s.unit==='K',
  'Load':        s => s.unit==='%',
  'Clock':       s => s.unit==='MHz' || s.unit==='GHz',
  'Power':       s => s.unit==='W',
  'Data':        s => s.unit==='GB' || s.unit==='MB' || s.unit==='KB/s' || s.unit==='MB/s',
  'Fan':         s => s.unit==='RPM',
  'Voltage':     s => s.unit==='V',
  'Other':       () => true,
};

function renderSensorTable() {
  const assigned = new Set();
  let html = '';

  Object.entries(GROUPS).forEach(([name, test]) => {
    const group = allSensors.filter(s => !assigned.has(s.id) && test(s));
    if (!group.length) return;
    group.forEach(s => assigned.add(s.id));
    const gid = 'grp-' + name.replace(/\W/g,'');

    html += `<div class="group-toggle" onclick="toggleGroup('${gid}')">
      <span class="arrow">▾</span> ${name} <span style="font-size:11px;font-weight:400;margin-left:4px;opacity:.6">(${group.length})</span>
    </div>
    <div class="group-body" id="${gid}">
    <table class="sensor-table">
      <thead><tr><th>NAME</th><th>PATH</th><th>VALUE</th><th>MIN</th><th>MAX</th><th class="pin-col">DASHBOARD</th></tr></thead>
      <tbody>`;

    group.forEach(s => {
      const cls      = sensorClass(s);
      const disp     = s.value!==null ? s.value.toFixed(['MHz','RPM','KB/s','MB/s'].includes(s.unit)?0:1)+' '+s.unit : '—';
      const pct      = s.unit==='%' ? s.value : null;
      const minD     = s.min!==null ? s.min.toFixed(1) : '—';
      const maxD     = s.max!==null ? s.max.toFixed(1) : '—';
      const bar      = pct!==null ? `<span class="mini-bar"><span class="mini-bar-fill ${cls}" style="width:${Math.min(pct,100).toFixed(1)}%"></span></span>` : '';
      const pathStr  = s.path.slice(1,-1).join(' › ');
      const kpiAct   = kpiIds.includes(s.id)   ? 'active' : '';
      const chartAct = chartIds.includes(s.id) ? 'active' : '';
      const pinned   = (kpiIds.includes(s.id) || chartIds.includes(s.id)) ? 'pinned-row' : '';
      const escapedId = s.id.replace(/\\/g,'\\\\').replace(/'/g,"\\'");

      html += `<tr data-sid="${s.id}" class="${pinned}">
        <td>${s.label}</td>
        <td style="color:var(--muted);font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${pathStr}">${pathStr}</td>
        <td class="val-cell ${cls}">${disp}${bar}</td>
        <td style="font-family:var(--font-mono);font-size:11px;color:var(--muted)">${minD}</td>
        <td style="font-family:var(--font-mono);font-size:11px;color:var(--muted)">${maxD}</td>
        <td class="pin-col">
          <button class="toggle-btn kpi-btn ${kpiAct}"   onclick="toggleKpi('${escapedId}')"   title="Show as KPI card">KPI</button>
          <button class="toggle-btn chart-btn ${chartAct}" onclick="toggleChart('${escapedId}')" title="Show as live chart">CHART</button>
        </td>
      </tr>`;
    });

    html += '</tbody></table></div>';
  });

  document.getElementById('sensor-table-container').innerHTML = html;
}

function updateSensorTableValues() {
  allSensors.forEach(s => {
    const row = document.querySelector(`.sensor-table tr[data-sid="${CSS.escape(s.id)}"]`);
    if (!row) return;
    const cls  = sensorClass(s);
    const disp = s.value!==null ? s.value.toFixed(['MHz','RPM','KB/s','MB/s'].includes(s.unit)?0:1)+' '+s.unit : '—';
    const pct  = s.unit==='%' ? s.value : null;
    const bar  = pct!==null ? `<span class="mini-bar"><span class="mini-bar-fill ${cls}" style="width:${Math.min(pct,100).toFixed(1)}%"></span></span>` : '';
    const cell = row.querySelector('.val-cell');
    if (cell) { cell.className = `val-cell ${cls}`; cell.innerHTML = disp + bar; }
  });
}

function expandAllGroups() {
  // Use a large fixed value — avoids scrollHeight timing issues.
  // The CSS transition only fires when collapsing, so this is visually clean.
  document.querySelectorAll('.group-body').forEach(b => {
    b.style.maxHeight = '20000px';
  });
}

function toggleGroup(id) {
  const body = document.getElementById(id);
  const btn  = body.previousElementSibling;
  // If not explicitly set to '0px', treat as open
  const open = body.style.maxHeight !== '0px';
  if (open) {
    // Animate collapse: lock to actual height first, then 0 in next frame
    body.style.maxHeight = body.scrollHeight + 'px';
    requestAnimationFrame(() => { body.style.maxHeight = '0px'; });
  } else {
    body.style.maxHeight = '20000px';
  }
  btn.classList.toggle('collapsed', open);
}

/* =====================================================================
   TABS
   ===================================================================== */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => {
    t.classList.toggle('active', ['dashboard','sensors'][i] === name);
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
}

/* =====================================================================
   SIDEBAR
   ===================================================================== */
function renderSidebar() {
  if (!rawTree) return;
  const sb = document.getElementById('sidebar');
  let html = '';

  function walk(node, depth) {
    if (!node.Children || node.Children.length === 0) {
      const cls = sensorClass({ unit: extractUnit(node.Value||''), value: parseFloat((node.Value||'').replace(/[^0-9.\-]/g,'')) });
      return `<div class="tree-leaf" style="padding-left:${14+depth*10}px">
        <span style="width:14px;flex-shrink:0;font-size:12px">${nodeEmoji(node.Text)}</span>
        <span class="lname" title="${node.Text}">${node.Text}</span>
        <span class="lval ${cls}">${node.Value||''}</span>
      </div>`;
    }
    let h = `<div class="sidebar-section" style="padding-left:${14+depth*10}px">${nodeEmoji(node.Text)} ${node.Text}</div>`;
    h += (node.Children||[]).map(c => walk(c, depth+1)).join('');
    return h;
  }

  (rawTree.Children||[]).forEach(c => { html += walk(c, 0); });
  sb.innerHTML = html || '<div style="padding:16px;color:var(--muted);font-size:12px">No data</div>';
}

function nodeEmoji(text) {
  if (/cpu|processor/i.test(text)) return '🔲';
  if (/gpu|nvidia|radeon/i.test(text)) return '🎮';
  if (/memory|ram/i.test(text)) return '🧠';
  if (/temperature|temp/i.test(text)) return '🌡';
  if (/load/i.test(text)) return '📊';
  if (/clock|freq/i.test(text)) return '⏱';
  if (/fan/i.test(text)) return '💨';
  if (/power/i.test(text)) return '⚡';
  if (/storage|hdd|ssd|nvme|disk/i.test(text)) return '💾';
  if (/network|ethernet|nic/i.test(text)) return '🌐';
  if (/voltage/i.test(text)) return '🔋';
  if (/motherboard|mainboard/i.test(text)) return '🖥';
  return '◈';
}

/* =====================================================================
   BOOT
   ===================================================================== */
(async () => {
  await loadDashboardConfig();
  fetchData();
  setInterval(fetchData, POLL_INTERVAL);
})();