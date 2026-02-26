'use strict';

/* ───────────────── STORAGE ───────────────── */
const DB_KEY_PLAYLISTS = 'playm3u_playlists';
const DB_KEY_LAST_CH   = 'playm3u_last_ch';
const DB_KEY_LAST_PL   = 'playm3u_last_pl';

function saveDB(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function loadDB(key, def) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : def;
  } catch { return def; }
}

/* ───────────────── FETCH TIMEOUT ───────────────── */
async function fetchWithTimeout(resource, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/* ───────────────── STATE ───────────────── */
const state = {
  playlists: [],
  currentPLIndex: 0,
  currentCHIndex: 0,
  hlsInstance: null,
  dashInstance: null,
  overlayTimer: null,
};

/* ───────────────── DOM CACHE ───────────────── */
const pages = {
  welcome:     document.getElementById('page-welcome'),
  chooseType:  document.getElementById('page-choose-type'),
  enterURL:    document.getElementById('page-enter-url'),
  enterStorage:document.getElementById('page-enter-storage'),
  name:        document.getElementById('page-playlist-name'),
  settings:    document.getElementById('page-settings'),
  playlists:   document.getElementById('page-playlists'),
  player:      document.getElementById('page-player'),
};

const video = document.getElementById('video-player');

/* ───────────────── PAGE SWITCHER ───────────────── */
function showPage(key) {
  Object.values(pages).forEach(p => p?.classList.remove('active'));
  pages[key]?.classList.add('active');

  setTimeout(() => {
    pages[key]?.querySelector('.focusable, button, input')?.focus();
  }, 60);
}

/* ───────────────── TOAST ───────────────── */
let toastEl;
function showToast(msg, dur = 2500) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }

  toastEl.textContent = msg;
  toastEl.classList.add('show');

  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), dur);
}

/* ───────────────── M3U PARSER ───────────────── */
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (line.startsWith('#EXTINF:')) {
      current = { name: 'Channel', group: '', logo: '', url: '' };

      const nameIdx = line.lastIndexOf(',');
      if (nameIdx !== -1) current.name = line.slice(nameIdx + 1).trim();

      const logoM = line.match(/tvg-logo="([^"]+)"/i);
      if (logoM) current.logo = logoM[1];

      const groupM = line.match(/group-title="([^"]+)"/i);
      if (groupM) current.group = groupM[1];

    } else if (current && line && !line.startsWith('#')) {
      current.url = line;
      channels.push(current);
      current = null;
    }
  }

  return channels;
}

/* ───────────────── FETCH PLAYLIST ───────────────── */
async function fetchM3U(url) {
  const attempts = [
    url,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  ];

  for (const u of attempts) {
    try {
      const res = await fetchWithTimeout(u);
      if (!res.ok) continue;

      const text = await res.text();
      if (text.includes('#EXTINF')) return text;

    } catch {}
  }

  throw new Error('Playlist gagal dimuat');
}

/* ───────────────── INIT ───────────────── */
function init() {
  state.playlists = loadDB(DB_KEY_PLAYLISTS, []);
  state.currentPLIndex = loadDB(DB_KEY_LAST_PL, 0);
  state.currentCHIndex = loadDB(DB_KEY_LAST_CH, 0);

  if (state.playlists.length) {
    showPage('player');
    startPlayback();
  } else {
    showPage('welcome');
  }

  bindKeyboard();
}

/* ───────────────── PLAYBACK ───────────────── */
function startPlayback() {
  const pl = state.playlists[state.currentPLIndex];
  if (!pl?.channels?.length) {
    showToast('Playlist kosong');
    showPage('settings');
    return;
  }

  playChannel(state.currentCHIndex);
}

function cleanupPlayer() {
  if (!video) return;

  video.pause();
  video.removeAttribute('src');
  video.load();

  try { state.hlsInstance?.destroy(); } catch {}
  try { state.dashInstance?.reset(); } catch {}

  state.hlsInstance = null;
  state.dashInstance = null;
}

function playChannel(index) {
  const pl = state.playlists[state.currentPLIndex];
  const ch = pl.channels[index];
  if (!ch || !video) return;

  state.currentCHIndex = index;
  saveDB(DB_KEY_LAST_CH, index);

  cleanupPlayer();

  const url = ch.url;
  const isHLS  = url.includes('.m3u8');
  const isDASH = url.includes('.mpd');

  video.onerror = () => showToast(`Error channel`);

  if (isDASH && typeof dashjs !== 'undefined') {
    const dash = dashjs.MediaPlayer().create();
    dash.initialize(video, url, true);
    state.dashInstance = dash;

  } else if (isHLS && typeof Hls !== 'undefined' && Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(video);
    state.hlsInstance = hls;

  } else {
    video.src = url;
  }

  video.play().catch(() => {});
  showOverlay(ch, index + 1, pl.name);
}

/* ───────────────── OVERLAY ───────────────── */
function showOverlay(ch, num, plName) {
  const nameEl = document.getElementById('ch-name');
  const numEl  = document.getElementById('ch-number');

  if (nameEl) nameEl.textContent = ch.name;
  if (numEl)  numEl.textContent = num;

  const overlay = document.getElementById('channel-overlay');
  if (!overlay) return;

  overlay.style.display = 'flex';

  clearTimeout(state.overlayTimer);
  state.overlayTimer = setTimeout(() => {
    overlay.style.display = 'none';
  }, 3500);
}

/* ───────────────── KEYBOARD ───────────────── */
function bindKeyboard() {
  document.addEventListener('keydown', e => {
    if (!pages.player?.classList.contains('active')) return;

    if (e.key === 'ArrowUp')   channelUp();
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
