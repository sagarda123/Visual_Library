/**
 * Icon / illustration upload modals + IndexedDB persistence (v3 stores).
 *
 * Uploaded assets live in the visitor's IndexedDB next to the animation
 * library — the static manifests (manifest.json / illustrations.json) stay
 * read-only. app.js merges records from here into its grids and exposes
 * delete affordances on uploaded items only.
 *
 * Exposed on window.GVLUploads for the non-module app.js IIFE.
 */
import { getAllVisualAssets, addVisualAsset, deleteVisualAsset, generateId } from './rive/db.js?v=phase-b-storage-ledger-1';
import { validate } from './rive/namingRules.js?v=1';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function getUploadedIcons() {
  return getAllVisualAssets('icon');
}
export async function getUploadedIllustrations() {
  return getAllVisualAssets('illustration');
}
export async function removeUploadedIcon(id) {
  return deleteVisualAsset('icon', id);
}
export async function removeUploadedIllustration(id) {
  return deleteVisualAsset('illustration', id);
}

/* ── shared modal shell ──────────────────────────────────────── */
function modal(title, bodyHTML) {
  let root = document.getElementById('gvl-upload-modal');
  if (root) root.remove();
  root = document.createElement('div');
  root.id = 'gvl-upload-modal';
  root.className = 'rv-modal';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = `
    <div class="rv-modal-card" style="max-width:460px">
      <div class="rv-modal-head">
        <h2 class="heading-small">${esc(title)}</h2>
        <button class="rv-icon-btn" data-close aria-label="Close">✕</button>
      </div>
      <div class="rv-modal-body">${bodyHTML}</div>
    </div>`;
  document.body.appendChild(root);
  const close = () => root.remove();
  root.querySelector('[data-close]').onclick = close;
  root.onclick = (e) => { if (e.target === root) close(); };
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
  return { root, close };
}

function nameHint(kind, name) {
  const res = validate(kind, name);
  return res.ok ? '' : `<span class="rv-name-err" title="${esc(res.violations.map((v) => v.message).join('\n'))}">⛔</span> <span style="color:var(--contentNegative)">${esc(res.violations[0].message)}</span>`;
}

/* ── icon upload (.svg) ──────────────────────────────────────── */
export function openIconUpload({ onDone, toast }) {
  const { root, close } = modal('Upload icons', `
    <p class="body-small" style="color:var(--contentSecondary);margin:0 0 12px">SVG files. Names should follow <code>mds_ic_huge_*</code> — see the conventions page.</p>
    <input type="file" id="gvl-icon-files" accept=".svg,image/svg+xml" multiple class="rv-input" style="padding:10px">
    <div id="gvl-icon-rows" style="margin-top:12px"></div>
    <button class="rv-btn rv-btn-accent" id="gvl-icon-save" style="width:100%;margin-top:12px" disabled>Add to library</button>
  `);
  const rowsEl = root.querySelector('#gvl-icon-rows');
  const saveBtn = root.querySelector('#gvl-icon-save');
  let picked = []; // { file, name }

  const renderRows = () => {
    rowsEl.innerHTML = picked.map((p, i) => `
      <div class="rv-field"><label>Icon name</label>
        <input class="rv-input" data-i="${i}" value="${esc(p.name)}">
        <div class="body-small" data-hint="${i}" style="min-height:16px;margin-top:4px">${nameHint('icon', p.name)}</div>
      </div>`).join('');
    rowsEl.querySelectorAll('input[data-i]').forEach((inp) => {
      inp.oninput = () => {
        const i = Number(inp.dataset.i);
        picked[i].name = inp.value.trim();
        rowsEl.querySelector(`[data-hint="${i}"]`).innerHTML = nameHint('icon', picked[i].name);
      };
    });
    saveBtn.disabled = !picked.length;
  };

  root.querySelector('#gvl-icon-files').onchange = (e) => {
    picked = [...(e.target.files || [])]
      .filter((f) => /\.svg$/i.test(f.name))
      .map((file) => ({ file, name: file.name.replace(/\.svg$/i, '') }));
    if (!picked.length) toast?.('Only .svg files are supported', 'err');
    renderRows();
  };

  saveBtn.onclick = async () => {
    if (saveBtn.disabled) return;         // guard against double-submit
    saveBtn.disabled = true;
    let added = 0;
    try {
      for (const p of picked) {
        if (!p.name) continue;
        const svg = await p.file.text();
        // Basic sanity: must parse as an <svg> root; strips nothing else since
        // icons render inline exactly like manifest icons do.
        if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg)) {
          toast?.(`${p.file.name}: not a valid SVG`, 'err');
          continue;
        }
        await addVisualAsset('icon', {
          id: `uicon-${generateId()}`,
          name: p.name,
          svg,
          uploadedAt: new Date().toISOString(),
        });
        added += 1;
      }
    } finally {
      saveBtn.disabled = false;
    }
    if (added) {
      toast?.(`${added} icon${added === 1 ? '' : 's'} added`);
      close();
      onDone?.();
    }
  };
}

/* ── illustration upload (light + dark pair) ─────────────────── */
export function openIllustrationUpload({ onDone, toast }) {
  const { root, close } = modal('Upload illustration', `
    <p class="body-small" style="color:var(--contentSecondary);margin:0 0 12px">Provide light and dark variants (SVG/WEBP/PNG). Names follow <code>mds_il_[type]_[name]</code> — see the illustration naming guidelines.</p>
    <div class="rv-field"><label>Name</label><input class="rv-input" id="gvl-illu-name" placeholder="mds_il_hero_empty_watchlist">
      <div class="body-small" id="gvl-illu-hint" style="min-height:16px;margin-top:4px"></div></div>
    <div class="rv-field"><label>Light variant</label><input type="file" id="gvl-illu-light" accept=".svg,.webp,.png" class="rv-input" style="padding:10px"></div>
    <div class="rv-field"><label>Dark variant</label><input type="file" id="gvl-illu-dark" accept=".svg,.webp,.png" class="rv-input" style="padding:10px"></div>
    <button class="rv-btn rv-btn-accent" id="gvl-illu-save" style="width:100%;margin-top:12px">Add to library</button>
  `);
  const nameEl = root.querySelector('#gvl-illu-name');
  nameEl.oninput = () => {
    root.querySelector('#gvl-illu-hint').innerHTML = nameEl.value.trim()
      ? nameHint('illustration', nameEl.value.trim()) : '';
  };
  const illuSaveBtn = root.querySelector('#gvl-illu-save');
  illuSaveBtn.onclick = async () => {
    if (illuSaveBtn.disabled) return;      // guard against double-submit
    const name = nameEl.value.trim();
    const light = root.querySelector('#gvl-illu-light').files[0];
    const dark = root.querySelector('#gvl-illu-dark').files[0];
    if (!name || !light || !dark) { toast?.('Name, light and dark files are all required', 'err'); return; }
    illuSaveBtn.disabled = true;
    try {
      await addVisualAsset('illustration', {
        id: `uillu-${generateId()}`,
        name,
        lightBlob: light,
        darkBlob: dark,
        lightType: light.type,
        darkType: dark.type,
        uploadedAt: new Date().toISOString(),
      });
    } catch (e) {
      illuSaveBtn.disabled = false;
      toast?.('Could not save illustration', 'err');
      return;
    }
    toast?.('Illustration added');
    close();
    onDone?.();
  };
}

window.GVLUploads = {
  openIconUpload, openIllustrationUpload,
  getUploadedIcons, getUploadedIllustrations,
  removeUploadedIcon, removeUploadedIllustration,
};
