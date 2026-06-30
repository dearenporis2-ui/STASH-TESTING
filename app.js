// ─────────────────────────────────────────────
// app.js — Stash main application logic
// Firebase auth, Firestore data, all UI interactions
// ─────────────────────────────────────────────

import { auth, db } from './firebase.js';
import { openUploadWidget } from './cloudinary.js';
import {
  startSkinSync, getSkin, getAllSkins, saveSkin, deleteSkin,
  applySkinToElement, renderCardHTML, mountCard, DEFAULT_SKIN
} from './cardEngine.js';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, limit,
  onSnapshot, getDocs, serverTimestamp, increment, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const functions = getFunctions();

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
let currentUser = null;
let currentUserData = null;
let currentScreen = 'dashboard';
let marketFilter = 'all';
let marketListings = [];
let currentSheetListing = null;
let unsubscribeListeners = [];


// ═══════════════════════════════════════════
// LOADING SCREEN
// ═══════════════════════════════════════════
const LOADING_SCREEN_MIN_MS = 1800;
const loadingScreenStartTime = Date.now();

function hideLoadingScreen() {
  const screen = document.getElementById('loadingScreen');
  if (!screen) return;
  const elapsed = Date.now() - loadingScreenStartTime;
  const remaining = Math.max(0, LOADING_SCREEN_MIN_MS - elapsed);

  setTimeout(() => {
    screen.style.opacity = '0';
    screen.style.transform = 'scale(1.02)';
    screen.style.pointerEvents = 'none';
    setTimeout(() => { screen.style.display = 'none'; }, 600);
  }, remaining);
}

function showLoadingAnimation() {
  const logo = document.getElementById('loadingLogo');
  const tagline = document.getElementById('loadingTagline');
  const bar = document.getElementById('loadingBar');
  if (logo) { logo.style.opacity = '1'; logo.style.transform = 'translateY(0)'; }
  if (tagline) { tagline.style.opacity = '1'; }
  if (bar) { setTimeout(() => { bar.style.width = '100%'; }, 100); }
}

// ═══════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    await loadUserData(user.uid);
    showApp();
    initApp();
  } else {
    currentUser = null;
    currentUserData = null;
    showAuth();
  }
  hideLoadingScreen();
});

// Start the loading animation immediately
showLoadingAnimation();

// Safety fallback — never let the loading screen hang forever
setTimeout(() => {
  hideLoadingScreen();
}, 5000);

async function loadUserData(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  if (snap.exists()) {
    currentUserData = snap.data();
  }
  // Listen for real-time user data updates (balance, locked status, rep)
  const unsub = onSnapshot(doc(db, 'users', uid), (snap) => {
    if (snap.exists()) {
      currentUserData = snap.data();
      updateUserUI();
    }
  });
  unsubscribeListeners.push(unsub);
}

async function handleRegister() {
  const username = document.getElementById('regUsername').value.trim().toLowerCase().replace('@','');
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;

  if (!username || !email || !password) return showToast('Please fill in all fields', 'error');
  if (username.length < 3) return showToast('Username must be at least 3 characters', 'error');

  let cred = null;
  try {
    // Create the auth account FIRST so we're authenticated for Firestore reads/writes
    cred = await createUserWithEmailAndPassword(auth, email, password);

    // Now check username uniqueness (we're authenticated, so this read is allowed)
    const usernameSnap = await getDocs(query(collection(db, 'users'), where('username', '==', username)));
    if (!usernameSnap.empty) {
      // Username taken — delete the auth account we just created and bail
      await cred.user.delete();
      return showToast('Username already taken', 'error');
    }

    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid,
      username,
      email,
      displayName: username,
      bio: '',
      avatarUrl: '',
      goldBlocks: 0,
      traderRep: 0,
      portfolioValue: 0,
      accountLocked: false,
      pendingDebt: 0,
      isAdmin: false,
      ownedFrames: ['default'],
      createdAt: serverTimestamp()
    });
    showToast('Welcome to Stash!', 'success');
  } catch (err) {
    // Clean up auth account if something failed after it was created
    if (cred && cred.user) {
      try { await cred.user.delete(); } catch (e) {}
    }
    showToast(err.message, 'error');
  }
}

async function handleLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!email || !password) return showToast('Please fill in all fields', 'error');
  try {
    await signInWithEmailAndPassword(auth, email, password);
    showToast('Welcome back!', 'success');
  } catch (err) {
    showToast('Invalid email or password', 'error');
  }
}

async function handleLogout() {
  unsubscribeListeners.forEach(u => u());
  unsubscribeListeners = [];
  await signOut(auth);
}

function showApp() {
  document.getElementById('authWrap').style.display = 'none';
  document.getElementById('appWrap').style.display = 'block';
}

function showAuth() {
  document.getElementById('authWrap').style.display = 'flex';
  document.getElementById('appWrap').style.display = 'none';
}

function showLogin() {
  document.getElementById('loginCard').style.display = 'block';
  document.getElementById('registerCard').style.display = 'none';
}

function showRegister() {
  document.getElementById('loginCard').style.display = 'none';
  document.getElementById('registerCard').style.display = 'block';
}

// ═══════════════════════════════════════════
// APP INIT
// ═══════════════════════════════════════════
function initApp() {
  setupSidebarNav();
  setupMobileNav();
  updateUserUI();
  loadDashboard();
  loadMarketplace();
  loadLeaderboard();
  startCountdown();
  startSkinSync(); // every user gets live access to admin-published skins (read-only)
}

