/* =====================================================================
   CONFIG
   ===================================================================== */
const API_URL       = 'http://192.168.2.99:8085/data.json';
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
      id:    node.id || myPath.join('/'),
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
            s.unit = 'MB/s';
        }
    });
}

/* =====================================================================
   STATUS
   ===================================================================== */
function setStatus(ok, msg) {
  document.getElementById('status-dot').className  = 'dot' + (ok?'':' error');
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
/* map class names to KPI card class */
function toCardClass(cls) {
  if (cls === 'crit') return 'danger';
  if (cls === 'hot')  return 'warn';
  if (cls === 'ok')   return 'ok';
  return '';
}

/* =====================================================================
   KPI DEFINITIONS  (order matters — first match wins)
   ===================================================================== */
const KPI_DEFS = [
  { key:'cpu-power', kpiLabel:'CPU POWER',  unit:'W',   re:/package.*power|cpu.*power|processor.*power|package/i },
  { key:'gpu-power', kpiLabel:'GPU POWER',  unit:'W',   re:/gpu.*power|GPU Package/i },
  { key:'fan', kpiLabel:'CPU FANS',    unit:'RPM', re:/Fan #1/i },
  { key:'pump', kpiLabel:'PUMP',    unit:'RPM', re:/Fan #5/i },
  { key:'disk-used',  kpiLabel:'SPACE USED',   unit:'%',   re:/Used Space/i },
  { key:'disk-read',  kpiLabel:'DISK READ',   unit:'%',   re:/Read Activity/i },
  { key:'disk-write', kpiLabel:'DISK WRITE',  unit:'%',   re:/Write Activity/i },
  { key:'disk-temp',  kpiLabel:'DISK TEMP',   unit:'°C',  re:/Disk Temperature/i },
  { key:'disk-spare',  kpiLabel:'DISK SPARE AVAILABLE',   unit:'%',   re:/Available Spare/i },
  { key:'net-down', kpiLabel:'NETWORK DOWNLOAD',    unit:'MB/s', re:/Download Speed 1/i },
  { key:'net-up', kpiLabel:'NETWORK UPLOAD',    unit:'MB/s', re:/Upload Speed 1/i },
];

function matchSensor(def) {
  return allSensors.find(s => {
    if (s.unit !== def.unit){
        console.log(def)
        return false;
    } 
    if (!def.re.test(s.label)) return false;
    if (def.notRe && def.notRe.test(s.label)) return false;
    return true;
  });
}

/* =====================================================================
   RENDER ALL
   ===================================================================== */
function renderAll() {
  //renderSidebar();
  if (firstRender) {
    firstRender = false;
    renderKPIs();
    renderCharts();
    renderSensorTable();
    expandAllGroups();
  } else {
    updateKPIs();
    updateCharts();
    updateSensorTableValues();
  }
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
   KPI CARDS
   ===================================================================== */
function renderKPIs() {
  const matches = KPI_DEFS.map(def => ({ def, sensor: matchSensor(def) })).filter(x => x.sensor);
  if (!matches.length) {
    document.getElementById('kpi-container').innerHTML =
      `<div class="error-box">⚠ Could not connect to Libre Hardware Monitor at ${API_URL}<br><br>
       Make sure LHM is running and the web server is enabled:<br>
       Options → Web Server → Run → Port 8085</div>`;
    return;
  }

  let html = '<div class="kpi-grid">';
  matches.forEach(({ def, sensor: s }) => {
    const cls   = toCardClass(sensorClass(s));
    const pct   = s.unit === '%' ? s.value : null;
    const disp  = s.value !== null ? s.value.toFixed(s.unit==='MHz'||s.unit==='RPM'||s.unit==='GB'||s.unit==='KB/s'||s.unit==='MB/s'?0:1) : '—';
    html += `<div class="kpi-card ${cls}" data-kpi="${def.key}">
      <div class="kpi-label">${def.kpiLabel}</div>
      <div><span class="kpi-value">${disp}</span><span class="kpi-unit">${s.unit}</span></div>
      ${pct!==null ? `<div class="kpi-bar"><div class="kpi-bar-fill" style="width:${Math.min(pct,100).toFixed(1)}%"></div></div>` : ''}
    </div>`;
  });
  html += '</div>';
  document.getElementById('kpi-container').innerHTML = html;
}

function updateKPIs() {
  KPI_DEFS.forEach(def => {
    const s    = matchSensor(def);
    const card = document.querySelector(`.kpi-card[data-kpi="${def.key}"]`);
    if (!s || !card) return;
    const cls  = toCardClass(sensorClass(s));
    card.className = `kpi-card ${cls}`;
    const disp = s.value !== null ? s.value.toFixed(s.unit==='MHz'||s.unit==='RPM'||s.unit==='GB'||s.unit==='KB/s'||s.unit==='MB/s'?0:1) : '—';
    card.querySelector('.kpi-value').textContent = disp;
    const bar = card.querySelector('.kpi-bar-fill');
    if (bar && s.unit === '%') bar.style.width = Math.min(s.value,100).toFixed(1) + '%';
  });
}

/* =====================================================================
   CHARTS
   ===================================================================== */
const CHART_DEFS = [
  { key:'cpu-load',  label:'CPU LOAD',  unit:'%',   color:'#00d4ff', re:/CPU Total|cpu package.*load/i, notRe:/core/i, yMax:100 },
  { key:'cpu-temp',  label:'CPU TEMP',  unit:'°C',  color:'#39ff14', re:/cpu package|CoreTctlTdie/i, yMax:110 },
  { key:'cpu-mem',  label:'CPU MEM',  unit:'%',  color:'#9f00ff', re:/memory.*load|used memory.*%|ram.*load|memory/i, yMax:100 },
  { key:'gpu-load',  label:'GPU LOAD',  unit:'%',   color:'#00d4ff', re:/gpu.*core|gpu usage/i, yMax:100 },
  { key:'gpu-temp',  label:'GPU TEMP',  unit:'°C',  color:'#39ff14', re:/gpu.*core|gpu temp/i, yMax:110 },
  { key:'gpu-mem',  label:'GPU MEM',  unit:'%',  color:'#ff00b7', re:/GPU Memory/i, yMax:100 },
  { key:'mem-load',  label:'RAM LOAD',  unit:'%',   color:'#c084fc', re:/memory.*load|used memory.*%/i, yMax:100 },
];

function findChartSensor(cd) {
  return allSensors.find(s => {
    if (s.unit !== cd.unit) return false;
    if (!cd.re.test(s.label)) return false;
    if (cd.notRe && cd.notRe.test(s.label)) return false;
    return true;
  });
}

function renderCharts() {
  const targets = CHART_DEFS.map(cd => ({ ...cd, sensor: findChartSensor(cd) })).filter(x => x.sensor);
  if (!targets.length) { document.getElementById('charts-container').innerHTML = ''; return; }

  let html = `<!-- <div class="section-header">
    <span class="section-title">Live Graphs</span><div class="section-line"></div>
  </div>--><div class="charts-grid">`;

  targets.forEach(t => {
    const h    = sensorHistory[t.sensor.id];
    const last = h && h.values.length ? h.values[h.values.length-1].v : t.sensor.value;
    html += `<div class="chart-card">
      <div class="chart-title">
        <span>${t.label}</span>
        <span class="chart-current" id="chart-cur-${t.key}">${last!==null?last.toFixed(1):'—'} ${t.sensor.unit}</span>
      </div>
      <div class="chart-wrap"><canvas id="chart-${t.key}"></canvas></div>
    </div>`;
  });
  html += '</div>';
  document.getElementById('charts-container').innerHTML = html;

  targets.forEach(t => {
    const h   = sensorHistory[t.sensor.id];
    const pts = h ? h.values : [{ t: Date.now(), v: t.sensor.value }];
    buildChart(t.key, pts, t.color, t.sensor.unit, t.yMax);
  });
}

function buildChart(key, pts, color, unit, yMax) {
  const ctx = document.getElementById(`chart-${key}`);
  if (!ctx) return;
  if (chartInstances[key]) chartInstances[key].destroy();

  chartInstances[key] = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels:   pts.map(p => new Date(p.t).toLocaleTimeString()),
      datasets: [{ data: pts.map(p=>p.v), borderColor: color, backgroundColor: color+'18',
                   borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode:'nearest', axis:'x', intersect:false },
      plugins: {
        legend: { display:false },
        tooltip: {
          callbacks: { label: c => `${c.parsed.y.toFixed(1)} ${unit}` },
          backgroundColor:'#0d1218', borderColor:color, borderWidth:1,
          titleColor:'#4a6070', bodyColor:color,
          titleFont:{ family:'Share Tech Mono', size:10 },
          bodyFont:{ family:'Share Tech Mono', size:11 }
        }
      },
      scales: {
        x: { display: false },
        y: {
          min: 0, max: yMax,
          grid: { color:'#1a2535' },
          border: { color:'#1a2535' },
          ticks: { color:'#4a6070', font:{ family:'Share Tech Mono', size:9 }, maxTicksLimit:4 }
        }
      }
    }
  });
}

function updateCharts() {
  CHART_DEFS.forEach(cd => {
    const s    = findChartSensor(cd);
    const inst = chartInstances[cd.key];
    const cur  = document.getElementById(`chart-cur-${cd.key}`);
    if (!s || !inst) return;
    const h   = sensorHistory[s.id];
    if (!h)   return;
    inst.data.labels              = h.values.map(p => new Date(p.t).toLocaleTimeString());
    inst.data.datasets[0].data    = h.values.map(p => p.v);
    inst.update('none');
    if (cur && h.values.length) {
      const last = h.values[h.values.length-1].v;
      cur.textContent = `${last.toFixed(1)} ${s.unit}`;
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
      <thead><tr><th>NAME</th><th>PATH</th><th>VALUE</th><th>MIN</th><th>MAX</th></tr></thead>
      <tbody>`;

    group.forEach(s => {
      const cls  = sensorClass(s);
      const disp = s.value!==null ? s.value.toFixed(s.unit==='MHz'||s.unit==='RPM'||s.unit==='KB/s'||s.unit==='MB/s'?0:1)+' '+s.unit : '—';
      const pct  = s.unit==='%' ? s.value : null;
      const minD = s.min!==null ? s.min.toFixed(1) : '—';
      const maxD = s.max!==null ? s.max.toFixed(1) : '—';
      const bar  = pct!==null ? `<span class="mini-bar"><span class="mini-bar-fill ${cls}" style="width:${Math.min(pct,100).toFixed(1)}%"></span></span>` : '';
      const pathStr = s.path.slice(1,-1).join(' › ');

      html += `<tr data-sid="${s.id}">
        <td>${s.label}</td>
        <td style="color:var(--muted);font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${pathStr}">${pathStr}</td>
        <td class="val-cell ${cls}">${disp}${bar}</td>
        <td style="font-family:var(--font-mono);font-size:11px;color:var(--muted)">${minD}</td>
        <td style="font-family:var(--font-mono);font-size:11px;color:var(--muted)">${maxD}</td>
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
    const disp = s.value!==null ? s.value.toFixed(s.unit==='MHz'||s.unit==='RPM'||s.unit==='KB/s'||s.unit==='MB/s'?0:1)+' '+s.unit : '—';
    const pct  = s.unit==='%' ? s.value : null;
    const bar  = pct!==null ? `<span class="mini-bar"><span class="mini-bar-fill ${cls}" style="width:${Math.min(pct,100).toFixed(1)}%"></span></span>` : '';
    const cell = row.querySelector('.val-cell');
    if (cell) { cell.className=`val-cell ${cls}`; cell.innerHTML=disp+bar; }
  });
}

function expandAllGroups() {
  document.querySelectorAll('.group-body').forEach(b => {
    b.style.maxHeight = b.scrollHeight + 'px';
  });
}

function toggleGroup(id) {
  const body = document.getElementById(id);
  const btn  = body.previousElementSibling;
  const open = body.style.maxHeight && body.style.maxHeight !== '0px';
  body.style.maxHeight = open ? '0px' : body.scrollHeight + 'px';
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
   BOOT
   ===================================================================== */
fetchData();
setInterval(fetchData, POLL_INTERVAL);