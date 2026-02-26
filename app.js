/* ==============================
   PLAY M3U — app.js
============================== */

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

// ── App State ────────────────────────────────────────────────────
const state = {
  playlists: [],        // [{name, url, type, channels:[], autoDownload}]
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

// ── DOM refs ──────────────────────────────────────────────────────
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
  if (pages[key]) pages[key].classList.add('active');
  // Fix focus for TV
  setTimeout(() => {
    const first = pages[key]?.querySelector('.focusable, button, input, [tabindex]');
    if (first) first.focus();
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) {
      current = { name: '', logo: '', group: '', url: '' };
      // name: last comma part
      const commaIdx = line.lastIndexOf(',');
      current.name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : 'Channel';
      // logo
      const logoM = line.match(/tvg-logo="([^"]+)"/i);
      if (logoM) current.logo = logoM[1];
      // group
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
  // Try direct, then CORS proxy fallback
  const proxies = [
    url,
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];
  for (const u of proxies) {
    try {
      const res = await fetch(u, { method: 'GET', signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const text = await res.text();
        if (text.includes('#EXTM3U') || text.includes('#EXTINF')) return text;
      }
    } catch(e) { /* try next */ }
  }
  throw new Error('Tidak dapat memuat playlist. Periksa URL dan koneksi internet.');
}

// ── Init ──────────────────────────────────────────────────────────
function init() {
  state.playlists = loadDB(DB_KEY_PLAYLISTS, []);
  state.currentPLIndex = loadDB(DB_KEY_LAST_PL, 0);
  state.currentCHIndex = loadDB(DB_KEY_LAST_CH, 0);

  const visited = loadDB(DB_KEY_FIRST_VISIT, false);

  if (state.playlists.length > 0) {
    // Returning visitor
    if (!visited) saveDB(DB_KEY_FIRST_VISIT, true);
    const pl = state.playlists[state.currentPLIndex] || state.playlists[0];
    if (!pl) { showPage('welcome'); return; }

    if (pl.autoDownload) {
      // Re-fetch playlist then play
      showPage('player');
      showPlayerLoading(true, 'Memperbaharui playlist...');
      fetchM3U(pl.url).then(text => {
        pl.channels = parseM3U(text);
        saveDB(DB_KEY_PLAYLISTS, state.playlists);
        startPlayback();
      }).catch(() => {
        // fallback: use cached
        startPlayback();
      });
    } else {
      showPage('player');
      showPlayerLoading(true, 'Mohon bersabar...');
      setTimeout(() => startPlayback(), 600);
    }
  } else {
    showPage('welcome');
  }

  bindEvents();
}

// ── Welcome ───────────────────────────────────────────────────────
document.getElementById('btn-add-playlist-welcome').addEventListener('click', () => {
  const btn = document.getElementById('btn-add-playlist-welcome');
  btn.classList.add('clicked');
  setTimeout(() => {
    btn.classList.remove('clicked');
    showPage('chooseType');
  }, 180);
});

// ── Choose Type ───────────────────────────────────────────────────
document.getElementById('back-from-choose').addEventListener('click', () => {
  showPage('welcome');
});

const optURL     = document.getElementById('opt-url');
const optStorage = document.getElementById('opt-storage');
const cataChText = document.getElementById('catatan-choose-text');

function selectOption(type) {
  state.pendingType = type;
  optURL.classList.toggle('active', type === 'url');
  optStorage.classList.toggle('active', type === 'storage');

  if (type === 'url') {
    cataChText.textContent = 'Masukkan URL playlist dari provider IPTV Anda. Pastikan link aktif dan dapat dibuka lewat internet.';
    setTimeout(() => showPage('enterURL'), 250);
  } else {
    cataChText.textContent = 'Gunakan opsi ini jika file playlist M3U tersimpan di perangkat atau USB. Pastikan file sudah ada dan bisa dibaca.';
    setTimeout(() => showPage('enterStorage'), 250);
  }
}

optURL.addEventListener('click', () => selectOption('url'));
optStorage.addEventListener('click', () => selectOption('storage'));
optURL.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' ') selectOption('url'); });
optStorage.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' ') selectOption('storage'); });

