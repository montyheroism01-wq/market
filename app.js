/* =============================================
   SMART MARKET LIST — APPLICATION LOGIC
   All data flows through Google Sheets via
   Apps Script Web App URL in config.js
   ============================================= */

'use strict';

// ══════════════════════════════════════════════
// GUARD: Check config URL
// ══════════════════════════════════════════════
function checkConfig() {
  if (typeof SCRIPT_URL === 'undefined' || SCRIPT_URL === 'YOUR_APPS_SCRIPT_URL_HERE' || !SCRIPT_URL.startsWith('http')) {
    const section = document.querySelector('.input-section');
    if (section) {
      const banner = document.createElement('div');
      banner.className = 'no-url-banner';
      banner.innerHTML = `
        ⚠️ <strong>Setup Required</strong><br>
        Open <code>config.js</code> and replace <code>YOUR_APPS_SCRIPT_URL_HERE</code>
        with your Google Apps Script Web App URL.<br>
        See the comments in <code>config.js</code> for step-by-step instructions.
      `;
      section.insertAdjacentElement('beforebegin', banner);
    }
    setSyncState('error', 'No URL');
    return false;
  }
  return true;
}

// ══════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════
let currentItem     = '';
let currentItemType = 'general'; // 'general' | 'oil' | 'water'
let currentUnit     = '';
let manualUnit      = false;
let isSaving        = false;
let items           = [];
let syncTimer       = null;
let configOk        = false;

// ══════════════════════════════════════════════
// DOM REFERENCES
// ══════════════════════════════════════════════
const $ = id => document.getElementById(id);

let DOM = {};

function bindDOM() {
  DOM = {
    itemInput:   $('item-input'),
    qtyInput:    $('qty-input'),
    qtyBox:      $('qty-box'),
    unitBtn:     $('unit-btn'),
    unitLabel:   $('unit-label'),
    oilOverlay:  $('oil-overlay'),
    itemsList:   $('items-list'),
    syncDot:     $('sync-dot'),
    syncText:    $('sync-text'),
    countBadge:  $('count-badge'),
    typeHint:    $('type-hint'),
    inputHint:   $('input-hint'),
    itemBox:     $('item-box'),
  };
}

// ══════════════════════════════════════════════
// API — ALL via GET params to avoid CORS issues
// ══════════════════════════════════════════════

async function apiFetch(params) {
  const qs = new URLSearchParams({ ...params, t: Date.now() });
  const res = await fetch(`${SCRIPT_URL}?${qs}`);
  return res.json();
}

async function apiGet() {
  return apiFetch({ action: 'get' });
}

async function apiAdd(item, qty, unit) {
  return apiFetch({ action: 'add', item, qty, unit });
}

async function apiTick(id) {
  return apiFetch({ action: 'tick', id });
}

// ══════════════════════════════════════════════
// SYNC
// ══════════════════════════════════════════════

let lastItemsStr = '';

async function fetchItems() {
  if (!configOk) return;
  try {
    const data = await apiGet();
    if (data.success) {
      items = data.items || [];
      const newItemsStr = JSON.stringify(items);
      // Only re-render if the data actually changed to prevent flickering
      if (newItemsStr !== lastItemsStr) {
        lastItemsStr = newItemsStr;
        renderItems();
      }
    } else {
      console.error('Fetch error');
    }
  } catch {
    console.error('Fetch failed (offline)');
  }
}

function startAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(fetchItems, 7000);
}

// ══════════════════════════════════════════════
// SMART DETECTION
// ══════════════════════════════════════════════

function detectType(text) {
  const t = text.toLowerCase().trim();
  if (/\boil\b|sarso|sarsoo|refine|তেল|tel\b/i.test(t)) return 'oil';
  if (/\bwater\b|pani\b|jal\b|পানি|पानी/i.test(t))       return 'water';
  return 'general';
}

function autoUnit(type, qty) {
  const n = parseFloat(qty);
  if (isNaN(n) || qty === '') return '';
  if (type === 'oil') {
    // 3+ digits → ml, else L
    return String(Math.round(Math.abs(n))).length >= 3 ? 'ml' : 'L';
  }
  if (type === 'water') return '';  // no unit for water
  // general: >50 → g, else kg
  return n > 50 ? 'g' : 'kg';
}

function toggleUnit(type, current) {
  // Volume cycle: L -> ml -> (empty/quantity) -> ₹ -> L
  if (type === 'oil' || type === 'water') {
    if (current === 'L') return 'ml';
    if (current === 'ml') return '';
    if (current === '') return '₹';
    return 'L';
  }
  // Weight/General cycle: kg -> g -> (empty/quantity) -> ₹ -> kg
  if (current === 'kg') return 'g';
  if (current === 'g') return '';
  if (current === '') return '₹';
  return 'kg';
}

