// ═══════════════════════════════════════════════════════
// STASH CARD ENGINE
// Renders an item as a 5-layer skinned card and maps a
// JSON skin config object directly onto CSS custom
// properties for instant, code-free re-skinning.
// ═══════════════════════════════════════════════════════

import { db } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ── Default skin — always exists, used as the visual floor ──
export const DEFAULT_SKIN = {
  id: 'default',
  name: 'Default',
  tier: 'standard',
  glowColor: '#D4A017',
  glowIntensity: 0.12,
  glowSpeed: 4,
  frameColor: 'rgba(255,255,255,0.1)',
  frameWidth: 1,
  frameAnimated: false,
  breakoutEnabled: false,
  badgeBg: 'rgba(255,255,255,0.06)',
  badgeBorder: 'rgba(255,255,255,0.15)',
  badgeColor: 'rgba(255,255,255,0.5)',
  badgeLabel: ''
};

// ── In-memory cache of all loaded skins, keyed by id ──
let skinCache = { default: DEFAULT_SKIN };
let skinsUnsub = null;

// Live-subscribes to the skins collection so new admin-created
// skins appear everywhere instantly without a page refresh.
export function startSkinSync(onUpdate) {
  if (skinsUnsub) return; // already syncing
  skinsUnsub = onSnapshot(collection(db, 'cardSkins'), (snap) => {
    snap.docs.forEach(d => { skinCache[d.id] = { id: d.id, ...d.data() }; });
    if (onUpdate) onUpdate(skinCache);
  });
}

export function stopSkinSync() {
  if (skinsUnsub) { skinsUnsub(); skinsUnsub = null; }
}

export function getSkin(skinId) {
  return skinCache[skinId] || DEFAULT_SKIN;
}

export function getAllSkins() {
  return Object.values(skinCache);
}

// ── Admin: save (create or update) a skin ──
export async function saveSkin(skinId, config) {
  const id = skinId || ('skin_' + Date.now());
  await setDoc(doc(db, 'cardSkins', id), config, { merge: false });
  skinCache[id] = { id, ...config };
  return id;
}

export async function deleteSkin(skinId) {
  if (skinId === 'default') throw new Error('Cannot delete the default skin');
  await deleteDoc(doc(db, 'cardSkins', skinId));
  delete skinCache[skinId];
}

// ── Camel → kebab for CSS var naming ──
function kebab(str) {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// Keys that map straight onto numeric/string CSS custom properties.
// Anything not listed here is treated as structural (tier, breakoutEnabled, badgeLabel, name)
// rather than painted as a raw CSS var.
const CSS_VAR_KEYS = [
  'glowColor', 'glowIntensity', 'glowSpeed',
  'frameColor', 'frameWidth', 'frameOpacity',
  'frameColor1', 'frameColor2', 'frameColor3', 'frameGradientAngle', 'gradientSpeed',
  'frameShadowBlur', 'frameShadowSpread', 'frameInnerHighlight',
  'breakoutOffset', 'breakoutScale', 'breakoutOpacity', 'breakoutSpeed', 'bleedRotation',
  'assetInset', 'assetRadius', 'cardRadius',
  'badgeBg', 'badgeBorder', 'badgeColor'
];

const PX_KEYS = new Set(['frameWidth', 'frameShadowBlur', 'frameShadowSpread', 'breakoutOffset', 'cardRadius', 'assetRadius']);
const PCT_KEYS = new Set(['assetInset']);
const S_KEYS = new Set(['glowSpeed', 'gradientSpeed', 'breakoutSpeed']);
const DEG_KEYS = new Set(['frameGradientAngle', 'bleedRotation']);

// Writes every property from a skin config onto a card element's
// inline style in one batched pass — no layout reads interleaved.
export function applySkinToElement(cardEl, skin) {
  if (!cardEl || !skin) return;

  CSS_VAR_KEYS.forEach(key => {
    if (skin[key] === undefined || skin[key] === null) return;
    let value = skin[key];
    if (PX_KEYS.has(key) && typeof value === 'number') value = value + 'px';
    else if (PCT_KEYS.has(key) && typeof value === 'number') value = value + '%';
    else if (S_KEYS.has(key) && typeof value === 'number') value = value + 's';
    else if (DEG_KEYS.has(key) && typeof value === 'number') value = value + 'deg';
    cardEl.style.setProperty('--' + kebab(key), value);
  });

  // Structural attributes (toggle layers/classes, not continuous values)
  cardEl.dataset.tier = skin.tier || 'standard';

  const frameLayer = cardEl.querySelector('.sce-layer-frame');
  if (frameLayer) {
    frameLayer.classList.toggle('sce-frame-animated', !!skin.frameAnimated);
  }
}

// Builds the full 5-layer DOM for one card. Returns an HTML string —
// keeps this framework-agnostic so it drops into the existing
// template-string rendering style used throughout app.js.
export function renderCardHTML({ id, name, imageUrl, priceLabel, emoji, skinId }) {
  const skin = getSkin(skinId || 'default');
  const showBadge = skin.badgeLabel && skin.tier !== 'standard';

  return `
    <div class="stash-card-engine" id="sce-${id}" data-skin="${skin.id}">
      <div class="sce-layer-bg"></div>
      <div class="sce-layer-asset">
        ${imageUrl ? `<img src="${imageUrl}" alt="${escapeHtml(name)}" loading="lazy">` : (emoji || '📦')}
      </div>
      <div class="sce-layer-frame"></div>
      <div class="sce-layer-breakout">
        <div class="sce-breakout-spikes"></div>
      </div>
      ${showBadge ? `<div class="sce-tier-badge">${escapeHtml(skin.badgeLabel)}</div>` : ''}
      <div class="sce-layer-footer">
        <div class="sce-footer-name">${escapeHtml(name)}</div>
        <div class="sce-footer-value">${priceLabel}</div>
      </div>
    </div>`;
}

// Call this after inserting renderCardHTML output into the DOM,
// once per card, to paint its skin variables.
export function mountCard(id, skinId) {
  const el = document.getElementById('sce-' + id);
  if (!el) return;
  applySkinToElement(el, getSkin(skinId || 'default'));
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
