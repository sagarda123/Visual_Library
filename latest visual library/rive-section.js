// ══════════════════════════════════════════════════════════════
// Rive Animations — vanilla rebuild of rive-animation-repo (React)
// on the Groww Visual Library design system.
// ══════════════════════════════════════════════════════════════
import {
  getAllAnimations, getAnimation, addAnimation, deleteAnimation,
  formatBytes, generateId,
} from './lib/rive/db.js?v=phase-b-storage-ledger-1';
import { seedSamplesIfEmpty } from './lib/rive/seed.js?v=phase-b-storage-ledger-1';
import {
  buildRiveHookParams, getArtboardDimensions, getPlaybackDuration,
  ensurePlaybackStarted, primePausedPlaybackPreview, resetPlaybackToFirstFrame, scrubRive,
  resolvePlaybackArtboard,
} from './lib/rive/rivePlayback.js?v=phase-b-universal-theme-1';
import { inspectRive, emptyMetadata, totalMetadataItems } from './lib/rive/riveInspect.js?v=phase-b-universal-theme-1';
import { applyThemeInput, isThemeSwitcherAnimation, findThemeSwitcherSM, resolveThemeInput } from './lib/rive/themeSwitcher.js?v=phase-b-universal-theme-1';
import { PLATFORMS, ASSIGNABLE_CATEGORIES, MAX_FILE_SIZE_BYTES } from './lib/rive/constants.js?v=phase-b-universal-theme-1';
import { validate as validateNaming } from './lib/rive/namingRules.js?v=1';
import { requireAuth, getSession } from './lib/auth.js?v=1';
import {
  BUILTIN_CATEGORIES, loadCustom, saveCustom, buildCategories, slugify, humanize,
  sanitizeCustomName, slugifyCategoryId, countActiveFilters, pruneActiveFilters, filterAnimations,
} from './lib/rive/filters.js?v=phase-b-universal-theme-1';
import {
  collectSafeZipEntries, assertInflatedZipEntrySize,
} from './lib/rive/zipSafety.js?v=phase-b-zip-safety-1';

const Rive = window.rive.Rive;

/** Hooks supplied by Groww Visual Library (app.js). */
let integration = { onCountChange: null, onSearchClear: null };

/* ── tiny DOM helpers ─────────────────────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The Visual Library's groww-huge-standard font lacks some glyph names the
// original rive repo used. Remap those to existing glyphs (or inline SVG).
const ICON_REMAP = {
  'search-01': 'global-search', play: 'play-circle', pause: 'pause-circle',
  'copy-01': 'copy-02', 'zip-01': 'folder-file-storage', 'file-01': 'file-02',
  'layers-02': 'grid-02', 'workflow-square-01': 'share-08', 'paint-board': 'paint-brush-02',
  flash: 'energy',
};
const ICON_SVG = {
  repeat: '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
};
const icon = (name, size = 'small') => {
  if (ICON_SVG[name]) return `<span class="mds-iconview mds-iconview--${size}">${ICON_SVG[name]}</span>`;
  return `<span class="mds-iconview mds-iconview--${size}"><i class="gh-standard-${ICON_REMAP[name] || name}"></i></span>`;
};

/**
 * Red error indicator shown beside names that violate conventions.html
 * (encoded in lib/rive/namingRules.js). Empty string when the name is valid.
 */
function namingBadge(entityType, name) {
  const res = validateNaming(entityType, name);
  if (res.ok) return '';
  const tip = res.violations.map((v) => `${v.message} — see conventions: ${v.section}`).join('\n');
  return `<span class="rv-name-err" role="img" aria-label="Naming convention error" title="${esc(tip)}">${'⛔'}</span>`;
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#rv-toast');
  t.textContent = msg;
  t.className = `rv-toast ${kind}`;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hidden'), 250); }, 1800);
  t.classList.remove('hidden');
}

