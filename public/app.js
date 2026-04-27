// =====================================================
// SENTINEL — frontend logic
// =====================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ----- Clock -----
function tickClock() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  $('#clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
setInterval(tickClock, 1000);
tickClock();

// ----- Bootstrap config + status -----
async function loadConfig() {
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    if (cfg.esp32StreamUrl) {
      const img = $('#liveFeed');
      img.src = cfg.esp32StreamUrl;
      img.onload = () => {
        img.classList.add('visible');
        $('#feedPlaceholder').style.display = 'none';
        $('#feedMeta').textContent = '— streaming —';
        $('#camStatus').classList.add('ok');
        $('#camStatus').classList.remove('bad');
      };
      img.onerror = () => {
        $('#feedMeta').textContent = '— camera unreachable —';
        $('#camStatus').classList.add('bad');
      };
    } else {
      $('#feedMeta').textContent = '— not configured —';
    }
  } catch (e) {
    console.error('config error', e);
  }
}

async function loadStats() {
  try {
    const s = await fetch('/api/stats').then((r) => r.json());
    $('#statTotal').textContent = s.total;
    $('#statAuth').textContent = s.authorized;
    $('#statUnauth').textContent = s.unauthorized;
    $('#dbStatus').classList.add('ok');
    $('#dbStatus').classList.remove('bad');
  } catch {
    $('#dbStatus').classList.add('bad');
  }
}

async function loadHistory() {
  try {
    const list = await fetch('/api/vehicles?limit=30').then((r) => r.json());
    const tbody = $('#logBody');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="log-empty">— no records —</td></tr>';
      return;
    }
    tbody.innerHTML = list
      .map((v) => {
        const t = new Date(v.detectedAt || v.createdAt);
        const time = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
        const date = t.toISOString().split('T')[0];
        const reg = v.registrationDate ? new Date(v.registrationDate).toISOString().split('T')[0] : '—';
        const veh = [v.manufacturer, v.model].filter(Boolean).join(' ') || '—';
        return `
          <tr>
            <td>${date}<br/>${time}</td>
            <td><span class="log-plate">${v.plateNumber}</span></td>
            <td><span class="log-status ${v.isAuthorized ? 'ok' : 'bad'}">${v.isAuthorized ? 'AUTHORIZED' : 'DENIED'}</span></td>
            <td>${v.ownerName || '—'}</td>
            <td>${veh}</td>
            <td>${reg}</td>
            <td>${v.reason || '—'}</td>
          </tr>
        `;
      })
      .join('');
  } catch (e) {
    console.error('history error', e);
  }
}

// ----- Render scan result -----
function renderResult(result) {
  const body = $('#resultBody');
  const meta = $('#resultMeta');

  if (!result.success) {
    meta.textContent = `failed @ ${result.stage || 'unknown'}`;
    body.innerHTML = `
      <div class="result-card">
        <div class="verdict unauthorized">
          <span class="verdict-icon">✕</span>
          <span>SCAN FAILED</span>
        </div>
        <p style="color: var(--ink-dim); font-size: 12px;">
          ${result.message || 'Unknown error'}
        </p>
        ${result.ocr ? `
          <p style="color: var(--ink-mute); font-size: 11px; margin-top: 12px;">
            OCR raw: <code>${(result.ocr.cleanedText || '').slice(0, 40) || '(empty)'}</code>
          </p>
        ` : ''}
      </div>
    `;
    return;
  }

  const v = result.vehicle;
  meta.textContent = new Date(v.createdAt).toLocaleTimeString();

  const reg = v.registrationDate
    ? new Date(v.registrationDate).toISOString().split('T')[0]
    : '—';
  const veh = [v.manufacturer, v.model].filter(Boolean).join(' ') || '—';

  body.innerHTML = `
    <div class="result-card">
      <div class="plate-display">${v.plateNumber}</div>
      <div class="verdict ${v.isAuthorized ? 'authorized' : 'unauthorized'}">
        <span class="verdict-icon">${v.isAuthorized ? '✓' : '✕'}</span>
        <span>${v.isAuthorized ? 'ACCESS GRANTED' : 'ACCESS DENIED'}</span>
      </div>
      <dl class="detail-grid">
        <dt>owner</dt><dd>${v.ownerName || '—'}</dd>
        <dt>vehicle</dt><dd>${veh}</dd>
        <dt>fuel</dt><dd>${v.fuelType || '—'}</dd>
        <dt>reg. date</dt><dd>${reg}</dd>
        <dt>rto</dt><dd>${v.rtoLocation || '—'}</dd>
        <dt>address</dt><dd>${v.address || '—'}</dd>
        ${v.reason ? `<dt>reason</dt><dd style="color: var(--red);">${v.reason}</dd>` : ''}
        <dt>confidence</dt><dd>${result.ocr?.confidence?.toFixed(1) || '—'}%</dd>
      </dl>
    </div>
  `;
}

// ----- Actions -----
async function triggerScan() {
  const btn = $('#btnTriggerScan');
  btn.disabled = true;
  btn.textContent = '◐ SCANNING...';
  $('#footStatus').textContent = 'capturing snapshot from esp32-cam...';
  try {
    const result = await fetch('/api/trigger-scan', { method: 'POST' }).then((r) => r.json());
    renderResult(result);
    await Promise.all([loadStats(), loadHistory()]);
    $('#footStatus').textContent = result.success
      ? `scan ok · ${result.vehicle.plateNumber}`
      : `scan failed · ${result.message || result.error}`;
  } catch (e) {
    $('#footStatus').textContent = `scan error · ${e.message}`;
    renderResult({ success: false, stage: 'network', message: e.message });
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ TRIGGER SCAN';
  }
}

async function uploadScan(file) {
  const btn = $('#btnUploadScan');
  btn.disabled = true;
  btn.textContent = '◐ UPLOADING...';
  $('#footStatus').textContent = 'processing upload...';
  try {
    const fd = new FormData();
    fd.append('image', file);
    const result = await fetch('/api/scan', { method: 'POST', body: fd }).then((r) => r.json());
    renderResult(result);
    await Promise.all([loadStats(), loadHistory()]);
    $('#footStatus').textContent = result.success
      ? `upload ok · ${result.vehicle.plateNumber}`
      : `upload failed · ${result.message || result.error}`;
  } catch (e) {
    $('#footStatus').textContent = `upload error · ${e.message}`;
    renderResult({ success: false, stage: 'network', message: e.message });
  } finally {
    btn.disabled = false;
    btn.textContent = '⇪ UPLOAD IMAGE';
  }
}

async function manualAlert(state) {
  $('#footStatus').textContent = `alert -> ${state}`;
  await fetch('/api/alert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
}

// ----- Wire up -----
$('#btnTriggerScan').addEventListener('click', triggerScan);
$('#btnUploadScan').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  if (e.target.files[0]) uploadScan(e.target.files[0]);
});
$('#btnRefresh').addEventListener('click', () => {
  loadStats();
  loadHistory();
});
$$('.alert-btn').forEach((btn) =>
  btn.addEventListener('click', () => manualAlert(btn.dataset.state))
);

// ----- Init -----
loadConfig();
loadStats();
loadHistory();
setInterval(loadStats, 15000); // soft refresh