// ── Enter URL ─────────────────────────────────────────────────────
document.getElementById('back-from-url').addEventListener('click', () => showPage('chooseType'));
document.getElementById('btn-clear-url').addEventListener('click', () => {
  document.getElementById('url-input').value = '';
  document.getElementById('url-input').classList.remove('filled');
  document.getElementById('url-input').focus();
});

const urlInput = document.getElementById('url-input');
urlInput.addEventListener('blur', () => {
  if (urlInput.value.trim()) urlInput.classList.add('filled');
  else urlInput.classList.remove('filled');
});
urlInput.addEventListener('focus', () => urlInput.classList.remove('filled'));

document.getElementById('btn-next-url').addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) { showToast('Masukkan URL playlist terlebih dahulu.'); return; }
  if (!url.startsWith('http')) { showToast('URL harus dimulai dengan http:// atau https://'); return; }

  document.getElementById('loading-url').style.display = 'flex';
  document.getElementById('btn-next-url').disabled = true;

  try {
    const text = await fetchM3U(url);
    const channels = parseM3U(text);
    if (channels.length === 0) throw new Error('Tidak ada channel ditemukan dalam playlist ini.');
    state.pendingURL = url;
    state.pendingChannels = channels;
    state.pendingType = 'url';
    document.getElementById('channel-count').textContent = `${channels.length} siaran ditemukan`;
    document.getElementById('name-input').value = '';
    showPage('name');
  } catch(e) {
    showToast(e.message || 'Gagal memuat playlist.');
  } finally {
    document.getElementById('loading-url').style.display = 'none';
    document.getElementById('btn-next-url').disabled = false;
  }
});

// ── Enter Storage ─────────────────────────────────────────────────
document.getElementById('back-from-storage').addEventListener('click', () => showPage('chooseType'));

const dropZone  = document.getElementById('file-drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' ') fileInput.click(); });
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFileLoad(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileLoad(fileInput.files[0]);
});

document.getElementById('btn-clear-file').addEventListener('click', () => {
  fileInput.value = '';
  state.pendingURL = '';
  state.pendingChannels = [];
  dropZone.classList.remove('has-file');
  dropZone.querySelector('p').textContent = 'Klik atau seret file .m3u / .m3u8';
});

document.getElementById('btn-next-file').addEventListener('click', () => {
  if (!state.pendingChannels.length) { showToast('Pilih file M3U terlebih dahulu.'); return; }
  document.getElementById('channel-count').textContent = `${state.pendingChannels.length} siaran ditemukan`;
  document.getElementById('name-input').value = '';
  showPage('name');
});

function handleFileLoad(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    const channels = parseM3U(text);
    if (!channels.length) { showToast('Tidak ada channel ditemukan.'); return; }
    state.pendingChannels = channels;
    state.pendingURL = file.name;
    state.pendingType = 'storage';
    dropZone.classList.add('has-file');
    dropZone.querySelector('p').textContent = `✓ ${file.name} (${channels.length} channel)`;
  };
  reader.readAsText(file);
}

// ── Playlist Name ─────────────────────────────────────────────────
document.getElementById('back-from-name').addEventListener('click', () => {
  if (state.pendingType === 'url') showPage('enterURL');
  else showPage('enterStorage');
});

document.getElementById('btn-clear-name').addEventListener('click', () => {
  document.getElementById('name-input').value = '';
  document.getElementById('name-input').focus();
});

const nameInput = document.getElementById('name-input');
nameInput.addEventListener('blur', () => {
  if (nameInput.value.trim()) nameInput.classList.add('filled');
  else nameInput.classList.remove('filled');
});
nameInput.addEventListener('focus', () => nameInput.classList.remove('filled'));