/* ══════════════ THEME STORE ══════════════ */
const THEME_KEY = 'rive-theme';
const THEME_EVENT = 'groww-theme-change';
function readThemePreference() {
  const globalTheme = window.GrowwVisualTheme?.get?.();
  if (globalTheme === 'dark' || globalTheme === 'light') return globalTheme;
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
const theme = {
  value: readThemePreference(),
  apply() {
    document.documentElement.classList.toggle('dark', this.value === 'dark');
    try { localStorage.setItem(THEME_KEY, this.value); } catch (_) {}
    const ico = $('#rv-theme-ico');
    if (ico) ico.className = `gh-standard-${this.value === 'dark' ? 'sun-01' : 'moon-02'}`;
    listeners.theme.forEach((f) => f(this.value));
  },
  set(value) {
    this.value = value === 'dark' ? 'dark' : 'light';
    this.apply();
  },
  toggle() {
    this.set(this.value === 'dark' ? 'light' : 'dark');
    return this.value;
  },
};
let globalThemeBridgeWired = false;
function wireGlobalThemeBridge() {
  if (globalThemeBridgeWired) return;
  globalThemeBridgeWired = true;
  window.addEventListener(THEME_EVENT, event => {
    const next = event.detail?.theme;
    if (next === 'dark' || next === 'light') theme.set(next);
  });
}

/* ══════════════ ANIMATIONS STORE ══════════════ */
const listeners = { items: new Set(), theme: new Set() };
let shellWired = false;
let itemsListenerWired = false;
let storeInitPromise = null;
const store = {
  items: [],
  loading: true,
  async refresh() {
    const all = await getAllAnimations();
    all.sort((a, b) => {
      const ao = Number.isFinite(a.sampleOrder) ? a.sampleOrder : null;
      const bo = Number.isFinite(b.sampleOrder) ? b.sampleOrder : null;
      if (ao != null && bo != null && ao !== bo) return ao - bo;
      const byDate = new Date(b.uploadedAt) - new Date(a.uploadedAt);
      return byDate || String(a.fileName || '').localeCompare(String(b.fileName || ''));
    });
    this.items = all;
    listeners.items.forEach((f) => f());
  },
  async init() {
    this.loading = true;
    try { await seedSamplesIfEmpty(); } catch (e) { console.warn('Seed skipped:', e); }
    await this.refresh();
    this.loading = false;
    integration.onCountChange?.(this.items.length);
    listeners.items.forEach((f) => f());
  },
  async add(record) {
    await addAnimation(record, {
      eventType: 'uploaded',
      reason: 'user-upload',
      source: record.storageBackend || 'local-indexeddb',
      actor: record.uploadedBy || null,
    });
    await this.refresh();
  },
  async remove(id) {
    await deleteAnimation(id, {
      reason: 'user-delete',
      source: 'animation-library-ui',
    });
    await this.refresh();
  },
  async update(id, patch) {
    const existing = await getAnimation(id);
    if (!existing) return null;
    const next = { ...existing, ...patch };
      await addAnimation(next);
    await this.refresh();
    return next;
  },
};
const onItems = (f) => { listeners.items.add(f); return () => listeners.items.delete(f); };

/* ══════════════ FILTERS STORE ══════════════ */
const filters = {
  custom: loadCustom(),
  active: {},
  get categories() { return buildCategories(this.custom); },
  get count() { return countActiveFilters(this.active); },
  _save() { saveCustom(this.custom); },
  _changed() { renderSubnav(); renderGrid(); },
  persistPrune() {
    const pruned = pruneActiveFilters(this.active, this.categories);
    if (pruned !== this.active) this.active = pruned;
  },
  toggleOption(cat, val) {
    const next = { ...this.active };
    const list = next[cat] ? [...next[cat]] : [];
    const i = list.indexOf(val);
    if (i >= 0) list.splice(i, 1); else list.push(val);
    if (list.length) next[cat] = list; else delete next[cat];
    this.active = next; this._changed();
  },
  removeOption(cat, val) {
    if (!this.active[cat]) return;
    const list = this.active[cat].filter((v) => v !== val);
    const next = { ...this.active };
    if (list.length) next[cat] = list; else delete next[cat];
    this.active = next; this._changed();
  },
  clearAll() { this.active = {}; this._changed(); },
  addCustomOption(cat, raw) {
    const display = sanitizeCustomName(raw);
    if (!display) return { ok: false, error: 'Name is required' };
    const slug = slugify(display);
    if (!slug) return { ok: false, error: 'Use letters or numbers for option names' };
    const category = this.categories.find((c) => c.id === cat);
    if (!category) return { ok: false, error: 'Category not found' };
    if (category.options.some((o) => o.value === slug || o.display.toLowerCase() === display.toLowerCase()))
      return { ok: false, error: 'That option already exists in this category' };
    this.custom.renames[cat] = this.custom.renames[cat] || {};
    this.custom.renames[cat][slug] = display;
    if (BUILTIN_CATEGORIES.some((b) => b.id === cat)) {
      this.custom.customOptions[cat] = [...(this.custom.customOptions[cat] || []), slug];
    } else {
      const cc = this.custom.customCategories.find((c) => c.id === cat);
      if (cc) cc.options = [...cc.options, slug];
    }
    this._save(); this._changed(); return { ok: true };
  },
  addCustomCategory(raw) {
    const label = sanitizeCustomName(raw);
    if (!label) return { ok: false, error: 'Category name is required' };
    if (this.categories.some((c) => c.label.toLowerCase() === label.toLowerCase()))
      return { ok: false, error: 'A category with that name already exists' };
    const id = slugifyCategoryId(label);
    this.custom.customCategories = [...this.custom.customCategories, { id, label, options: [] }];
    this._save(); this._changed(); return { ok: true, id };
  },
  removeCustomOption(cat, val) {
    if (this.custom.renames[cat]) { delete this.custom.renames[cat][val]; if (!Object.keys(this.custom.renames[cat]).length) delete this.custom.renames[cat]; }
    if (BUILTIN_CATEGORIES.some((b) => b.id === cat)) {
      const co = this.custom.customOptions[cat] || [];
      if (co.includes(val)) this.custom.customOptions[cat] = co.filter((v) => v !== val);
      else { this.custom.hiddenBuiltins[cat] = [...new Set([...(this.custom.hiddenBuiltins[cat] || []), val])]; }
    } else {
      const cc = this.custom.customCategories.find((c) => c.id === cat);
      if (cc) cc.options = cc.options.filter((v) => v !== val);
    }
    this.removeOption(cat, val);
    this._save(); this.persistPrune(); this._changed();
  },
  removeCustomCategory(cat) {
    if (BUILTIN_CATEGORIES.some((b) => b.id === cat)) return;
    this.custom.customCategories = this.custom.customCategories.filter((c) => c.id !== cat);
    delete this.custom.renames[cat]; delete this.custom.hiddenBuiltins[cat];
    this._save(); this.persistPrune(); this._changed();
  },
  renameOption(cat, value, raw) {
    const name = sanitizeCustomName(raw);
    const category = this.categories.find((c) => c.id === cat);
    if (!category) return { ok: false, error: 'Category not found' };
    if (!category.options.some((o) => o.value === value)) return { ok: false, error: 'Option not found' };
    if (!name) {
      if (this.custom.renames[cat]) { delete this.custom.renames[cat][value]; if (!Object.keys(this.custom.renames[cat]).length) delete this.custom.renames[cat]; }
      this._save(); this._changed(); return { ok: true };
    }
    if (category.options.some((o) => o.value !== value && (o.display === name || o.value === name)))
      return { ok: false, error: 'Another option already uses that label' };
    this.custom.renames[cat] = this.custom.renames[cat] || {};
    this.custom.renames[cat][value] = name;
    this._save(); this._changed(); return { ok: true };
  },
};

/* ══════════════ ZIP (JSZip) ══════════════ */
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' };
const kindByExt = (e) => (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(e) ? 'image' : ['ttf', 'otf', 'woff', 'woff2'].includes(e) ? 'font' : ['mp3', 'wav', 'ogg', 'm4a'].includes(e) ? 'audio' : 'other');
const normPath = (p) => String(p).replace(/\\/g, '/').replace(/^\/+/, '');

async function extractZipBundle(file) {
  const buf = await file.arrayBuffer();
  if (buf.byteLength > 50 * 1024 * 1024) throw new Error('ZIP is too large (max 50 MB)');
  let zip;
  try { zip = await JSZip.loadAsync(buf); } catch (_) { throw new Error('Could not read ZIP archive'); }
  const files = collectSafeZipEntries(Object.values(zip.files));
  const rivs = [], sidecars = [];
  let inflatedBytes = 0;
  for (const f of files) {
    const path = normPath(f.name);
    const bytes = await f.async('uint8array');
    inflatedBytes = assertInflatedZipEntrySize(path, bytes.byteLength, inflatedBytes);
    if (!bytes.length) continue;
    const name = path.split('/').pop();
    if (/\.riv$/i.test(name)) rivs.push({ path, name, bytes });
    else {
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      sidecars.push({ path, name, ext, bytes, mimeType: MIME_BY_EXT[ext] || 'application/octet-stream', kind: kindByExt(ext), size: bytes.length, sizeReadable: formatBytes(bytes.length) });
    }
  }
  if (!rivs.length) throw new Error('No .riv file found in ZIP');
  return rivs.map((riv) => {
    const prefix = riv.path.includes('/') ? riv.path.slice(0, riv.path.lastIndexOf('/') + 1) : '';
    let chosen = sidecars.filter((a) => !prefix || a.path.startsWith(prefix) || !a.path.includes('/'));
    if (!chosen.length) chosen = sidecars;
    const bundleAssets = chosen.map((a) => ({ path: a.path, name: a.name, ext: a.ext, mimeType: a.mimeType, kind: a.kind, size: a.size, sizeReadable: a.sizeReadable, fileBlob: new Blob([a.bytes], { type: a.mimeType }) }));
    return { file: new File([riv.bytes], riv.name, { type: 'application/octet-stream' }), sourceType: 'zip', sourceZipName: file.name, rivPath: riv.path, bundleAssets };
  });
}

function triggerBlobDownload(blob, filename) {
  // File names originate from user uploads / zip entries — strip characters
  // that are path separators or invalid on common filesystems.
  const safeName = String(filename || 'download').replace(/[<>:"|?*\\/\u0000-\u001f]/g, '_');
  const url = URL.createObjectURL(blob);
  const a = el('a'); a.href = url; a.download = safeName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function downloadSingleBundledAsset(asset) {
  if (!asset?.fileBlob) throw new Error('Asset unavailable');
  triggerBlobDownload(asset.fileBlob, asset.name);
}
async function downloadBundledAssetsZip(animation) {
  const assets = animation.bundleAssets || [];
  if (!assets.length) throw new Error('No bundled assets to download');
  const zip = new JSZip();
  for (const a of assets) zip.file(normPath(a.path || a.name), a.fileBlob);
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerBlobDownload(blob, `${animation.fileName || 'animation'}-assets.zip`);
}
async function downloadFullBundleZip(animation) {
  const zip = new JSZip();
  zip.file(normPath(animation.rivPath || `${animation.fileName || 'animation'}.riv`), animation.fileBlob);
  for (const a of (animation.bundleAssets || [])) zip.file(normPath(a.path || a.name), a.fileBlob);
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerBlobDownload(blob, `${animation.fileName || 'animation'}-bundle.zip`);
}

/* ══════════════ HOVER-PLAY TILE GRID ══════════════ */
let platform = 'All';
let query = '';
let debouncedQuery = '';
let debounceTimer;
let tileRenderToken = 0;
const tileInstances = new Map(); // id -> { rive, buffer }

// Cache of the resolved artboard record per animation id, so the (possibly
// expensive) artboard probe runs at most once per file per session.
const artboardChoiceCache = new Map();

async function resolveChosenArtboard(animation) {
  const key = animation?.id;
  if (key && artboardChoiceCache.has(key)) return artboardChoiceCache.get(key);

  let artboards = animation?.artboards;
  let defaultArtboard = animation?.defaultArtboard ?? animation?.metadata?.defaultArtboard ?? null;

  // Seeded records carry no artboard metadata until inspected — probe the file
  // once so multi-artboard files (empty default + real named artboard) resolve.
  if ((!artboards || !artboards.length) && animation?.fileBlob) {
    try {
      const meta = await inspectRive(animation.fileBlob, { bundleAssets: animation.bundleAssets });
      artboards = meta.artboards;
      defaultArtboard = meta.defaultArtboard;
      // Backfill in-memory so autoBind (rivePlayback) sees real VM presence
      // for seeded records that were stored before inspection.
      if (!animation.viewModels?.length && meta.viewModels?.length) {
        animation.viewModels = meta.viewModels;
      }
    } catch (_) { /* fall back to runtime default artboard */ }
  }

  const chosen = resolvePlaybackArtboard(artboards, defaultArtboard);
  if (key) artboardChoiceCache.set(key, chosen);
  return chosen;
}

async function buildRive(buffer, animation, canvas, autoplay, onLoad) {
  const chosenArtboard = await resolveChosenArtboard(animation);
  const params = buildRiveHookParams(buffer, animation, { autoplay }, chosenArtboard);
  if (!params) return null;
  return new Rive({ ...params, canvas, onLoad });
}

function cleanupTiles() {
  tileRenderToken += 1;
  tileInstances.forEach((inst) => { try { inst.rive?.cleanup(); } catch (_) {} });
  tileInstances.clear();
}

function computeFiltered() {
  let list = store.items;
  if (platform !== 'All') list = list.filter((i) => i.platform === platform);
  list = filterAnimations(list, filters.active);
  if (debouncedQuery) {
    const fuse = new Fuse(list, { keys: ['fileName', 'tags', 'description', 'category'], threshold: 0.35, ignoreLocation: true });
    list = fuse.search(debouncedQuery).map((r) => r.item);
  }
  return list;
}

function tileEl(a) {
  const tile = el('div', 'rv-tile');
  const renderToken = tileRenderToken;
  tile.setAttribute('role', 'button'); tile.tabIndex = 0;
  tile.setAttribute('aria-label', `Open ${a.fileName}`);
  tile.innerHTML = `
    <div class="rv-tile-preview"><div class="rv-tile-preview-inner"><canvas class="rv-tile-canvas"></canvas></div>
      <div class="rv-tile-play">${icon('play', 'xsmall')}</div></div>
    <div class="rv-tile-foot">
      <div style="min-width:0">
        <div class="rv-tile-name">${esc(a.fileName)}${namingBadge('file', a.fileName)}</div>
        <div class="rv-tile-meta"><span class="rv-tile-size">${esc(a.fileSizeReadable || '')}</span></div>
      </div>
      <button class="rv-tile-copy" aria-label="Copy share link" title="Copy share link">${icon('link-05', 'small')}</button>
    </div>`;
  const canvas = $('.rv-tile-canvas', tile);
  // lazy-load + hover play
  (async () => {
    try {
      const buffer = await a.fileBlob.arrayBuffer();
      const isTS = isThemeSwitcherAnimation(a);
      let rive;
      rive = await buildRive(buffer, a, canvas, false, () => {
        if (!tile.isConnected || renderToken !== tileRenderToken) return;
        try { primePausedPlaybackPreview(rive, isTS); } catch (_) {}
        tile.classList.add('is-ready');
        if (tile.matches(':hover')) {
          try { ensurePlaybackStarted(rive, isTS); } catch (_) {}
        }
      });
      if (!tile.isConnected || renderToken !== tileRenderToken) {
        try { rive?.cleanup(); } catch (_) {}
        return;
      }
      tileInstances.set(a.id, { rive, isTS });
    } catch (_) {}
  })();
  tile.addEventListener('mouseenter', () => {
    const inst = tileInstances.get(a.id);
    if (inst?.rive) {
      try { ensurePlaybackStarted(inst.rive, inst.isTS); } catch (_) {}
    }
  });
  tile.addEventListener('mouseleave', () => {
    const inst = tileInstances.get(a.id);
    if (inst?.rive) {
      try { resetPlaybackToFirstFrame(inst.rive, inst.isTS); } catch (_) {}
    }
  });
  tile.addEventListener('click', (e) => { if (e.target.closest('.rv-tile-copy')) return; openViewer(a); });
  tile.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(a); } });
  $('.rv-tile-copy', tile).addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(shareLinkFor(a.id));
      toast('Link copied');
    } catch (_) { toast('Could not copy link', 'err'); }
  });
  return tile;
}

