'use strict';

// ── Storage helpers ──────────────────────────────────────────────
const DB_KEY_PLAYLISTS   = 'playm3u_playlists';
const DB_KEY_LAST_CH     = 'playm3u_last_ch';
const DB_KEY_LAST_PL     = 'playm3u_last_pl';
const DB_KEY_FIRST_VISIT = 'playm3u_visited';

function saveDB(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) {}
}
function loadDB(key, def) {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? JSON.parse(v) : def;
  } catch(e) { return def; }
}

// ── Fetch with timeout (compatibility-safe) ──────────────────────
async function fetchWithTimeout(resource, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ── App State ────────────────────────────────────────────────────
const state = {
  playlists: [],
  currentPLIndex: 0,
  currentCHIndex: 0,
  pendingURL: '',
  pendingType: 'url',
  pendingChannels: [],
  channelNumberBuffer: '',
  channelNumberTimer: null,
  overlayTimer: null,
  hlsInstance: null,
  dashInstance: null,
};

// ── DOM refs ─────────────────────────────────────────────────────
const pages = {
  welcome:    document.getElementById('page-welcome'),
  chooseType: document.getElementById('page-choose-type'),
  enterURL:   document.getElementById('page-enter-url'),
  enterStorage: document.getElementById('page-enter-storage'),
  name:       document.getElementById('page-playlist-name'),
  settings:   document.getElementById('page-settings'),
  playlists:  document.getElementById('page-playlists'),
  player:     document.getElementById('page-player'),
};

function showPage(key) {
  Object.values(pages).forEach(p => p.classList.remove('active'));
  pages[key]?.classList.add('active');

  setTimeout(() => {
    const first = pages[key]?.querySelector('.focusable, button, input, [tabindex]');
    first?.focus();
  }, 80);
}

// ── Toast ─────────────────────────────────────────────────────────
let toastEl = null;
function showToast(msg, dur = 2800) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), dur);
}

// ── M3U Parser ───────────────────────────────────────────────────
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (line.startsWith('#EXTINF:')) {
      current = { name: 'Channel', logo: '', group: '', url: '' };

      const commaIdx = line.lastIndexOf(',');
      if (commaIdx >= 0) current.name = line.slice(commaIdx + 1).trim();

      const logoM = line.match(/tvg-logo="([^"]+)"/i);
      if (logoM) current.logo = logoM[1];

      const grpM = line.match(/group-title="([^"]+)"/i);
      if (grpM) current.group = grpM[1];

    } else if (current && line && !line.startsWith('#')) {
      current.url = line;
      channels.push(current);
      current = null;
    }
  }
  return channels;
}

// ── Fetch M3U ─────────────────────────────────────────────────────
async function fetchM3U(url) {
  const proxies = [
    url,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];

  for (const u of proxies) {
    try {
      const res = await fetchWithTimeout(u, { method: 'GET' }, 15000);
      if (!res.ok) continue;

      const text = await res.text();
      if (text.includes('#EXTINF') || text.includes('#EXTM3U')) {
        return text;
      }
    } catch(e) {}
  }

  throw new Error('Tidak dapat memuat playlist.');
}

// ── Init ──────────────────────────────────────────────────────────
function init() {
  state.playlists = loadDB(DB_KEY_PLAYLISTS, []);
  state.currentPLIndex = loadDB(DB_KEY_LAST_PL, 0);
  state.currentCHIndex = loadDB(DB_KEY_LAST_CH, 0);

  if (state.playlists.length > 0) {
    showPage('player');
    showPlayerLoading(true);

    const pl = state.playlists[state.currentPLIndex];

    if (pl.autoDownload && pl.type === 'url') {
      fetchM3U(pl.url)
        .then(text => {
          pl.channels = parseM3U(text);
          saveDB(DB_KEY_PLAYLISTS, state.playlists);
        })
        .finally(startPlayback);
    } else {
      setTimeout(startPlayback, 500);
    }

  } else {
    showPage('welcome');
  }

  bindEvents();
}

// ── Player ────────────────────────────────────────────────────────
function showPlayerLoading(show, text = 'Mohon bersabar...') {
  const el = document.getElementById('player-loading');
  const txt = document.getElementById('player-loading-text');
  el.style.display = show ? 'flex' : 'none';
  if (txt) txt.textContent = text;
}

function startPlayback() {
  const pl = state.playlists[state.currentPLIndex];
  if (!pl?.channels?.length) {
    showPlayerLoading(false);
    showToast('Tidak ada channel.');
    showPage('settings');
    return;
  }

  playChannel(state.currentCHIndex);
}

function playChannel(idx) {
  const pl = state.playlists[state.currentPLIndex];
  const ch = pl.channels[idx];
  if (!ch) return;

  state.currentCHIndex = idx;
  saveDB(DB_KEY_LAST_CH, idx);

  const video = document.getElementById('video-player');

  // Reset handlers
  video.onerror = null;
  video.src = '';
  video.load();

  if (state.hlsInstance) state.hlsInstance.destroy();
  if (state.dashInstance) state.dashInstance.reset();

  showPlayerLoading(true);

  const url = ch.url;
  const isHLS = url.includes('.m3u8');
  const isDASH = url.includes('.mpd');

  const onReady = () => {
    showPlayerLoading(false);
    showChannelOverlay(ch, idx + 1, pl.name);
  };

  video.onerror = () => {
    showPlayerLoading(false);
    showToast(`Error: ${ch.name}`);
  };

  if (isDASH && typeof dashjs !== 'undefined') {
    const dash = dashjs.MediaPlayer().create();
    dash.initialize(video, url, true);
    state.dashInstance = dash;
    video.addEventListener('canplay', onReady, { once: true });

  } else if (isHLS && typeof Hls !== 'undefined' && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
      onReady();
    });
    state.hlsInstance = hls;

  } else {
    video.src = url;
    video.play().catch(() => {});
    video.addEventListener('canplay', onReady, { once: true });
  }
}

// ── Overlay ───────────────────────────────────────────────────────
function showChannelOverlay(ch, num, plName) {
  document.getElementById('ch-playlist-name').textContent = plName;
  document.getElementById('ch-group').textContent = ch.group || '';
  document.getElementById('ch-number').textContent = num;
  document.getElementById('ch-name').textContent = ch.name;

  const overlay = document.getElementById('channel-overlay');
  overlay.style.display = 'flex';

  clearTimeout(state.overlayTimer);
  state.overlayTimer = setTimeout(() => {
    overlay.style.display = 'none';
  }, 4000);
}

// ── Keyboard ──────────────────────────────────────────────────────
function bindEvents() {
  document.addEventListener('keydown', e => {
    if (!pages.player.classList.contains('active')) return;

    if (e.key === 'ArrowUp') channelUp();
    if (e.key === 'ArrowDown') channelDown();
  });
}

function channelUp() {
  const pl = state.playlists[state.currentPLIndex];
  playChannel((state.currentCHIndex + 1) % pl.channels.length);
}
function channelDown() {
  const pl = state.playlists[state.currentPLIndex];
  playChannel((state.currentCHIndex - 1 + pl.channels.length) % pl.channels.length);
}

document.addEventListener('DOMContentLoaded', init);