document.getElementById('btn-save-playlist').addEventListener('click', () => {
  const name = nameInput.value.trim() || 'Playlist ' + (state.playlists.length + 1);
  const autoDownload = document.getElementById('radio-yes').checked;

  const pl = {
    name,
    url: state.pendingURL,
    type: state.pendingType,
    channels: state.pendingChannels,
    autoDownload,
  };

  // Check duplicate
  const existing = state.playlists.findIndex(p => p.url === pl.url);
  if (existing >= 0) {
    state.playlists[existing] = pl;
    state.currentPLIndex = existing;
  } else {
    state.playlists.push(pl);
    state.currentPLIndex = state.playlists.length - 1;
  }

  state.currentCHIndex = 0;
  saveDB(DB_KEY_PLAYLISTS, state.playlists);
  saveDB(DB_KEY_LAST_PL, state.currentPLIndex);
  saveDB(DB_KEY_LAST_CH, 0);
  saveDB(DB_KEY_FIRST_VISIT, true);

  showPage('settings');
});

// ── Settings ──────────────────────────────────────────────────────
document.getElementById('btn-start-watch').addEventListener('click', () => {
  document.getElementById('btn-start-watch').classList.add('active');
  setTimeout(() => {
    document.getElementById('btn-start-watch').classList.remove('active');
    showPage('player');
    showPlayerLoading(true, 'Mohon bersabar...');
    setTimeout(() => startPlayback(), 500);
  }, 180);
});

document.getElementById('btn-go-playlists').addEventListener('click', () => {
  document.getElementById('btn-go-playlists').classList.add('active');
  setTimeout(() => {
    document.getElementById('btn-go-playlists').classList.remove('active');
    renderPlaylistsPage();
    showPage('playlists');
  }, 180);
});

// ── Playlists Manager ─────────────────────────────────────────────
document.getElementById('back-from-playlists').addEventListener('click', () => {
  if (state.playlists.length > 0) showPage('settings');
  else showPage('welcome');
});

document.getElementById('btn-add-new-playlist').addEventListener('click', () => {
  showPage('chooseType');
});

function renderPlaylistsPage() {
  const container = document.getElementById('playlist-list-container');
  container.innerHTML = '';

  if (!state.playlists.length) {
    container.innerHTML = '<p style="padding:24px;color:rgba(255,255,255,0.6);font-size:14px;">Belum ada playlist.</p>';
  }

  state.playlists.forEach((pl, idx) => {
    const entry = document.createElement('div');
    entry.className = 'playlist-entry focusable';
    entry.tabIndex = idx + 2;
    if (idx === state.currentPLIndex) entry.classList.add('active-pl');

    entry.innerHTML = `
      <div class="playlist-entry-info">
        <div class="pl-name">${esc(pl.name)}</div>
        <div class="pl-sub">${(pl.channels?.length||0).toLocaleString()} ch. (${pl.type === 'url' ? 'URL' : 'File'})</div>
      </div>
      <div class="pl-actions">
        <button class="pl-btn-small btn-update focusable" data-idx="${idx}" tabindex="-1" title="Update">↻</button>
        <button class="pl-btn-small btn-del focusable" data-idx="${idx}" tabindex="-1" title="Hapus">✕</button>
      </div>
    `;

    // Click on entry = select & watch
    entry.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      state.currentPLIndex = idx;
      state.currentCHIndex = 0;
      saveDB(DB_KEY_LAST_PL, idx);
      saveDB(DB_KEY_LAST_CH, 0);
      renderPlaylistsPage();
    });

    entry.querySelector('.btn-update').addEventListener('click', e => {
      e.stopPropagation();
      updatePlaylist(idx);
    });
    entry.querySelector('.btn-del').addEventListener('click', e => {
      e.stopPropagation();
      deletePlaylist(idx);
    });

    container.appendChild(entry);
  });

  // Storage estimate
  try {
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(est => {
        const used = (est.usage / 1048576).toFixed(1);
        const avail = ((est.quota - est.usage) / 1048576).toFixed(1);
        document.getElementById('storage-detail').textContent = `Used: ${used} MB / Available: ${avail} MB`;
      });
    } else {
      document.getElementById('storage-detail').textContent = 'Used: — / Available: —';
    }
  } catch(e) {}
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
}