/* ── Share links (#/animation/<id>) — hash parsing lives in app.js ── */
const ANIMATION_HASH_PREFIX = '#/animation/';
function shareLinkFor(id) {
  return `${location.origin}${location.pathname}${ANIMATION_HASH_PREFIX}${encodeURIComponent(id)}`;
}
function syncViewerHash(id) {
  const base = location.pathname + location.search;
  history.replaceState(null, '', id ? `${base}${ANIMATION_HASH_PREFIX}${encodeURIComponent(id)}` : base);
}
export async function openAnimationById(id) {
  // Already showing this one (e.g. a hashchange that matches the current
  // viewer) — don't rebuild the Rive instance and restart playback.
  if (viewer.open && viewer.anim?.id === id) return true;
  await storeInitPromise;
  const anim = store.items.find((a) => a.id === id);
  if (!anim) { toast('Animation not found', 'err'); syncViewerHash(null); return false; }
  openViewer(anim);
  return true;
}

function renderGrid() {
  const grid = $('#rv-grid'), skel = $('#rv-skeleton');
  const emptyLib = $('#rv-empty-library'), emptyFil = $('#rv-empty-filter');
  cleanupTiles();

  if (store.loading) { grid.classList.add('hidden'); emptyLib.classList.add('hidden'); emptyFil.classList.add('hidden'); renderSkeleton(); return; }
  skel.classList.add('hidden'); skel.innerHTML = '';

  const filtered = computeFiltered();
  const hasNarrowing = platform !== 'All' || filters.count > 0 || debouncedQuery.length > 0;
  const isLibraryEmpty = store.items.length === 0;
  const isFilterEmpty = filtered.length === 0 && store.items.length > 0;

  if (isLibraryEmpty) { grid.classList.add('hidden'); emptyFil.classList.add('hidden'); emptyLib.classList.remove('hidden'); return; }
  emptyLib.classList.add('hidden');
  if (isFilterEmpty) {
    grid.classList.add('hidden'); emptyFil.classList.remove('hidden');
    $('#rv-clear-filters').classList.toggle('hidden', !hasNarrowing);
    return;
  }
  emptyFil.classList.add('hidden');
  grid.classList.remove('hidden');
  grid.innerHTML = '';
  filtered.forEach((a) => grid.appendChild(tileEl(a)));
}

function renderSkeleton() {
  const skel = $('#rv-skeleton');
  skel.classList.remove('hidden');
  skel.innerHTML = '';
  for (let i = 0; i < 10; i++) {
    const c = el('div', 'rv-tile');
    c.innerHTML = `<div class="rv-tile-preview"><div class="rv-tile-preview-inner"><div class="rv-tile-ph"></div></div></div><div class="rv-tile-foot"><div style="flex:1"><div class="rv-tile-ph" style="height:12px;margin-bottom:6px"></div><div class="rv-tile-ph" style="height:10px;width:60%"></div></div></div>`;
    skel.appendChild(c);
  }
}

/* ══════════════ FULLSCREEN VIEWER ══════════════ */
const viewer = {
  open: false, anim: null, rive: null, raf: 0,
  playing: true, loop: true, speed: 1, duration: 0, progress: 0, startTs: 0, isTS: false,
};

function fmtTime(sec) { if (!sec || !isFinite(sec)) return '0:00'; const s = Math.floor(sec % 60), m = Math.floor(sec / 60); return `${m}:${String(s).padStart(2, '0')}`; }