function updateUserUI() {
  if (!currentUserData) return;
  const initials = (currentUserData.displayName || currentUserData.username || 'U').substring(0,2).toUpperCase();
  const gbDisplay = `${Number(currentUserData.goldBlocks || 0).toLocaleString()} GB`;

  // Avatars
  ['sidebarAvatar','topbarAvatar','mobileAvatar'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (currentUserData.avatarUrl) {
      el.innerHTML = `<img src="${currentUserData.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else {
      el.textContent = initials;
    }
  });

  // Names
  const nameEl = document.getElementById('sidebarName');
  const handleEl = document.getElementById('sidebarHandle');
  if (nameEl) nameEl.textContent = currentUserData.displayName || currentUserData.username;
  if (handleEl) handleEl.textContent = '@' + currentUserData.username;

  // GB Balances
  ['sidebarGBBalance','topbarGBBalance','mobileGBBalance','dashGBBalance'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = gbDisplay;
  });

  // Dashboard stats
  const repEl = document.getElementById('dashTraderRep');
  if (repEl) repEl.textContent = currentUserData.traderRep || 0;

  // Account locked banner
  const banner = document.getElementById('lockedBanner');
  if (banner) banner.style.display = currentUserData.accountLocked ? 'flex' : 'none';

  // Admin nav
  if (currentUserData.isAdmin) {
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'flex');
  }

  // Portfolio screen
  updatePortfolioUI();
  // Mobile drawer
  updateDrawerUI();
  // Refresh exotic shop owned badges whenever user data changes
  refreshShopOwnership();
}

function refreshShopOwnership() {
  const owned = currentUserData?.ownedFrames || ['default'];
  const shopFrames = [
    { id: 'gold', btnId: 'buyBtnGold' },
    { id: 'holo', btnId: 'buyBtnHolo' },
    { id: 'purple', btnId: 'buyBtnPurple' },
    { id: 'carbon', btnId: 'buyBtnCarbon' },
    { id: 'neon', btnId: 'buyBtnNeon' }
  ];
  shopFrames.forEach(({ id, btnId }) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const card = btn.closest('.skin-card');
    if (owned.includes(id)) {
      btn.textContent = 'Owned ✓';
      btn.style.background = 'rgba(46,204,113,0.15)';
      btn.style.color = '#2ecc71';
      btn.style.cursor = 'default';
      if (card && !card.querySelector('.owned-ribbon')) {
        const ribbon = document.createElement('div');
        ribbon.className = 'owned-ribbon';
        ribbon.style.cssText = 'position:absolute;top:12px;left:12px;background:rgba(46,204,113,0.9);color:#080809;font-size:10px;font-weight:800;padding:4px 10px;border-radius:6px;z-index:2';
        ribbon.textContent = 'OWNED';
        if (card.style.position !== 'relative') card.style.position = 'relative';
        card.prepend(ribbon);
      }
    } else {
      btn.textContent = 'Buy Now';
      btn.style.background = '';
      btn.style.color = '';
      btn.style.cursor = 'pointer';
      const ribbon = card?.querySelector('.owned-ribbon');
      if (ribbon) ribbon.remove();
    }
  });
}

function updatePortfolioUI() {
  if (!currentUserData) return;
  const initials = (currentUserData.displayName || currentUserData.username || 'U').substring(0,2).toUpperCase();
  const portAvatar = document.getElementById('portAvatar');
  if (portAvatar) {
    if (currentUserData.avatarUrl) {
      portAvatar.innerHTML = `<img src="${currentUserData.avatarUrl}" style="width:100%;height:100%;object-fit:cover">`;
    } else {
      portAvatar.textContent = initials;
    }
  }
  setText('portName', currentUserData.displayName || currentUserData.username);
  setText('portHandle', '@' + currentUserData.username + ' · stash.app/u/' + currentUserData.username);
  setText('portBio', currentUserData.bio || 'Add a bio in your profile settings.');
  setText('portTraderRep', currentUserData.traderRep || 0);
  setText('portStatRep', currentUserData.traderRep || 0);
  setText('portStatGB', (currentUserData.goldBlocks || 0) + ' GB');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}


// ═══════════════════════════════════════════
// NOTIFICATION SOUND SYSTEM
// ═══════════════════════════════════════════
const AudioContext = window.AudioContext || window.webkitAudioContext;

function playNotificationSound(type = 'info') {
  try {
    const ctx = new AudioContext();

    const sounds = {
      success: [
        { freq: 523.25, start: 0,    duration: 0.12, gain: 0.18 }, // C5
        { freq: 659.25, start: 0.1,  duration: 0.12, gain: 0.16 }, // E5
        { freq: 783.99, start: 0.2,  duration: 0.2,  gain: 0.14 }, // G5
      ],
      error: [
        { freq: 311.13, start: 0,    duration: 0.15, gain: 0.18 }, // Eb4
        { freq: 277.18, start: 0.14, duration: 0.25, gain: 0.15 }, // Db4
      ],
      info: [
        { freq: 698.46, start: 0,    duration: 0.1,  gain: 0.14 }, // F5
        { freq: 880.00, start: 0.09, duration: 0.18, gain: 0.12 }, // A5
      ]
    };

    const notes = sounds[type] || sounds.info;

    notes.forEach(({ freq, start, duration, gain }) => {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);

      // Smooth fade in and out for elegance
      gainNode.gain.setValueAtTime(0, ctx.currentTime + start);
      gainNode.gain.linearRampToValueAtTime(gain, ctx.currentTime + start + 0.04);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);

      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + duration + 0.05);
    });

    // Close context after all sounds finish
    setTimeout(() => ctx.close(), 1000);
  } catch (e) {
    // Silently fail if audio not supported
  }
}

// ═══════════════════════════════════════════
// SCREEN SWITCHING
// ═══════════════════════════════════════════
const topbarTitles = {
  dashboard: 'My Stash',
  marketplace: 'Marketplace',
  shop: '✦ Exotic Shop',
  leaderboard: '🏆 Leaderboard',
  portfolio: 'Public Profile',
  trades: 'My Trades',
  admin: '🛡 Admin Panel'
};

function switchScreen(id) {
  if (id === currentScreen) return;

  // Hard block — only the verified admin account can ever see this screen
  if (id === 'admin' && !currentUserData?.isAdmin) {
    showToast('Access denied', 'error');
    return;
  }

  const leaving = document.getElementById('screen-' + currentScreen);
  const entering = document.getElementById('screen-' + id);
  if (!entering) return;

  leaving.classList.add('leaving');
  setTimeout(() => {
    leaving.classList.remove('leaving', 'active');
    entering.scrollTop = 0;
    entering.classList.add('active');
    currentScreen = id;

    // Lazy load screen data
    if (id === 'marketplace') loadMarketplace();
    if (id === 'leaderboard') loadLeaderboard();
    if (id === 'trades') loadTrades();
    if (id === 'portfolio') loadPortfolioListings();
    if (id === 'admin' && currentUserData?.isAdmin) loadAdminData();
  }, 220);

  document.querySelectorAll('.snav').forEach(n => n.classList.toggle('active', n.dataset.screen === id));
  document.querySelectorAll('.bottom-nav .nav-item[data-screen]').forEach(n => n.classList.toggle('active', n.dataset.screen === id));
  const titleEl = document.getElementById('topbarTitle');
  if (titleEl) titleEl.textContent = topbarTitles[id] || id;
}

function setupSidebarNav() {
  document.querySelectorAll('.snav[data-screen]').forEach(el => {
    el.addEventListener('click', () => switchScreen(el.dataset.screen));
  });
}

function setupMobileNav() {
  document.querySelectorAll('.bottom-nav .nav-item[data-screen]').forEach(el => {
    el.addEventListener('click', () => switchScreen(el.dataset.screen));
  });
}

// ═══════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════
async function loadDashboard() {
  if (!currentUser) return;

  // No orderBy here to avoid needing a composite Firestore index
  const q = query(
    collection(db, 'listings'),
    where('sellerId', '==', currentUser.uid),
    where('status', '==', 'active')
  );

  const unsub = onSnapshot(q, (snap) => {
    const listings = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderDashboard(listings);
  });
  unsubscribeListeners.push(unsub);
}

function renderDashboard(listings) {
  const pinned = listings.filter(l => l.pinned);
  const all = listings;

  // Portfolio value
  const total = listings.reduce((sum, l) => sum + (l.priceSCR || 0), 0);
  const nwEl = document.getElementById('nwValue');
  if (nwEl) animateCount(nwEl, total);

  const trendEl = document.getElementById('nwTrend');
  if (trendEl) {
    trendEl.textContent = listings.length === 0
      ? 'No items yet — list your first item!'
      : `${listings.length} item${listings.length !== 1 ? 's' : ''} in your stash`;
    trendEl.style.color = 'var(--green)';
    trendEl.style.background = 'var(--green-bg)';
    trendEl.style.border = '1px solid var(--green-border)';
  }

  setText('dashTotalItems', listings.length);

  // Update Firestore portfolio value
  if (currentUser) {
    updateDoc(doc(db, 'users', currentUser.uid), { portfolioValue: total }).catch(() => {});
  }

  // Portfolio screen stats
  setText('portStatItems', listings.length);
  setText('portStatValue', 'SCR ' + total.toLocaleString());
  setText('portValue', 'SCR ' + total.toLocaleString());
  setText('portItemCount', listings.length + ' items');
  setText('pubCount', listings.length + ' Items');
  setText('myListingsCount', listings.length + ' Items');

  // Pinned grails
  setText('pinnedCount', pinned.length + ' Pinned');
  const pinnedGrid = document.getElementById('pinnedGrid');
  if (pinnedGrid) {
    if (pinned.length === 0) {
      pinnedGrid.innerHTML = `<div class="empty-state" style="grid-column:span 3;padding:40px"><div class="empty-icon">📌</div><div class="empty-title">No Grails Pinned Yet</div><div class="empty-sub">Pin your most prized items to the Top Shelf when listing them.</div></div>`;
    } else {
      pinnedGrid.innerHTML = pinned.slice(0,3).map((l, i) => renderTopShelfCard(l, i === 0)).join('');
    }
  }

  // My listings grid
  const grid = document.getElementById('myListingsGrid');
  if (grid) {
    if (all.length === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:span 4;padding:40px"><div class="empty-icon">📦</div><div class="empty-title">Your Stash is Empty</div><div class="empty-sub">Start listing your items to build your collection portfolio.</div><button class="modal-btn" style="width:auto;padding:14px 28px;margin-top:16px" onclick="openListingModal()">List Your First Item</button></div>`;
    } else {
      grid.innerHTML = all.map(l => renderClosetCard(l)).join('');
    }
  }

  // Portfolio grid
  renderPortfolioGrid(all);
}

function renderTopShelfCard(l, featured = false) {
  const frameClass = getFrameClass(l.frame);
  const imgContent = l.imageUrl
    ? `<img src="${l.imageUrl}" style="width:100%;height:100%;object-fit:cover">`
    : getCategoryEmoji(l.category);
  return `
    <div class="glass-card ${frameClass}${featured ? '' : ''}" style="${featured ? 'grid-column:span 1' : ''}">
      <div class="quick-edit-btn" onclick="openConfirmDelete('${l.id}')"><i class="ti ti-trash"></i></div>
      ${getFrameBadge(l.frame)}
      <div class="item-img tall">${imgContent}</div>
      <div class="item-name">${escHtml(l.name)}</div>
      <div class="item-sub">${escHtml(l.description || '')}</div>
      <div class="item-value">SCR ${Number(l.priceSCR || 0).toLocaleString()}</div>
    </div>`;
}

function renderClosetCard(l) {
  const imgContent = l.imageUrl
    ? `<img src="${l.imageUrl}" style="width:100%;height:100%;object-fit:cover">`
    : getCategoryEmoji(l.category);
  const intentTag = l.intent ? `<div class="intent-tag tag-${l.intent}" style="margin-top:6px">${getIntentLabel(l.intent)}</div>` : '';
  return `
    <div class="closet-card" style="position:relative">
      <div class="quick-edit-btn" style="top:10px;right:10px" onclick="openEditListing('${l.id}')"><i class="ti ti-pencil"></i></div>
      <div class="closet-img">${imgContent}</div>
      <div class="closet-name">${escHtml(l.name)}</div>
      <div class="closet-sub">${escHtml(l.category || '')}</div>
      <div class="closet-value">SCR ${Number(l.priceSCR || 0).toLocaleString()}</div>
      ${intentTag}
    </div>`;
}

function renderPortfolioGrid(listings) {
  const grid = document.getElementById('portfolioGrid');
  if (!grid) return;
  if (listings.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:span 4"><div class="empty-icon">📦</div><div class="empty-title">No Public Listings</div></div>`;
    return;
  }
  grid.innerHTML = listings.map(l => {
    const frameClass = l.frame && l.frame !== 'default' ? `${l.frame}-frame` : '';
    const imgContent = l.imageUrl ? `<img src="${l.imageUrl}" style="width:100%;height:100%;object-fit:cover">` : getCategoryEmoji(l.category);
    const intentTag = `<div class="intent-tag tag-${l.intent || 'trade'}">${getIntentLabel(l.intent)}</div>`;
    return `
      <div class="p-card ${frameClass}" data-intent="${l.intent || 'trade'}" style="position:relative">
        <div class="quick-edit-btn" onclick="openEditListing('${l.id}')"><i class="ti ti-pencil"></i></div>
        ${getFrameBadge(l.frame)}
        <div class="p-img">${imgContent}</div>
        <div class="item-name">${escHtml(l.name)}</div>
        <div class="item-sub">${escHtml(l.category || '')}</div>
        <div class="p-footer">
          <div><div class="p-value">SCR ${Number(l.priceSCR || 0).toLocaleString()}</div>${intentTag}</div>
          <button class="inquire-btn" style="background:var(--glass-gold);color:var(--gold)" onclick="openEditListing('${l.id}')">Edit</button>
        </div>
      </div>`;
  }).join('');
}

// ═══════════════════════════════════════════
// MARKETPLACE
// ═══════════════════════════════════════════
async function loadMarketplace() {
  // No orderBy to avoid composite index requirement
  const q = query(
    collection(db, 'listings'),
    where('status', 'in', ['active', 'reserved']),
    limit(50)
  );

  const unsub = onSnapshot(q, (snap) => {
    marketListings = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderMarketplace();
  });
  unsubscribeListeners.push(unsub);
}

