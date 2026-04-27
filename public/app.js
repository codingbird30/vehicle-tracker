// =====================================================
// Vehicle Entry Tracker — frontend
// =====================================================

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ----- Theme -----
function initTheme() {
  const saved = localStorage.getItem('vet-theme') || 'dark';
  document.body.setAttribute('data-theme', saved);
}
function toggleTheme() {
  const current = document.body.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', next);
  localStorage.setItem('vet-theme', next);
}
initTheme();
$('#themeToggle').addEventListener('click', toggleTheme);

// ----- Clock -----
function tickClock() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  $('#clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
setInterval(tickClock, 1000); tickClock();

// ----- Config -----
let CONFIG = { esp32StreamUrl: null, ocrSource: 'tesseract' };

async function loadConfig() {
  try {
    CONFIG = await fetch('/api/config').then((r) => r.json());
    $('#ocrSourceLabel').textContent = CONFIG.ocrSource || 'tesseract';
    if (CONFIG.esp32StreamUrl) {
      const img = $('#liveFeed');
      img.src = CONFIG.esp32StreamUrl;
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
  } catch (e) { console.error('config error', e); }
}

async function loadStats() {
  try {
    const s = await fetch('/api/stats').then((r) => r.json());
    $('#statTotal').textContent = s.total;
    $('#statAuth').textContent = s.authorized;
    $('#statUnauth').textContent = s.unauthorized;
    $('#dbStatus').classList.add('ok');
    $('#dbStatus').classList.remove('bad');
  } catch { $('#dbStatus').classList.add('bad'); }
}

async function loadHistory() {
  try {
    const list = await fetch('/api/vehicles?limit=30').then((r) => r.json());
    const tbody = $('#logBody');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="log-empty">No records yet</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((v) => {
      const t = v.detectedAt || v.createdAt;
      let date = '—', time = '—';
      try {
        const dt = new Date(t);
        if (!isNaN(dt.getTime())) {
          date = dt.toISOString().split('T')[0];
          time = `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}:${String(dt.getSeconds()).padStart(2,'0')}`;
        }
      } catch {}
      const reg = safeDate(v.registrationDate);
      const veh = [v.manufacturer, v.model].filter(Boolean).join(' ') || '—';
      const thumb = v.capturedImagePath
        ? `<img class="log-thumb" src="${v.capturedImagePath}" data-full="${v.capturedImagePath}" data-plate="${escapeHtml(v.plateNumber)}" alt="snapshot" />`
        : '<span class="log-no-thumb">—</span>';
      return `
        <tr>
          <td class="log-time">${date}<br/>${time}</td>
          <td>${thumb}</td>
          <td><span class="log-plate">${escapeHtml(v.plateNumber)}</span></td>
          <td><span class="log-status ${v.isAuthorized ? 'ok' : 'bad'}">${v.isAuthorized ? 'Authorized' : 'Not Authorized'}</span></td>
          <td>${escapeHtml(v.ownerName || '—')}</td>
          <td>${escapeHtml(veh)}</td>
          <td>${reg}</td>
          <td>${escapeHtml(v.reason || '—')}</td>
        </tr>
      `;
    }).join('');

    // attach modal listeners
    $$('.log-thumb').forEach((img) => {
      img.addEventListener('click', () => openModal(img.dataset.full, img.dataset.plate));
    });
  } catch (e) { console.error('history error', e); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ----- Bounding box overlay (green boxes on live feed when text detected) -----
const BBOX_FADE_MS = 1500;
let bboxClearTimer = null;

function drawBoxes(payload) {
  const overlay = $('#bboxOverlay');
  if (!overlay) return;
  const imgW = payload.imageWidth || 800;
  const imgH = payload.imageHeight || 600;
  // Set viewBox to match the detected image so coords map directly
  overlay.setAttribute('viewBox', `0 0 ${imgW} ${imgH}`);
  overlay.innerHTML = '';

  const ns = 'http://www.w3.org/2000/svg';

  // Draw all individual text detections in thin green
  for (const det of (payload.allDetections || [])) {
    if (!det.bbox) continue;
    const [x1, y1, x2, y2] = det.bbox;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('class', 'detection');
    rect.setAttribute('x', x1);
    rect.setAttribute('y', y1);
    rect.setAttribute('width', x2 - x1);
    rect.setAttribute('height', y2 - y1);
    overlay.appendChild(rect);
  }

  // If a plate was detected, draw its box thicker + with the plate text label
  const plateText = payload.vehicle?.plateNumber || payload.ocr?.plateNumber || payload.ocrText;
  if (payload.bbox && plateText) {
    const [x1, y1, x2, y2] = payload.bbox;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('class', 'plate');
    rect.setAttribute('x', x1);
    rect.setAttribute('y', y1);
    rect.setAttribute('width', x2 - x1);
    rect.setAttribute('height', y2 - y1);
    overlay.appendChild(rect);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('class', 'label');
    label.setAttribute('x', x1);
    label.setAttribute('y', Math.max(y1 - 6, 14));
    label.textContent = plateText;
    overlay.appendChild(label);
  }

  // Clear after a short delay so boxes don't linger forever
  if (bboxClearTimer) clearTimeout(bboxClearTimer);
  bboxClearTimer = setTimeout(() => {
    overlay.innerHTML = '';
  }, BBOX_FADE_MS);
}

function clearBoxes() {
  const overlay = $('#bboxOverlay');
  if (overlay) overlay.innerHTML = '';
  if (bboxClearTimer) { clearTimeout(bboxClearTimer); bboxClearTimer = null; }
}

// ----- Modal -----
function openModal(src, plate) {
  $('#modalImage').src = src;
  $('#modalTitle').textContent = plate || 'Snapshot';
  $('#modalMeta').textContent = src;
  $('#snapshotModal').hidden = false;
}
function closeModal() { $('#snapshotModal').hidden = true; }
$$('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function safeTime(value) {
  if (!value) return '—';
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString();
  } catch { return '—'; }
}

function safeDate(value) {
  if (!value) return '—';
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toISOString().split('T')[0];
  } catch { return '—'; }
}

// ----- Render scan result -----
function renderLoading(plateNumber, opts = {}) {
  const body = $('#resultBody');
  const meta = $('#resultMeta');
  meta.textContent = opts.label || 'looking up...';
  body.innerHTML = `
    <div class="result-card">
      ${plateNumber ? `<div class="plate-display">${escapeHtml(plateNumber)}</div>` : ''}
      <div class="loading-state">
        <div class="loading-spinner" aria-hidden="true"></div>
        <p class="loading-title">${escapeHtml(opts.title || 'Looking up RTO records')}</p>
        <p class="loading-sub" id="loadingSub">${escapeHtml(opts.sub || 'Verifying vehicle authorization...')}</p>
      </div>
    </div>
  `;
}
function renderResult(result, opts = {}) {
  const body = $('#resultBody');
  const meta = $('#resultMeta');
  const attemptedPlate = opts.attemptedPlate || result.ocr?.plateNumber || result.vehicle?.plateNumber || null;

  if (!result.success) {
    meta.textContent = result.stage === 'dedup' ? 'duplicate (skipped)' : `failed @ ${result.stage || 'unknown'}`;

    // Build detail rows showing what PaddleOCR actually saw
    let ocrDetail = '';
    if (result.ocr) {
      const detections = result.ocr.allDetections || result.allDetections || [];
      if (detections.length > 0) {
        const items = detections.slice(0, 6).map(d =>
          `<li><code class="mono">${escapeHtml(d.text)}</code> <span style="color:var(--ink-mute)">${Math.round(d.confidence || 0)}%</span></li>`
        ).join('');
        ocrDetail = `
          <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line);">
            <p style="font-size: 11px; color: var(--ink-mute); margin-bottom: 6px;">PaddleOCR saw ${detections.length} text region${detections.length !== 1 ? 's' : ''}:</p>
            <ul style="list-style: none; padding-left: 0; font-size: 12px;">${items}</ul>
            <p style="font-size: 10px; color: var(--ink-mute); margin-top: 8px; line-height: 1.4;">None matched the plate format <code class="mono">XX00XX0000</code>. Check image quality, lighting, and angle.</p>
          </div>
        `;
      } else if (result.ocr.candidates?.length || result.ocr.plateNumber) {
        const txt = (result.ocr.candidates || []).join(', ') || result.ocr.plateNumber;
        ocrDetail = `<p style="color: var(--ink-mute); font-size: 11px; margin-top: 10px;">OCR text: <code class="mono">${escapeHtml(txt)}</code></p>`;
      }
    }

    body.innerHTML = `
      <div class="result-card">
        ${attemptedPlate ? `<div class="plate-display">${escapeHtml(attemptedPlate)}</div>` : ''}
        <div class="verdict unauthorized">
          <span class="verdict-icon">✕</span>
          <span>${result.stage === 'dedup' ? 'Skipped (duplicate)' : 'Scan failed'}</span>
        </div>
        <p style="color: var(--ink-dim); font-size: 12px;">${escapeHtml(result.message || result.error || 'Unknown error')}</p>
        ${ocrDetail}
      </div>
    `;
    return;
  }

  const v = result.vehicle;
  meta.textContent = safeTime(v.createdAt);
  const reg = safeDate(v.registrationDate);
  const veh = [v.manufacturer, v.model].filter(Boolean).join(' ') || '—';
  const insurance = v.insuranceCompany
    ? `${v.insuranceCompany}${v.insuranceUpto ? ' (until ' + safeDate(v.insuranceUpto) + ')' : ''}`
    : '—';

  body.innerHTML = `
    <div class="result-card">
      <div class="plate-display">${escapeHtml(v.plateNumber)}</div>
      <div class="verdict ${v.isAuthorized ? 'authorized' : 'unauthorized'}">
        <span class="verdict-icon">${v.isAuthorized ? '✓' : '✕'}</span>
        <span>${v.isAuthorized ? 'Vehicle is authorized' : 'Vehicle is not authorized'}</span>
      </div>
      <dl class="detail-grid">
        <dt>Owner</dt><dd>${escapeHtml(v.ownerName || '—')}</dd>
        <dt>Vehicle</dt><dd>${escapeHtml(veh)}</dd>
        <dt>Fuel</dt><dd>${escapeHtml(v.fuelType || '—')}</dd>
        <dt>Reg. date</dt><dd>${reg}</dd>
        <dt>RTO</dt><dd>${escapeHtml(v.rtoLocation || '—')}</dd>
        <dt>Address</dt><dd>${escapeHtml(v.permanentAddress || '—')}</dd>
        <dt>Insurance</dt><dd>${escapeHtml(insurance)}</dd>
        ${v.reason ? `<dt>Reason</dt><dd style="color: var(--red);">${escapeHtml(v.reason)}</dd>` : ''}
        <dt>OCR</dt><dd>${escapeHtml(v.ocrSource || '—')} · ${Math.round(v.ocrConfidence || 0)}%</dd>
      </dl>
      ${v.capturedImagePath ? `<img class="result-thumb" src="${v.capturedImagePath}" data-full="${v.capturedImagePath}" data-plate="${escapeHtml(v.plateNumber)}" alt="snapshot" />` : ''}
    </div>
  `;

  const resultThumb = body.querySelector('.result-thumb');
  if (resultThumb) {
    resultThumb.addEventListener('click', () => openModal(resultThumb.dataset.full, resultThumb.dataset.plate));
  }
}

// ----- Scan actions -----
async function triggerScan() {
  const btn = $('#btnTriggerScan');
  btn.disabled = true;
  $('#footStatus').textContent = 'capturing snapshot...';
  renderLoading(null, { title: 'Capturing snapshot', sub: 'Reading from ESP32-CAM...' });
  try {
    const result = await fetch('/api/trigger-scan', { method: 'POST' }).then((r) => r.json());
    renderResult(result);
    await Promise.all([loadStats(), loadHistory()]);
    $('#footStatus').textContent = result.success ? `scan ok · ${result.vehicle.plateNumber}` : `failed · ${result.message || result.error}`;
  } catch (e) {
    $('#footStatus').textContent = `error · ${e.message}`;
    renderResult({ success: false, stage: 'network', message: e.message });
  } finally {
    btn.disabled = false;
  }
}

async function uploadScan(file) {
  const btn = $('#btnUploadScan');
  btn.disabled = true;
  $('#footStatus').textContent = 'processing upload...';
  renderLoading(null, { title: 'Processing image', sub: 'Running OCR & RTO lookup...' });
  try {
    const fd = new FormData();
    fd.append('image', file);
    const result = await fetch('/api/scan', { method: 'POST', body: fd }).then((r) => r.json());
    renderResult(result);
    await Promise.all([loadStats(), loadHistory()]);
    $('#footStatus').textContent = result.success ? `upload ok · ${result.vehicle.plateNumber}` : `failed · ${result.message || result.error}`;
  } catch (e) {
    $('#footStatus').textContent = `error · ${e.message}`;
    renderResult({ success: false, stage: 'network', message: e.message });
  } finally {
    btn.disabled = false;
  }
}

async function manualAlert(state) {
  $('#footStatus').textContent = `alert -> ${state}`;
  try {
    await fetch('/api/alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
  } catch (e) {
    $('#footStatus').textContent = `alert failed: ${e.message}`;
  }
}

async function checkPlate() {
  const input = $('#manualPlateInput');
  const btn = $('#btnCheckPlate');
  const raw = (input.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) {
    input.focus();
    $('#footStatus').textContent = 'enter a plate number first';
    return;
  }

  btn.disabled = true;
  $('#footStatus').textContent = `checking ${raw}...`;
  renderLoading(raw, { sub: 'Calling RTO database (up to 3 retries)...' });
  try {
    const result = await fetch('/api/check-plate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plateNumber: raw }),
    }).then((r) => r.json());

    renderResult(result, { attemptedPlate: raw });
    await Promise.all([loadStats(), loadHistory()]);
    if (result.success) {
      $('#footStatus').textContent = `manual · ${result.vehicle.plateNumber} · ${result.vehicle.isAuthorized ? 'authorized' : 'Not Authorized'}`;
      input.value = '';
    } else {
      $('#footStatus').textContent = `failed · ${result.message || result.error}`;
    }
  } catch (e) {
    $('#footStatus').textContent = `network error · ${e.message}`;
    renderResult(
      { success: false, stage: 'network', message: `Could not reach the server: ${e.message}` },
      { attemptedPlate: raw }
    );
  } finally {
    btn.disabled = false;
  }
}

// ----- Auto-scan loop -----
const AUTO_SCAN_INTERVAL_MS = 1500;
const AUTO_SCAN_MAX_CONSECUTIVE_FAILURES = 5;
let autoScanTimer = null;
let autoScanInFlight = false;
let consecutiveFailures = 0;

async function autoScanTick() {
  if (autoScanInFlight) return;
  autoScanInFlight = true;
  $('#scanIndicator').classList.add('visible');
  $('#autoScanPill').classList.add('scanning');

  try {
    const result = await fetch('/api/auto-scan', { method: 'POST' }).then((r) => r.json());

    // Draw bounding boxes for ANY result that has detection info (whether or not a plate matched)
    if (result.allDetections || result.bbox) {
      drawBoxes(result);
    }

    if (result.skip) {
      // silent skip — nothing happened (no plate detected, or duplicate, or camera offline)
      if (result.reason === 'camera_unreachable') {
        consecutiveFailures++;
        if (consecutiveFailures >= AUTO_SCAN_MAX_CONSECUTIVE_FAILURES) {
          $('#footStatus').textContent = `auto-scan paused — camera offline (toggle off to silence)`;
          stopAutoScan();
          $('#autoScanToggle').checked = false;
        } else {
          $('#footStatus').textContent = `camera unreachable (${consecutiveFailures}/${AUTO_SCAN_MAX_CONSECUTIVE_FAILURES})`;
        }
      } else if (result.reason === 'ocr_unreachable') {
        $('#footStatus').textContent = 'OCR service offline — start python-ocr';
      } else if (result.reason === 'recent_duplicate') {
        consecutiveFailures = 0;
        $('#footStatus').textContent = `seen recently · ${result.plateNumber}`;
      }
      return;
    }

    consecutiveFailures = 0; // any non-skip response means camera + OCR are both reachable

    if (result.detected === false) {
      // OCR ran but nothing plausible
      if (result.ocrText) {
        $('#footStatus').textContent = `no plate · "${result.ocrText}"`;
      } else if (result.allDetections?.length) {
        $('#footStatus').textContent = `${result.allDetections.length} text region(s) — no plate`;
      } else {
        $('#footStatus').textContent = 'no plate detected';
      }
      return;
    }

    // Detected!
    renderResult(result);
    await Promise.all([loadStats(), loadHistory()]);
    $('#footStatus').textContent = `auto · ${result.vehicle.plateNumber} · ${result.vehicle.isAuthorized ? 'authorized' : 'Not Authorized'}`;
  } catch (e) {
    consecutiveFailures++;
    $('#footStatus').textContent = `auto-scan error · ${e.message}`;
  } finally {
    autoScanInFlight = false;
    $('#scanIndicator').classList.remove('visible');
    $('#autoScanPill').classList.remove('scanning');
  }
}

function startAutoScan() {
  if (autoScanTimer) return;
  consecutiveFailures = 0;
  $('#autoScanPill').classList.add('ok');
  $('#footStatus').textContent = 'auto-scan started';
  autoScanTimer = setInterval(autoScanTick, AUTO_SCAN_INTERVAL_MS);
  autoScanTick(); // first tick immediately
}

function stopAutoScan() {
  if (autoScanTimer) clearInterval(autoScanTimer);
  autoScanTimer = null;
  $('#autoScanPill').classList.remove('ok');
  $('#footStatus').textContent = 'auto-scan stopped';
}

$('#autoScanToggle').addEventListener('change', (e) => {
  if (e.target.checked) startAutoScan();
  else stopAutoScan();
});

// ----- Wire up -----
$('#btnTriggerScan').addEventListener('click', triggerScan);
$('#btnUploadScan').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => { if (e.target.files[0]) uploadScan(e.target.files[0]); });
$('#btnRefresh').addEventListener('click', () => { loadStats(); loadHistory(); });
$$('.alert-btn').forEach((btn) => btn.addEventListener('click', () => manualAlert(btn.dataset.state)));
$('#btnCheckPlate').addEventListener('click', checkPlate);
$('#manualPlateInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); checkPlate(); }
});

// ----- Init -----
(async () => {
  await loadConfig();
  await loadStats();
  await loadHistory();
  // Start auto-scan only if camera is configured
  if (CONFIG.esp32StreamUrl) {
    startAutoScan();
  } else {
    $('#autoScanToggle').checked = false;
    $('#footStatus').textContent = 'camera not configured — auto-scan disabled';
  }
})();

setInterval(loadStats, 20000); // soft refresh