function stopViewerRaf() { if (viewer.raf) { cancelAnimationFrame(viewer.raf); viewer.raf = 0; } }
function startViewerRaf() {
  stopViewerRaf();
  viewer.startTs = performance.now();
  const scrub = $('#rv-scrub'), time = $('#rv-time');
  const tick = (now) => {
    if (viewer.playing && viewer.duration > 0) {
      const dt = (now - viewer.startTs) / 1000;
      let p = viewer.progress + (dt * viewer.speed) / viewer.duration;
      if (viewer.loop) p = p % 1;
      else if (p >= 1) { p = 1; viewer.playing = false; try { viewer.rive.pause(); } catch (_) {} syncPlay(); }
      viewer.progress = p;
      scrub.value = String(p); scrub.style.setProperty('--timeline-progress', `${p * 100}%`);
      time.textContent = `${fmtTime(p * viewer.duration)} / ${fmtTime(viewer.duration)}`;
    }
    viewer.startTs = now;
    viewer.raf = requestAnimationFrame(tick);
  };
  viewer.raf = requestAnimationFrame(tick);
}
function syncPlay() {
  const ico = $('#rv-play-ico');
  if (ico) ico.className = `gh-standard-${viewer.playing ? 'pause-circle' : 'play-circle'}`;
}
function applyViewerSpeed() {
  try { const anims = viewer.rive?.animator?.animations; if (Array.isArray(anims)) anims.forEach((a) => { if (typeof a?.speed !== 'undefined') a.speed = viewer.speed; }); } catch (_) {}
}

async function openViewer(animation) {
  viewer.open = true; viewer.anim = animation;
  syncViewerHash(animation.id);
  viewer.playing = true; viewer.loop = true; viewer.speed = 1; viewer.progress = 0; viewer.duration = 0;
  viewer.isTS = isThemeSwitcherAnimation(animation);
  const root = $('#rv-viewer');
  root.classList.remove('hidden'); root.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => $('#rv-viewer-close')?.focus?.({ preventScroll: true }));
  $('#rv-loop').setAttribute('aria-pressed', 'true');
  $('#rv-speed').value = '1';
  $('#rv-scrub').value = '0'; $('#rv-scrub').style.setProperty('--timeline-progress', '0%');
  $('#rv-time').textContent = '0:00 / 0:00';
  syncPlay();
  renderViewerSide(animation, { artboards: animation.artboards || [], stateMachines: (animation.stateMachines || []).map((s) => typeof s === 'string' ? s : s.name), timelines: animation.timelines || [], viewModels: (animation.viewModels || []).map((v) => typeof v === 'string' ? { name: v, properties: [] } : v) });

  // load + create Rive instance
  if (viewer.rive) { try { viewer.rive.cleanup(); } catch (_) {} viewer.rive = null; }
  stopViewerRaf();
  const canvas = $('#rv-viewer-canvas');
  let buffer;
  try { buffer = await animation.fileBlob.arrayBuffer(); } catch (_) { return; }
  if (!viewer.open || viewer.anim !== animation) return;
  viewer.rive = await buildRive(buffer, animation, canvas, true, () => {
    try { viewer.rive.resizeDrawingSurfaceToCanvas(); } catch (_) {}
    try { ensurePlaybackStarted(viewer.rive, viewer.isTS); } catch (_) {}
    viewer.duration = getPlaybackDuration(viewer.rive) || 0;
    const dims = getArtboardDimensions(viewer.rive);
    updateViewerHeaderMeta(animation, dims);
    $('#rv-scrub').disabled = viewer.duration <= 0;
    applyViewerSpeed();
    startViewerRaf();
    mountThemeSwitch();
  });

  // backfill inspection if needed
  if (!animation.inspectedAt) backfillInspection(animation);
}

async function backfillInspection(animation) {
  try {
    const result = await inspectRive(animation.fileBlob, { bundleAssets: animation.bundleAssets });
    const flatSM = (result.stateMachines || []).map((s) => typeof s === 'string' ? s : s.name);
    const flatTL = (result.animations || []).map((a) => typeof a === 'string' ? a : a.name);
    if (viewer.open && viewer.anim?.id === animation.id) {
      viewer.anim = {
        ...viewer.anim,
        artboards: result.artboards,
        stateMachines: result.stateMachines,
        timelines: flatTL,
        viewModels: result.viewModels,
        metadata: result,
        duration: animation.duration ?? result.duration ?? null,
        inspectedAt: new Date().toISOString(),
      };
      viewer.isTS = isThemeSwitcherAnimation(viewer.anim);
      renderViewerSide(viewer.anim, { artboards: result.artboards, stateMachines: flatSM, timelines: flatTL, viewModels: result.viewModels });
      mountThemeSwitch();
    }
    await store.update(animation.id, {
      artboards: result.artboards, stateMachines: result.stateMachines, timelines: flatTL,
      viewModels: result.viewModels, metadata: result,
      duration: animation.duration ?? result.duration ?? null, inspectedAt: new Date().toISOString(),
    });
  } catch (_) {}
}

function closeViewer() {
  viewer.open = false; viewer.anim = null;
  stopViewerRaf();
  if (viewer.rive) { try { viewer.rive.cleanup(); } catch (_) {} viewer.rive = null; }
  const root = $('#rv-viewer');
  root.classList.add('hidden'); root.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  $('#rv-theme-switch-slot').innerHTML = '';
  listeners.theme.clear();
  syncViewerHash(null);
}

function updateViewerHeaderMeta(a, dims) {
  const metaEl = $('#rv-viewer-meta-line');
  if (!metaEl) return;
  const bits = [a.fileSizeReadable];
  if (dims) bits.push(`${dims.w} × ${dims.h}`);
  if (viewer.duration > 0) bits.push(`${viewer.duration.toFixed(2)}s`);
  metaEl.textContent = bits.filter(Boolean).join(' · ');
}

function metaSection(label, items, fmt, entityType = null) {
  const n = items.length;
  if (!n) return `<details class="rv-meta-sec"><summary class="rv-meta-sum">${label}<span class="rv-meta-cnt">0</span></summary><div class="rv-meta-empty">None detected</div></details>`;
  const open = label === 'Artboards' ? ' open' : '';
  const lis = items.map((it) => {
    const name = typeof it === 'string' ? it : it?.primary;
    const err = entityType ? namingBadge(entityType, name) : '';
    return `<li>${fmt ? fmt(it) : esc(it)}${err}</li>`;
  }).join('');
  return `<details class="rv-meta-sec"${open}><summary class="rv-meta-sum">${label}<span class="rv-meta-cnt">${n}</span></summary><ul class="rv-meta-list">${lis}</ul></details>`;
}

function detectedMetadataHTML(meta) {
  if (!meta) return '';
  const ab = (meta.artboards || []).map((a) => a.name || a);
  const sm = (meta.stateMachines || []).map((s) => s.name || s);
  const an = (meta.animations || []).map((a) => a.name || a);
  const vm = (meta.viewModels || []).map((v) => ({ primary: v.name, secondary: `Properties: ${v.properties?.length || 0} · Instances: ${v.instanceCount ?? v.instances?.length ?? 0}` }));
  const inp = (meta.inputs || []).map((i) => ({ primary: i.name, secondary: `(${i.type})` }));
  return `<div class="rv-meta-card"><div class="heading-eyebrow" style="color:var(--contentSecondary);margin-bottom:8px">Detected Metadata</div>
    ${metaSection('Artboards', ab, null, 'artboard')}
    ${metaSection('State Machines', sm, null, 'stateMachine')}
    ${metaSection('View Models', vm, (o) => `<code>${esc(o.primary)}</code><span class="hint">${esc(o.secondary)}</span>`, 'viewModel')}
    ${metaSection('Animations / Timelines', an, null, 'timeline')}
    ${metaSection('Inputs', inp, (o) => `<code>${esc(o.primary)}</code><span class="hint">${esc(o.secondary)}</span>`, 'input')}
  </div>`;
}

