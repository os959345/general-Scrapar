const btnSelect        = document.getElementById('btn-select');
const btnScrape        = document.getElementById('btn-scrape');
const btnClear         = document.getElementById('btn-clear');
const btnExportCsv     = document.getElementById('btn-export-csv');
const btnExportJson    = document.getElementById('btn-export-json');
const btnExportXlsx    = document.getElementById('btn-export-xlsx');
const templateSelect   = document.getElementById('template-select');
const btnTemplateLoad  = document.getElementById('btn-template-load');
const btnTemplateSave  = document.getElementById('btn-template-save');
const btnScrollScrape  = document.getElementById('btn-scroll-scrape');
const btnPaginate      = document.getElementById('btn-paginate');
const btnStopScroll    = document.getElementById('btn-stop-scroll');
const progressPanel    = document.getElementById('progress-panel');
const progressBar      = document.getElementById('progress-bar');
const progressLabel    = document.getElementById('progress-label');
const btnPause         = document.getElementById('btn-pause');
const btnResume        = document.getElementById('btn-resume');
const fieldsList       = document.getElementById('fields-list');
const statusText       = document.getElementById('status-text');
const statusDot        = document.querySelector('.status-dot');
const connBadge        = document.getElementById('conn-badge');
const resultsSection   = document.getElementById('results-section');
const resultsCount     = document.getElementById('results-count');
const previewTableWrap = document.getElementById('preview-table-wrap');
const previewTable     = document.getElementById('preview-table');
const autoDetectPanel  = document.getElementById('auto-detect-panel');
const autoDetectFields = document.getElementById('auto-detect-fields');
const autoDetectCount  = document.getElementById('auto-detect-count');
const btnAutoApply     = document.getElementById('btn-auto-apply');
const btnAutoDismiss   = document.getElementById('btn-auto-dismiss');

let fields = [];
let isSelecting = false;
let activeTabId = null;
let lastScrapedData = [];
// columnMap: original key → display name (for rename). Deleted columns are removed from this map.
let columnMap = {};

// ── M11: Auto-detect ─────────────────────────────────────────────────────────

let autoSuggestions = []; // full field objects from content script
let selectedSuggestions = new Set(); // indices currently checked

function renderAutoDetectPanel(suggestions) {
  if (!suggestions || !suggestions.length) {
    autoDetectPanel.classList.add('hidden');
    return;
  }

  autoSuggestions = suggestions;
  selectedSuggestions = new Set(suggestions.map((_, i) => i)); // all selected by default

  autoDetectCount.textContent = `${suggestions.length} fields · ${suggestions[0].rowCount} rows`;
  autoDetectFields.innerHTML = '';

  suggestions.forEach((s, i) => {
    const chip = document.createElement('div');
    chip.className = 'auto-detect-chip selected';
    chip.dataset.idx = i;
    chip.innerHTML = `
      <span class="auto-detect-chip-check">&#10003;</span>
      <span>${s.name}</span>
      <span class="auto-detect-chip-type">${s.type}</span>
    `;
    chip.addEventListener('click', () => {
      if (selectedSuggestions.has(i)) {
        selectedSuggestions.delete(i);
        chip.classList.remove('selected');
      } else {
        selectedSuggestions.add(i);
        chip.classList.add('selected');
      }
      btnAutoApply.disabled = selectedSuggestions.size === 0;
    });
    autoDetectFields.appendChild(chip);
  });

  autoDetectPanel.classList.remove('hidden');
}

btnAutoApply.addEventListener('click', () => {
  const toAdd = autoSuggestions.filter((_, i) => selectedSuggestions.has(i));
  if (!toAdd.length) return;

  // Merge with existing fields (avoid duplicate names)
  const existingNames = new Set(fields.map(f => f.name));
  const newFields = toAdd.filter(f => !existingNames.has(f.name));
  fields.push(...newFields);
  renderFields();
  chrome.storage.local.set({ fields });
  autoDetectPanel.classList.add('hidden');

  const added = newFields.length;
  const skipped = toAdd.length - added;
  let msg = `${added} field(s) applied`;
  if (skipped > 0) msg += ` (${skipped} already exist)`;
  setStatus('idle', msg);
});

btnAutoDismiss.addEventListener('click', () => {
  autoDetectPanel.classList.add('hidden');
});