function renderMarketplace() {
  const search = (document.getElementById('marketSearch')?.value || '').toLowerCase();
  let filtered = marketListings;

  if (marketFilter !== 'all') {
    filtered = filtered.filter(l => l.category === marketFilter);
  }
  if (search) {
    filtered = filtered.filter(l =>
      l.name?.toLowerCase().includes(search) ||
      l.category?.toLowerCase().includes(search) ||
      l.description?.toLowerCase().includes(search)
    );
  }

  setText('marketCount', filtered.length + ' Listings');

  const grid = document.getElementById('marketplaceGrid');
  if (!grid) return;

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:span 4"><div class="empty-icon">🔍</div><div class="empty-title">No Listings Found</div><div class="empty-sub">Try adjusting your search or filters.</div></div>`;
    return;
  }

  grid.innerHTML = filtered.map(l => {
    const isMine = l.sellerId === currentUser?.uid;
    const imgContent = l.imageUrl
      ? `<img src="${l.imageUrl}" style="width:100%;height:100%;object-fit:cover">`
      : getCategoryEmoji(l.category);
    const statusTag = l.status === 'reserved'
      ? `<div class="intent-tag tag-reserved">Reserved</div>`
      : `<div class="intent-tag tag-${l.intent || 'trade'}">${getIntentLabel(l.intent)}</div>`;

    const actionBtn = isMine
      ? `<button class="reserve-btn" style="background:var(--glass-gold);color:var(--gold)" onclick="openEditListing('${l.id}')"><i class="ti ti-pencil" style="margin-right:4px"></i>Edit Listing</button>`
      : `<button class="reserve-btn" onclick="openSheet('${l.id}')" ${l.status === 'reserved' ? 'disabled' : ''}>${l.status === 'reserved' ? 'Reserved' : 'Inquire / Reserve'}</button>`;

    return `
      <div class="listing-card" style="${isMine ? 'border-color:rgba(212,160,23,0.35)' : ''}">
        <div class="listing-img" style="position:relative">${imgContent}${isMine ? '<div style="position:absolute;top:8px;right:8px;background:rgba(212,160,23,0.9);color:#080809;font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px">YOURS</div>' : ''}</div>
        <div class="listing-name">${escHtml(l.name)}</div>
        <div class="listing-seller">by @${escHtml(l.sellerUsername || 'unknown')}${isMine ? ' (you)' : ''}</div>
        <div class="listing-price">SCR ${Number(l.priceSCR || 0).toLocaleString()}</div>
        ${statusTag}
        <div class="listing-footer" style="margin-top:10px">
          ${actionBtn}
        </div>
      </div>`;
  }).join('');
}