function renderViewerSide(a, details) {
  const side = $('#rv-viewer-side');
  const hasBundle = (a.bundleAssets?.length ?? 0) > 0;
  const meta = a.metadata || {
    artboards: details.artboards || [],
    stateMachines: (details.stateMachines || []).map((name) => ({ name })),
    animations: (details.timelines || []).map((name) => ({ name })),
    viewModels: details.viewModels || [], inputs: [], duration: a.duration ?? null,
  };
  side.innerHTML = `
    <div class="rv-section" style="padding-right:44px">
      <h2 class="heading-base" style="word-break:break-word">${esc(a.fileName)}${namingBadge('file', a.fileName)}</h2>
      <div class="body-small" id="rv-viewer-meta-line" style="color:var(--contentSecondary);margin-top:4px">${esc(a.fileSizeReadable || '')}</div>
    </div>
    <div class="rv-section" style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="rv-btn rv-btn-accent" id="rv-dl-riv">${icon('download-03')} .riv</button>
      <button class="rv-icon-btn" id="rv-copy-name" title="Copy file name">${icon('copy-01')}</button>
      ${hasBundle ? `<button class="rv-btn rv-btn-soft" id="rv-dl-assets">All assets (.zip)</button><button class="rv-btn rv-btn-soft" id="rv-dl-bundle">Full bundle (.zip)</button>` : ''}
    </div>
    <div class="rv-section"><div class="heading-eyebrow rv-section-title">Details</div>
      ${detailRow('Platform', a.platform || '—')}
      ${a.rivPath ? detailRow('Rive path', a.rivPath) : ''}
      ${detailRow('Uploaded', new Date(a.uploadedAt).toLocaleDateString())}
      ${detailRow('By', a.uploadedBy || '—')}
      ${detailRow('Source', sourceLabel(a))}
      ${detailRow('Storage', storageLabel(a))}
      ${viewer.isTS ? `<div class="rv-detail-row"><span>Type</span><span class="rv-pill-tag">${icon('moon-02', 'xsmall')} ThemeSwitcher</span></div>` : ''}
    </div>
    ${hasBundle ? bundleAssetsHTML(a) : ''}
    ${a.description ? `<div class="rv-section"><div class="heading-eyebrow rv-section-title">Description</div><p class="body-base" style="color:var(--contentSecondary)">${esc(a.description)}</p></div>` : ''}
    ${detectedMetadataHTML(meta)}
    <div class="rv-section" style="padding-top:8px">
      <button class="rv-btn rv-btn-ghost" id="rv-delete" style="width:100%;color:var(--contentNegative);border-color:var(--borderPrimary)">${icon('delete-01', 'xsmall')} Remove from library</button>
    </div>`;

  $('#rv-dl-riv').onclick = () => { triggerBlobDownload(a.fileBlob, `${a.fileName}.riv`); toast('Download started'); };
  $('#rv-copy-name').onclick = async () => { try { await navigator.clipboard.writeText(a.fileName); toast('File name copied'); } catch (_) { toast('Could not copy', 'err'); } };
  if (hasBundle) {
    $('#rv-dl-assets').onclick = async () => { try { await downloadBundledAssetsZip(a); toast('Bundled assets download started'); } catch (e) { toast(e.message, 'err'); } };
    $('#rv-dl-bundle').onclick = async () => { try { await downloadFullBundleZip(a); toast('Full bundle download started'); } catch (e) { toast(e.message, 'err'); } };
    $$('.rv-asset-dl', side).forEach((btn) => { btn.onclick = () => { try { downloadSingleBundledAsset(a.bundleAssets[+btn.dataset.i]); toast(`Downloading ${a.bundleAssets[+btn.dataset.i].name}`); } catch (_) { toast('Could not download', 'err'); } }; });
  }
  $('#rv-delete').onclick = () => requireAuth(async () => {
    if (!confirm(`Remove "${a.fileName}" from the animation library?`)) return;
    await store.remove(a.id);
    toast('Removed from library');
    closeViewer();
  }, { toast });
}
function detailRow(label, value) { return `<div class="rv-detail-row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`; }
function sourceLabel(a) {
  if (a.origin === 'repo-manifest' || a.uploadedBy === 'Sample Library') return 'Repository sample';
  if (a.origin === 'user-upload') return 'Uploaded asset';
  return 'Animation library';
}
function storageLabel(a) {
  if (a.syncStatus === 'local-only' || a.storageBackend === 'indexeddb-local') return 'Local browser';
  if (a.storageBackend === 'indexeddb-cache') return 'Cached from repository';
  return a.storageBackend || 'Library storage';
}
function bundleAssetsHTML(a) {
  const lis = a.bundleAssets.map((asset, i) => `<li style="display:flex;gap:8px;align-items:flex-start;background:var(--backgroundSecondary);border-radius:8px;padding:8px;margin-bottom:4px"><div style="min-width:0;flex:1"><div class="body-small" style="font-family:monospace;color:var(--contentPrimary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(asset.name)}</div><div style="font-size:11px;text-transform:uppercase;color:var(--contentTertiary);margin-top:2px">${esc(asset.kind)} · ${esc(asset.sizeReadable)}</div></div><button class="rv-tile-dl rv-asset-dl" data-i="${i}" style="opacity:1" aria-label="Download ${esc(asset.name)}">${icon('download-03', 'xsmall')}</button></li>`).join('');
  return `<div class="rv-section"><div class="heading-eyebrow rv-section-title">Bundled Assets <span class="rv-meta-cnt">${a.bundleAssets.length}</span></div><ul style="list-style:none">${lis}</ul></div>`;
}

/* theme-switch toggle inside the viewer */
function mountThemeSwitch() {
  const slot = $('#rv-theme-switch-slot');
  // Mounted twice per viewer session (on open, again after inspect refresh) —
  // drop the previous mount's listener or theme changes fire the toggle twice.
  listeners.theme.clear();
  if (!viewer.isTS || !viewer.rive) { slot.innerHTML = ''; return; }
  const smName = findThemeSwitcherSM(viewer.anim);
  let resolved = null;
  try { resolved = resolveThemeInput(viewer.rive, smName); } catch (_) {}

  if (!resolved) {
    slot.innerHTML = `<span class="rv-ts rv-ts-disabled"><span class="rv-ts-label">Theme unavailable</span></span>`;
    return;
  }

  slot.innerHTML = `<span class="rv-ts"><span class="rv-ts-label">Theme</span><button class="rv-ts-btn" id="rv-ts-btn" aria-pressed="false" aria-label="Switch animation theme"><span class="rv-ts-knob"></span></button></span>`;
  const btn = $('#rv-ts-btn');
  const knob = $('#rv-ts-btn .rv-ts-knob');
  const sync = () => {
    const isDark = theme.value === 'dark';
    btn.setAttribute('aria-pressed', String(isDark));
    btn.setAttribute('title', `Switch to ${isDark ? 'light' : 'dark'} mode`);
    knob.innerHTML = icon(isDark ? 'moon-02' : 'sun-01', 'xsmall');
  };
  const applyTS = (commitToggle = false) => {
    try { return applyThemeInput(resolved, theme.value === 'dark', { commitToggle }); }
    catch (_) { return false; }
  };
  sync();
  applyTS(false);
  const onThemeChange = () => {
    sync();
    applyTS(true);
  };
  listeners.theme.add(onThemeChange);
  btn.onclick = () => {
    if (window.GrowwVisualTheme?.toggle) window.GrowwVisualTheme.toggle();
    else theme.toggle();
    sync();
  };
}

/* viewer controls wiring (once) */
function wireViewer() {
  const root = $('#rv-viewer');
  root.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeViewer();
    }
  };
  $('#rv-viewer-close').onclick = closeViewer;
  $('#rv-play').onclick = () => { if (!viewer.rive) return; viewer.playing = !viewer.playing; try { viewer.playing ? viewer.rive.play() : viewer.rive.pause(); } catch (_) {} viewer.startTs = performance.now(); syncPlay(); };
  $('#rv-restart').onclick = () => { if (!viewer.rive) return; try { viewer.rive.reset?.({ autoplay: true }); ensurePlaybackStarted(viewer.rive, viewer.isTS); } catch (_) { try { viewer.rive.play(); } catch (_) {} } viewer.progress = 0; viewer.playing = true; viewer.startTs = performance.now(); applyViewerSpeed(); syncPlay(); };
  $('#rv-loop').onclick = () => { viewer.loop = !viewer.loop; $('#rv-loop').setAttribute('aria-pressed', String(viewer.loop)); };
  $('#rv-speed').onchange = (e) => { viewer.speed = parseFloat(e.target.value) || 1; applyViewerSpeed(); };
  $('#rv-scrub').oninput = (e) => { const v = parseFloat(e.target.value); viewer.progress = v; viewer.startTs = performance.now(); e.target.style.setProperty('--timeline-progress', `${v * 100}%`); $('#rv-time').textContent = `${fmtTime(v * viewer.duration)} / ${fmtTime(viewer.duration)}`; scrubRive(viewer.rive, v, viewer.duration); };
}

