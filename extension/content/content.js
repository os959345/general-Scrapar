console.log('[Web Scraper] Content script loaded on:', window.location.href);

// Guard against "Extension context invalidated" errors that occur when the
// extension is reloaded/updated while the content script is still alive.
function isContextValid() {
  try { return !!chrome.runtime?.id; } catch (_) { return false; }
}

function safeSendMessage(msg) {
  if (!isContextValid()) return;
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (_) {}
}

function safeStorageGet(keys, cb) {
  if (!isContextValid()) return;
  try { chrome.storage.local.get(keys, cb); } catch (_) {}
}

function safeStorageSet(obj, cb) {
  if (!isContextValid()) return;
  try { chrome.storage.local.set(obj, cb); } catch (_) {}
}

safeSendMessage({ action: 'contentScriptReady', url: window.location.href });

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function safeQuery(root, sel) {
  if (!sel) return null;
  try { return root.querySelector(sel); } catch (_) { return null; }
}

function safeQueryAll(root, sel) {
  if (!sel) return [];
  try { return [...root.querySelectorAll(sel)]; } catch (_) { return []; }
}

// ─── Build the tightest stable selector for ONE element ───────────────────────
// Priority: data-* attrs > stable classes > aria-label > itemtype > nth-child
function elementSelector(el) {
  const tag = el.tagName.toLowerCase();

  // data-* semantic attrs — most stable across frameworks
  for (const attr of ['data-component-type','data-test-id','data-testid','data-qa','data-type','data-item','data-id']) {
    const val = el.getAttribute(attr);
    if (val && val.length > 1 && !/^\d+$/.test(val)) {
      const sel = `${tag}[${attr}="${CSS.escape(val)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel; // unique on page
    }
  }

  // id — only if it looks stable (not purely numeric / random)
  if (el.id && !/^\d+$/.test(el.id) && !/[a-f0-9]{6,}/i.test(el.id)) {
    const sel = `#${CSS.escape(el.id)}`;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }

  // stable classes + tag
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).filter(c =>
      c.length > 2 &&
      !/^[a-f0-9]{5,}$/i.test(c) &&
      !/\d{4,}/.test(c)
    );
    if (classes.length) {
      const sel = tag + '.' + classes.slice(0,3).map(c => CSS.escape(c)).join('.');
      const count = document.querySelectorAll(sel).length;
      if (count >= 1 && count <= 200) return sel;
    }
  }

  return null; // caller will use nth-child path
}


// ─── Strip numeric/hash suffixes from a class name ───────────────────────────
// e.g. "card-1" → "card", "abc123" → "" (filtered out), "product-card" → "product-card"
function stableClasses(el) {
  if (!el.className || typeof el.className !== 'string') return [];
  return el.className.trim().split(/\s+/).filter(c =>
    c.length > 1 &&
    !/^\d+$/.test(c) &&                // purely numeric
    !/^[a-f0-9]{5,}$/i.test(c) &&     // hex hash
    !/css-[a-z0-9]+/i.test(c) &&      // CSS-in-JS generated (e.g. css-1a2b3c)
    !/^sc-[a-z0-9]+$/i.test(c)        // styled-components
  ).map(c => c.replace(/[-_]?\d+$/, '')).filter(Boolean); // strip trailing digits
}

// ─── Build a CSS selector for a node that can match its siblings ──────────────
function buildRowSelector(node) {
  const tag = node.tagName.toLowerCase();

  // 1. Semantic data-* attributes (most stable — survive redesigns)
  for (const attr of ['data-component-type','data-testid','data-test-id','data-qa','data-type','data-item','itemprop']) {
    const val = node.getAttribute(attr);
    if (val && val.length > 1 && !/^\d+$/.test(val)) {
      return `${tag}[${attr}="${CSS.escape(val)}"]`;
    }
  }

  // 2. schema.org itemtype
  const itemtype = node.getAttribute('itemtype');
  if (itemtype) return `${tag}[itemtype="${CSS.escape(itemtype)}"]`;

  // 3. Stable classes (digits stripped so "card-1" and "card-2" both become "card")
  const classes = stableClasses(node);
  if (classes.length) return tag + '.' + classes.slice(0, 2).map(c => CSS.escape(c)).join('.');

  return tag;
}