function deletePlaylist(idx) {
  state.playlists.splice(idx, 1);
  if (state.currentPLIndex >= state.playlists.length)
    state.currentPLIndex = Math.max(0, state.playlists.length - 1);
  state.currentCHIndex = 0;
  saveDB(DB_KEY_PLAYLISTS, state.playlists);
  saveDB(DB_KEY_LAST_PL, state.currentPLIndex);
  saveDB(DB_KEY_LAST_CH, 0);
  renderPlaylistsPage();
  if (!state.playlists.length) {
    showPage('welcome');
  }
}

async function updatePlaylist(idx) {
  const pl = state.playlists[idx];
  if (!pl || pl.type === 'storage') { showToast('Hanya bisa update playlist dari URL.'); return; }

  const container = document.getElementById('playlist-list-container');
  const oldHTML = container.innerHTML;

  const loadDiv = document.createElement('div');
  loadDiv.className = 'pl-update-loading';
  loadDiv.innerHTML = `<div class="spinner"></div><p>Mohon bersabar...</p>`;
  container.insertBefore(loadDiv, container.firstChild);

  try {
    const text = await fetchM3U(pl.url);
    const channels = parseM3U(text);
    pl.channels = channels;
    saveDB(DB_KEY_PLAYLISTS, state.playlists);
    loadDiv.remove();

    const msg = document.createElement('p');
    msg.className = 'pl-update-msg';
    msg.textContent = 'Playlist telah diperbaharui';
    container.insertBefore(msg, container.firstChild);
    setTimeout(() => { msg.remove(); renderPlaylistsPage(); }, 2500);
  } catch(e) {
    loadDiv.remove();
    showToast(e.message || 'Gagal update playlist.');
    renderPlaylistsPage();
  }
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
  if (!pl || !pl.channels || !pl.channels.length) {
    showPlayerLoading(false);
    showToast('Tidak ada channel tersedia.');
    showPage('settings');
    return;
  }
  const idx = Math.min(state.currentCHIndex, pl.channels.length - 1);
  state.currentCHIndex = idx;
  playChannel(idx);
}

function playChannel(idx) {
  const pl = state.playlists[state.currentPLIndex];
  if (!pl || !pl.channels) return;
  const ch = pl.channels[idx];
  if (!ch) return;

  state.currentCHIndex = idx;
  saveDB(DB_KEY_LAST_CH, idx);
  saveDB(DB_KEY_LAST_PL, state.currentPLIndex);

  const video = document.getElementById('video-player');
  showPlayerLoading(true);

  // Destroy old instances
  if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
  if (state.dashInstance) { state.dashInstance.reset(); state.dashInstance = null; }
  video.src = '';
  video.load();

  const url = ch.url;
  const isHLS  = url.includes('.m3u8') || url.includes('m3u8');
  const isDASH = url.includes('.mpd')  || url.includes('manifest');

  const onReady = () => {
    showPlayerLoading(false);
    showChannelOverlay(ch, idx + 1, pl.name);
  };

  video.onerror = () => {
    showPlayerLoading(false);
    showToast(`Error memuat channel: ${ch.name}`);
  };

  if (isDASH && typeof dashjs !== 'undefined') {
    const dash = dashjs.MediaPlayer().create();
    dash.initialize(video, url, true);
    state.dashInstance = dash;
    video.addEventListener('canplay', onReady, { once: true });
  } else if (isHLS || url.includes('.ts')) {
    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        onReady();
      });
      hls.on(Hls.Events.ERROR, (evt, data) => {
        if (data.fatal) {
          showPlayerLoading(false);
          showToast(`Error: ${ch.name}`);
        }
      });
      state.hlsInstance = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = url;
      video.play().catch(() => {});
      video.addEventListener('canplay', onReady, { once: true });
    } else {
      video.src = url;
      video.play().catch(() => {});
      video.addEventListener('canplay', onReady, { once: true });
    }
  } else {
    // MP4, AAC, MP3, etc.
    video.src = url;
    video.play().catch(() => {});
    video.addEventListener('canplay', onReady, { once: true });
  }
}