function hintForType(type) {
  if (type === 'oil')   return '1–2 digits → L &nbsp;|&nbsp; 3 digits → ml';
  if (type === 'water') return 'Enter any quantity — no unit rule';
  return '1–50 → kg &nbsp;|&nbsp; above 50 → g';
}

// ══════════════════════════════════════════════
// EVENT HANDLERS
// ══════════════════════════════════════════════

function initEventHandlers() {

  // ── Live type detection hint ────────────────
  DOM.itemInput.addEventListener('input', () => {
    const val = DOM.itemInput.value.trim();
    if (!val) { DOM.typeHint.className = 'type-hint'; return; }
    const t = detectType(val);
    if (t === 'oil')   { DOM.typeHint.textContent = '🫙 Oil detected';   DOM.typeHint.className = 'type-hint show'; }
    else if (t === 'water') { DOM.typeHint.textContent = '💧 Water detected'; DOM.typeHint.className = 'type-hint show'; }
    else { DOM.typeHint.className = 'type-hint'; }
  });

  // ── Item name: Enter ────────────────────────
  DOM.itemInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== 'Go') return;
    e.preventDefault();
    const val = DOM.itemInput.value.trim();
    if (!val) return;

    currentItemType = detectType(val);

    if (currentItemType === 'oil') {
      currentItem = val;
      openOilModal();
    } else {
      currentItem = val;
      activateQtyBox();
    }
  });

  // ── Oil option buttons ───────────────────────
  $('sarso-btn').addEventListener('click', () => selectOil('Sarso Oil'));
  $('refine-btn').addEventListener('click', () => selectOil('Refine Oil'));

  // ── Close oil modal on backdrop click ───────
  DOM.oilOverlay.addEventListener('click', e => {
    if (e.target === DOM.oilOverlay) closeOilModal(true);
  });

  // ── Qty input: live unit update ──────────────
  DOM.qtyInput.addEventListener('input', () => {
    if (manualUnit) return;
    const v = DOM.qtyInput.value;
    currentUnit = autoUnit(currentItemType, v);
    DOM.unitLabel.textContent = currentUnit || ' ';
  });

  // ── Qty input: Enter to save ─────────────────
  DOM.qtyInput.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' && e.key !== 'Go') return;
    e.preventDefault();
    if (isSaving) return;
    const qty = DOM.qtyInput.value.trim();
    if (!qty) return;

    if (!manualUnit) {
      currentUnit = autoUnit(currentItemType, qty);
    }
    await saveItem(currentItem, qty, currentUnit);
  });

  // ── Unit toggle button ───────────────────────
  DOM.unitBtn.addEventListener('click', () => {
    manualUnit  = true;
    currentUnit = toggleUnit(currentItemType, currentUnit);
    DOM.unitLabel.textContent = currentUnit || ' ';
    DOM.unitBtn.classList.add('toggled');
    setTimeout(() => DOM.unitBtn.classList.remove('toggled'), 320);
  });

  // ── ESC closes oil modal ─────────────────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && DOM.oilOverlay.classList.contains('open')) {
      closeOilModal(true);
    }
  });
}

// ══════════════════════════════════════════════
// UI ACTIONS
// ══════════════════════════════════════════════

function selectOil(oilName) {
  currentItem     = oilName;
  currentItemType = 'oil';
  closeOilModal(false);
  activateQtyBox();
}

function openOilModal() {
  DOM.oilOverlay.classList.add('open');
  setTimeout(() => $('sarso-btn').focus(), 50);
}

function closeOilModal(clearItem = false) {
  DOM.oilOverlay.classList.remove('open');
  if (clearItem) {
    DOM.itemInput.value = '';
    DOM.typeHint.className = 'type-hint';
    currentItem = '';
  }
  DOM.itemInput.focus();
}

function activateQtyBox() {
  DOM.qtyBox.classList.add('active');
  DOM.qtyInput.value = '';
  DOM.unitLabel.textContent = ' ';
  manualUnit  = false;
  currentUnit = '';

  // Update helper hint
  DOM.inputHint.innerHTML = hintForType(currentItemType) + ' — press <kbd>Enter ↵</kbd> to save';

  // Double-RAF to ensure CSS transition triggers before focus
  requestAnimationFrame(() => requestAnimationFrame(() => {
    DOM.qtyInput.focus();
  }));
}

function resetToIdle(savedOk = false) {
  currentItem     = '';
  currentItemType = 'general';
  currentUnit     = '';
  manualUnit      = false;
  isSaving        = false;
  DOM.itemInput.value = '';
  DOM.qtyInput.value  = '';
  DOM.unitLabel.textContent = ' ';
  DOM.typeHint.className    = 'type-hint';
  DOM.qtyBox.classList.remove('active');
  DOM.inputHint.innerHTML = 'Type item name and press <kbd>Enter ↵</kbd>';

  if (savedOk) {
    DOM.itemBox.classList.add('saved');
    DOM.itemBox.addEventListener('animationend', () => DOM.itemBox.classList.remove('saved'), { once: true });
  }

  requestAnimationFrame(() => DOM.itemInput.focus());
}