// ─── Find repeating children of a container (Instant Data Scraper algorithm) ──
// Groups children by their CSS class combo (digits stripped).
// Returns children whose class combo appears in ≥ 50% of children (±2 tolerance).
function findRepeatingChildren(container) {
  const children = [...container.children].filter(c => {
    const tag = c.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return false;
    if (!(c.textContent || '').trim() && !c.querySelector('img')) return false;
    return true;
  });
  if (children.length < 2) return [];

  // Build class combo counts (sorted stable classes joined)
  const comboCounts = new Map();
  const singleCounts = new Map();
  children.forEach(child => {
    const cls = stableClasses(child).sort();
    const combo = cls.join(' ');
    comboCounts.set(combo, (comboCounts.get(combo) || 0) + 1);
    cls.forEach(c => singleCounts.set(c, (singleCounts.get(c) || 0) + 1));
  });

  const threshold = Math.max(2, children.length / 2 - 2);

  // Find qualifying combos
  let goodCombos = [...comboCounts.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([combo]) => combo);

  // Fall back to single-class matching if no combo qualifies
  if (!goodCombos.length) {
    const goodClasses = new Set(
      [...singleCounts.entries()]
        .filter(([, count]) => count >= threshold)
        .map(([cls]) => cls)
    );
    if (goodClasses.size) {
      return children.filter(child =>
        stableClasses(child).some(c => goodClasses.has(c))
      );
    }
    // Last resort: if all children share the same tag (e.g. <tr>, <li>)
    const tagCounts = new Map();
    children.forEach(c => tagCounts.set(c.tagName, (tagCounts.get(c.tagName) || 0) + 1));
    const dominantTag = [...tagCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (dominantTag && dominantTag[1] >= threshold) {
      return children.filter(c => c.tagName === dominantTag[0]);
    }
    return [];
  }

  return children.filter(child => {
    const cls = stableClasses(child).sort().join(' ');
    return goodCombos.includes(cls);
  });
}

// ─── Score a container: pixel_area × repeating_children² (IDS formula) ────────
function scoreContainer(node, repeatingChildren) {
  const n = repeatingChildren.length;
  if (n < 2) return 0;
  const area = (node.offsetWidth || 0) * (node.offsetHeight || 0);
  if (area === 0) return 0;

  let score = area * n * n;

  // Boost for semantic tags / product-related class names
  const cls = (typeof node.className === 'string') ? node.className : '';
  if (/product|item|card|result|listing|offer|grid|catalog/i.test(cls)) score *= 1.5;
  if (/article|section|ul|ol/.test(node.tagName.toLowerCase())) score *= 1.2;
  if (node.getAttribute('itemtype')) score *= 1.3;

  // Penalise nav/footer/header containers
  if (/nav|header|footer|sidebar|menu|breadcrumb|filter|facet/i.test(cls)) score *= 0.1;
  const tag = node.tagName.toLowerCase();
  if (tag === 'nav' || tag === 'header' || tag === 'footer') score *= 0.1;

  return score;
}

// ─── Detect the repeating row container (walk up from clicked element) ────────
function detectRowContainer(clickedEl) {
  const SKIP_TAGS = new Set(['span','a','em','strong','b','i','small','label',
    'h1','h2','h3','h4','h5','h6','p','img','svg','path','abbr','code','time','br','button']);

  let node = clickedEl.parentElement;
  let bestNode = null;
  let bestScore = 0;

  while (node && node !== document.body) {
    const tag = node.tagName.toLowerCase();
    if (!SKIP_TAGS.has(tag)) {
      const repeating = findRepeatingChildren(node);
      if (repeating.length >= 2) {
        const score = scoreContainer(node, repeating);
        if (score > bestScore) {
          bestScore = score;
          bestNode = node;
        }
      }
    }
    node = node.parentElement;
  }

  // If nothing scored, fall back: walk up and return first node with 2+ same-tag children
  if (!bestNode) {
    node = clickedEl.parentElement;
    while (node && node !== document.body) {
      const tag = node.tagName.toLowerCase();
      if (!SKIP_TAGS.has(tag) && node.children.length >= 2) {
        const tagCounts = {};
        [...node.children].forEach(c => { tagCounts[c.tagName] = (tagCounts[c.tagName] || 0) + 1; });
        if (Math.max(...Object.values(tagCounts)) >= 2) { bestNode = node; break; }
      }
      node = node.parentElement;
    }
  }

  return bestNode;
}

// ─── Relative path from row container to field element ───────────────────────
// Each segment uses elementSelector or falls back to tag.nth-child
function relativePath(descendant, ancestor) {
  if (!descendant || !ancestor || descendant === ancestor) return null;
  const parts = [];
  let node = descendant;
  while (node && node !== ancestor) {
    const tag  = node.tagName.toLowerCase();
    const quick = elementSelector(node);
    if (quick) {
      const hits = safeQueryAll(ancestor, quick);
      if (hits.length === 1) { parts.unshift(quick); node = node.parentElement; continue; }
    }
    if (node.parentElement) {
      const idx = [...node.parentElement.children].indexOf(node) + 1;
      parts.unshift(`${tag}:nth-child(${idx})`);
    } else {
      parts.unshift(tag);
    }
    node = node.parentElement;
  }
  return parts.length ? parts.join(' > ') : null;
}

// ─── Field type / name guessing ──────────────────────────────────────────────
function detectFieldType(el) {
  if (el.tagName === 'IMG') return 'image';
  if (el.tagName === 'A')   return 'link';
  const text = (el.textContent || '').trim();
  if (/^\$?[\d,]+\.?\d*$/.test(text)) return 'price';
  return 'text';
}

function guessFieldName(el) {
  const text = (el.textContent || '').trim().slice(0, 30);
  if (el.tagName === 'IMG') return el.alt ? el.alt.slice(0,30) : 'Image';
  if (el.tagName === 'A')   return text || 'Link';
  const hint = (el.className + ' ' + el.id).toLowerCase();
  if (/price|cost|amount|sale/.test(hint))  return 'Price';
  if (/title|name|heading|product/.test(hint)) return 'Title';
  if (/rating|star|review/.test(hint))      return 'Rating';
  return text.slice(0,25) || 'Field';
}

// ─── Check if a class name is stable (not hashed/generated) ─────────────────
function isStableClass(c) {
  if (c.length <= 2) return false;
  if (/^[a-f0-9]{5,}$/i.test(c)) return false;        // pure hex hash
  if (/css-[a-z0-9]+/i.test(c)) return false;          // CSS-in-JS (emotion/styled)
  if (/^sc-[a-z0-9]+$/i.test(c)) return false;         // styled-components
  if (/^[a-z]{1,3}_[a-f0-9]{4,}/i.test(c)) return false; // mangled (e.g. rq_abc123)
  if (/\d{4,}/.test(c)) return false;                  // long digit runs
  return true;
}

// ─── Build a selector that matches the clicked element within every row ───────
// Uses a multi-strategy approach for universal compatibility:
// 1. Semantic data-* attributes (most stable)
// 2. Stable CSS classes (filtered for hashed/generated names)
// 3. Structural nth-child path (works even with 100% dynamic classes)
// 4. Try progressively shorter suffix paths until one matches across rows
function buildFieldAbsSel(el, rowContainer) {
  if (!rowContainer) return null;

  // Strategy A: try data-* and stable-class based path first
  const parts = [];
  let node = el;
  while (node && node !== rowContainer) {
    const tag = node.tagName.toLowerCase();
    let pushed = false;

    // data-* semantic attrs — most stable across frameworks
    for (const attr of ['data-testid','data-test-id','data-qa','data-type','data-asin','data-sku','itemprop']) {
      const val = node.getAttribute(attr);
      if (val && val.length > 1 && !/^\d+$/.test(val)) {
        parts.unshift(`${tag}[${attr}="${CSS.escape(val)}"]`);
        pushed = true;
        break;
      }
    }

    // Stable classes (filter out hashed/generated names)
    if (!pushed && node.className && typeof node.className === 'string') {
      const classes = node.className.trim().split(/\s+/).filter(isStableClass);
      if (classes.length) {
        parts.unshift(tag + '.' + classes.slice(0, 2).map(c => CSS.escape(c)).join('.'));
        pushed = true;
      }
    }

    if (!pushed) parts.unshift(tag);
    node = node.parentElement;
  }

  if (parts.length) {
    const sel = parts.join(' > ');
    if (safeQuery(rowContainer, sel)) return sel;

    // Try progressively shorter suffixes (drop unstable prefix segments)
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join(' > ');
      if (safeQuery(rowContainer, suffix)) return suffix;
    }
  }

  // Strategy B: structural nth-child path — works with ANY class scheme
  // Build a path using tag + nth-child position within each parent.
  // Then verify it matches across multiple sibling rows.
  const structParts = [];
  node = el;
  while (node && node !== rowContainer) {
    const tag = node.tagName.toLowerCase();
    if (node.parentElement) {
      const idx = [...node.parentElement.children].indexOf(node) + 1;
      structParts.unshift(`${tag}:nth-child(${idx})`);
    } else {
      structParts.unshift(tag);
    }
    node = node.parentElement;
  }

  if (!structParts.length) return null;
  const structSel = structParts.join(' > ');
  // Verify it at least hits the first row
  if (safeQuery(rowContainer, structSel)) return structSel;

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOLTIP
// ═══════════════════════════════════════════════════════════════════════════════

let tooltip = null;

function showTooltip(el, x, y) {
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'wse-tooltip';
    tooltip.innerHTML = '<span class="wse-tooltip-tag"></span><span class="wse-tooltip-xpath"></span>';
    document.body.appendChild(tooltip);
  }
  const tag  = el.tagName.toLowerCase();
  const text = (el.textContent || '').trim().slice(0, 40);
  tooltip.querySelector('.wse-tooltip-tag').textContent = `<${tag}>${text ? ' "' + text + '"' : ''}`;
  tooltip.querySelector('.wse-tooltip-xpath').textContent = buildRowSelector(el) || tag;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x + 14, top = y + 14;
  if (left + 360 > vw - 8) left = x - 374;
  if (top  + 52  > vh - 8) top  = y - 66;
  tooltip.style.left    = Math.max(8, left) + 'px';
  tooltip.style.top     = Math.max(8, top)  + 'px';
  tooltip.style.display = 'block';
}