function showChannelOverlay(ch, num, plName) {
  const overlay = document.getElementById('channel-overlay');
  const logo    = document.getElementById('ch-logo');
  const logoWrap = document.getElementById('ch-logo-wrap');

  document.getElementById('ch-playlist-name').textContent = plName || '';
  document.getElementById('ch-group').textContent  = ch.group || '';
  document.getElementById('ch-number').textContent = num;
  document.getElementById('ch-name').textContent   = ch.name || '';

  if (ch.logo) {
    logo.src = ch.logo;
    logo.style.display = 'block';
    logoWrap.style.display = 'flex';
  } else {
    logo.style.display = 'none';
    logoWrap.style.display = 'none';
  }

  overlay.style.display = 'flex';
  clearTimeout(state.overlayTimer);
  state.overlayTimer = setTimeout(() => {
    overlay.style.display = 'none';
  }, 4000);
}

// ── Channel Switching ─────────────────────────────────────────────
function switchChannelByNumber(num) {
  const pl = state.playlists[state.currentPLIndex];
  if (!pl) return;
  const idx = num - 1;
  if (idx < 0 || idx >= pl.channels.length) {
    showToast(`Channel ${num} tidak ditemukan.`);
    return;
  }
  playChannel(idx);
}

function channelUp() {
  const pl = state.playlists[state.currentPLIndex];
  if (!pl) return;
  const next = (state.currentCHIndex + 1) % pl.channels.length;
  playChannel(next);
}

function channelDown() {
  const pl = state.playlists[state.currentPLIndex];
  if (!pl) return;
  const prev = (state.currentCHIndex - 1 + pl.channels.length) % pl.channels.length;
  playChannel(prev);
}

// ── Keyboard / Remote ─────────────────────────────────────────────
function bindEvents() {
  document.addEventListener('keydown', e => {
    const onPlayer = pages.player.classList.contains('active');
    const onOther  = !onPlayer;

    // Number keys (0-9) — channel switch while on player
    if (onPlayer && e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      const numInput = document.getElementById('ch-num-input-overlay');
      const numDisp  = document.getElementById('ch-num-display');
      numInput.style.display = 'block';
      state.channelNumberBuffer += e.key;
      numDisp.textContent = state.channelNumberBuffer;

      clearTimeout(state.channelNumberTimer);
      state.channelNumberTimer = setTimeout(() => {
        const n = parseInt(state.channelNumberBuffer, 10);
        state.channelNumberBuffer = '';
        numInput.style.display = 'none';
        if (!isNaN(n)) switchChannelByNumber(n);
      }, 1500);
      return;
    }

    if (onPlayer) {
      switch(e.key) {
        case 'ArrowUp':
        case 'ChannelUp':
        case 'PageUp':
          e.preventDefault();
          channelUp();
          break;
        case 'ArrowDown':
        case 'ChannelDown':
        case 'PageDown':
          e.preventDefault();
          channelDown();
          break;
        case 'Escape':
        case 'Back':
        case 'GoBack':
          e.preventDefault();
          renderPlaylistsPage();
          showPage('playlists');
          break;
        case 'Enter':
        case 'MediaPlay':
        case 'MediaPause':
        case 'MediaPlayPause': {
          const video = document.getElementById('video-player');
          if (video.paused) video.play().catch(() => {});
          else video.pause();
          break;
        }
      }
    }

    // Back key on other pages
    if (onOther && (e.key === 'Escape' || e.key === 'Back')) {
      const backBtn = document.querySelector('.page.active .btn-back');
      if (backBtn) backBtn.click();
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
