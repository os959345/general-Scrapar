const templateList = document.getElementById('template-list');
const btnClearAll  = document.getElementById('btn-clear-all');
const toast        = document.getElementById('toast');

let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function loadTemplates(cb) {
  chrome.storage.local.get(['templates'], res => cb(res.templates || {}));
}

function saveTemplates(templates, cb) {
  chrome.storage.local.set({ templates }, cb);
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderTemplates(templates) {
  templateList.innerHTML = '';
  const names = Object.keys(templates).sort();

  if (!names.length) {
    templateList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">&#128196;</div>
        <p>No templates yet.<br/>Save a field configuration from the popup to see it here.</p>
      </div>`;
    return;
  }

  names.forEach(name => {
    const tpl = templates[name];
    const item = document.createElement('div');
    item.className = 'template-item';

    const fieldChips = (tpl.fields || []).map(f =>
      `<span class="field-chip">${f.name} <span class="field-chip-type">${f.type}</span></span>`
    ).join('');

    item.innerHTML = `
      <div class="template-item-info">
        <div class="template-item-name">${name}</div>
        <div class="template-item-meta">
          ${tpl.fields.length} field(s)${tpl.savedAt ? ' · saved ' + formatDate(tpl.savedAt) : ''}
        </div>
        <div class="template-item-fields">${fieldChips}</div>
      </div>
      <div class="template-actions">
        <button class="btn btn-rename" data-name="${name}">Rename</button>
        <button class="btn btn-delete" data-name="${name}">Delete</button>
      </div>
    `;

    item.querySelector('.btn-rename').addEventListener('click', () => {
      const newName = prompt('New template name:', name);
      if (!newName || !newName.trim() || newName.trim() === name) return;
      const trimmed = newName.trim();
      loadTemplates(tpls => {
        if (tpls[trimmed]) { alert(`A template named "${trimmed}" already exists.`); return; }
        tpls[trimmed] = tpls[name];
        delete tpls[name];
        saveTemplates(tpls, () => { renderTemplates(tpls); showToast(`Renamed to "${trimmed}"`); });
      });
    });

    item.querySelector('.btn-delete').addEventListener('click', () => {
      if (!confirm(`Delete template "${name}"?`)) return;
      loadTemplates(tpls => {
        delete tpls[name];
        saveTemplates(tpls, () => { renderTemplates(tpls); showToast(`"${name}" deleted`); });
      });
    });

    templateList.appendChild(item);
  });
}

btnClearAll.addEventListener('click', () => {
  if (!confirm('Delete ALL templates? This cannot be undone.')) return;
  saveTemplates({}, () => { renderTemplates({}); showToast('All templates deleted'); });
});

// Initial render
loadTemplates(renderTemplates);

// Live-update if popup saves a new template while this page is open
chrome.storage.onChanged.addListener((changes) => {
  if (changes.templates) renderTemplates(changes.templates.newValue || {});
});