/* ══════════════ SUBNAV (platforms + filter pill + active pills) ══════════════ */
function platformCounts() {
  const counts = {}; PLATFORMS.forEach((p) => (counts[p] = 0));
  counts.All = store.items.length;
  store.items.forEach((it) => { if (counts[it.platform] !== undefined) counts[it.platform]++; });
  return counts;
}
function renderSubnav() {
  const nav = $('#rv-platforms'); const counts = platformCounts();
  nav.innerHTML = PLATFORMS.map((p) => `<button class="rv-tab" data-p="${p}" aria-pressed="${p === platform}">${p}<span class="rv-tab-count">${counts[p] ?? 0}</span></button>`).join('');
  $$('.rv-tab', nav).forEach((b) => (b.onclick = () => {
    platform = b.dataset.p;
    query = '';
    debouncedQuery = '';
    integration.onSearchClear?.();
    renderSubnav();
    renderGrid();
  }));
  const fc = $('#rv-filter-count'); const n = filters.count;
  fc.textContent = n; fc.classList.toggle('hidden', n === 0);
  $('#rv-filter-btn').classList.toggle('is-active', n > 0 || filterPanelOpen);
  renderActivePills();
}
function shortLabel(label) { if (/animation type/i.test(label)) return 'Type'; if (/sub-product/i.test(label)) return 'Feature'; return label; }
function renderActivePills() {
  const wrap = $('#rv-active-pills'); const cats = filters.categories; const out = [];
  for (const [catId, vals] of Object.entries(filters.active)) {
    const cat = cats.find((c) => c.id === catId); if (!cat) continue;
    for (const v of vals) { const opt = cat.options.find((o) => o.value === v); out.push({ catId, catLabel: cat.label, value: v, display: opt?.display || v }); }
  }
  wrap.innerHTML = out.map((p) => `<span class="rv-active-pill">${esc(shortLabel(p.catLabel))}: ${esc(p.display)}<button data-c="${esc(p.catId)}" data-v="${esc(p.value)}" aria-label="Remove">${icon('cancel-01', 'xsmall')}</button></span>`).join('');
  $$('button', wrap).forEach((b) => (b.onclick = () => filters.removeOption(b.dataset.c, b.dataset.v)));
}

/* ══════════════ FILTER PANEL ══════════════ */
let filterPanelOpen = false;
let filterEditMode = false;
function toggleFilterPanel(force) {
  filterPanelOpen = force != null ? force : !filterPanelOpen;
  $('#rv-filter-btn').setAttribute('aria-expanded', String(filterPanelOpen));
  let panel = $('#rv-filterpanel'); let backdrop = $('#rv-filter-backdrop');
  if (filterPanelOpen) {
    if (!backdrop) { backdrop = el('div', 'rv-backdrop'); backdrop.id = 'rv-filter-backdrop'; backdrop.onclick = () => toggleFilterPanel(false); document.body.appendChild(backdrop); }
    if (!panel) { panel = el('div', 'rv-filterpanel'); panel.id = 'rv-filterpanel'; $('#rv-filter-wrap').appendChild(panel); }
    renderFilterPanel();
  } else {
    filterEditMode = false;
    panel?.remove(); backdrop?.remove();
  }
  renderSubnav();
}
function renderFilterPanel() {
  const panel = $('#rv-filterpanel'); if (!panel) return;
  const cats = filters.categories;
  panel.innerHTML = `
    <div class="rv-filterpanel-head">
      <span class="heading-eyebrow" style="color:var(--contentSecondary)">Filters${filterEditMode ? ' · Editing' : ''}</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        ${filters.count > 0 && !filterEditMode ? `<button class="rv-btn rv-btn-soft" id="rv-fp-clear" style="padding:6px 12px;font-size:12px">Clear All</button>` : ''}
        <button class="rv-btn rv-btn-ghost" id="rv-fp-edit" style="padding:6px 12px;font-size:12px" aria-pressed="${filterEditMode}">${filterEditMode ? 'Done' : 'Edit'}</button>
        <button class="rv-icon-btn" id="rv-fp-close" style="height:32px;width:32px" aria-label="Close filters">${icon('cancel-01', 'xsmall')}</button>
      </div>
    </div>
    <div class="rv-filterpanel-body">
      ${cats.map((c) => catSectionHTML(c)).join('')}
      ${filterEditMode ? `<button class="rv-btn rv-btn-ghost" id="rv-fp-addcat" style="width:100%;border-style:dashed">${icon('add-01', 'xsmall')} Add category</button>` : ''}
    </div>
    <div class="rv-filterpanel-foot">
      <button class="rv-btn rv-btn-ghost" id="rv-fp-clear2" ${filters.count === 0 ? 'disabled' : ''}>Clear All</button>
      <button class="rv-btn rv-btn-accent" id="rv-fp-done">Done</button>
    </div>`;
  // wire
  $('#rv-fp-close').onclick = () => toggleFilterPanel(false);
  $('#rv-fp-done').onclick = () => toggleFilterPanel(false);
  $('#rv-fp-edit').onclick = () => { filterEditMode = !filterEditMode; renderFilterPanel(); };
  const clear = () => { filters.clearAll(); renderFilterPanel(); };
  if ($('#rv-fp-clear')) $('#rv-fp-clear').onclick = clear;
  if ($('#rv-fp-clear2')) $('#rv-fp-clear2').onclick = clear;
  if ($('#rv-fp-addcat')) $('#rv-fp-addcat').onclick = () => { const name = prompt('New category name'); if (name) { const r = filters.addCustomCategory(name); if (!r.ok) toast(r.error, 'err'); else renderFilterPanel(); } };
  $$('.rv-opt', panel).forEach((b) => (b.onclick = () => {
    if (filterEditMode) {
      if (b.dataset.removable === '1') { filters.removeCustomOption(b.dataset.c, b.dataset.v); renderFilterPanel(); }
      return;
    }
    filters.toggleOption(b.dataset.c, b.dataset.v); renderFilterPanel();
  }));
  $$('.rv-addopt', panel).forEach((b) => (b.onclick = () => { const name = prompt(`Add option to ${b.dataset.label}`); if (name) { const r = filters.addCustomOption(b.dataset.c, name); if (!r.ok) toast(r.error, 'err'); else renderFilterPanel(); } }));
  $$('.rv-delcat', panel).forEach((b) => (b.onclick = () => { filters.removeCustomCategory(b.dataset.c); renderFilterPanel(); }));
}
const BUILTIN_OPTION_COUNTS = Object.fromEntries(BUILTIN_CATEGORIES.map((c) => [c.id, c.options.length]));
function catSectionHTML(category) {
  const selected = filters.active[category.id] || [];
  const builtinCount = BUILTIN_OPTION_COUNTS[category.id] || 0;
  const pills = category.options.map((opt, idx) => {
    const isCustom = idx >= builtinCount;
    const on = selected.includes(opt.value);
    const removable = filterEditMode && isCustom ? ' data-removable="1"' : '';
    return `<button class="rv-opt" data-c="${esc(category.id)}" data-v="${esc(opt.value)}"${removable} aria-pressed="${on}">${esc(opt.display)}${filterEditMode && isCustom ? ' ✕' : ''}</button>`;
  }).join('');
  const addBtn = filterEditMode ? `<button class="rv-opt rv-addopt" data-c="${esc(category.id)}" data-label="${esc(category.label)}">${icon('add-01', 'xsmall')}</button>` : '';
  const delCat = filterEditMode && !category.isBuiltin ? `<button class="rv-icon-btn rv-delcat" data-c="${esc(category.id)}" style="height:28px;width:28px" aria-label="Delete category">${icon('delete-01', 'xsmall')}</button>` : '';
  return `<div class="rv-catsec"><div class="rv-catsec-head"><span class="heading-eyebrow" style="color:var(--contentSecondary)">${esc(category.label)}</span>${delCat}</div><div class="rv-pillrow">${pills}${addBtn}</div></div>`;
}

/* ══════════════ UPLOAD MODAL ══════════════ */
const UPLOADER_NAMES_KEY = 'rive-uploader-names';
const LAST_UPLOADER_KEY = 'rive-last-uploader';
const upload = { open: false, stage: 'drop', files: [], extracting: false, previousFocus: null };