function hideTooltip() {
  if (tooltip) tooltip.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIELD DIALOG
// ═══════════════════════════════════════════════════════════════════════════════

let dialog = null;

function showFieldDialog(el) {
  if (dialog) dialog.remove();

  const autoType     = detectFieldType(el);
  const autoName     = guessFieldName(el);
  const rowContainer = detectRowContainer(el);
  const rowSel       = rowContainer ? buildRowSelector(rowContainer) : null;
  const fieldRelPath = rowContainer ? relativePath(el, rowContainer) : null;
  const rowCount     = rowSel ? safeQueryAll(document, rowSel).length : 1;

  // Build an absolute selector for the clicked element so we can anchor
  // the valid-row filter to "rows that contain this exact kind of element".
  const fieldAbsSel = buildFieldAbsSel(el, rowContainer);

  console.log('[WS] rowSel:', rowSel, '| count:', rowCount, '| relPath:', fieldRelPath, '| absSel:', fieldAbsSel);

  dialog = document.createElement('div');
  dialog.className = 'wse-dialog';
  dialog.innerHTML = `
    <div class="wse-dialog-inner">
      <div class="wse-dialog-header">
        <span class="wse-dialog-title">Add Field</span>
        <button class="wse-dialog-close" id="wse-close">&times;</button>
      </div>
      <div class="wse-dialog-body">
        <label class="wse-label">Field Name</label>
        <input class="wse-input" id="wse-field-name" type="text" value="${autoName}" placeholder="e.g. Product Name" />
        <label class="wse-label">Field Type</label>
        <select class="wse-select" id="wse-field-type">
          <option value="text"  ${autoType==='text'  ?'selected':''}>Text</option>
          <option value="link"  ${autoType==='link'  ?'selected':''}>Link (URL)</option>
          <option value="image" ${autoType==='image' ?'selected':''}>Image (src)</option>
          <option value="price" ${autoType==='price' ?'selected':''}>Price</option>
        </select>
        <label class="wse-label">Row selector</label>
        <div class="wse-selector-box">${rowSel || '(none)'}</div>
        <div class="wse-row-hint">
          ${rowSel
            ? `<span class="wse-hint-ok">&#10003; ${rowCount} rows — ${fieldRelPath}</span>`
            : `<span class="wse-hint-warn">&#9888; Could not detect repeating rows</span>`}
        </div>
      </div>
      <div class="wse-dialog-footer">
        <button class="wse-btn wse-btn-cancel" id="wse-cancel">Cancel</button>
        <button class="wse-btn wse-btn-add" id="wse-add">Add Field</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  const nameInput = dialog.querySelector('#wse-field-name');
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);

  dialog.querySelector('#wse-close').addEventListener('click', closeDialog);
  dialog.querySelector('#wse-cancel').addEventListener('click', closeDialog);
  dialog.querySelector('#wse-add').addEventListener('click', () => {
    const name = nameInput.value.trim() || autoName;
    const type = dialog.querySelector('#wse-field-type').value;
    const newField = { name, type, rowSel, fieldRelPath, fieldAbsSel, rowCount };
    safeStorageGet(['fields'], (res) => {
      const existing = res.fields || [];
      existing.push(newField);
      safeStorageSet({ fields: existing }, () => {
        safeSendMessage({ action: 'fieldSelected', field: newField });
      });
    });
    closeDialog();
  });

  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(); });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  dialog.querySelector('#wse-add').click();
    if (e.key === 'Escape') closeDialog();
  });
}