// ══════════════════════════════════════════════
// SAVE ITEM
// ══════════════════════════════════════════════

async function saveItem(item, qty, unit) {
  if (isSaving || !configOk) return;
  isSaving = true;

  // Optimistic count bump
  animateCount(parseInt(DOM.countBadge.textContent || '0') + 1);

  try {
    const res = await apiAdd(item, qty, unit);
    if (res.success) {
      resetToIdle(true);
      await fetchItems();          // re-pull authoritative list
    } else {
      throw new Error(res.error || 'Add failed');
    }
  } catch (err) {
    console.error('Save error:', err);
    animateCount(parseInt(DOM.countBadge.textContent || '1') - 1);
    isSaving = false;
  }
}

// ══════════════════════════════════════════════
// TICK (mark purchased)
// ══════════════════════════════════════════════

async function handleTick(id) {
  const card = $(`item-${id}`);
  if (!card) return;

  // Optimistic UI removal
  card.classList.add('ticking');
  setTimeout(() => card && card.remove(), 490);
  animateCount(Math.max(0, parseInt(DOM.countBadge.textContent || '1') - 1));

  try {
    await apiTick(id);
    // Quietly sync in background after 1.5s
    setTimeout(fetchItems, 1500);
  } catch {
    // If error, pull fresh data to restore
    await fetchItems();
  }
}

// expose to inline onclick
window.handleTick = handleTick;

// ══════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════

function renderItems() {
  animateCount(items.length);

  if (items.length === 0) {
    DOM.itemsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🛒</div>
        <h2>Your list is empty</h2>
        <p>Add items using the input above</p>
      </div>
    `;
    return;
  }

  // Group by date (newest first)
  const groups = {};
  items.forEach(it => {
    const k = it.date || todayStr();
    if (!groups[k]) groups[k] = [];
    groups[k].push(it);
  });

  const sortedDates = Object.keys(groups).sort((a, b) => parseIndianDate(b) - parseIndianDate(a));

  DOM.itemsList.innerHTML = '';
  let delay = 0;

  sortedDates.forEach(date => {
    const grp = groups[date];

    // Date header
    const hdr = document.createElement('div');
    hdr.className = 'date-hdr';
    hdr.innerHTML = `
      <span class="date-lbl">${formatDateLabel(date)}</span>
      <span class="date-cnt">${grp.length} item${grp.length !== 1 ? 's' : ''}</span>
    `;
    DOM.itemsList.appendChild(hdr);

    grp.forEach(it => {
      const card = buildCard(it, delay);
      DOM.itemsList.appendChild(card);
      delay += 55;
    });
  });
}

function buildCard(it, delay = 0) {
  const card = document.createElement('div');
  card.className = 'item-card';
  card.id = `item-${it.id}`;
  card.style.animationDelay = `${delay}ms`;

  const displayQty = it.unit
    ? `${esc(it.quantity)} ${esc(it.unit)}`
    : esc(it.quantity);

  card.innerHTML = `
    <div class="item-body">
      <div class="item-name">${esc(it.item)}</div>
      <div class="item-qty-row">
        <span class="qty-pill">${displayQty}</span>
      </div>
    </div>
    <button
      class="tick-btn"
      onclick="handleTick('${esc(it.id)}')"
      aria-label="Mark ${esc(it.item)} as purchased"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="3" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </button>
  `;
  return card;
}

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function todayStr() {
  const d = new Date();
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function parseIndianDate(str) {
  if (!str || str === 'Today') return new Date();
  const p = String(str).split('/');
  if (p.length === 3) return new Date(+p[2], +p[1] - 1, +p[0]);
  return new Date(str);
}

function formatDateLabel(dateStr) {
  const today = todayStr();
  if (!dateStr || dateStr === today || dateStr === 'Today') return '📅 Today';

  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yest = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  if (dateStr === yest) return '📅 Yesterday';

  try {
    const parsed = parseIndianDate(dateStr);
    if (isNaN(parsed)) return `📅 ${dateStr}`;
    return '📅 ' + parsed.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  } catch {
    return `📅 ${dateStr}`;
  }
}

function animateCount(n) {
  DOM.countBadge.textContent = n;
  DOM.countBadge.classList.remove('bump');
  void DOM.countBadge.offsetWidth; // reflow to restart animation
  DOM.countBadge.classList.add('bump');
}

// Sync state removed

// ══════════════════════════════════════════════
// PARTICLES (lightweight CSS-driven)
// ══════════════════════════════════════════════

function spawnParticles() {
  // Disabled as per user request to keep UI clean, simple, and lag-free
}

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  bindDOM();
  spawnParticles();
  initEventHandlers();

  configOk = checkConfig();
  if (!configOk) return;

  await fetchItems();
  startAutoSync();
  DOM.itemInput.focus();
});