function blankMeta(file, extras = {}) {
  return {
    clientId: generateId(), file, fileName: file.name.replace(/\.riv$/i, ''),
    category: ASSIGNABLE_CATEGORIES[0], platform: PLATFORMS.find((p) => p !== 'All') || 'Mobile',
    tags: '', description: '', uploadedBy: localStorage.getItem(LAST_UPLOADER_KEY) || '',
    progress: 0, error: null, sourceType: 'riv', sourceZipName: null, rivPath: null, bundleAssets: [],
    inspectionStatus: 'pending', inspection: null, inspectionError: null, ...extras,
  };
}
function openUpload() {
  upload.open = true;
  upload.stage = 'drop';
  upload.files = [];
  upload.previousFocus = document.activeElement;
  const modal = $('#rv-upload');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  renderUpload();
  requestAnimationFrame(() => ($('#rv-dropzone') || $('#rv-upload-close'))?.focus?.({ preventScroll: true }));
}
function closeUpload() {
  upload.open = false;
  const modal = $('#rv-upload');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  if (!viewer.open) document.body.style.overflow = '';
  upload.previousFocus?.focus?.({ preventScroll: true });
  upload.previousFocus = null;
}

function wireUploadShell() {
  const modal = $('#rv-upload');
  if (!modal || modal.dataset.riveShellWired === 'true') return;
  modal.dataset.riveShellWired = 'true';
  modal.addEventListener('click', (e) => { if (e.target.id === 'rv-upload') closeUpload(); });
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeUpload();
    }
  });
}

async function acceptFiles(incoming) {
  const accepted = [], rejected = [], zips = [];
  for (const f of incoming) {
    if (/\.zip$/i.test(f.name)) { zips.push(f); continue; }
    if (!/\.riv$/i.test(f.name)) { rejected.push(`${f.name}: use .riv or .zip`); continue; }
    if (f.size > MAX_FILE_SIZE_BYTES) toast(`${f.name} is ${formatBytes(f.size)} (>5 MB) — large files may slow the grid.`, 'warn');
    accepted.push(blankMeta(f));
  }
  if (zips.length) {
    upload.extracting = true; renderUpload();
    for (const zip of zips) {
      try {
        const payloads = await extractZipBundle(zip);
        for (const p of payloads) {
          const note = p.bundleAssets.length ? ` Includes ${p.bundleAssets.length} bundled asset${p.bundleAssets.length === 1 ? '' : 's'}.` : '';
          accepted.push(blankMeta(p.file, { sourceType: 'zip', sourceZipName: p.sourceZipName, rivPath: p.rivPath, bundleAssets: p.bundleAssets, description: `Imported from ${p.sourceZipName}.${note}`.trim() }));
        }
      } catch (e) { rejected.push(`${zip.name}: ${e.message || 'invalid ZIP'}`); }
    }
    upload.extracting = false;
  }
  if (!upload.open) return;
  if (rejected.length) toast(rejected.join(', '), 'err');
  if (accepted.length) { upload.files = [...upload.files, ...accepted]; upload.stage = 'meta'; renderUpload(); accepted.forEach((row) => runInspection(row)); }
  else renderUpload();
}

async function runInspection(row) {
  patchRow(row.clientId, { inspectionStatus: 'analyzing' }); renderUpload();
  try {
    const blob = new Blob([await row.file.arrayBuffer()], { type: 'application/octet-stream' });
    const inspection = await inspectRive(blob, { bundleAssets: row.bundleAssets });
    patchRow(row.clientId, { inspectionStatus: 'ready', inspection, inspectionError: null });
  } catch (e) {
    patchRow(row.clientId, { inspectionStatus: 'failed', inspection: emptyMetadata(), inspectionError: e.message || 'Could not analyze file' });
  }
  renderUpload();
}
function patchRow(clientId, patch) { upload.files = upload.files.map((f) => f.clientId === clientId ? { ...f, ...patch } : f); }

async function submitAll() {
  if (!upload.files.length) return;
  upload.stage = 'uploading'; renderUpload();
  let ok = 0;
  for (const meta of upload.files) {
    try {
      patchRow(meta.clientId, { progress: 20 }); renderUpload();
      const blob = new Blob([await meta.file.arrayBuffer()], { type: 'application/octet-stream' });
      patchRow(meta.clientId, { progress: 55 });
      let extracted = meta.inspection;
      if (!extracted) { try { extracted = await inspectRive(blob, { bundleAssets: meta.bundleAssets }); } catch (_) { extracted = emptyMetadata(); } }
      patchRow(meta.clientId, { progress: 85 });
      const tags = meta.tags.split(',').map((t) => t.trim()).filter(Boolean);
      await store.add({
        id: generateId(), fileName: meta.fileName.trim() || meta.file.name.replace(/\.riv$/i, ''),
        fileSize: blob.size, fileSizeReadable: formatBytes(blob.size), category: meta.category, platform: meta.platform,
        tags, description: meta.description.trim(), uploadedAt: new Date().toISOString(), uploadedBy: meta.uploadedBy.trim() || 'Anonymous',
        origin: 'user-upload', storageBackend: 'indexeddb-local', syncStatus: 'local-only',
        duration: extracted.duration, artboards: extracted.artboards, stateMachines: extracted.stateMachines,
        timelines: (extracted.animations || []).map((a) => a.name), viewModels: extracted.viewModels, metadata: extracted,
        fileBlob: blob, mimeType: 'application/octet-stream', sourceType: meta.sourceType || 'riv',
        sourceZipName: meta.sourceZipName || null, rivPath: meta.rivPath || null, bundleAssets: meta.bundleAssets || [], inspectedAt: new Date().toISOString(),
      });
      patchRow(meta.clientId, { progress: 100 }); ok++;
    } catch (e) { patchRow(meta.clientId, { error: e.message || 'Upload failed', progress: 0 }); }
    renderUpload();
  }
  if (ok > 0) {
    const last = upload.files.find((f) => f.uploadedBy.trim())?.uploadedBy.trim();
    if (last) localStorage.setItem(LAST_UPLOADER_KEY, last);
    toast(`${ok} ${ok === 1 ? 'animation' : 'animations'} added`);
  }
  if (ok === upload.files.length) closeUpload();
}