function closeDialog() {
  if (dialog) { dialog.remove(); dialog = null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALUE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

function extractValue(el, type) {
  if (!el) return '';
  switch (type) {
    case 'image': {
      const img = el.tagName === 'IMG' ? el : el.querySelector('img');
      if (!img) return '';
      const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') ||
                   img.getAttribute('data-original') || img.getAttribute('data-srcset');
      if (lazy) return lazy.split(/\s+/)[0];
      const srcset = img.getAttribute('srcset') || img.srcset;
      if (srcset) {
        const parts = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
      }
      return img.src || img.getAttribute('src') || '';
    }
    case 'link': {
      let node = el;
      while (node && node.tagName !== 'A') node = node.parentElement;
      if (!node) node = el.querySelector('a');
      return node ? (node.href || node.getAttribute('href') || '') : '';
    }
    case 'price':
      // findInRow resolved to the price leaf; use textContent (handles hidden .a-offscreen)
      return (el.textContent || '').replace(/\s+/g, ' ').trim();
    default: {
      // For text fields, prefer innerText (renders visible text only) but fall back
      // to textContent for elements hidden with CSS (clip/visibility tricks).
      const getText = (node) => {
        const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
        return t || (node.textContent || '').replace(/\s+/g, ' ').trim();
      };
      if (el.children.length > 0) {
        const text = getText(el);
        // If the element has too much concatenated text, prefer the tightest text leaf
        if (text.length > 200) {
          const leaf = findFirstTextLeaf(el);
          if (leaf) return getText(leaf);
        }
        return text;
      }
      return getText(el);
    }
  }
}

function findPriceLeaf(el) {
  // Amazon: .a-price contains an .a-offscreen span with the full price string
  const offscreen = el.querySelector('.a-offscreen');
  if (offscreen) {
    const t = (offscreen.textContent || '').trim();
    if (t.length > 0 && t.length < 60 && /\d{2,}/.test(t)) return offscreen;
  }
  // If already a leaf with price-like content, return it
  if (el.children.length === 0) {
    const t = (el.textContent || '').trim();
    if (/\d/.test(t)) return el;
  }
  // Scan all descendants for the tightest element containing a price pattern
  for (const candidate of el.querySelectorAll('span,b,strong,ins,del,p')) {
    if (candidate.children.length > 0) continue;
    const t = (candidate.textContent || '').trim();
    if (t.length > 0 && t.length < 60 &&
        /\d{2,}/.test(t) &&
        (/[\$£€₹¥]|Rs\.?|PKR|USD|EUR|INR|GBP|AED|SAR/i.test(t) || /\d{1,3}[,\.]\d{2,3}/.test(t))) {
      return candidate;
    }
  }
  // Fallback: return shallowest child that has price-like class
  return el.querySelector('[class*="price" i],[class*="amount" i],[class*="a-price" i]') || el;
}

function findFirstTextLeaf(el) {
  // DFS to find the first leaf with non-empty text
  for (const child of el.children) {
    if (child.children.length === 0) {
      const t = (child.textContent || '').trim();
      if (t.length > 0) return child;
    }
    const deeper = findFirstTextLeaf(child);
    if (deeper) return deeper;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIND ELEMENT WITHIN A ROW
// Uses the stored relative path, then falls back to type-based heuristics.
// ═══════════════════════════════════════════════════════════════════════════════

function isPriceText(t) {
  return t.length > 0 && t.length < 50 && /\d{2,}/.test(t) &&
    (/[\$£€₹¥]|Rs\.?|PKR|USD|EUR|INR|GBP|AED|SAR/i.test(t) || /\d{1,3}[,\.]\d{2,3}/.test(t));
}

function findInRow(row, field) {
  const isPrice = field.type === 'price';

  // 0. Try fieldAbsSel — class-based, works across all rows without nth-child
  if (field.fieldAbsSel) {
    const el = safeQuery(row, field.fieldAbsSel);
    if (el) {
      if (!isPrice) return el;
      const leaf = findPriceLeaf(el);
      if (isPriceText((leaf.textContent || '').trim())) return leaf;
    }
  }

  // 1. Try full relative path
  if (field.fieldRelPath) {
    const el = safeQuery(row, field.fieldRelPath);
    if (el) {
      // For price fields, verify the matched element actually has price-like text
      if (!isPrice) return el;
      const leaf = findPriceLeaf(el);
      const t = (leaf.textContent || '').trim();
      if (isPriceText(t)) return leaf;
    }
  }

  // 2. Try progressively shorter suffixes of the relative path
  if (field.fieldRelPath) {
    const parts = field.fieldRelPath.split('>').map(s => s.trim()).filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join(' > ');
      const el = safeQuery(row, suffix);
      if (el) {
        if (!isPrice) return el;
        const leaf = findPriceLeaf(el);
        const t = (leaf.textContent || '').trim();
        if (isPriceText(t)) return leaf;
      }
    }
    // 3. Try just the last segment (tag or tag.class)
    const last = parts[parts.length - 1];
    if (last) {
      const el = safeQuery(row, last);
      if (el) {
        if (!isPrice) return el;
        const leaf = findPriceLeaf(el);
        const t = (leaf.textContent || '').trim();
        if (isPriceText(t)) return leaf;
      }
      // 4. Strip nth-child and try again
      const stripped = last.replace(/:nth-child\(\d+\)/g, '');
      if (stripped !== last) {
        const el2 = safeQuery(row, stripped);
        if (el2) {
          if (!isPrice) return el2;
          const leaf = findPriceLeaf(el2);
          const t = (leaf.textContent || '').trim();
          if (isPriceText(t)) return leaf;
        }
      }
    }
  }

  // 5. Type-based generic heuristics (last resort)
  if (isPrice) {
    // Scan all leaf nodes for price-like text
    for (const el of row.querySelectorAll('span,div,p,strong,b,ins,del')) {
      if (el.children.length > 0) continue;
      if (isPriceText((el.textContent || '').trim())) return el;
    }
    // Fallback to price-class container (extractValue will return its text)
    return safeQuery(row, '[class*="price" i],[class*="amount" i],[class*="cost" i],[class*="a-price" i]');
  }
  if (field.type === 'image') return row.querySelector('img') || null;
  if (field.type === 'link')  return row.querySelector('a[href]') || null;
  if (field.type === 'text') {
    // Use field name to guide which element to pick
    const name = (field.name || '').toLowerCase();
    if (/rating|star|review/.test(name)) {
      return safeQuery(row, '[class*="rating" i],[class*="star" i],[class*="review" i],[aria-label*="out of" i],[aria-label*="stars" i]') || null;
    }
    if (/title|name|heading|product/.test(name)) {
      // Try headings first, then title-class elements, then the longest-text <a> in row
      const heading = row.querySelector('h1,h2,h3,h4,h5,h6');
      if (heading) return heading;
      const titleEl = safeQuery(row, '[class*="title" i],[class*="name" i],[class*="product" i],[class*="item-name" i]');
      if (titleEl) return titleEl;
      // Find the <a> with the longest text — usually the product title link
      const links = [...row.querySelectorAll('a[href]')];
      if (links.length) {
        return links.reduce((best, a) =>
          (a.textContent || '').trim().length > (best.textContent || '').trim().length ? a : best
        , links[0]);
      }
      return null;
    }
    // Generic text: return first heading or the longest-text link
    const heading = row.querySelector('h1,h2,h3,h4,h5,h6');
    if (heading) return heading;
    const links = [...row.querySelectorAll('a[href]')];
    if (links.length) {
      return links.reduce((best, a) =>
        (a.textContent || '').trim().length > (best.textContent || '').trim().length ? a : best
      , links[0]);
    }
    return null;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROW EXTRACTION — generic, no site-specific logic
// ═══════════════════════════════════════════════════════════════════════════════

function extractRows(fields) {
  if (!fields.length) return [];

  // Use the field with the most rows as the primary driver
  const primaryField = fields.reduce((a, b) => (b.rowCount || 0) > (a.rowCount || 0) ? b : a);
  const primarySel   = primaryField.rowSel;
  if (!primarySel) return [];

  const allRows = safeQueryAll(document, primarySel);
  console.log('[WS] extractRows — sel:', primarySel, '| raw count:', allRows.length);
  if (!allRows.length) return [];

  // Filter: keep only rows that contain an element matching the user's
  // fieldAbsSel (the selector built from the element they actually clicked).
  // This is the strong anchor — it eliminates nav, footer, filter rows that
  // happen to share the row selector but don't have the product field element.
  // Fall back to non-empty-value check only when fieldAbsSel is unavailable.
  const productRows = allRows.filter(row => {
    // Try fieldAbsSel anchor first (strong filter)
    const anchored = fields.some(f => {
      if (!f.fieldAbsSel) return false;
      const el = safeQuery(row, f.fieldAbsSel);
      if (!el) return false;
      return extractValue(el, f.type).trim().length > 0;
    });
    if (anchored) return true;

    // Fallback: require ALL fields with a relPath to find a non-empty, meaningful value
    const fieldsWithPath = fields.filter(f => f.fieldRelPath);
    if (!fieldsWithPath.length) return false;
    return fieldsWithPath.every(f => {
      const el = findInRow(row, f);
      if (!el) return false;
      const val = extractValue(el, f.type).trim();
      if (!val.length) return false;
      // For text/title fields, reject rows that only have noise values
      if (f.type === 'text') {
        // Too short to be a real product title (e.g. "Results", rating strings)
        if (/title|name|heading|product/i.test(f.name || '')) {
          if (val.length < 15) return false;
          if (/^\d+(\.\d+)?\s*out\s*of\s*\d+/i.test(val)) return false;
          if (/^see\s+options?$/i.test(val)) return false;
          if (/^\d+\s+new\s+offer/i.test(val)) return false;
        }
      }
      return true;
    });
  });

  console.log('[WS] extractRows — product rows after filter:', productRows.length);

  const results = [];
  for (let i = 0; i < productRows.length; i++) {
    const primaryRow = productRows[i];
    const record = {};
    let filled = 0;
    for (const f of fields) {
      let row = primaryRow;
      // If this field's rowSel differs, find the secondary container that
      // either contains or is contained by the primary row.
      if (f.rowSel && f.rowSel !== primarySel) {
        const secRow = safeQuery(primaryRow, f.rowSel) ||
                       primaryRow.closest(f.rowSel) ||
                       safeQueryAll(document, f.rowSel)[i];
        if (secRow) row = secRow;
      }
      const el  = findInRow(row, f);
      const val = extractValue(el, f.type);
      record[f.name] = val;
      if (val.trim().length > 0) filled++;
    }
    if (filled > 0) results.push(record);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WAIT / LAZY-IMAGE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function waitForRows(sel) {
  return new Promise(resolve => {
    if (!sel) { resolve([]); return; }
    const existing = safeQueryAll(document, sel);
    if (existing.length > 0) { resolve(existing); return; }
    let resolved = false;
    const done = rows => {
      if (resolved) return;
      resolved = true; observer.disconnect(); clearTimeout(timer); resolve(rows);
    };
    const observer = new MutationObserver(() => {
      const r = safeQueryAll(document, sel);
      if (r.length > 0) done(r);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => done(safeQueryAll(document, sel)), 30000);
  });
}

function scrollIntoViewAndWait(el) {
  return new Promise(resolve => {
    if (!el) { resolve(); return; }
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    setTimeout(resolve, 120);
  });
}

async function scrapeCurrentPage(fields) {
  if (!fields.length) return [];
  const primaryField = fields.reduce((a, b) => (b.rowCount || 0) > (a.rowCount || 0) ? b : a);
  await waitForRows(primaryField.rowSel);
  await new Promise(r => setTimeout(r, 600));

  let results = extractRows(fields);
  if (results.length === 0) {
    const t0 = Date.now(); let delay = 500;
    while (results.length === 0 && Date.now() - t0 < 30000) {
      await new Promise(r => setTimeout(r, delay));
      results = extractRows(fields);
      delay = Math.min(delay * 1.5, 3000);
    }
  }

  // Trigger lazy images
  const imgField = fields.find(f => f.type === 'image');
  if (imgField?.rowSel && results.length > 0) {
    for (const row of safeQueryAll(document, imgField.rowSel)) {
      const img = row.querySelector('img');
      if (img && !img.src && !img.getAttribute('data-src')) await scrollIntoViewAndWait(img);
    }
    results = extractRows(fields);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HUMAN DELAY / FINGERPRINT
// ═══════════════════════════════════════════════════════════════════════════════

function humanDelay(min = 800, max = 2000) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

function rowFingerprint(rec) {
  return Object.values(rec).join('\x00');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGINATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

const NEXT_PATTERNS = [
  'a[aria-label*="next" i]','button[aria-label*="next" i]',
  'a[title*="next" i]','button[title*="next" i]',
  // Amazon search pagination
  'a.s-pagination-next','a[class*="s-pagination-next"]',
  '.next a','.next-page a','.pagination-next a',
  'a.next','a.next-page','button.next',
  '[class*="next"] a','[class*="Next"] a',
  '[class*="next-page"]','[class*="nextPage"]',
  '[id*="next"] a','[id*="Next"] a',
  'a[rel="next"]',
  '.pagination a:last-child','[class*="pagination"] a:last-child',
  '[class*="pager"] a:last-child',
  '[data-page="next"]','[data-action="next"]',
];

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect(), s = window.getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && (r.width > 0 || r.height > 0);
}
function isDisabled(el) {
  return el.disabled || el.getAttribute('aria-disabled') === 'true' ||
    /\bdisabled\b|\binactive\b/i.test(el.getAttribute('class') || '');
}

function findNextButton() {
  for (const sel of NEXT_PATTERNS) {
    try { const el = document.querySelector(sel); if (el && isVisible(el) && !isDisabled(el)) return el; } catch (_) {}
  }
  for (const el of document.querySelectorAll('a,button')) {
    if (!isVisible(el) || isDisabled(el)) continue;
    const text = (el.innerText || el.textContent || '').trim();
    // Match standalone or combined: "Next", "Next Page", "Next ›", "Next »", etc.
    if (/\bnext\b/i.test(text) || /^[›»→>]$/.test(text) || /^>>$/.test(text)) return el;
    if (/next/i.test(el.getAttribute('aria-label') || '')) return el;
  }
  return null;
}

function waitForPageChange(prevUrl, primarySel) {
  // Record the current row fingerprints so we can detect content replacement,
  // not just row presence (which could still be the old page's rows in SPA).
  const prevRowTexts = new Set(
    safeQueryAll(document, primarySel).map(el => (el.textContent || '').trim().slice(0, 80))
  );

  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; obs.disconnect(); clearTimeout(t); resolve(); } };
    const obs = new MutationObserver(() => {
      if (window.location.href !== prevUrl) { finish(); return; }
      const newRows = safeQueryAll(document, primarySel);
      if (newRows.length > 0) {
        // Require that the MAJORITY of visible rows are new, not just the first
        const newCount = newRows.filter(r =>
          !prevRowTexts.has((r.textContent || '').trim().slice(0, 80))
        ).length;
        if (newCount >= Math.ceil(newRows.length / 2)) finish();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const t = setTimeout(finish, 15000);
  });
}

let paginationStopped = false;
let paginationPaused  = false;

function waitWhilePaused(checkStopped) {
  return new Promise(resolve => {
    const id = setInterval(() => {
      if (checkStopped() || (!paginationPaused && !scrollPaused)) { clearInterval(id); resolve(); }
    }, 300);
  });
}

async function paginationScrape(fields, onProgress) {
  paginationStopped = false;
  paginationPaused  = false;
  const allData = new Map();
  const primary = fields.reduce((a, b) => (b.rowCount || 0) > (a.rowCount || 0) ? b : a);
  let pageNum = 1;

  while (!paginationStopped) {
    await waitForRows(primary.rowSel);
    await humanDelay(400, 800);
    extractRows(fields).forEach(r => { const fp = rowFingerprint(r); if (!allData.has(fp)) allData.set(fp, r); });
    onProgress([...allData.values()], pageNum);

    // Pause checkpoint
    if (paginationPaused) await waitWhilePaused(() => paginationStopped);
    if (paginationStopped) break;

    const nextBtn = findNextButton();
    if (!nextBtn) break;
    await humanDelay(800, 2000);
    if (paginationStopped) break;
    const prevUrl = window.location.href;
    nextBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
    await new Promise(r => setTimeout(r, 200));
    nextBtn.click();
    pageNum++;
    await waitForPageChange(prevUrl, primary.rowSel);
    await humanDelay(600, 1200);
  }
  return [...allData.values()];
}

// ═══════════════════════════════════════════════════════════════════════════════
// INFINITE SCROLL ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

let scrollStopped = false;
let scrollPaused  = false;

async function triggerLazyImages(fields, knownCount) {
  const imgField = fields.find(f => f.type === 'image');
  if (!imgField?.rowSel) return;
  const rows = safeQueryAll(document, imgField.rowSel).slice(knownCount);
  for (const row of rows) {
    if (scrollStopped) break;
    const img = row.querySelector('img');
    if (img && !img.src && !img.getAttribute('data-src')) await scrollIntoViewAndWait(img);
  }
}

async function scrollAndScrape(fields, onProgress) {
  scrollStopped = false;
  scrollPaused  = false;
  const allData = new Map();
  const hasImg  = fields.some(f => f.type === 'image');
  let processedImgRows = 0;

  (await scrapeCurrentPage(fields)).forEach(r => allData.set(rowFingerprint(r), r));
  if (hasImg) { const f = fields.find(f => f.type === 'image'); processedImgRows = f?.rowSel ? safeQueryAll(document, f.rowSel).length : 0; }
  onProgress([...allData.values()]);

  let stagnantPasses = 0;
  while (!scrollStopped) {
    // Pause checkpoint
    if (scrollPaused) await waitWhilePaused(() => scrollStopped);
    if (scrollStopped) break;

    const before = document.body.scrollHeight;
    await humanDelay(600, 1800);
    if (scrollStopped) break;
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; obs.disconnect(); clearTimeout(t); resolve(); } };
      const obs = new MutationObserver(() => { if (document.body.scrollHeight > before + 10) finish(); });
      obs.observe(document.body, { childList: true, subtree: true });
      const t = setTimeout(finish, 3000);
    });
    await humanDelay(400, 900);
    if (scrollStopped) break;
    const after = document.body.scrollHeight;
    if (after <= before + 10) { if (++stagnantPasses >= 5) break; } else { stagnantPasses = 0; }
    if (hasImg && !scrollStopped) {
      await triggerLazyImages(fields, processedImgRows);
      const f = fields.find(f => f.type === 'image'); processedImgRows = f?.rowSel ? safeQueryAll(document, f.rowSel).length : processedImgRows;
    }
    let added = 0;
    extractRows(fields).forEach(r => { const fp = rowFingerprint(r); if (!allData.has(fp)) { allData.set(fp, r); added++; } });
    onProgress([...allData.values()]);
    console.log('[WS] scroll pass — new:', added, '| total:', allData.size);
  }
  return [...allData.values()];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELECTION MODE
// ═══════════════════════════════════════════════════════════════════════════════

let isSelecting = false, hoveredEl = null;

function onMouseOver(e) {
  if (!isSelecting) return;
  e.stopPropagation();
  if (hoveredEl && hoveredEl !== e.target) hoveredEl.classList.remove('wse-highlight');
  hoveredEl = e.target;
  hoveredEl.classList.add('wse-highlight');
  showTooltip(hoveredEl, e.clientX, e.clientY);
}
function onMouseOut(e) {
  if (!isSelecting) return;
  e.target.classList.remove('wse-highlight');
  hideTooltip();
}
function onClick(e) {
  if (!isSelecting) return;
  e.preventDefault(); e.stopPropagation();
  e.target.classList.remove('wse-highlight');
  hideTooltip();
  stopSelectionMode();
  showFieldDialog(e.target);
}
function onKeyDown(e) {
  if (e.key === 'Escape') {
    if (dialog) { closeDialog(); return; }
    if (isSelecting) { stopSelectionMode(); safeSendMessage({ action: 'selectionStopped' }); }
  }
}

function onMouseMove(e) {
  if (!isSelecting || !hoveredEl) return;
  showTooltip(hoveredEl, e.clientX, e.clientY);
}

function startSelectionMode() {
  isSelecting = true;
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseout',  onMouseOut,  true);
  document.addEventListener('click',     onClick,     true);
  document.addEventListener('keydown',   onKeyDown,   true);
  document.body.style.cursor = 'crosshair';
}
function stopSelectionMode() {
  isSelecting = false;
  document.removeEventListener('mouseover', onMouseOver, true);
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('mouseout',  onMouseOut,  true);
  document.removeEventListener('click',     onClick,     true);
  document.removeEventListener('keydown',   onKeyDown,   true);
  if (hoveredEl) { hoveredEl.classList.remove('wse-highlight'); hoveredEl = null; }
  hideTooltip();
  document.body.style.cursor = '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// M11: AI AUTO-DETECTION
// Scans the page DOM for repeating structural patterns, scores candidates,
// and returns field suggestions without any manual user interaction.
// ═══════════════════════════════════════════════════════════════════════════════


function autoDetectFields() {
  // ── 1. Walk every element, score via IDS area×n² formula ─────────────────
  const SKIP_TAGS = new Set(['script','style','svg','path','noscript','head','meta','link','iframe','template','br','hr']);
  const NAV_TAGS  = new Set(['nav','header','footer']);
  const candidates = [];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => SKIP_TAGS.has(node.tagName.toLowerCase())
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT
  });

  let el;
  while ((el = walker.nextNode())) {
    if (NAV_TAGS.has(el.tagName.toLowerCase())) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/\b(nav|header|footer|sidebar|menu|breadcrumb|filter|facet|toolbar|banner|ad|ads|advertisement)\b/i.test(cls)) continue;

    const repeating = findRepeatingChildren(el);
    if (repeating.length < 3) continue;

    const score = scoreContainer(el, repeating);
    if (score > 0) candidates.push({ container: el, repeating, score });
  }

  if (!candidates.length) return null;

  // ── 2. Pick top candidate by IDS score ────────────────────────────────────
  candidates.sort((a, b) => b.score - a.score);
  const best      = candidates[0];
  const rowSel    = buildRowSelector(best.repeating[0]);
  const rowCount  = best.repeating.length;
  const sample    = best.repeating[0]; // representative row

  console.log('[WS] autoDetect — rowSel:', rowSel, '| count:', rowCount, '| score:', best.score);

  // ── 3. Probe representative row for common field types ───────────────────
  const suggestions = [];

  // Helper to build a suggestion with both relPath and absSel
  const makeSuggestion = (name, type, el) => ({
    name, type, rowSel,
    fieldRelPath: relativePath(el, sample),
    fieldAbsSel: buildFieldAbsSel(el, sample),
    rowCount,
  });

  // Title/Name — first heading, or longest-text <a>, or title-class element
  const titleEl = sample.querySelector('h1,h2,h3,h4,h5,h6') ||
                  (() => {
                    const links = [...sample.querySelectorAll('a[href]')];
                    return links.length ? links.reduce((b, a) =>
                      (a.textContent||'').trim().length > (b.textContent||'').trim().length ? a : b
                    , links[0]) : null;
                  })() ||
                  safeQuery(sample, '[class*="title" i],[class*="name" i],[class*="heading" i]');
  if (titleEl) suggestions.push(makeSuggestion('Title', 'text', titleEl));

  // Price — check .a-offscreen first (Amazon), then leaf nodes, then price-class container
  let priceEl = null;
  const aPriceEl = safeQuery(sample, '.a-price');
  if (aPriceEl) {
    const offscreen = aPriceEl.querySelector('.a-offscreen');
    if (offscreen) priceEl = aPriceEl; // use container; findPriceLeaf will drill into .a-offscreen
  }
  if (!priceEl) {
    for (const candidate of sample.querySelectorAll('span,div,p,strong,b,ins,del,[class*="price" i],[class*="amount" i],[class*="cost" i]')) {
      if (candidate.children.length > 0) continue;
      const t = (candidate.textContent || '').trim();
      if (t.length > 0 && t.length < 60 &&
          (/[\$£€₹¥]|Rs\.?|PKR|USD|EUR|INR|GBP|AED|SAR/i.test(t) || /\d{1,3}[,\.]\d{2,3}/.test(t))) {
        priceEl = candidate;
        break;
      }
    }
  }
  if (!priceEl) priceEl = safeQuery(sample, '[class*="price" i],[class*="amount" i],[class*="cost" i],[class*="sale" i]');
  if (priceEl && priceEl !== titleEl) suggestions.push(makeSuggestion('Price', 'price', priceEl));

  // Image
  const imgEl = sample.querySelector('img');
  if (imgEl) suggestions.push(makeSuggestion('Image', 'image', imgEl));

  // Link — first <a> with a meaningful href (only if not already used as title)
  const linkEl = sample.querySelector('a[href]');
  if (linkEl && linkEl !== titleEl) suggestions.push(makeSuggestion('Link', 'link', linkEl));

  // Rating — look for stars / review count patterns
  const ratingEl = safeQuery(sample, '[class*="rating" i],[class*="star" i],[class*="review" i],[aria-label*="rating" i],[aria-label*="stars" i]');
  if (ratingEl) suggestions.push(makeSuggestion('Rating', 'text', ratingEl));

  return suggestions.length ? { rowSel, rowCount, fields: suggestions } : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE LISTENER
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'ping') { sendResponse({ status: 'ok', url: window.location.href }); return true; }
  if (msg.action === 'startSelection') { startSelectionMode(); sendResponse({ status: 'ok' }); return true; }
  if (msg.action === 'stopSelection')  { stopSelectionMode();  sendResponse({ status: 'ok' }); return true; }

  if (msg.action === 'scrape') {
    scrapeCurrentPage(msg.fields).then(results => {
      safeStorageSet({ scrapedData: results }, () => {
        safeSendMessage({ action: 'scrapeComplete', count: results.length, data: results });
      });
      sendResponse({ status: 'ok', count: results.length });
    });
    return true;
  }

  if (msg.action === 'scrollScrape') {
    scrollAndScrape(msg.fields, data => {
      safeSendMessage({ action: 'scrapeProgress', count: data.length, data });
    }).then(results => {
      safeStorageSet({ scrapedData: results }, () => {
        safeSendMessage({ action: 'scrapeComplete', count: results.length, data: results });
      });
      sendResponse({ status: 'ok', count: results.length });
    });
    return true;
  }

  if (msg.action === 'stopScroll')  { scrollStopped = true;  scrollPaused = false; sendResponse({ status: 'ok' }); return true; }
  if (msg.action === 'pauseScroll') { scrollPaused  = true;  sendResponse({ status: 'ok' }); return true; }
  if (msg.action === 'resumeScroll'){ scrollPaused  = false; sendResponse({ status: 'ok' }); return true; }

  if (msg.action === 'paginationScrape') {
    paginationScrape(msg.fields, (data, page) => {
      safeSendMessage({ action: 'scrapeProgress', count: data.length, data, page });
    }).then(results => {
      safeStorageSet({ scrapedData: results }, () => {
        safeSendMessage({ action: 'scrapeComplete', count: results.length, data: results });
      });
      sendResponse({ status: 'ok', count: results.length });
    });
    return true;
  }

  if (msg.action === 'stopPagination')  { paginationStopped = true;  paginationPaused = false; sendResponse({ status: 'ok' }); return true; }
  if (msg.action === 'pausePagination') { paginationPaused  = true;  sendResponse({ status: 'ok' }); return true; }
  if (msg.action === 'resumePagination'){ paginationPaused  = false; sendResponse({ status: 'ok' }); return true; }

  if (msg.action === 'autoDetect') {
    // Run after a short delay so JS-rendered content has settled
    setTimeout(() => {
      const result = autoDetectFields();
      sendResponse(result || null);
    }, 800);
    return true;
  }
});