function setMarketFilter(el, filter) {
  document.querySelectorAll('#marketFilterRow .filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  marketFilter = filter;
  renderMarketplace();
}

function filterMarketplace() {
  renderMarketplace();
}

// ═══════════════════════════════════════════
// LEADERBOARD
// ═══════════════════════════════════════════
async function loadLeaderboard() {
  const q = query(
    collection(db, 'users'),
    orderBy('portfolioValue', 'desc'),
    limit(10)
  );
  const snap = await getDocs(q);
  const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderLeaderboard(users);
}

function renderLeaderboard(users) {
  const podium = document.getElementById('leaderboardPodium');
  const list = document.getElementById('leaderboardList');
  if (!podium || !list) return;

  if (users.length === 0) {
    podium.innerHTML = '';
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🏆</div><div class="empty-title">No data yet</div></div>`;
    return;
  }

  const top3 = users.slice(0, 3);
  const rest = users.slice(3);
  const medals = ['🥇','🥈','🥉'];
  const podiumOrder = top3.length >= 2 ? [top3[1], top3[0], top3[2]].filter(Boolean) : top3;
  const podiumClasses = top3.length >= 2 ? ['second','first','third'] : ['first'];

  podium.innerHTML = podiumOrder.map((u, i) => {
    const initials = (u.displayName || u.username || '?').substring(0,2).toUpperCase();
    const rank = top3.indexOf(u);
    return `
      <div class="podium-card ${podiumClasses[i]}">
        <div class="podium-rank">${medals[rank] || ''}</div>
        <div class="podium-avatar" style="background:linear-gradient(135deg,var(--gold),var(--gold-light))">
          ${u.avatarUrl ? `<img src="${u.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : initials}
        </div>
        <div class="podium-name">${escHtml(u.displayName || u.username)}</div>
        <div class="podium-handle">@${escHtml(u.username)}</div>
        <div class="podium-value">SCR ${Number(u.portfolioValue || 0).toLocaleString()}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Rep: ${u.traderRep || 0}</div>
      </div>`;
  }).join('');

  list.innerHTML = rest.map((u, i) => {
    const initials = (u.displayName || u.username || '?').substring(0,2).toUpperCase();
    const isMe = u.id === currentUser?.uid;
    return `
      <div class="lb-row" style="${isMe ? 'border-color:rgba(212,160,23,0.4);background:rgba(212,160,23,0.06)' : ''}">
        <div class="lb-rank" style="${isMe ? 'color:var(--gold)' : ''}">${i + 4}</div>
        <div class="lb-avatar" style="background:linear-gradient(135deg,var(--gold),var(--gold-light))">
          ${u.avatarUrl ? `<img src="${u.avatarUrl}" style="width:100%;height:100%;object-fit:cover">` : initials}
        </div>
        <div class="lb-info">
          <div class="lb-name">${escHtml(u.displayName || u.username)}${isMe ? ' <span style="font-size:10px;color:var(--gold);font-weight:700">· You</span>' : ''}</div>
          <div class="lb-handle">@${escHtml(u.username)}</div>
        </div>
        <div style="text-align:right">
          <div class="lb-value">SCR ${Number(u.portfolioValue || 0).toLocaleString()}</div>
          <div class="lb-change">Rep: ${u.traderRep || 0}</div>
        </div>
      </div>`;
  }).join('');
}

// ═══════════════════════════════════════════
// PORTFOLIO FILTERS
// ═══════════════════════════════════════════
function setPubFilter(el, intent) {
  document.querySelectorAll('#screen-portfolio .filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  const cards = document.querySelectorAll('#portfolioGrid .p-card');
  let visible = 0;
  cards.forEach(card => {
    const show = intent === 'all' || card.dataset.intent === intent;
    card.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  setText('pubCount', visible + ' Items');
}

async function loadPortfolioListings() {
  if (!currentUser) return;
  const q = query(
    collection(db, 'listings'),
    where('sellerId', '==', currentUser.uid),
    where('status', '==', 'active')
  );
  const snap = await getDocs(q);
  const listings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderPortfolioGrid(listings);
  setText('portStatItems', listings.length);
  const total = listings.reduce((s, l) => s + (l.priceSCR || 0), 0);
  setText('portStatValue', 'SCR ' + total.toLocaleString());
}

// ═══════════════════════════════════════════
// LISTING MODAL
// ═══════════════════════════════════════════
const specFields = {
  Watches: [
    { id: 'specMovement', label: 'Movement Type', placeholder: 'e.g. Automatic, Quartz' },
    { id: 'specCaseSize', label: 'Case Size (mm)', placeholder: 'e.g. 40mm' },
    { id: 'specDial', label: 'Dial Color', placeholder: 'e.g. Black, Blue' }
  ],
  Sneakers: [
    { id: 'specSize', label: 'Size', placeholder: 'e.g. US 10' },
    { id: 'specCondition', label: 'Condition', placeholder: 'e.g. DS, VNDS, Worn' }
  ],
  Tech: [
    { id: 'specModel', label: 'Model / Spec', placeholder: 'e.g. M3 Max, 64GB' },
    { id: 'specCondition', label: 'Condition', placeholder: 'e.g. New, Like New' }
  ],
  Cars: [
    { id: 'specYear', label: 'Year', placeholder: 'e.g. 2021' },
    { id: 'specMileage', label: 'Mileage', placeholder: 'e.g. 15,000 km' }
  ],
  'Parts Bin': [
    { id: 'specPartType', label: 'Part Type', placeholder: 'e.g. Watch strap, Mod chip' },
    { id: 'specCompatibility', label: 'Compatibility', placeholder: 'e.g. Rolex 20mm' }
  ]
};

function updateSpecFields() {
  const cat = document.getElementById('listingCategory').value;
  const wrap = document.getElementById('specFieldsWrap');
  const fields = specFields[cat];
  if (!fields || !wrap) { if (wrap) wrap.innerHTML = ''; return; }
  wrap.innerHTML = `
    <div style="grid-column:span 2;font-size:11px;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">
      ${cat} Specs
    </div>
    ${fields.map(f => `
      <div class="modal-group">
        <div class="modal-label">${f.label}</div>
        <input class="modal-input" id="${f.id}" type="text" placeholder="${f.placeholder}" />
      </div>
    `).join('')}`;
}

let editingListingId = null;

function openListingModal() {
  editingListingId = null;
  document.querySelector('#listingModal .modal-title').textContent = 'List an Item';
  document.querySelector('#listingModal .modal-btn').textContent = 'List Item ✦';
  refreshFrameDropdownOwnership();
  populateCustomSkinsInDropdown();
  document.getElementById('listingModal').classList.add('open');
}

// Injects admin-created custom skins (from cardSkins collection) into the
// Card Frame dropdown, below the 5 built-in frames, so listing an item
// always offers whatever the admin has published — live, no app update needed.
function populateCustomSkinsInDropdown() {
  const dropdown = document.getElementById('csFrameDropdown');
  if (!dropdown) return;
  // Clear any previously injected custom options first
  dropdown.querySelectorAll('.cs-option[data-custom-skin]').forEach(el => el.remove());

  const customSkins = getAllSkins().filter(s => s.id !== 'default');
  const owned = currentUserData?.ownedFrames || ['default'];

  customSkins.forEach(s => {
    const emoji = s.tier === 'mythic' ? '🔥' : s.tier === 'epic' ? '🟣' : s.tier === 'rare' ? '🔷' : '✦';
    const opt = document.createElement('div');
    opt.className = 'cs-option';
    opt.setAttribute('data-custom-skin', s.id);
    opt.innerHTML = `<span class="cs-opt-icon">${emoji}</span>${escHtml(s.name)}`;
    opt.onclick = () => { selectCS('csFrame', 'listingFrame', s.id, `${emoji} ${s.name}`); };

    const isOwned = owned.includes(s.id);
    if (!isOwned) {
      opt.style.opacity = '0.35';
      opt.style.pointerEvents = 'none';
      const badge = document.createElement('span');
      badge.style.cssText = 'margin-left:auto;font-size:10px;color:var(--text-muted);display:flex;align-items:center;gap:3px';
      badge.innerHTML = '<i class="ti ti-lock" style="font-size:12px"></i> Shop';
      opt.appendChild(badge);
    }
    dropdown.appendChild(opt);
  });
}

function refreshFrameDropdownOwnership() {
  const owned = currentUserData?.ownedFrames || ['default'];
  const frameMap = {
    default: { label: '⬜ Default (Free)', emoji: '⬜' },
    gold: { label: '🟨 Liquid Gold Frame', emoji: '🟨' },
    holo: { label: '🌈 Holographic Foil', emoji: '🌈' },
    purple: { label: '💜 Royal Purple', emoji: '💜' },
    carbon: { label: '🖤 Carbon Fiber', emoji: '🖤' },
    neon: { label: '💚 Neon Grid', emoji: '💚' }
  };
  const dropdown = document.querySelector('#csFrame .cs-dropdown');
  if (!dropdown) return;

  dropdown.querySelectorAll('.cs-option').forEach(opt => {
    const onclickAttr = opt.getAttribute('onclick') || '';
    const match = onclickAttr.match(/'([a-z]+)',/);
    if (!match) return;
    const frameId = match[1];
    const isOwned = owned.includes(frameId);

    if (!isOwned) {
      opt.style.opacity = '0.35';
      opt.style.pointerEvents = 'none';
      opt.setAttribute('data-locked', 'true');
      if (!opt.querySelector('.cs-lock-badge')) {
        const badge = document.createElement('span');
        badge.className = 'cs-lock-badge';
        badge.style.cssText = 'margin-left:auto;font-size:10px;color:var(--text-muted);display:flex;align-items:center;gap:3px';
        badge.innerHTML = '<i class="ti ti-lock" style="font-size:12px"></i> Shop';
        opt.appendChild(badge);
      }
    } else {
      opt.style.opacity = '1';
      opt.style.pointerEvents = 'auto';
      opt.removeAttribute('data-locked');
      const badge = opt.querySelector('.cs-lock-badge');
      if (badge) badge.remove();
    }
  });
}

async function openEditListing(listingId) {
  const snap = await getDoc(doc(db, 'listings', listingId));
  if (!snap.exists()) return showToast('Listing not found', 'error');
  const l = snap.data();

  editingListingId = listingId;
  document.querySelector('#listingModal .modal-title').textContent = 'Edit Listing';
  document.querySelector('#listingModal .modal-btn').textContent = 'Save Changes ✦';

  document.getElementById('listingName').value = l.name || '';
  document.getElementById('listingPrice').value = l.priceSCR || '';
  document.getElementById('listingDesc').value = l.description || '';
  document.getElementById('listingImageUrl').value = l.imageUrl || '';
  document.getElementById('listingWhatsApp').value = l.whatsapp || '';
  document.getElementById('listingInstagram').value = l.instagram || '';
  document.getElementById('listingPinned').checked = !!l.pinned;

  // Set category via custom dropdown
  if (l.category) {
    const catEmoji = { Watches:'⌚', Sneakers:'👟', Tech:'💻', Jewelry:'💍', Cars:'🚗', Bags:'👜', 'Parts Bin':'🔧', Other:'📦' };
    selectCS('csCategory', 'listingCategory', l.category, (catEmoji[l.category]||'📦') + ' ' + l.category);
    updateSpecFields();
    // Fill spec fields after they render
    setTimeout(() => {
      if (l.specs) {
        Object.keys(l.specs).forEach(key => {
          const el = document.getElementById(key);
          if (el) el.value = l.specs[key];
        });
      }
    }, 50);
  }

  // Set intent via custom dropdown
  const intentLabels = { trade: '🔄 Looking to Trade', cash: '💰 Accepting Cash Offers', grail: '👑 Personal Grail (View Only)' };
  selectCS('csIntent', 'listingIntent', l.intent || 'trade', intentLabels[l.intent || 'trade']);

  // Set frame via custom dropdown
  const frameLabels = { default: '⬜ Default (Free)', gold: '🟨 Liquid Gold Frame', holo: '🌈 Holographic Foil', purple: '💜 Royal Purple', carbon: '🖤 Carbon Fiber', neon: '💚 Neon Grid' };
  populateCustomSkinsInDropdown();
  const customSkin = getSkin(l.frame);
  if (customSkin && customSkin.id === l.frame && l.frame !== 'default' && !frameLabels[l.frame]) {
    const emoji = customSkin.tier === 'mythic' ? '🔥' : customSkin.tier === 'epic' ? '🟣' : customSkin.tier === 'rare' ? '🔷' : '✦';
    selectCS('csFrame', 'listingFrame', l.frame, `${emoji} ${customSkin.name}`);
  } else {
    selectCS('csFrame', 'listingFrame', l.frame || 'default', frameLabels[l.frame || 'default']);
  }
  refreshFrameDropdownOwnership();

  // Image preview
  const preview = document.getElementById('uploadPreview');
  if (preview) {
    preview.innerHTML = l.imageUrl
      ? `<img src="${l.imageUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:12px">`
      : `<i class="ti ti-photo-up" style="font-size:32px;color:var(--text-muted);margin-bottom:8px"></i><div style="font-size:13px;color:var(--text-muted)">Click to upload photo</div>`;
  }

  document.getElementById('listingModal').classList.add('open');
}

function closeListingModal() {
  document.getElementById('listingModal').classList.remove('open');
  editingListingId = null;
  // Reset form
  ['listingName','listingPrice','listingDesc','listingImageUrl','listingWhatsApp','listingInstagram'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('listingCategory').value = '';
  document.getElementById('listingIntent').value = 'trade';
  document.getElementById('listingFrame').value = 'default';
  document.getElementById('listingPinned').checked = false;
  document.getElementById('specFieldsWrap').innerHTML = '';
  const preview = document.getElementById('uploadPreview');
  if (preview) preview.innerHTML = `<i class="ti ti-photo-up" style="font-size:32px;color:var(--text-muted);margin-bottom:8px"></i><div style="font-size:13px;color:var(--text-muted)">Click to upload photo</div>`;
}

function triggerUpload() {
  openUploadWidget((url) => {
    document.getElementById('listingImageUrl').value = url;
    const preview = document.getElementById('uploadPreview');
    if (preview) preview.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:12px">`;
  });
}

async function submitListing() {
  if (!currentUser || !currentUserData) return;
  if (currentUserData.accountLocked) return showToast('Account restricted. Settle your debt first.', 'error');

  const name = document.getElementById('listingName').value.trim();
  const price = parseFloat(document.getElementById('listingPrice').value);
  const category = document.getElementById('listingCategory').value;
  const intent = document.getElementById('listingIntent').value;
  const frame = document.getElementById('listingFrame').value;
  const desc = document.getElementById('listingDesc').value.trim();
  const imageUrl = document.getElementById('listingImageUrl').value;
  const pinned = document.getElementById('listingPinned').checked;
  const whatsapp = document.getElementById('listingWhatsApp').value.trim();
  const instagram = document.getElementById('listingInstagram').value.trim();

  if (!name) return showToast('Please enter an item name', 'error');
  if (!price || isNaN(price)) return showToast('Please enter a valid price', 'error');
  if (!category) return showToast('Please select a category', 'error');
  if (intent !== 'grail' && !whatsapp && !instagram) {
    return showToast('Add a WhatsApp number or Instagram so buyers can reach you', 'error');
  }

  // Collect spec fields
  const specs = {};
  const catFields = specFields[category] || [];
  catFields.forEach(f => {
    const el = document.getElementById(f.id);
    if (el && el.value) specs[f.id] = el.value.trim();
  });

  const listingData = {
    name,
    priceSCR: price,
    category,
    intent,
    frame,
    description: desc,
    imageUrl: imageUrl || '',
    specs,
    pinned,
    whatsapp: whatsapp || '',
    instagram: instagram || ''
  };

  try {
    if (editingListingId) {
      // EDIT MODE — update existing listing
      await updateDoc(doc(db, 'listings', editingListingId), listingData);
      closeListingModal();
      showToast('Listing updated!', 'success');
    } else {
      // CREATE MODE — new listing
      await addDoc(collection(db, 'listings'), {
        ...listingData,
        sellerId: currentUser.uid,
        sellerUsername: currentUserData.username,
        sellerDisplayName: currentUserData.displayName || currentUserData.username,
        status: 'active',
        createdAt: serverTimestamp()
      });
      closeListingModal();
      showToast('Item listed successfully!', 'success');
    }
  } catch (err) {
    showToast('Error saving listing: ' + err.message, 'error');
  }
}

async function deleteListing(listingId) {
  openConfirmDelete(listingId);
}

// ═══════════════════════════════════════════
// QUICK-STRIKE SHEET
// ═══════════════════════════════════════════
async function openSheet(listingId) {
  const snap = await getDoc(doc(db, 'listings', listingId));
  if (!snap.exists()) return showToast('Listing not found', 'error');
  currentSheetListing = { id: listingId, ...snap.data() };
  const l = currentSheetListing;

  const imgEl = document.getElementById('sheetImg');
  if (imgEl) {
    imgEl.innerHTML = l.imageUrl
      ? `<img src="${l.imageUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:12px">`
      : getCategoryEmoji(l.category);
  }
  setText('sheetName', l.name);
  setText('sheetSeller', 'Listed by @' + (l.sellerUsername || 'unknown'));
  setText('sheetVal', 'SCR ' + Number(l.priceSCR || 0).toLocaleString());

  const isGrail = l.intent === 'grail';
  const pitch = document.getElementById('autoPitch');
  const actionBtns = document.getElementById('actionBtns');
  const actionLabel = document.getElementById('actionLabel');
  const grailNotice = document.getElementById('grailNotice');
  const pitchText = document.getElementById('pitchText');

  if (isGrail) {
    if (pitch) pitch.style.display = 'none';
    if (actionBtns) actionBtns.style.display = 'none';
    if (actionLabel) actionLabel.style.display = 'none';
    if (grailNotice) grailNotice.style.display = 'block';
    const igBtnHide = document.getElementById('sheetIgBtn');
    if (igBtnHide) igBtnHide.style.display = 'none';
  } else {
    if (pitch) pitch.style.display = '';
    if (actionBtns) actionBtns.style.display = '';
    if (actionLabel) actionLabel.style.display = '';
    if (grailNotice) grailNotice.style.display = 'none';
    const msg = l.intent === 'trade'
      ? `"Yo! I saw your <b>${escHtml(l.name)}</b> on Stash — I've got heat to swap. Let's talk."`
      : `"Yo! I saw your <b>${escHtml(l.name)}</b> on Stash. What's your best price?"`;
    if (pitchText) pitchText.innerHTML = msg;

    const plainMsg = l.intent === 'trade'
      ? `Yo! I saw your ${l.name} on Stash — I've got heat to swap. Let's talk.`
      : `Yo! I saw your ${l.name} on Stash. What's your best price?`;

    const waBtn = document.getElementById('sheetWaBtn');
    if (waBtn) {
      if (l.whatsapp) {
        const cleanNumber = l.whatsapp.replace(/[^0-9]/g, '');
        waBtn.href = `https://wa.me/${cleanNumber}?text=${encodeURIComponent(plainMsg)}`;
        waBtn.style.opacity = '1';
        waBtn.style.pointerEvents = 'auto';
      } else {
        waBtn.removeAttribute('href');
        waBtn.style.opacity = '0.4';
        waBtn.style.pointerEvents = 'none';
      }
    }

    const igBtn = document.getElementById('sheetIgBtn');
    if (igBtn) {
      if (l.instagram) {
        const handle = l.instagram.replace('@', '').trim();
        igBtn.href = `https://instagram.com/${handle}`;
        igBtn.style.display = 'flex';
      } else {
        igBtn.style.display = 'none';
      }
    }
  }
  document.getElementById('sheetOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  document.getElementById('sheetOverlay').classList.remove('open');
  document.body.style.overflow = '';
  currentSheetListing = null;
}

async function reserveItem() {
  if (!currentUser || !currentSheetListing) return;
  if (!currentUserData) return showToast('User data not loaded', 'error');

  const ESCROW_COST = 100; // GB required to reserve
  if (currentUserData.goldBlocks < ESCROW_COST) {
    return showToast(`You need ${ESCROW_COST} GB to reserve an item. Visit the Exotic Shop to buy Gold Blocks.`, 'error');
  }

  try {
    const lockEscrowFn = httpsCallable(functions, 'lockEscrow');
    await lockEscrowFn({ listingId: currentSheetListing.id, goldBlockAmount: ESCROW_COST });
    closeSheet();
    showToast('Item reserved! Go to My Trades to manage the handshake.', 'success');
    switchScreen('trades');
  } catch (err) {
    showToast('Error reserving item: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════
// TRADES SCREEN
// ═══════════════════════════════════════════
async function loadTrades() {
  if (!currentUser) return;

  // Active trades (as buyer or seller)
  const buyerQ = query(collection(db, 'trades'), where('buyerId', '==', currentUser.uid), where('status', '==', 'pending'));
  const sellerQ = query(collection(db, 'trades'), where('sellerId', '==', currentUser.uid), where('status', '==', 'pending'));

  const [buyerSnap, sellerSnap] = await Promise.all([getDocs(buyerQ), getDocs(sellerQ)]);
  const trades = [
    ...buyerSnap.docs.map(d => ({ id: d.id, role: 'buyer', ...d.data() })),
    ...sellerSnap.docs.map(d => ({ id: d.id, role: 'seller', ...d.data() }))
  ];

  const tradesList = document.getElementById('activeTradesList');
  if (!tradesList) return;

  if (trades.length === 0) {
    tradesList.innerHTML = `<div class="empty-state"><div class="empty-icon">🔄</div><div class="empty-title">No Active Trades</div><div class="empty-sub">When you reserve an item or someone reserves yours, trades appear here.</div></div>`;
  } else {
    tradesList.innerHTML = trades.map(t => {
      const expiresAt = t.expiresAt?.toDate ? t.expiresAt.toDate() : new Date(t.expiresAt);
      const timeLeft = Math.max(0, expiresAt - Date.now());
      const hours = Math.floor(timeLeft / 3600000);
      const mins = Math.floor((timeLeft % 3600000) / 60000);
      const isSeller = t.role === 'seller';
      return `
        <div class="glass-card" style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div>
              <div style="font-size:14px;font-weight:700">Trade #${t.id.substring(0,8)}</div>
              <div style="font-size:12px;color:var(--text-muted)">You are the ${t.role}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:13px;font-weight:700;color:var(--gold)">${hours}h ${mins}m remaining</div>
              <div class="intent-tag tag-trade">Pending QR Scan</div>
            </div>
          </div>
          <div style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
            🟨 ${t.goldBlocksLocked} GB locked as collateral — refunded on successful handshake
          </div>
          ${isSeller
            ? `<button class="modal-btn" onclick="openQRModal('${t.id}','seller')">Generate QR Code</button>`
            : `<button class="modal-btn" onclick="openQRModal('${t.id}','buyer')">Scan Seller QR</button>`
          }
        </div>`;
    }).join('');
  }

  // Debt ledger
  const debtQ = query(collection(db, 'debtLedger'), where('userId', '==', currentUser.uid), where('status', '==', 'unpaid'));
  const debtSnap = await getDocs(debtQ);
  const debts = debtSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const debtList = document.getElementById('debtLedgerList');
  if (debtList) {
    if (debts.length === 0) {
      debtList.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:13px">No outstanding debts. You're all clear ✓</div>`;
    } else {
      debtList.innerHTML = debts.map(d => `
        <div class="glass-card" style="margin-bottom:10px;border-color:rgba(255,77,77,0.3)">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-size:14px;font-weight:700;color:var(--red)">Unpaid Platform Fee</div>
              <div style="font-size:12px;color:var(--text-muted)">Trade: ${d.tradeId?.substring(0,8) || 'N/A'}</div>
            </div>
            <div style="font-size:18px;font-weight:800;color:var(--red)">SCR ${Number(d.amountSCR || 0).toFixed(2)}</div>
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:8px">Contact admin to settle this debt and unlock your account.</div>
        </div>`).join('');
    }
  }
}

// ═══════════════════════════════════════════
// QR HANDSHAKE MODAL
// ═══════════════════════════════════════════
let qrInstance = null;
let qrTimerInterval = null;
let qrScannerInstance = null;

async function openQRModal(tradeId, role) {
  document.getElementById('qrModal').classList.add('open');
  const sellerView = document.getElementById('qrSellerView');
  const buyerView = document.getElementById('qrBuyerView');
  setText('qrModalTitle', role === 'seller' ? 'Show QR to Buyer' : 'Scan Buyer QR');

  if (role === 'seller') {
    sellerView.style.display = 'block';
    buyerView.style.display = 'none';
    try {
      const generateQRFn = httpsCallable(functions, 'generateQR');
      const result = await generateQRFn({ tradeId });
      const { payload, expiresAt } = result.data;
      // Generate QR code
      const qrDisplay = document.getElementById('qrCodeDisplay');
      qrDisplay.innerHTML = '';
      qrInstance = new QRCode(qrDisplay, {
        text: payload,
        width: 180,
        height: 180,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });
      // Countdown timer
      const expiry = new Date(expiresAt);
      qrTimerInterval = setInterval(() => {
        const left = Math.max(0, expiry - Date.now());
        const m = Math.floor(left / 60000);
        const s = Math.floor((left % 60000) / 1000);
        setText('qrTimer', `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
        if (left === 0) clearInterval(qrTimerInterval);
      }, 1000);
    } catch (err) {
      showToast('Error generating QR: ' + err.message, 'error');
      closeQRModal();
    }
  } else {
    sellerView.style.display = 'none';
    buyerView.style.display = 'block';
    // Start QR scanner
    setTimeout(() => {
      qrScannerInstance = new Html5Qrcode('qrReader');
      qrScannerInstance.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: 200 },
        async (decodedText) => {
          await qrScannerInstance.stop();
          await handleQRScan(decodedText);
        },
        () => {}
      ).catch(err => showToast('Camera error: ' + err, 'error'));
    }, 300);
  }
}

async function handleQRScan(payload) {
  showToast('QR detected. Running verification...', 'info');
  try {
    // Get GPS
    const gps = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(
        p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => res(null),
        { enableHighAccuracy: true, timeout: 5000 }
      )
    );

    const verifyFn = httpsCallable(functions, 'verifyQRScan');
    await verifyFn({
      qrPayload: payload,
      scanData: {
        buyerGPS: gps,
        buyerDeviceId: await getDeviceId(),
        buyerIP: null // handled server-side
      }
    });
    closeQRModal();
    showToast('🎉 Trade verified! Gold Blocks refunded.', 'success');
    loadTrades();
  } catch (err) {
    showToast('Verification failed: ' + err.message, 'error');
    closeQRModal();
  }
}

function closeQRModal() {
  document.getElementById('qrModal').classList.remove('open');
  if (qrTimerInterval) clearInterval(qrTimerInterval);
  if (qrScannerInstance) qrScannerInstance.stop().catch(() => {});
  qrInstance = null;
  qrScannerInstance = null;
}

async function getDeviceId() {
  const stored = localStorage.getItem('stash_device_id');
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem('stash_device_id', id);
  return id;
}

// ═══════════════════════════════════════════
// SLIDE TO PAY
// ═══════════════════════════════════════════
let slideSkinName = '';
let slideSkinCost = 0;
let slideFrameId = '';

function openSlideModal(name, cost, frameId) {
  slideSkinName = name;
  slideSkinCost = cost;
  slideFrameId = frameId;

  const ownedFrames = currentUserData?.ownedFrames || ['default'];
  if (ownedFrames.includes(frameId)) {
    showToast('You already own this frame!', 'info');
    return;
  }

  setText('slideTitle', name);
  setText('slidePrice', cost.toLocaleString() + ' GB');

  document.getElementById('slideAlreadyOwned').style.display = 'none';
  document.getElementById('slidePurchaseFlow').style.display = 'block';
  document.getElementById('slideWrap').style.display = '';
  document.getElementById('slideSuccess').style.display = 'none';
  document.getElementById('slideThumb').style.transform = 'translateX(0)';
  document.getElementById('slideThumb').innerHTML = '→';
  setText('slideTextEl', 'Slide to Confirm');
  document.getElementById('slideTextEl').style.opacity = '1';
  initSlide();

  document.getElementById('slideModal').classList.add('open');
}

function closeSlideModal() {
  document.getElementById('slideModal').classList.remove('open');
  const canvas = document.getElementById('particleCanvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function initSlide() {
  const wrap = document.getElementById('slideWrap');
  const thumb = document.getElementById('slideThumb');
  const textEl = document.getElementById('slideTextEl');
  const track = wrap.querySelector('.slide-track');

  // Clone to strip any old listeners from previous opens
  const newWrap = wrap.cloneNode(true);
  wrap.parentNode.replaceChild(newWrap, wrap);
  const nw = document.getElementById('slideWrap');
  const nt = nw.querySelector('.slide-thumb');
  const ntxt = nw.querySelector('.slide-text');
  const ntrack = nw.querySelector('.slide-track');

  let dragging = false;
  let startX = 0;
  let completed = false;

  const getMax = () => ntrack.offsetWidth - nt.offsetWidth;
  const getCurrentX = () => {
    const t = nt.style.transform;
    const match = t.match(/translateX\(([-\d.]+)px\)/);
    return match ? parseFloat(match[1]) : 0;
  };

  function onStart(e) {
    if (completed) return;
    dragging = true;
    nt.style.transition = 'none';
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    startX = clientX - getCurrentX();
  }

  function onMove(e) {
    if (!dragging || completed) return;
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const max = getMax();
    let x = clientX - startX;
    x = Math.max(0, Math.min(x, max));
    nt.style.transform = `translateX(${x}px)`;
    ntxt.style.opacity = String(Math.max(0, 1 - (x / max) * 1.4));
    if (x >= max * 0.9 && !completed) {
      onComplete();
    }
  }

  function onEnd() {
    if (!dragging || completed) return;
    dragging = false;
    const max = getMax();
    if (getCurrentX() < max * 0.9) {
      nt.style.transition = 'transform 0.3s cubic-bezier(0.4,0,0.2,1)';
      nt.style.transform = 'translateX(0)';
      ntxt.style.opacity = '1';
    }
  }

  async function onComplete() {
    if (completed) return;
    completed = true;
    dragging = false;

    const max = getMax();
    nt.style.transition = 'transform 0.2s ease';
    nt.style.transform = `translateX(${max}px)`;
    nt.innerHTML = '✓';

    if (!currentUser || !currentUserData) {
      showToast('You must be logged in', 'error');
      completed = false;
      return;
    }

    // Double-check ownership server-side before charging (prevents duplicate buys)
    if ((currentUserData.ownedFrames || []).includes(slideFrameId)) {
      showToast('You already own this frame!', 'info');
      closeSlideModal();
      return;
    }

    if (currentUserData.goldBlocks < slideSkinCost) {
      showToast('Not enough Gold Blocks!', 'error');
      setTimeout(() => {
        nt.style.transition = 'transform 0.3s';
        nt.style.transform = 'translateX(0)';
        nt.innerHTML = '→';
        ntxt.style.opacity = '1';
        completed = false;
      }, 600);
      return;
    }

    try {
      await updateDoc(doc(db, 'users', currentUser.uid), {
        goldBlocks: increment(-slideSkinCost),
        ownedFrames: arrayUnion(slideFrameId)
      });
      await addDoc(collection(db, 'gbTransactions'), {
        userId: currentUser.uid,
        amount: -slideSkinCost,
        type: 'skin_purchase',
        skinName: slideSkinName,
        frameId: slideFrameId,
        createdAt: serverTimestamp()
      });

      fireParticleBurst();

      setTimeout(() => {
        document.getElementById('slideWrap').style.display = 'none';
        document.getElementById('slideSuccess').style.display = 'block';
        setTimeout(closeSlideModal, 2200);
      }, 250);

      showToast(`${slideSkinName} unlocked!`, 'success');
    } catch (err) {
      showToast('Purchase failed: ' + err.message, 'error');
      nt.style.transition = 'transform 0.3s';
      nt.style.transform = 'translateX(0)';
      nt.innerHTML = '→';
      ntxt.style.opacity = '1';
      completed = false;
    }
  }

  nw.addEventListener('mousedown', onStart);
  nw.addEventListener('touchstart', onStart, { passive: false });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onEnd);
  window.addEventListener('touchend', onEnd);
}

// ═══════════════════════════════════════════
// PARTICLE BURST EFFECT (canvas confetti)
// ═══════════════════════════════════════════
function fireParticleBurst() {
  const canvas = document.getElementById('particleCanvas');
  if (!canvas) return;
  const modal = canvas.closest('.modal-sheet');
  const rect = modal.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext('2d');

  const colors = ['#D4A017', '#F5C842', '#FFD700', '#fff', '#FFA500'];
  const particles = [];
  const count = 60;
  const originX = rect.width / 2;
  const originY = rect.height / 2;

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const speed = 3 + Math.random() * 6;
    particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      size: 3 + Math.random() * 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 1,
      decay: 0.012 + Math.random() * 0.012,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.3,
      shape: Math.random() > 0.5 ? 'square' : 'circle'
    });
  }

  let frame = 0;
  const maxFrames = 120;

  function animate() {
    frame++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let alive = false;
    particles.forEach(p => {
      if (p.life <= 0) return;
      alive = true;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15; // gravity
      p.vx *= 0.99;
      p.life -= p.decay;
      p.rotation += p.rotSpeed;

      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      if (p.shape === 'square') {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });

    if (alive && frame < maxFrames) {
      requestAnimationFrame(animate);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  requestAnimationFrame(animate);
}

// ═══════════════════════════════════════════
// ADMIN PANEL
// ═══════════════════════════════════════════
async function adminCreditGB() {
  const username = document.getElementById('adminUsername').value.trim().replace('@','');
  const amount = parseInt(document.getElementById('adminGBAmount').value);
  const note = document.getElementById('adminNote').value.trim();
  if (!username || !amount) return showToast('Fill in all fields', 'error');

  try {
    const creditFn = httpsCallable(functions, 'adminCreditGoldBlocks');
    // Find user by username
    const userSnap = await getDocs(query(collection(db, 'users'), where('username', '==', username)));
    if (userSnap.empty) return showToast('User not found', 'error');
    const userId = userSnap.docs[0].id;
    await creditFn({ userId, amount, note });
    showToast(`Credited ${amount} GB to @${username}`, 'success');
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
}

async function adminSettleDebt() {
  const username = document.getElementById('adminDebtUsername').value.trim().replace('@','');
  const debtId = document.getElementById('adminDebtId').value.trim();
  if (!username || !debtId) return showToast('Fill in all fields', 'error');

  try {
    const settleFn = httpsCallable(functions, 'settleDebt');
    const userSnap = await getDocs(query(collection(db, 'users'), where('username', '==', username)));
    if (userSnap.empty) return showToast('User not found', 'error');
    const userId = userSnap.docs[0].id;
    const result = await settleFn({ userId, debtId });
    showToast(result.data.accountUnlocked ? 'Debt settled & account unlocked!' : 'Debt settled', 'success');
  } catch (err) { showToast('Error: ' + err.message, 'error'); }
}

async function loadAdminData() {
  try {
    const [usersSnap, listingsSnap, tradesSnap, debtsSnap] = await Promise.all([
      getDocs(collection(db, 'users')),
      getDocs(query(collection(db, 'listings'), where('status', '==', 'active'))),
      getDocs(query(collection(db, 'trades'), where('status', '==', 'completed'))),
      getDocs(query(collection(db, 'debtLedger'), where('status', '==', 'unpaid')))
    ]);
    setText('adminTotalUsers', usersSnap.size);
    setText('adminTotalListings', listingsSnap.size);
    setText('adminTotalTrades', tradesSnap.size);

    const debts = debtsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const adminDebtList = document.getElementById('adminDebtList');
    if (adminDebtList) {
      adminDebtList.innerHTML = debts.length === 0
        ? `<div style="text-align:center;padding:40px;color:var(--text-muted)">No pending debts</div>`
        : debts.map(d => `
          <div class="glass-card" style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-size:13px;font-weight:700">User: ${d.userId?.substring(0,12)}...</div>
                <div style="font-size:11px;color:var(--text-muted)">Debt ID: ${d.id}</div>
              </div>
              <div style="font-size:16px;font-weight:800;color:var(--red)">SCR ${Number(d.amountSCR || 0).toFixed(2)}</div>
            </div>
          </div>`).join('');
    }

    // Skin sync starts once admin opens the panel — keeps it live everywhere
    startSkinSync(() => { renderAdminSkinsList(); });
    initSkinStudioPreview();
    renderAdminSkinsList();
  } catch (err) { showToast('Admin load error: ' + err.message, 'error'); }
}

// ═══════════════════════════════════════════
// ADMIN SUB-TABS
// ═══════════════════════════════════════════
function setAdminTab(el, tab) {
  document.querySelectorAll('#screen-admin .filter-row .filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('adminTab-overview').style.display = tab === 'overview' ? 'block' : 'none';
  document.getElementById('adminTab-skinStudio').style.display = tab === 'skinStudio' ? 'block' : 'none';
  if (tab === 'skinStudio') {
    initSkinStudioPreview();
    renderAdminSkinsList();
  }
}

// ═══════════════════════════════════════════
// SKIN STUDIO — live preview card + editor
// ═══════════════════════════════════════════
let editingSkinId = null;
let previewBgMode = 'dark';

function initSkinStudioPreview() {
  const mount = document.getElementById('skinPreviewMount');
  if (!mount) return;
  mount.innerHTML = renderCardHTML({
    id: 'preview',
    name: 'Rolex Daytona',
    priceLabel: 'SCR 38,500',
    emoji: '⌚',
    skinId: 'previewLive'
  });
  applyPreviewBgStyle();
  updatePreview();
}

function applyPreviewBgStyle() {
  const mount = document.getElementById('skinPreviewMount');
  if (!mount) return;
  if (previewBgMode === 'grid') {
    mount.style.background = 'repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 24px), repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 24px), #0d0d0f';
  } else {
    mount.style.background = 'transparent';
  }
  mount.style.padding = '24px';
  mount.style.borderRadius = '16px';
}

function setPreviewBg(el, mode) {
  document.querySelectorAll('#adminTab-skinStudio .filter-row .filter-chip').forEach(c => {
    if (c.textContent.includes('BG')) c.classList.remove('active');
  });
  el.classList.add('active');
  previewBgMode = mode;
  applyPreviewBgStyle();
}

// Reads every control in the Skin Studio form into a flat config object
function readSkinFormConfig() {
  const tier = document.getElementById('skinTier').value || 'standard';
  return {
    name: document.getElementById('skinName').value.trim() || 'Untitled Skin',
    tier,
    badgeLabel: document.getElementById('skinBadgeLabel').value.trim(),
    glowColor: document.getElementById('skinGlowColor').value,
    glowIntensity: parseFloat(document.getElementById('skinGlowIntensity').value),
    glowSpeed: parseFloat(document.getElementById('skinGlowSpeed').value),
    frameWidth: parseInt(document.getElementById('skinFrameWidth').value),
    frameColor: document.getElementById('skinFrameColor').value,
    frameAnimated: document.getElementById('skinFrameAnimated').checked,
    frameColor1: document.getElementById('skinFrameColor').value,
    frameColor2: document.getElementById('skinFrameColor2').value,
    frameColor3: document.getElementById('skinFrameColor3').value,
    gradientSpeed: 6,
    breakoutEnabled: tier === 'mythic',
    breakoutOffset: parseInt(document.getElementById('skinBreakoutOffset').value),
    breakoutScale: parseFloat(document.getElementById('skinBreakoutScale').value),
    bleedRotation: parseInt(document.getElementById('skinBleedRotation').value),
    breakoutSpeed: parseFloat(document.getElementById('skinBreakoutSpeed').value),
    breakoutOpacity: 0.85,
    badgeBg: hexToRgba(document.getElementById('skinGlowColor').value, 0.15),
    badgeBorder: hexToRgba(document.getElementById('skinGlowColor').value, 0.4),
    badgeColor: document.getElementById('skinGlowColor').value
  };
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Live-updates every numeric readout label + repaints the preview card —
// this is the "instant repaint" requirement, driven entirely by reading
// the form and writing CSS custom properties, no rebuild of the DOM.
function updatePreview() {
  setText('valGlowIntensity', document.getElementById('skinGlowIntensity').value);
  setText('valGlowSpeed', document.getElementById('skinGlowSpeed').value);
  setText('valFrameWidth', document.getElementById('skinFrameWidth').value);
  setText('valBreakoutOffset', document.getElementById('skinBreakoutOffset').value);
  setText('valBreakoutScale', document.getElementById('skinBreakoutScale').value);
  setText('valBleedRotation', document.getElementById('skinBleedRotation').value);
  setText('valBreakoutSpeed', document.getElementById('skinBreakoutSpeed').value);

  const config = readSkinFormConfig();
  const breakoutPanel = document.getElementById('breakoutPanel');
  if (breakoutPanel) breakoutPanel.style.opacity = config.tier === 'mythic' ? '1' : '0.4';

  const previewEl = document.getElementById('sce-preview');
  if (previewEl) applySkinToElement(previewEl, config);
}

async function saveCurrentSkin() {
  const config = readSkinFormConfig();
  if (!config.name || config.name === 'Untitled Skin') {
    return showToast('Give your skin a name first', 'error');
  }
  try {
    const id = await saveSkin(editingSkinId, config);
    editingSkinId = id;
    showToast(`"${config.name}" published — live for every user now`, 'success');
    renderAdminSkinsList();
  } catch (err) {
    showToast('Error saving skin: ' + err.message, 'error');
  }
}

function renderAdminSkinsList() {
  const list = document.getElementById('adminSkinsList');
  if (!list) return;
  const skins = getAllSkins().filter(s => s.id !== 'default');

  if (skins.length === 0) {
    list.innerHTML = `<div style="grid-column:span 4;text-align:center;padding:40px;color:var(--text-muted)">No custom skins yet — build one above and publish it.</div>`;
    return;
  }

  list.innerHTML = skins.map(s => `
    <div class="skin-card" style="border-color:${s.badgeBorder || 'var(--glass-border)'}">
      <div class="skin-preview" style="background:${s.glowColor}22;border:2px solid ${s.glowColor}">${s.tier === 'mythic' ? '🔥' : '✦'}</div>
      <div class="skin-name">${escHtml(s.name)}</div>
      <div class="skin-desc">Tier: ${escHtml(s.tier)} ${s.badgeLabel ? '· Badge: ' + escHtml(s.badgeLabel) : ''}</div>
      <div class="skin-footer">
        <button class="buy-btn" style="background:var(--glass-gold);color:var(--gold)" onclick="loadSkinIntoStudio('${s.id}')"><i class="ti ti-pencil"></i></button>
        <button class="buy-btn" style="background:rgba(255,77,77,0.15);color:#ff4d4d" onclick="confirmDeleteSkin('${s.id}','${escHtml(s.name)}')"><i class="ti ti-trash"></i></button>
      </div>
    </div>`).join('');
}

function loadSkinIntoStudio(skinId) {
  const s = getSkin(skinId);
  if (!s) return;
  editingSkinId = skinId;

  document.getElementById('skinName').value = s.name || '';
  document.getElementById('skinBadgeLabel').value = s.badgeLabel || '';
  document.getElementById('skinGlowColor').value = s.glowColor || '#D4A017';
  document.getElementById('skinGlowIntensity').value = s.glowIntensity ?? 0.3;
  document.getElementById('skinGlowSpeed').value = s.glowSpeed ?? 3.5;
  document.getElementById('skinFrameWidth').value = s.frameWidth ?? 2;
  document.getElementById('skinFrameColor').value = s.frameColor1 || s.frameColor || '#D4A017';
  document.getElementById('skinFrameAnimated').checked = !!s.frameAnimated;
  document.getElementById('skinFrameColor2').value = s.frameColor2 || '#6ee7f7';
  document.getElementById('skinFrameColor3').value = s.frameColor3 || '#a855f7';
  document.getElementById('skinBreakoutOffset').value = s.breakoutOffset ?? 20;
  document.getElementById('skinBreakoutScale').value = s.breakoutScale ?? 1;
  document.getElementById('skinBleedRotation').value = s.bleedRotation ?? 0;
  document.getElementById('skinBreakoutSpeed').value = s.breakoutSpeed ?? 4;

  const tierLabels = { standard: '⬜ Standard', rare: '🔷 Rare', epic: '🟣 Epic', mythic: '🔥 Mythic (breakout fx)' };
  selectCS('csSkinTier', 'skinTier', s.tier || 'standard', tierLabels[s.tier || 'standard']);

  updatePreview();
  showToast(`Editing "${s.name}"`, 'info');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

let pendingDeleteSkinId = null;
function confirmDeleteSkin(skinId, name) {
  if (!confirm(`Delete the "${name}" skin? Items using it will fall back to the default frame.`)) return;
  deleteSkin(skinId)
    .then(() => { showToast('Skin deleted', 'info'); renderAdminSkinsList(); })
    .catch(err => showToast('Error: ' + err.message, 'error'));
}


// COUNTDOWN TIMER (Exotic Shop)
// ═══════════════════════════════════════════
function startCountdown() {
  const nextMidnight = new Date();
  nextMidnight.setHours(24, 0, 0, 0);

  setInterval(() => {
    const left = Math.max(0, nextMidnight - Date.now());
    const h = Math.floor(left / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    const s = Math.floor((left % 60000) / 1000);
    setText('cd-h', String(h).padStart(2,'0'));
    setText('cd-m', String(m).padStart(2,'0'));
    setText('cd-s', String(s).padStart(2,'0'));
  }, 1000);
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════
function setChipFilter(el) {
  el.closest('.filter-row').querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
}

function animateCount(el, target) {
  let cur = 0;
  const steps = 60;
  const inc = target / steps;
  const interval = setInterval(() => {
    cur = Math.min(cur + inc, target);
    el.textContent = Math.round(cur).toLocaleString();
    if (cur >= target) clearInterval(interval);
  }, 1800 / steps);
}

function getCategoryEmoji(cat) {
  const map = { Watches:'⌚', Sneakers:'👟', Tech:'💻', Jewelry:'💍', Cars:'🚗', Bags:'👜', 'Parts Bin':'🔧', Other:'📦' };
  return map[cat] || '📦';
}

function getFrameClass(frame) {
  const map = { gold:'gold-frame', holo:'holo-frame', purple:'grail-frame', carbon:'', neon:'' };
  return map[frame] || '';
}

function getFrameBadge(frame) {
  const badges = {
    gold: `<div class="frame-badge badge-gold">✦ Liquid Gold Frame</div>`,
    holo: `<div class="frame-badge badge-holo">◈ Holo Foil Frame</div>`,
    purple: `<div class="frame-badge badge-grail">👑 Royal Purple Frame</div>`
  };
  return badges[frame] || '';
}

function getIntentLabel(intent) {
  const map = { trade:'Looking to Trade', cash:'Accepting Offers', grail:'Personal Grail' };
  return map[intent] || intent;
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function copyProfileLink() {
  if (!currentUserData) return;
  const link = `${window.location.origin}?user=${currentUserData.username}`;
  navigator.clipboard.writeText(link).then(() => showToast('Profile link copied!', 'success'));
}

function showToast(msg, type = 'info') {
  const wrap = document.getElementById('toastWrap');
  if (!wrap) return;
  playNotificationSound(type);
  const icons = { success:'ti-circle-check', error:'ti-circle-x', info:'ti-info-circle' };
  const colors = { success:'var(--green)', error:'var(--red)', info:'var(--gold)' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="ti ${icons[type]}" style="font-size:18px;color:${colors[type]};flex-shrink:0"></i>${escHtml(msg)}`;
  wrap.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(20px)'; toast.style.transition = 'all 0.3s'; setTimeout(() => toast.remove(), 300); }, 3500);
}



// ═══════════════════════════════════════════
// MOBILE BURGER DRAWER
// ═══════════════════════════════════════════
function toggleMobileDrawer() {
  const drawer = document.getElementById('mobileDrawer');
  const overlay = document.getElementById('mobileOverlay');
  const burger = document.getElementById('burgerBtn');
  if (!drawer) return;
  const isOpen = drawer.classList.contains('open');
  if (isOpen) {
    closeMobileDrawer();
  } else {
    drawer.classList.add('open');
    overlay.classList.add('open');
    if (burger) burger.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
}

function closeMobileDrawer() {
  const drawer = document.getElementById('mobileDrawer');
  const overlay = document.getElementById('mobileOverlay');
  const burger = document.getElementById('burgerBtn');
  if (!drawer) return;
  drawer.classList.remove('open');
  overlay.classList.remove('open');
  if (burger) burger.classList.remove('open');
  document.body.style.overflow = '';
}

function drawerNav(screenId) {
  closeMobileDrawer();
  switchScreen(screenId);
  // Update drawer active state
  document.querySelectorAll('.drawer-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.screen === screenId);
  });
}

function updateDrawerUI() {
  if (!currentUserData) return;
  const initials = (currentUserData.displayName || currentUserData.username || 'U').substring(0,2).toUpperCase();
  const gbDisplay = Number(currentUserData.goldBlocks || 0).toLocaleString() + ' GB';

  const drawerAvatar = document.getElementById('drawerAvatar');
  if (drawerAvatar) {
    drawerAvatar.textContent = initials;
    if (currentUserData.avatarUrl) {
      drawerAvatar.innerHTML = `<img src="${currentUserData.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    }
  }
  const drawerName = document.getElementById('drawerName');
  const drawerHandle = document.getElementById('drawerHandle');
  const drawerGB = document.getElementById('drawerGBBalance');
  if (drawerName) drawerName.textContent = currentUserData.displayName || currentUserData.username;
  if (drawerHandle) drawerHandle.textContent = '@' + currentUserData.username;
  if (drawerGB) drawerGB.textContent = gbDisplay;

  // Show admin nav in drawer if admin
  if (currentUserData.isAdmin) {
    document.querySelectorAll('.drawer-nav-item.admin-only').forEach(el => el.style.display = 'flex');
  }
}


// ═══════════════════════════════════════════
// EDIT PROFILE
// ═══════════════════════════════════════════
function openEditProfile() {
  if (!currentUserData) return;
  document.getElementById('editDisplayName').value = currentUserData.displayName || '';
  document.getElementById('editBio').value = currentUserData.bio || '';
  document.getElementById('editAvatarUrl').value = currentUserData.avatarUrl || '';

  const preview = document.getElementById('profilePhotoPreview');
  if (currentUserData.avatarUrl) {
    preview.innerHTML = `<img src="${currentUserData.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:12px">`;
  } else {
    preview.innerHTML = `<i class="ti ti-camera" style="font-size:24px;color:rgba(255,255,255,0.4)"></i><span style="font-size:13px;color:rgba(255,255,255,0.4)">Upload profile photo</span>`;
  }
  document.getElementById('editProfileModal').classList.add('open');
}

function closeEditProfile() {
  document.getElementById('editProfileModal').classList.remove('open');
}

function triggerProfilePhotoUpload() {
  openUploadWidget((url) => {
    document.getElementById('editAvatarUrl').value = url;
    const preview = document.getElementById('profilePhotoPreview');
    preview.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:12px">`;
  });
}

async function saveProfile() {
  if (!currentUser) return;
  const displayName = document.getElementById('editDisplayName').value.trim();
  const bio = document.getElementById('editBio').value.trim();
  const avatarUrl = document.getElementById('editAvatarUrl').value;

  if (!displayName) return showToast('Display name cannot be empty', 'error');

  try {
    await updateDoc(doc(db, 'users', currentUser.uid), {
      displayName,
      bio,
      avatarUrl
    });
    closeEditProfile();
    showToast('Profile updated!', 'success');
  } catch (err) {
    showToast('Error saving profile: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════
// CONFIRM DELETE LISTING
// ═══════════════════════════════════════════
let pendingDeleteId = null;

function openConfirmDelete(listingId) {
  pendingDeleteId = listingId;
  document.getElementById('confirmDeleteModal').classList.add('open');
}

function closeConfirmDelete() {
  pendingDeleteId = null;
  document.getElementById('confirmDeleteModal').classList.remove('open');
}

async function confirmDelete() {
  if (!pendingDeleteId) return;
  try {
    await deleteDoc(doc(db, 'listings', pendingDeleteId));
    closeConfirmDelete();
    showToast('Listing removed', 'info');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════
// CUSTOM SELECT DROPDOWNS
// ═══════════════════════════════════════════
function toggleCS(wrapId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const isOpen = wrap.classList.contains('open');
  // Close all open dropdowns first
  document.querySelectorAll('.custom-select-wrap.open').forEach(w => w.classList.remove('open'));
  if (!isOpen) wrap.classList.add('open');
}

function selectCS(wrapId, inputId, value, label, callback) {
  const wrap = document.getElementById(wrapId);
  const input = document.getElementById(inputId);
  if (!wrap || !input) return;

  input.value = value;

  // Update displayed label
  const labelEl = wrap.querySelector('.cs-selected span:first-child') ||
                  wrap.querySelector('.cs-selected span');
  if (labelEl) {
    labelEl.textContent = label;
    labelEl.classList.remove('cs-placeholder');
  }

  // Mark selected option
  wrap.querySelectorAll('.cs-option').forEach(opt => {
    opt.classList.toggle('selected', opt.getAttribute('onclick')?.includes(`'${value}'`));
  });

  wrap.classList.remove('open');

  // Fire callback if provided
  if (callback && window[callback]) window[callback]();
}

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.custom-select-wrap')) {
    document.querySelectorAll('.custom-select-wrap.open').forEach(w => w.classList.remove('open'));
  }
});

// ── Close modals on overlay click
document.getElementById('sheetOverlay')?.addEventListener('click', e => { if (e.target === document.getElementById('sheetOverlay')) closeSheet(); });
document.getElementById('slideModal')?.addEventListener('click', e => { if (e.target === document.getElementById('slideModal')) closeSlideModal(); });
document.getElementById('listingModal')?.addEventListener('click', e => { if (e.target === document.getElementById('listingModal')) closeListingModal(); });
document.getElementById('editProfileModal')?.addEventListener('click', e => { if (e.target === document.getElementById('editProfileModal')) closeEditProfile(); });
document.getElementById('confirmDeleteModal')?.addEventListener('click', e => { if (e.target === document.getElementById('confirmDeleteModal')) closeConfirmDelete(); });
document.getElementById('qrModal')?.addEventListener('click', e => { if (e.target === document.getElementById('qrModal')) closeQRModal(); });

// ── Expose functions to HTML onclick
window.handleLogin = handleLogin;
window.handleRegister = handleRegister;
window.handleLogout = handleLogout;
window.showLogin = showLogin;
window.showRegister = showRegister;
window.switchScreen = switchScreen;
window.setChipFilter = setChipFilter;
window.setMarketFilter = setMarketFilter;
window.filterMarketplace = filterMarketplace;
window.setPubFilter = setPubFilter;
window.openListingModal = openListingModal;
window.openEditListing = openEditListing;
window.closeListingModal = closeListingModal;
window.triggerUpload = triggerUpload;
window.submitListing = submitListing;
window.deleteListing = deleteListing;
window.updateSpecFields = updateSpecFields;
window.openSheet = openSheet;
window.closeSheet = closeSheet;
window.reserveItem = reserveItem;
window.openQRModal = openQRModal;
window.closeQRModal = closeQRModal;
window.openSlideModal = openSlideModal;
window.closeSlideModal = closeSlideModal;
window.adminCreditGB = adminCreditGB;
window.adminSettleDebt = adminSettleDebt;
window.setAdminTab = setAdminTab;
window.updatePreview = updatePreview;
window.setPreviewBg = setPreviewBg;
window.saveCurrentSkin = saveCurrentSkin;
window.loadSkinIntoStudio = loadSkinIntoStudio;
window.confirmDeleteSkin = confirmDeleteSkin;
window.copyProfileLink = copyProfileLink;
window.showToast = showToast;
window.openEditProfile = openEditProfile;
window.closeEditProfile = closeEditProfile;
window.triggerProfilePhotoUpload = triggerProfilePhotoUpload;
window.saveProfile = saveProfile;
window.openConfirmDelete = openConfirmDelete;
window.closeConfirmDelete = closeConfirmDelete;
window.confirmDelete = confirmDelete;
window.toggleCS = toggleCS;
window.toggleMobileDrawer = toggleMobileDrawer;
window.closeMobileDrawer = closeMobileDrawer;
window.drawerNav = drawerNav;
window.selectCS = selectCS;