function renderUpload() {
  const body = $('#rv-upload-body'), foot = $('#rv-upload-foot');
  if (upload.stage === 'drop') {
    body.innerHTML = `<div class="rv-dropzone" id="rv-dropzone" role="button" tabindex="0" aria-disabled="${upload.extracting}">${icon('cloud-upload', 'xlarge')}<h3 class="heading-small">${upload.extracting ? 'Extracting ZIP…' : 'Drop .riv or .zip files'}</h3><p class="body-base">or click to browse</p></div>`;
    foot.innerHTML = '';
    const dz = $('#rv-dropzone');
    dz.onclick = () => { if (!upload.extracting) $('#rv-file-input').click(); };
    dz.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        dz.click();
      }
    };
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
    dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); acceptFiles([...(e.dataTransfer.files || [])]); };
  } else {
    const anyAnalyzing = upload.files.some((f) => f.inspectionStatus === 'analyzing');
    body.innerHTML = upload.files.map((f) => metaRowHTML(f)).join('') + (upload.stage !== 'uploading' ? `<button class="rv-btn rv-btn-ghost" id="rv-addmore" style="width:100%;border-style:dashed">${icon('add-01', 'xsmall')} Add more</button>` : '');
    foot.innerHTML = `<button class="rv-btn rv-btn-ghost" id="rv-up-cancel">Cancel</button><button class="rv-btn rv-btn-accent" id="rv-up-submit" ${upload.stage === 'uploading' || !upload.files.length || anyAnalyzing ? 'disabled' : ''}>${upload.stage === 'uploading' ? 'Uploading…' : anyAnalyzing ? 'Analyzing…' : 'Add to library'}</button>`;
    if ($('#rv-addmore')) $('#rv-addmore').onclick = () => $('#rv-file-input').click();
    $('#rv-up-cancel').onclick = closeUpload;
    $('#rv-up-submit').onclick = submitAll;
    upload.files.forEach((f) => wireMetaRow(f));
  }
}
function metaRowHTML(f) {
  const badge = f.inspectionStatus === 'ready' ? `${icon('tick-02', 'xsmall')} File analyzed${f.inspection && totalMetadataItems(f.inspection) ? ` · ${totalMetadataItems(f.inspection)} items` : ''}`
    : f.inspectionStatus === 'failed' ? `${icon('alert-02', 'xsmall')} Analysis failed`
    : `<span class="rv-spinner"></span> Analyzing Rive file…`;
  return `<div class="rv-metarow" data-cid="${f.clientId}">
    <div class="rv-metarow-head">
      <div class="rv-metarow-ico ${f.sourceType === 'zip' ? 'zip' : ''}">${icon(f.sourceType === 'zip' ? 'zip-01' : 'file-01')}</div>
      <div style="flex:1;min-width:0">
        <div class="body-base-heavy" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.file.name)}${namingBadge('file', f.file.name)}</div>
        <div class="rv-badge-inspect">${badge}</div>
      </div>
      ${upload.stage !== 'uploading' ? `<button class="rv-icon-btn rv-row-remove" style="height:32px;width:32px" aria-label="Remove">${icon('cancel-01', 'xsmall')}</button>` : ''}
    </div>
    <div class="rv-field"><label>Animation name</label><input class="rv-input rv-f-name" value="${esc(f.fileName)}"></div>
    <div class="rv-field"><label>Platform</label><select class="rv-select rv-f-plat">${PLATFORMS.filter((p) => p !== 'All').map((p) => `<option ${p === f.platform ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    <div class="rv-field"><label>Uploaded by</label><input class="rv-input rv-f-by" value="${esc(f.uploadedBy)}" placeholder="Your name"></div>
    <div class="rv-field"><label>Tags (comma separated)</label><input class="rv-input rv-f-tags" value="${esc(f.tags)}"></div>
    <div class="rv-field"><label>Description</label><textarea class="rv-textarea rv-f-desc" rows="2">${esc(f.description)}</textarea></div>
    ${f.progress > 0 || f.error ? (f.error ? `<div class="body-small" style="color:var(--contentNegative);margin-top:8px">${esc(f.error)}</div>` : `<div class="rv-progress"><div class="rv-progress-bar" style="width:${f.progress}%"></div></div>`) : ''}
    ${(f.inspectionStatus === 'ready' || f.inspectionStatus === 'failed') && f.inspection ? `<div style="margin-top:12px">${detectedMetadataCompact(f.inspection)}</div>` : ''}
  </div>`;
}
function detectedMetadataCompact(meta) {
  const ab = (meta.artboards || []).map((a) => a.name || a);
  const sm = (meta.stateMachines || []).map((s) => s.name || s);
  const an = (meta.animations || []).map((a) => a.name || a);
  const vm = (meta.viewModels || []).map((v) => ({ primary: v.name, secondary: `Properties: ${v.properties?.length || 0}` }));
  const inp = (meta.inputs || []).map((i) => ({ primary: i.name, secondary: `(${i.type})` }));
  return `<div class="rv-meta-card compact">${metaSection('Artboards', ab, null, 'artboard')}${metaSection('State Machines', sm, null, 'stateMachine')}${metaSection('View Models', vm, (o) => `<code>${esc(o.primary)}</code><span class="hint">${esc(o.secondary)}</span>`, 'viewModel')}${metaSection('Animations / Timelines', an, null, 'timeline')}${metaSection('Inputs', inp, (o) => `<code>${esc(o.primary)}</code><span class="hint">${esc(o.secondary)}</span>`, 'input')}</div>`;
}
function wireMetaRow(f) {
  const row = $(`.rv-metarow[data-cid="${f.clientId}"]`); if (!row) return;
  const upd = (patch) => { patchRow(f.clientId, patch); };
  $('.rv-f-name', row)?.addEventListener('input', (e) => upd({ fileName: e.target.value }));
  $('.rv-f-plat', row)?.addEventListener('change', (e) => upd({ platform: e.target.value }));
  $('.rv-f-by', row)?.addEventListener('input', (e) => upd({ uploadedBy: e.target.value }));
  $('.rv-f-tags', row)?.addEventListener('input', (e) => upd({ tags: e.target.value }));
  $('.rv-f-desc', row)?.addEventListener('input', (e) => upd({ description: e.target.value }));
  $('.rv-row-remove', row)?.addEventListener('click', () => { upload.files = upload.files.filter((x) => x.clientId !== f.clientId); if (!upload.files.length) upload.stage = 'drop'; renderUpload(); });
}

/* ══════════════ INIT ══════════════ */
function wireShell() {
  wireGlobalThemeBridge();
  theme.set(readThemePreference());
  wireUploadShell();
  if (shellWired) return;
  shellWired = true;
  // Upload/delete are maintainer-only — credentials verified by the server.
  // (The topbar Upload button in app.js is the main entry; #rv-empty-upload
  // is the empty-library state's shortcut.)
  $('#rv-upload-close').onclick = closeUpload;
  $('#rv-empty-upload').onclick = () => requireAuth(openUpload, { toast });
  getSession().then((s) => {
    if (s.available) return;
    const b = $('#rv-empty-upload');
    if (b) { b.disabled = true; b.title = 'Requires the library server'; }
  });
  $('#rv-clear-filters').onclick = () => {
    platform = 'All';
    query = '';
    debouncedQuery = '';
    integration.onSearchClear?.();
    filters.clearAll();
    renderSubnav();
    renderGrid();
  };
  $('#rv-file-input').onchange = (e) => { acceptFiles([...(e.target.files || [])]); e.target.value = ''; };
  $('#rv-filter-btn').onclick = () => toggleFilterPanel();
  wireViewer();
}

/** Sync query from the Visual Library topbar search input. */
export function setRiveSearchQuery(value) {
  query = value;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debouncedQuery = query.trim();
    renderGrid();
  }, 200);
}

/** Called from app.js bindKeys when the Animation tab is active. Returns true if handled. */
export function handleRiveKeydown(e) {
  if (e.key === 'Escape') {
    if (viewer.open) { closeViewer(); return true; }
    if (upload.open) { closeUpload(); return true; }
    if (filterPanelOpen) { toggleFilterPanel(false); return true; }
  }
  if (e.key === ' ' && viewer.open && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'SELECT') {
    e.preventDefault();
    $('#rv-play').click();
    return true;
  }
  return false;
}

export function isRiveOverlayOpen() {
  return viewer.open || upload.open || filterPanelOpen;
}

// The Rive WASM runtime logs "Could not find a View Model linked to Artboard X"
// straight to console.error whenever autoBind targets an artboard that has no
// ViewModel linked in the source file. Binding is impossible for such artboards
// (a .riv authoring decision, not an app error) and the message repeats on
// every instantiation and hover reset, flooding the console. Filter exactly
// that message; everything else passes through untouched.
let vmNoiseFilterInstalled = false;
function installVmNoiseFilter() {
  if (vmNoiseFilterInstalled) return;
  vmNoiseFilterInstalled = true;
  const original = console.error;
  console.error = function (...args) {
    if (typeof args[0] === 'string' && args[0].startsWith('Could not find a View Model linked to Artboard')) return;
    return original.apply(this, args);
  };
}

export async function initRiveSection(options = {}) {
  installVmNoiseFilter();
  integration = { ...integration, ...options };
  wireShell();
  renderSubnav();
  if (!itemsListenerWired) {
    onItems(() => {
      renderSubnav();
      renderGrid();
      integration.onCountChange?.(store.items.length);
    });
    itemsListenerWired = true;
  }
  renderGrid();
  if (!storeInitPromise) {
    storeInitPromise = store.init().catch((error) => {
      storeInitPromise = null;
      throw error;
    });
  }
  await storeInitPromise;
  integration.onCountChange?.(store.items.length);
  // Deep link handed off by app.js routing (#/animation/<id>) before this
  // lazy module finished loading — consume it once the store is ready.
  if (window.__riveDeepLink) {
    const id = window.__riveDeepLink;
    window.__riveDeepLink = null;
    openAnimationById(id);
  }
  // openUpload is exposed un-gated: the topbar Upload button in app.js wraps
  // the call in requireAuth before dispatching here.
  return { setRiveSearchQuery, handleRiveKeydown, isRiveOverlayOpen, openAnimationById, openUpload };
}
