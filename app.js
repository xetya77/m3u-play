'use strict';

/* ───────── STORAGE ───────── */
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

/* ───────── FETCH TIMEOUT ───────── */
async function fetchWithTimeout(resource, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/* ───────── STATE ───────── */
const state = {
  pendingURL: '',
  pendingChannels: [],
  pendingType: 'url',
  hls: null,
  dash: null,
};

/* ───────── DOM / PAGE ───────── */
const pages = {
  welcome: document.getElementById('page-welcome'),
  chooseType: document.getElementById('page-choose-type'),
  enterURL: document.getElementById('page-enter-url'),
  enterStorage: document.getElementById('page-enter-storage'),
  name: document.getElementById('page-playlist-name'),
  player: document.getElementById('page-player'),
};

function showPage(key) {
  Object.values(pages).forEach(p => p?.classList.remove('active'));
  pages[key]?.classList.add('active');
}

/* ───────── TOAST ───────── */
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

/* ───────── M3U PARSER ───────── */
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (line.startsWith('#EXTINF:')) {
      current = { name: 'Channel', group: '', url: '' };

      const nameIdx = line.lastIndexOf(',');
      if (nameIdx !== -1) current.name = line.slice(nameIdx + 1).trim();

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

/* ───────── FETCH PLAYLIST ───────── */
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

/* ───────── PLAYER ENGINE ───────── */
function cleanupPlayer() {
  const video = document.getElementById('video-player');
  if (!video) return;

  video.pause();
  video.removeAttribute('src');
  video.load();

  try { state.hls?.destroy(); } catch {}
  try { state.dash?.reset(); } catch {}

  state.hls = null;
  state.dash = null;
}

function playStream(url) {
  const video = document.getElementById('video-player');
  if (!video) return;

  cleanupPlayer();

  const isHLS  = url.includes('.m3u8');
  const isDASH = url.includes('.mpd');

  if (isDASH && typeof dashjs !== 'undefined') {
    const dash = dashjs.MediaPlayer().create();
    dash.initialize(video, url, true);
    state.dash = dash;

  } else if (isHLS && typeof Hls !== 'undefined' && Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(video);
    state.hls = hls;

  } else {
    video.src = url;
  }

  video.play().catch(() => {});
}

/* ───────── BUTTON BINDINGS ───────── */
function bindButtons() {

  document.getElementById('btn-add-playlist-welcome')
    ?.addEventListener('click', () => showPage('chooseType'));

  document.getElementById('back-from-choose')
    ?.addEventListener('click', () => showPage('welcome'));

  document.getElementById('opt-url')
    ?.addEventListener('click', () => {
      state.pendingType = 'url';
      showPage('enterURL');
    });

  document.getElementById('opt-storage')
    ?.addEventListener('click', () => {
      state.pendingType = 'file';
      showPage('enterStorage');
    });

  document.getElementById('back-from-url')
    ?.addEventListener('click', () => showPage('chooseType'));

  document.getElementById('btn-next-url')
    ?.addEventListener('click', async () => {
      const url = document.getElementById('url-input').value.trim();
      if (!url) return showToast('URL kosong');

      try {
        showToast('Memuat playlist...');
        const text = await fetchM3U(url);

        state.pendingURL = url;
        state.pendingChannels = parseM3U(text);

        updateChannelCount();
        showPage('name');

      } catch {
        showToast('Gagal memuat playlist');
      }
    });

  const fileInput = document.getElementById('file-input');
  document.getElementById('file-drop-zone')
    ?.addEventListener('click', () => fileInput?.click());

  fileInput?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();

    reader.onload = () => {
      try {
        state.pendingChannels = parseM3U(reader.result);
        updateChannelCount();
        showPage('name');
      } catch {
        showToast('File tidak valid');
      }
    };

    reader.onerror = () => showToast('Gagal baca file');
    reader.readAsText(file);
  });

  document.getElementById('btn-save-playlist')
    ?.addEventListener('click', () => {
      const name = document.getElementById('name-input').value.trim();
      if (!name) return showToast('Nama playlist kosong');
      if (!state.pendingChannels.length) return showToast('Channel kosong');

      const playlists = loadDB(DB_KEY_PLAYLISTS, []);

      playlists.push({
        name,
        url: state.pendingURL,
        channels: state.pendingChannels,
        type: state.pendingType
      });

      saveDB(DB_KEY_PLAYLISTS, playlists);

      const newIndex = playlists.length - 1;
      saveDB(DB_KEY_LAST_PL, newIndex);
      saveDB(DB_KEY_LAST_CH, 0);

      showToast('Playlist disimpan');

      showPage('player');

      setTimeout(() => {
        playStream(playlists[newIndex].channels[0].url);
      }, 300);

      resetPending();
    });
}

/* ───────── HELPERS ───────── */
function updateChannelCount() {
  const el = document.getElementById('channel-count');
  if (el) el.textContent = `${state.pendingChannels.length} siaran`;
}

function resetPending() {
  state.pendingURL = '';
  state.pendingChannels = [];
  document.getElementById('url-input').value = '';
  document.getElementById('name-input').value = '';
}

/* ───────── INIT ───────── */
function init() {
  bindButtons();
  showPage('welcome');
}

document.addEventListener('DOMContentLoaded', init);