function runAutoDetect(tabId) {
  // Only auto-detect if user has no fields yet
  chrome.storage.local.get(['fields'], (res) => {
    if (res.fields && res.fields.length > 0) return;
    chrome.tabs.sendMessage(tabId, { action: 'autoDetect' }, (result) => {
      if (chrome.runtime.lastError || !result) return;
      renderAutoDetectPanel(result.fields);
      if (result.fields && result.fields.length) {
        setStatus('idle', `Auto-detected ${result.fields.length} field(s) — ${result.rowCount} rows`);
      }
    });
  });
}

// ── M13: Templates ────────────────────────────────────────────────────────────

function loadTemplates(callback) {
  chrome.storage.local.get(['templates'], (res) => callback(res.templates || {}));
}

function saveTemplates(templates, callback) {
  chrome.storage.local.set({ templates }, callback);
}

function refreshTemplateDropdown(templates) {
  const prev = templateSelect.value;
  // Keep the placeholder
  templateSelect.innerHTML = '<option value="">Load template…</option>';
  Object.keys(templates).sort().forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} (${templates[name].fields.length} fields)`;
    templateSelect.appendChild(opt);
  });
  if (prev && templates[prev]) templateSelect.value = prev;
  btnTemplateLoad.disabled = !templateSelect.value;
}

templateSelect.addEventListener('change', () => {
  btnTemplateLoad.disabled = !templateSelect.value;
});

btnTemplateSave.addEventListener('click', () => {
  if (!fields.length) {
    setStatus('error', 'No fields to save — add fields first');
    return;
  }
  const name = prompt('Template name:', '');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  loadTemplates(templates => {
    templates[trimmed] = { fields: JSON.parse(JSON.stringify(fields)), savedAt: Date.now() };
    saveTemplates(templates, () => {
      refreshTemplateDropdown(templates);
      templateSelect.value = trimmed;
      btnTemplateLoad.disabled = false;
      setStatus('idle', `Template "${trimmed}" saved`);
    });
  });
});

btnTemplateLoad.addEventListener('click', () => {
  const name = templateSelect.value;
  if (!name) return;
  loadTemplates(templates => {
    const tpl = templates[name];
    if (!tpl) return;
    fields = JSON.parse(JSON.stringify(tpl.fields));
    renderFields();
    chrome.storage.local.set({ fields });
    setStatus('idle', `Template "${name}" loaded — ${fields.length} field(s)`);
  });
});

// Populate dropdown on init
loadTemplates(refreshTemplateDropdown);

// ── M14: Progress panel ───────────────────────────────────────────────────────

let currentMode = null; // 'scroll' | 'paginate' | null
let isPaused = false;
let maxItemsSeen = 0;

function showProgressPanel(mode) {
  currentMode = mode;
  isPaused = false;
  maxItemsSeen = 0;
  progressBar.style.width = '0%';
  progressBar.classList.add('indeterminate');
  progressLabel.textContent = '0 items';
  btnPause.classList.remove('hidden');
  btnResume.classList.add('hidden');
  progressPanel.classList.remove('hidden');
  btnScrollScrape.classList.add('hidden');
  btnPaginate.classList.add('hidden');
}

function hideProgressPanel() {
  progressPanel.classList.add('hidden');
  progressBar.classList.remove('indeterminate');
  progressBar.style.width = '0%';
  btnScrollScrape.classList.remove('hidden');
  btnPaginate.classList.remove('hidden');
  currentMode = null;
  isPaused = false;
}

function updateProgress(count, page) {
  progressLabel.textContent = page
    ? `${count} items — page ${page}`
    : `${count} items`;
  if (count > 0) {
    progressBar.classList.remove('indeterminate');
    // Grow the bar logarithmically — looks alive without needing a known total
    const pct = Math.min(92, 20 + Math.log2(count + 1) * 10);
    progressBar.style.width = pct + '%';
  }
}

function finishProgress() {
  progressBar.classList.remove('indeterminate');
  progressBar.style.width = '100%';
  setTimeout(hideProgressPanel, 800);
}

btnPause.addEventListener('click', () => {
  if (!currentMode) return;
  isPaused = true;
  btnPause.classList.add('hidden');
  btnResume.classList.remove('hidden');
  setStatus('idle', 'Paused — click Resume to continue');
  if (currentMode === 'scroll')   chrome.tabs.sendMessage(activeTabId, { action: 'pauseScroll' });
  if (currentMode === 'paginate') chrome.tabs.sendMessage(activeTabId, { action: 'pausePagination' });
});

btnResume.addEventListener('click', () => {
  if (!currentMode) return;
  isPaused = false;
  btnResume.classList.add('hidden');
  btnPause.classList.remove('hidden');
  setStatus('scraping', currentMode === 'scroll' ? 'Scrolling and scraping...' : 'Paginating...');
  if (currentMode === 'scroll')   chrome.tabs.sendMessage(activeTabId, { action: 'resumeScroll' });
  if (currentMode === 'paginate') chrome.tabs.sendMessage(activeTabId, { action: 'resumePagination' });
});

// ── Status helpers ────────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

function setConnected(connected) {
  if (connected) {
    connBadge.textContent = 'Connected';
    connBadge.className = 'conn-badge connected';
    btnSelect.disabled = false;
  } else {
    connBadge.textContent = 'Not connected';
    connBadge.className = 'conn-badge disconnected';
    btnSelect.disabled = true;
    btnScrape.disabled = true;
    btnScrollScrape.disabled = true;
    btnPaginate.disabled = true;
    setStatus('error', 'Cannot connect to page — try refreshing');
  }
}

// ── Preview table (M7 + M8: rename & delete columns) ─────────────────────────

function initColumnMap(data) {
  if (!data || !data.length) return;
  const keys = Object.keys(data[0]);
  // Preserve existing renames; only add new keys
  keys.forEach(k => { if (!(k in columnMap)) columnMap[k] = k; });
  // Remove keys no longer in data
  Object.keys(columnMap).forEach(k => { if (!keys.includes(k)) delete columnMap[k]; });
  chrome.storage.local.set({ columnMap });
}

function renderPreviewTable(data) {
  if (!data || !data.length) {
    previewTableWrap.classList.add('hidden');
    return;
  }

  initColumnMap(data);
  // visibleCols = original keys that have not been deleted
  const visibleCols = Object.keys(data[0]).filter(k => k in columnMap);

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  visibleCols.forEach(col => {
    const th = document.createElement('th');
    th.dataset.col = col;

    const label = document.createElement('span');
    label.className = 'th-label';
    label.textContent = columnMap[col];

    const delBtn = document.createElement('button');
    delBtn.className = 'th-delete';
    delBtn.title = 'Delete column';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      delete columnMap[col];
      chrome.storage.local.set({ columnMap });
      renderPreviewTable(data);
    });

    th.appendChild(label);
    th.appendChild(delBtn);

    // Double-click to rename inline
    th.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.className = 'th-rename-input';
      input.value = columnMap[col];
      th.innerHTML = '';
      th.appendChild(input);
      input.focus();
      input.select();

      const commit = () => {
        const newName = input.value.trim();
        if (newName) columnMap[col] = newName;
        chrome.storage.local.set({ columnMap });
        renderPreviewTable(data);
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  commit();
        if (e.key === 'Escape') renderPreviewTable(data);
      });
    });

    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);

  const tbody = document.createElement('tbody');
  data.forEach(row => {
    const tr = document.createElement('tr');
    visibleCols.forEach(col => {
      const td = document.createElement('td');
      td.textContent = row[col] || '';
      td.title = row[col] || '';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  previewTable.innerHTML = '';
  previewTable.appendChild(thead);
  previewTable.appendChild(tbody);
  previewTableWrap.classList.remove('hidden');
}

function exportCsv(data) {
  if (!data || !data.length) return;
  // Only export visible (non-deleted) columns, using their display names
  const allKeys = Object.keys(data[0]);
  const visibleCols = allKeys.filter(k => k in columnMap);
  if (!visibleCols.length) return;

  const escape = v => '"' + String(v || '').replace(/"/g, '""') + '"';
  const header = visibleCols.map(k => escape(columnMap[k])).join(',');
  const lines  = [header];
  data.forEach(row => lines.push(visibleCols.map(k => escape(row[k])).join(',')));

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'scraped_data.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function exportJson(data) {
  if (!data || !data.length) return;
  const allKeys = Object.keys(data[0]);
  const visibleCols = allKeys.filter(k => k in columnMap);
  if (!visibleCols.length) return;

  // Build output using display names and only visible columns
  const out = data.map(row => {
    const obj = {};
    visibleCols.forEach(k => { obj[columnMap[k]] = row[k] || ''; });
    return obj;
  });

  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'scraped_data.json';
  a.click();
  URL.revokeObjectURL(url);
}

function exportXlsx(data) {
  if (!data || !data.length) return;
  if (typeof XLSX === 'undefined') {
    setStatus('error', 'Excel library not loaded — try reloading the extension');
    return;
  }
  const allKeys = Object.keys(data[0]);
  const visibleCols = allKeys.filter(k => k in columnMap);
  if (!visibleCols.length) return;

  // Build array-of-arrays: header row + data rows
  const header = visibleCols.map(k => columnMap[k]);
  const rows   = data.map(row => visibleCols.map(k => row[k] || ''));

  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);

  // Auto column widths
  const colWidths = header.map((h, i) => {
    const maxLen = Math.max(h.length, ...rows.map(r => String(r[i] || '').length));
    return { wch: Math.min(maxLen + 2, 50) };
  });
  ws['!cols'] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Scraped Data');
  XLSX.writeFile(wb, 'scraped_data.xlsx');
}

// ── Field rendering ───────────────────────────────────────────────────────────

function renderFields() {
  if (fields.length === 0) {
    fieldsList.innerHTML = '<p class="empty-hint">No fields selected yet.<br/>Click "Start Selection" to begin.</p>';
    btnScrape.disabled = true;
    btnScrollScrape.disabled = true;
    btnPaginate.disabled = true;
    return;
  }

  fieldsList.innerHTML = '';
  fields.forEach((field, idx) => {
    const item = document.createElement('div');
    item.className = 'field-item';
    item.innerHTML = `
      <span class="field-name">${field.name}</span>
      <span class="field-type">${field.type}</span>
      <button class="field-remove" data-idx="${idx}" title="Remove">&times;</button>
    `;
    fieldsList.appendChild(item);
  });

  btnScrape.disabled = false;
  btnScrollScrape.disabled = false;
  btnPaginate.disabled = false;
}

fieldsList.addEventListener('click', (e) => {
  if (e.target.classList.contains('field-remove')) {
    const idx = parseInt(e.target.dataset.idx);
    fields.splice(idx, 1);
    renderFields();
    chrome.storage.local.set({ fields });
  }
});

// ── Ping content script to check connection ───────────────────────────────────

function pingContentScript(tabId) {
  chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      // Content script not yet injected — try programmatic injection
      chrome.scripting.executeScript(
        { target: { tabId }, files: ['content/content.js'] },
        () => {
          if (chrome.runtime.lastError) {
            setConnected(false);
            return;
          }
          chrome.scripting.insertCSS(
            { target: { tabId }, files: ['content/highlighter.css'] },
            () => {
              // Re-ping after injection
              setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { action: 'ping' }, (res) => {
                  const ok = !chrome.runtime.lastError && !!res;
                  setConnected(ok);
                  if (ok) runAutoDetect(tabId);
                });
              }, 200);
            }
          );
        }
      );
    } else {
      setConnected(true);
      setStatus('idle', 'Ready — ' + shortenUrl(response.url));
      runAutoDetect(tabId);
    }
  });
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url;
  }
}

// ── Button handlers ───────────────────────────────────────────────────────────

btnSelect.addEventListener('click', () => {
  isSelecting = !isSelecting;

  if (isSelecting) {
    btnSelect.textContent = 'Stop Selection';
    btnSelect.classList.add('active');
    setStatus('selecting', 'Hover over elements and click to select');
  } else {
    btnSelect.textContent = 'Start Selection';
    btnSelect.classList.remove('active');
    setStatus('idle', 'Ready');
  }

  chrome.tabs.sendMessage(activeTabId, {
    action: isSelecting ? 'startSelection' : 'stopSelection'
  });
});

btnScrape.addEventListener('click', () => {
  if (fields.length === 0) return;
  setStatus('scraping', 'Scraping page...');
  btnScrape.disabled = true;
  resultsSection.classList.add('hidden');

  chrome.tabs.sendMessage(activeTabId, { action: 'scrape', fields }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setStatus('error', 'Scrape failed — try refreshing the page');
      btnScrape.disabled = false;
      btnScrollScrape.disabled = false;
      btnPaginate.disabled = false;
    }
  });
});

btnPaginate.addEventListener('click', () => {
  if (fields.length === 0) return;
  setStatus('scraping', 'Paginating...');
  btnScrape.disabled = true;
  resultsSection.classList.add('hidden');
  showProgressPanel('paginate');

  chrome.tabs.sendMessage(activeTabId, { action: 'paginationScrape', fields }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setStatus('error', 'Pagination failed — try refreshing the page');
      btnScrape.disabled = false;
      hideProgressPanel();
    }
  });
});

btnScrollScrape.addEventListener('click', () => {
  if (fields.length === 0) return;
  setStatus('scraping', 'Scrolling and scraping...');
  btnScrape.disabled = true;
  resultsSection.classList.add('hidden');
  showProgressPanel('scroll');

  chrome.tabs.sendMessage(activeTabId, { action: 'scrollScrape', fields }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setStatus('error', 'Scroll scrape failed — try refreshing');
      btnScrape.disabled = false;
      hideProgressPanel();
    }
  });
});

btnStopScroll.addEventListener('click', () => {
  chrome.tabs.sendMessage(activeTabId, { action: 'stopScroll' });
  chrome.tabs.sendMessage(activeTabId, { action: 'stopPagination' });
  hideProgressPanel();
  setStatus('done', 'Stopped');
});

btnClear.addEventListener('click', () => {
  fields = [];
  lastScrapedData = [];
  columnMap = {};
  autoSuggestions = [];
  selectedSuggestions = new Set();
  renderFields();
  resultsSection.classList.add('hidden');
  previewTableWrap.classList.add('hidden');
  autoDetectPanel.classList.add('hidden');
  hideProgressPanel();
  setStatus('idle', 'Ready');
  chrome.storage.local.set({ fields: [], scrapedData: [], columnMap: {} });
  // Re-run auto-detect after clearing
  if (activeTabId) runAutoDetect(activeTabId);
});

btnExportCsv.addEventListener('click',  () => exportCsv(lastScrapedData));
btnExportJson.addEventListener('click', () => exportJson(lastScrapedData));
btnExportXlsx.addEventListener('click', () => exportXlsx(lastScrapedData));

// ── Incoming messages from content script ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'fieldSelected') {
    fields.push(msg.field);
    renderFields();
    chrome.storage.local.set({ fields });
    // Sync button — selection mode exits after a click
    isSelecting = false;
    btnSelect.textContent = 'Start Selection';
    btnSelect.classList.remove('active');
    setStatus('idle', `"${msg.field.name}" added — ${fields.length} field(s)`);
  }

  if (msg.action === 'selectionStopped') {
    isSelecting = false;
    btnSelect.textContent = 'Start Selection';
    btnSelect.classList.remove('active');
    setStatus('idle', 'Ready');
  }

  if (msg.action === 'scrapeProgress') {
    lastScrapedData = msg.data || [];
    updateProgress(msg.count, msg.page);
    const pageInfo = msg.page ? ` — page ${msg.page}` : '';
    if (!isPaused) setStatus('scraping', `Scraping${pageInfo}... ${msg.count} items`);
    resultsCount.textContent = `${msg.count} items found`;
    resultsSection.classList.remove('hidden');
    renderPreviewTable(lastScrapedData);
  }

  if (msg.action === 'scrapeComplete') {
    lastScrapedData = msg.data || [];
    setStatus('done', `Done — ${msg.count} items found`);
    resultsCount.textContent = `${msg.count} items found`;
    resultsSection.classList.remove('hidden');
    renderPreviewTable(lastScrapedData);
    btnScrape.disabled = false;
    btnScrollScrape.disabled = false;
    btnPaginate.disabled = false;
    if (currentMode) finishProgress(); // only animate if scroll/paginate was running
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

// Always read latest fields, data, and columnMap from storage when popup opens
chrome.storage.local.get(['fields', 'scrapedData', 'columnMap'], (result) => {
  if (result.fields && result.fields.length > 0) {
    fields = result.fields;
    renderFields();
  }
  // Restore column renames/deletions
  if (result.columnMap) {
    columnMap = result.columnMap;
  }
  // Restore last scrape result if available
  if (result.scrapedData && result.scrapedData.length > 0) {
    lastScrapedData = result.scrapedData;
    resultsCount.textContent = `${result.scrapedData.length} items found`;
    resultsSection.classList.remove('hidden');
    renderPreviewTable(lastScrapedData);
    setStatus('done', `${result.scrapedData.length} items ready`);
  }
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs[0]) { setConnected(false); return; }
  activeTabId = tabs[0].id;
  pingContentScript(activeTabId);
});
