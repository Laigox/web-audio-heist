/* ==========================================================
   Client-side script: public/assets/script.js
   - Manages UI state, rendering, socket.io events, and user actions
   - Sections marked below: configuration, state, socket, rendering,
     metadata, download controls, preview, helpers
 ========================================================== */

const MODE_STORAGE_KEY = 'yt-audio-heist-mode';

const MODE_CONFIG = {
  audio: {
    icon: '🎵',
    label: 'Audio',
    actionLabel: '⬇ Descargar MP3',
    doneLabel: 'Descargar MP3 otra vez',
    emptyIcon: '🎵',
    emptyCopy: 'Aún no hay nada aquí.<br>Pega un link arriba para comenzar.',
    subtitle: 'Arma tu lista y baja cada video en MP3 con bitrate por item.'
  },
  video: {
    icon: '🎬',
    label: 'Video',
    actionLabel: '⬇ Descargar MP4',
    doneLabel: 'Descargar MP4 otra vez',
    emptyIcon: '🎬',
    emptyCopy: 'La lista está vacía.<br>Agrega videos o playlists para preparar descargas MP4.',
    subtitle: 'Cambia a video para elegir resolución por item y decidir si incluyes miniatura.'
  },
  thumbnail: {
    icon: '🖼',
    label: 'Miniatura',
    actionLabel: '⬇ Descargar miniatura',
    doneLabel: 'Descargar miniatura otra vez',
    emptyIcon: '🖼',
    emptyCopy: 'Todavía no hay miniaturas en cola.<br>Agrega un link para elegir el tamaño de imagen.',
    subtitle: 'Descarga miniaturas en distintos tamaños visuales usando la misma lista.'
  }
};

const AUDIO_QUALITY_OPTIONS = [
  { value: '96', shortLabel: 'Baja', label: 'Baja · 96 Kbps' },
  { value: '128', shortLabel: 'Media', label: 'Media · 128 Kbps' },
  { value: '256', shortLabel: 'Alta', label: 'Alta · 256 Kbps' },
  { value: '320', shortLabel: 'Máxima', label: 'Máxima · 320 Kbps' }
];

const THUMBNAIL_OPTIONS = [
  { key: 'small', label: 'Pequeña', width: 120, height: 90 },
  { key: 'medium', label: 'Media', width: 320, height: 180 },
  { key: 'high', label: 'Alta', width: 640, height: 480 },
  { key: 'max', label: 'Máxima', width: 1280, height: 720 },
  { key: 'hd', label: 'HD', width: 1920, height: 1080 }
];

let currentMode = localStorage.getItem(MODE_STORAGE_KEY) || 'audio';
let items = [];
let undoStack = [];
let redoStack = [];
let youtubeSearchResults = [];
let displayedResultCount = 0;
let activeCommandText = '';
let metadataRequestInFlight = null;

const metadataCache = new Map();
const metadataQueue = [];
const pendingMetadataUrls = new Set();

let socket;
if (typeof io !== 'undefined') {
  const preferredOrigin = window.location.protocol.startsWith('http')
    ? window.location.origin
    : 'http://localhost:3001';

  try {
    socket = io(preferredOrigin);
  } catch (error) {
    socket = io('http://localhost:3001');
  }
} else {
  socket = {
    connected: false,
    on: () => {},
    emit: () => {}
  };
}

socket.on('connect', () => {
  processMetadataQueue();
});

socket.on('connect_error', () => {
  showToast('No se pudo conectar al servidor.', 'error');
});

socket.on('disconnect', () => {
  showToast('Conexión al servidor perdida.', 'error');
});

socket.on('search-results', (results) => {
  youtubeSearchResults = results;
  displayedResultCount = 0;
  renderYouTubeResults();
  showToast(`Se encontraron ${results.length} resultados.`, 'success');
});

socket.on('search-error', (data) => {
  showToast(data.message || 'Error en la búsqueda.', 'error');
});

socket.on('playlist-info', (data) => {
  const { url, items: playlistItems, title, id } = data;
  addItem(url, title || 'Playlist de YouTube', `https://img.youtube.com/vi/${playlistItems[0]?.id || id}/mqdefault.jpg`, true, playlistItems);
});

socket.on('media-info', ({ url, info }) => {
  metadataCache.set(url, info);
  pendingMetadataUrls.delete(url);
  metadataRequestInFlight = null;
  applyMetadataToItems(url, info);
  render();
  processMetadataQueue();
});

socket.on('media-info-error', ({ url }) => {
  pendingMetadataUrls.delete(url);
  metadataRequestInFlight = null;
  markMetadataError(url);
  processMetadataQueue();
});

socket.on('progress', (data) => {
  const { url, percent } = data;
  const item = items.find((entry) => entry.url === url);

  if (item) {
    item.status = 'downloading';
    item.percent = percent;
    updateProgressBar(url, percent);
    return;
  }

  items.forEach((playlist) => {
    if (!playlist.isPlaylist || !playlist.playlistItems) return;

    const subIndex = playlist.playlistItems.findIndex((sub) => sub.url === url);
    if (subIndex === -1) return;

    const subItem = playlist.playlistItems[subIndex];
    subItem.status = 'downloading';
    subItem.percent = percent;
    updateProgressBar(url, percent);
    recalculatePlaylistState(playlist);
  });
});

socket.on('done', (data) => {
  const { url, fileName, extraFileName } = data;
  const item = items.find((entry) => entry.url === url);

  if (item) {
    item.status = 'done';
    item.percent = 100;
    item.downloadedFileName = fileName;
    item.extraFileName = extraFileName || null;
    render();
    showToast(extraFileName ? `Listo: ${fileName} + ${extraFileName}` : `Listo: ${fileName}`, 'success');
    return;
  }

  items.forEach((playlist) => {
    if (!playlist.isPlaylist || !playlist.playlistItems) return;

    const subItem = playlist.playlistItems.find((entry) => entry.url === url);
    if (!subItem) return;

    subItem.status = 'done';
    subItem.percent = 100;
    subItem.downloadedFileName = fileName;
    subItem.extraFileName = extraFileName || null;
    recalculatePlaylistState(playlist);
    render();
  });
});

socket.on('error', (data) => {
  const { url, message } = data;
  const item = items.find((entry) => entry.url === url);

  if (item) {
    item.status = 'error';
    item.percent = 0;
    render();
  }

  items.forEach((playlist) => {
    if (!playlist.isPlaylist || !playlist.playlistItems) return;

    const subItem = playlist.playlistItems.find((entry) => entry.url === url);
    if (!subItem) return;

    subItem.status = 'error';
    subItem.percent = 0;
    recalculatePlaylistState(playlist);
    render();
  });

  showToast(message || 'La descarga falló.', 'error');
});

/**
 * buildDefaultQualityState
 * Devuelve el estado por defecto de selección de calidad para un nuevo item.
 * - `audio`: bitrate por defecto (Kbps)
 * - `video`: resolución por defecto ('max' = la mejor disponible)
 * - `thumbnail`: preset por defecto para miniaturas
 */
function buildDefaultQualityState() {
  return {
    audio: '320',
    video: 'max',
    thumbnail: 'max'
  };
}

/**
 * createMediaEntry
 * Crea la estructura interna que representa un item en la lista.
 * Parámetros:
 * - `url`: URL del video o playlist
 * - `title`: título opcional (si no, se genera por `getTitle`)
 * - `thumb`: miniatura inicial
 * - `isPlaylist`: booleano si es playlist
 * - `playlistItems`: lista de sub-items cuando es playlist
 * Devuelve un objeto con campos usados por la UI y la lógica de descarga.
 */
function createMediaEntry({ url, title = null, thumb = null, isPlaylist = false, playlistItems = null }) {
  return {
    url,
    title: title || getTitle(url),
    thumb: thumb || getThumbnail(url),
    isPlaylist,
    playlistItems,
    status: 'pending',
    percent: 0,
    timestamp: Date.now() + Math.random(),
    expanded: false,
    isNew: true,
    meta: null,
    metadataStatus: isPlaylist ? 'ready' : 'idle',
    quality: buildDefaultQualityState(),
    videoIncludeThumbnail: false,
    downloadedFileName: null,
    extraFileName: null
  };
}

/**
 * saveState
 * Guarda el estado actual de `items` en la pila de deshacer (undo).
 * También limpia la pila de rehacer (redo) para mantener consistencia.
 */
function saveState() {
  undoStack.push(JSON.stringify(items));
  redoStack = [];
  updateHistoryButtons();
}

/**
 * undo
 * Restaura el último estado guardado en la pila de `undo`.
 * Guarda el estado actual en `redo` para permitir rehacer.
 */
function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(JSON.stringify(items));
  items = JSON.parse(undoStack.pop());
  render();
  updateHistoryButtons();
  showToast('Acción deshecha.', 'success');
}

/**
 * redo
 * Re-aplica la última acción deshecha, si existe.
 */
function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(JSON.stringify(items));
  items = JSON.parse(redoStack.pop());
  render();
  updateHistoryButtons();
  showToast('Acción rehecha.', 'success');
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * searchYouTube
 * Solicita al servidor una búsqueda en YouTube usando `yt-dlp`.
 * Validaciones: requiere texto en el input; actualiza la UI inicial.
 */
function searchYouTube() {
  const input = document.getElementById('youtube-search-input');
  const query = input.value.trim();

  if (!query) {
    showToast('Escribe algo para buscar.', 'warn');
    return;
  }

  youtubeSearchResults = [];
  displayedResultCount = 0;
  renderYouTubeResults();
  showToast('Buscando en YouTube...', 'success');
  socket.emit('search-youtube', { query, count: 25 });
}

function loadMoreResults() {
  displayedResultCount += 5;
  renderYouTubeResults();
}

/**
 * renderYouTubeResults
 * Pinta los resultados devueltos por la búsqueda en el contenedor
 * `#youtube-search-results`. Maneja paginación básica (cargar más).
 */
function renderYouTubeResults() {
  const container = document.getElementById('youtube-search-results');
  if (!container) return;

  if (youtubeSearchResults.length === 0) {
    container.innerHTML = '';
    return;
  }

  const resultsToShow = youtubeSearchResults.slice(0, displayedResultCount + 5);
  displayedResultCount = resultsToShow.length;

  let html = '';
  resultsToShow.forEach((result) => {
    html += `
      <div class="youtube-result-card">
        <img src="${escapeHtml(result.thumb)}" class="result-thumb" alt="">
        <div class="result-info">
          <div class="result-title">${escapeHtml(result.title)}</div>
        </div>
        <button class="add-result-btn" onclick="addResultToItems('${escapeHtml(result.url)}', '${escapeHtml(result.title)}', '${escapeHtml(result.thumb)}')">
          + Agregar
        </button>
      </div>
    `;
  });

  if (displayedResultCount < youtubeSearchResults.length) {
    html += `
      <button class="load-more-btn" onclick="loadMoreResults()">
        ↪ Más resultados
      </button>
    `;
  }

  container.innerHTML = html;
}

/**
 * addResultToItems
 * Añade el resultado seleccionado a la lista de items. Si es playlist,
 * solicita al servidor la información de la playlist y crea sub-items.
 */
function addResultToItems(url, title, thumb = null) {
  if (url.includes('playlist') || url.includes('list=')) {
    showToast('Obteniendo información de la playlist...', 'success');
    socket.emit('get-playlist-info', url);
    return;
  }

  addItem(url, title, thumb);
}

/**
 * getYTId
 * Extrae el videoId de YouTube a partir de una URL.
 * Retorna `null` si no encuentra un ID válido.
 */
function getYTId(url) {
  const match = String(url).match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function getThumbnail(url) {
  const id = getYTId(url);
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
}

function getTitle(url) {
  const id = getYTId(url);
  if (id) return `Video · ${id}`;
  if (url.includes('playlist')) return 'Playlist de YouTube';
  return url;
}

function isValidYT(url) {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

/**
 * handleInput
 * Maneja el input principal cuando el usuario pega un link y presiona +Agregar.
 * Valida que sea un link de YouTube y decide si es video o playlist.
 */
function handleInput() {
  const input = document.getElementById('main-input');
  const url = input.value.trim();

  if (!url) {
    showToast('Pega un link primero.', 'warn');
    return;
  }

  if (!isValidYT(url)) {
    showToast('Solo se aceptan links de YouTube.', 'warn');
    return;
  }

  if (url.includes('playlist') || url.includes('list=')) {
    showToast('Obteniendo información de la playlist...', 'success');
    socket.emit('get-playlist-info', url);
  } else {
    addItem(url);
  }

  input.value = '';
}

/**
 * addItem
 * Añade un nuevo item (video o playlist) a la lista interna `items`.
 * Cuando se agrega un video se encola la petición de metadata para poblar
 * las opciones reales de calidad.
 */
function addItem(url, title = null, thumb = null, isPlaylist = false, playlistItems = null) {
  if (items.some((entry) => entry.url === url)) {
    showToast('Ese link ya está en la lista.', 'warn');
    return;
  }

  saveState();

  let item;
  if (isPlaylist) {
    const subItems = (playlistItems || []).map((sub) => createMediaEntry({
      url: sub.url || `https://www.youtube.com/watch?v=${sub.id}`,
      title: sub.title,
      thumb: `https://img.youtube.com/vi/${getYTId(sub.url || `https://www.youtube.com/watch?v=${sub.id}`) || sub.id}/mqdefault.jpg`
    }));

    item = createMediaEntry({
      url,
      title: title || 'Playlist de YouTube',
      thumb,
      isPlaylist: true,
      playlistItems: subItems
    });

    subItems.forEach((subItem) => queueMetadataFetch(subItem.url));
  } else {
    item = createMediaEntry({ url, title, thumb });
    queueMetadataFetch(item.url);
  }

  items.push(item);
  sortItems();
  render();

  setTimeout(() => {
    item.isNew = false;
  }, 500);

  showToast('Agregado a la lista.', 'success');
}

function sortItems() {
  items.sort((a, b) => {
    if (a.isPlaylist !== b.isPlaylist) {
      return a.isPlaylist ? 1 : -1;
    }
    return a.timestamp - b.timestamp;
  });
}

/**
 * queueMetadataFetch
 * Encola la petición de metadata para un URL. Evita duplicados y usa cache
 * en `metadataCache` si ya está disponible.
 */
function queueMetadataFetch(url) {
  if (!url || pendingMetadataUrls.has(url)) return;

  if (metadataCache.has(url)) {
    applyMetadataToItems(url, metadataCache.get(url));
    return;
  }

  pendingMetadataUrls.add(url);
  metadataQueue.push(url);
  processMetadataQueue();
}

/**
 * processMetadataQueue
 * Procesa la cola de metadata enviando un `get-media-info` al servidor
 * para el siguiente URL pendiente.
 */
function processMetadataQueue() {
  if (metadataRequestInFlight || metadataQueue.length === 0) return;
  metadataRequestInFlight = metadataQueue.shift();
  socket.emit('get-media-info', { url: metadataRequestInFlight });
}

/**
 * applyMetadataToItems
 * Aplica la metadata recibida del servidor a los items correspondientes
 * actualizando `meta`, `thumbnail`, `title` y las opciones de calidad.
 */
function applyMetadataToItems(url, info) {
  items.forEach((entry) => {
    if (!entry.isPlaylist && entry.url === url) {
      hydrateEntry(entry, info, true);
      return;
    }

    if (!entry.isPlaylist || !entry.playlistItems) return;

    entry.playlistItems.forEach((subItem, subIndex) => {
      if (subItem.url !== url) return;
      hydrateEntry(subItem, info, false);

      if (subIndex === 0 && !entry.thumb) {
        entry.thumb = subItem.thumb;
      }
    });
  });
}

/**
 * hydrateEntry
 * Rellena un `entry` con la metadata obtenida (`extractMediaInfo` en server).
 * - `allowTitleOverwrite`: si true, reemplaza títulos por defecto.
 * - Actualiza `meta`, `metadataStatus`, `thumb` y las calidades.
 */
function hydrateEntry(entry, info, allowTitleOverwrite) {
  entry.meta = info;
  entry.metadataStatus = 'ready';

  if (info.thumbnailPreviewUrl) {
    entry.thumb = info.thumbnailPreviewUrl;
  }

  if (allowTitleOverwrite && (!entry.title || entry.title.startsWith('Video ·'))) {
    entry.title = info.title;
  }

  syncEntryQuality(entry);
}

function markMetadataError(url) {
  items.forEach((entry) => {
    if (!entry.isPlaylist && entry.url === url) {
      entry.metadataStatus = 'error';
      return;
    }

    if (!entry.isPlaylist || !entry.playlistItems) return;
    entry.playlistItems.forEach((subItem) => {
      if (subItem.url === url) subItem.metadataStatus = 'error';
    });
  });
}

/**
 * getThumbnailOptions
 * Construye las opciones de miniatura para un entry usando metadata o
 * una URL fallback basada en el videoId.
 */
function getThumbnailOptions(entry) {
  const fromMeta = entry.meta?.thumbnailOptions || [];
  const fallbackId = getYTId(entry.url);

  return THUMBNAIL_OPTIONS.map((preset) => {
    const metaOption = fromMeta.find((option) => option.key === preset.key);
    return {
      key: preset.key,
      label: preset.label,
      width: preset.width,
      height: preset.height,
      available: metaOption?.available ?? true,
      url: metaOption?.url || (fallbackId ? `https://img.youtube.com/vi/${fallbackId}/${getThumbnailFileForPreset(preset.key)}` : entry.thumb)
    };
  });
}

function getThumbnailFileForPreset(key) {
  const mapping = {
    small: 'default.jpg',
    medium: 'mqdefault.jpg',
    high: 'sddefault.jpg',
    max: 'hq720.jpg',
    hd: 'maxresdefault.jpg'
  };
  return mapping[key] || 'mqdefault.jpg';
}

function resolveVideoSelection(entry, requestedValue) {
  const options = entry.meta?.videoQualities || [];

  if (options.length === 0) {
    return requestedValue || 'max';
  }

  if (requestedValue === 'max' || !requestedValue) {
    return options[options.length - 1].value;
  }

  const exact = options.find((option) => option.value === String(requestedValue));
  if (exact) return exact.value;

  const target = Number(requestedValue);
  if (!Number.isFinite(target)) {
    return options[options.length - 1].value;
  }

  const lowerOrEqual = options.filter((option) => option.height <= target);
  if (lowerOrEqual.length > 0) {
    return lowerOrEqual[lowerOrEqual.length - 1].value;
  }

  return options[0].value;
}

function resolveAudioSelection(requestedValue) {
  if (AUDIO_QUALITY_OPTIONS.some((option) => option.value === String(requestedValue))) {
    return String(requestedValue);
  }
  return '320';
}

function resolveThumbnailSelection(entry, requestedValue) {
  const options = getThumbnailOptions(entry);
  const key = requestedValue === 'max' ? 'max' : String(requestedValue || 'max');
  return options.some((option) => option.key === key) ? key : 'max';
}

function syncEntryQuality(entry) {
  entry.quality.audio = resolveAudioSelection(entry.quality.audio);
  entry.quality.video = resolveVideoSelection(entry, entry.quality.video);
  entry.quality.thumbnail = resolveThumbnailSelection(entry, entry.quality.thumbnail);
}

function setMode(mode) {
  if (!MODE_CONFIG[mode]) return;
  currentMode = mode;
  localStorage.setItem(MODE_STORAGE_KEY, mode);
  closeGlobalQualityMenu();
  updateModeUI();
  render();
}

function updateModeUI() {
  document.body.dataset.mode = currentMode;

  document.querySelectorAll('.mode-switch .mode').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === currentMode);
  });

  const config = MODE_CONFIG[currentMode];
  document.getElementById('main-download-btn').textContent = config.actionLabel;
  document.getElementById('empty-icon').textContent = config.emptyIcon;
  document.getElementById('empty-copy').innerHTML = config.emptyCopy;
  document.getElementById('page-subtitle').textContent = config.subtitle;
  document.getElementById('global-quality-wrap').style.display = currentMode === 'thumbnail' ? 'none' : 'block';
}

function render() {
  const container = document.getElementById('items-container');
  const empty = document.getElementById('main-empty');
  const count = document.getElementById('main-count');
  const batch = document.getElementById('main-batch');

  count.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;
  empty.style.display = items.length === 0 ? 'block' : 'none';
  batch.style.display = items.length > 0 ? 'flex' : 'none';

  container.innerHTML = items.map((item, index) => renderItemCard(item, index)).join('');

  items.forEach((item) => {
    if (item.status === 'downloading') {
      updateProgressBar(item.url, item.percent);
    }

    if (!item.isPlaylist || !item.expanded || !item.playlistItems) return;
    item.playlistItems.forEach((subItem) => {
      if (subItem.status === 'downloading') {
        updateProgressBar(subItem.url, subItem.percent);
      }
    });
  });

  updateHistoryButtons();
}

function renderItemCard(item, index) {
  const modeClass = `${currentMode}-mode`;
  const thumbHtml = renderThumb(item);
  const removeButton = `<button class="remove-btn" onclick="removeItem(${index})">✕</button>`;
  const expandButton = item.isPlaylist
    ? `<button class="playlist-expand-btn" onclick="toggleExpand(${index})">${item.expanded ? '▴' : '▾'}</button>`
    : '';

  const body = item.isPlaylist
    ? renderPlaylistCardBody(item, index)
    : renderSingleCardBody(item, index);

  return `
    <div class="item-card ${modeClass} ${item.status === 'downloading' ? 'downloading' : ''} ${item.isNew ? 'new-item' : ''}">
      <div class="item-header-tools">
        <div class="status-pill ${item.status}">${getStatusLabel(item.status)}</div>
        <div class="header-tool-group">
          ${expandButton}
          ${removeButton}
        </div>
      </div>
      <div class="item-body">
        ${thumbHtml}
        ${body}
      </div>
      ${item.isPlaylist && item.expanded ? renderPlaylistSubItems(item, index) : ''}
    </div>
  `;
}

function renderThumb(item) {
  const previewEntry = item.isPlaylist ? item.playlistItems?.[0] || item : item;
  const selectedThumb = getSelectedThumbnailOption(previewEntry);
  const imageSrc = currentMode === 'thumbnail' ? (selectedThumb?.url || previewEntry.thumb || item.thumb) : (previewEntry.thumb || item.thumb);

  if (imageSrc) {
    return `<img class="item-thumb" src="${escapeHtml(imageSrc)}" alt="">`;
  }

  return `<div class="item-thumb-placeholder">${currentMode === 'thumbnail' ? '🖼' : item.isPlaylist ? '📋' : '🎵'}</div>`;
}

function renderSingleCardBody(item, index) {
  const metaLine = renderMetaLine(item, false);
  const controlBlock = renderControlBlock(item, index);
  const progress = item.status === 'downloading' ? `<div class="progress" id="progress-${getSafeId(item.url)}"></div>` : '';
  const commandButton = `<button class="secondary-btn" onclick="openCommandModal(${index})">⌘ Ver comando</button>`;
  // Mostrar Preview en todos los modos si el item tiene videoId
  const previewButton = getYTId(item.url)
    ? `<button class="secondary-btn" onclick="openPreview(${index})">▶ Preview</button>`
    : '';

  return `
    <div class="item-content">
      <div class="item-title-row">
        <div class="item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <span class="item-type-badge ${item.isPlaylist ? 'badge-playlist' : 'badge-song'}">${item.isPlaylist ? 'Playlist' : MODE_CONFIG[currentMode].label}</span>
      </div>
      <div class="item-subtitle" title="${escapeHtml(item.url)}">${escapeHtml(getSecondaryLine(item))}</div>
      ${metaLine}
      ${controlBlock}
      ${progress}
      <div class="item-actions">
        ${renderPrimaryAction(item, index)}
        ${commandButton}
        ${previewButton}
      </div>
    </div>
  `;
}

function renderPlaylistCardBody(item, index) {
  const metaLine = renderMetaLine(item, true);
  const progress = item.status === 'downloading' ? `<div class="progress" id="progress-${getSafeId(item.url)}"></div>` : '';

  return `
    <div class="item-content">
      <div class="item-title-row">
        <div class="item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <span class="item-type-badge badge-playlist">Playlist</span>
      </div>
      <div class="item-subtitle">${item.playlistItems?.length || 0} videos listos para ${MODE_CONFIG[currentMode].label.toLowerCase()}.</div>
      ${metaLine}
      <div class="item-controls playlist-controls">
        <div class="control-group">
          <label>Aplicar a toda la playlist</label>
          ${renderPlaylistQualitySelect(item, index)}
        </div>
        ${currentMode === 'video' ? renderPlaylistThumbnailToggle(item, index) : ''}
      </div>
      ${progress}
      <div class="item-actions">
        ${renderPrimaryAction(item, index)}
        <button class="secondary-btn" onclick="openCommandModal(${index}, 0)">⌘ Ver comando base</button>
      </div>
    </div>
  `;
}

function renderPlaylistSubItems(item, index) {
  if (!item.playlistItems || item.playlistItems.length === 0) return '';

  return `
    <div class="playlist-songs-container show">
      ${item.playlistItems.map((subItem, subIndex) => renderSubItem(item, index, subItem, subIndex)).join('')}
    </div>
  `;
}

function renderSubItem(item, index, subItem, subIndex) {
  const progress = subItem.status === 'downloading' ? `<div class="progress" id="progress-${getSafeId(subItem.url)}"></div>` : '';

  return `
    <div class="sub-card ${subItem.status === 'downloading' ? 'downloading' : ''}">
      <div class="sub-card-main">
        ${renderSubThumb(subItem)}
        <div class="sub-card-content">
          <div class="item-title" title="${escapeHtml(subItem.title)}">${escapeHtml(subItem.title)}</div>
          <div class="item-subtitle" title="${escapeHtml(subItem.url)}">${escapeHtml(getSecondaryLine(subItem))}</div>
          ${renderMetaLine(subItem, false)}
          ${renderControlBlock(subItem, index, subIndex)}
          ${progress}
          <div class="sub-card-actions">
            ${renderPrimaryAction(subItem, index, subIndex)}
            <button class="secondary-btn" onclick="openCommandModal(${index}, ${subIndex})">⌘ Comando</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSubThumb(subItem) {
  const selectedThumb = getSelectedThumbnailOption(subItem);
  const imageSrc = currentMode === 'thumbnail' ? (selectedThumb?.url || subItem.thumb) : subItem.thumb;

  if (imageSrc) {
    return `<img class="item-thumb" src="${escapeHtml(imageSrc)}" alt="">`;
  }

  return `<div class="item-thumb-placeholder">🎵</div>`;
}

function renderMetaLine(item, isPlaylist) {
  const chips = [];

  if (isPlaylist) {
    chips.push(`<span class="meta-chip">${item.playlistItems?.length || 0} items</span>`);
    chips.push(`<span class="meta-chip">${getPlaylistSelectionSummary(item)}</span>`);
  } else {
    if (item.meta?.channel) {
      chips.push(`<span class="meta-chip">${escapeHtml(item.meta.channel)}</span>`);
    }

    if (currentMode === 'video' && item.meta?.durationText) {
      chips.push(`<span class="meta-chip">${escapeHtml(item.meta.durationText)}</span>`);
    }

    chips.push(`<span class="meta-chip accent">${escapeHtml(getSelectedQualityLabel(item, currentMode))}</span>`);

    if (currentMode === 'video') {
      chips.push(`<span class="meta-chip">${item.videoIncludeThumbnail ? 'Con miniatura' : 'Sin miniatura'}</span>`);
      if (item.videoIncludeThumbnail) {
        chips.push(`<span class="meta-chip">${escapeHtml(getSelectedQualityLabel(item, 'thumbnail'))}</span>`);
      }
    }
  }

  if (item.metadataStatus === 'idle' && currentMode === 'video') {
    chips.push('<span class="meta-chip muted">Cargando calidades...</span>');
  }

  return `<div class="meta-line">${chips.join('')}</div>`;
}

function renderControlBlock(item, index, subIndex = null) {
  return `
    <div class="item-controls">
      <div class="control-group">
        <label>${getQualityLabelTitle(currentMode)}</label>
        ${renderQualitySelect(item, index, subIndex)}
      </div>
      ${currentMode === 'video' ? renderThumbnailToggle(item, index, subIndex) : ''}
    </div>
  `;
}

function getQualityLabelTitle(mode) {
  if (mode === 'audio') return 'Bitrate';
  if (mode === 'video') return 'Resolución';
  return 'Tamaño';
}

function renderQualitySelect(item, index, subIndex = null) {
  const options = getCurrentModeOptions(item);
  const selectedValue = getCurrentModeValue(item);
  const disabled = currentMode === 'video' && options.length === 0;
  const changeHandler = subIndex === null
    ? `changeItemQuality(${index}, this.value)`
    : `changeSubItemQuality(${index}, ${subIndex}, this.value)`;

  const htmlOptions = disabled
    ? '<option value="">Cargando...</option>'
    : options.map((option) => `
        <option value="${escapeHtml(option.value)}" ${option.value === selectedValue ? 'selected' : ''}>
          ${escapeHtml(option.label)}
        </option>
      `).join('');

  return `
    <select class="quality-select" onchange="${changeHandler}" ${disabled ? 'disabled' : ''}>
      ${htmlOptions}
    </select>
  `;
}

function renderPlaylistQualitySelect(item, index) {
  const options = getPlaylistControlOptions();
  const selectedValue = item.quality[currentMode];
  const htmlOptions = options.map((option) => `
    <option value="${escapeHtml(option.value)}" ${option.value === selectedValue ? 'selected' : ''}>
      ${escapeHtml(option.label)}
    </option>
  `).join('');

  return `
    <select class="quality-select" onchange="changePlaylistQuality(${index}, this.value)">
      ${htmlOptions}
    </select>
  `;
}

function renderThumbnailToggle(item, index, subIndex = null) {
  const checked = item.videoIncludeThumbnail ? 'checked' : '';
  const changeHandler = subIndex === null
    ? `toggleVideoThumbnail(${index}, this.checked)`
    : `toggleVideoThumbnail(${index}, this.checked, ${subIndex})`;

  return `
    <label class="thumb-toggle">
      <input type="checkbox" onchange="${changeHandler}" ${checked}>
      <span>Descargar con miniatura</span>
    </label>
  `;
}

function renderPlaylistThumbnailToggle(item, index) {
  const checked = item.videoIncludeThumbnail ? 'checked' : '';

  return `
    <label class="thumb-toggle">
      <input type="checkbox" onchange="togglePlaylistVideoThumbnail(${index}, this.checked)" ${checked}>
      <span>Aplicar miniatura a toda la playlist</span>
    </label>
  `;
}

function renderPrimaryAction(item, index, subIndex = null) {
  if (item.status === 'downloading') {
    const clickHandler = subIndex === null
      ? `cancelDownload('${escapeHtml(item.url)}', ${index})`
      : `cancelSubDownload(${index}, ${subIndex})`;

    return `<button class="primary-btn cancel" onclick="${clickHandler}">⏹ Cancelar</button>`;
  }

  const clickHandler = subIndex === null
    ? `downloadItem(${index})`
    : `downloadSubItem(${index}, ${subIndex})`;

  const label = item.status === 'done' ? MODE_CONFIG[currentMode].doneLabel : MODE_CONFIG[currentMode].actionLabel;
  return `<button class="primary-btn" onclick="${clickHandler}">${escapeHtml(label)}</button>`;
}

function getSecondaryLine(item) {
  if (currentMode === 'audio') {
    return item.meta?.channel || item.url;
  }

  if (currentMode === 'video') {
    return item.meta?.durationText ? `${item.meta.durationText} · ${item.url}` : item.url;
  }

  return `${getSelectedQualityLabel(item, 'thumbnail')} · ${item.url}`;
}

function getStatusLabel(status) {
  if (status === 'downloading') return 'Descargando';
  if (status === 'done') return 'Completado';
  if (status === 'error') return 'Error';
  return 'Listo';
}

function getCurrentModeOptions(item) {
  if (currentMode === 'audio') {
    return AUDIO_QUALITY_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label
    }));
  }

  if (currentMode === 'video') {
    return (item.meta?.videoQualities || []).map((option) => ({
      value: option.value,
      label: option.label
    }));
  }

  return getThumbnailOptions(item).map((option) => ({
    value: option.key,
    label: `${option.label} · ${option.width} × ${option.height}`
  }));
}

function getCurrentModeValue(item) {
  if (currentMode === 'audio') return item.quality.audio;
  if (currentMode === 'video') return resolveVideoSelection(item, item.quality.video);
  return item.quality.thumbnail;
}

function getSelectedQualityLabel(item, mode) {
  if (mode === 'audio') {
    const match = AUDIO_QUALITY_OPTIONS.find((option) => option.value === item.quality.audio);
    return match ? match.label.replace(' · ', ' ') : '320 Kbps';
  }

  if (mode === 'video') {
    const resolved = resolveVideoSelection(item, item.quality.video);
    const match = (item.meta?.videoQualities || []).find((option) => option.value === resolved);
    return match ? match.label : resolved === 'max' ? 'Mejor disponible' : `${resolved}p`;
  }

  const selected = getSelectedThumbnailOption(item);
  if (!selected) return 'Máxima';
  return `${selected.label} ${selected.width} × ${selected.height}`;
}

function getSelectedThumbnailOption(item) {
  const options = getThumbnailOptions(item);
  return options.find((option) => option.key === item.quality.thumbnail) || options.find((option) => option.key === 'max') || options[0] || null;
}

function getPlaylistControlOptions() {
  if (currentMode === 'audio') {
    return [
      { value: '320', label: 'Máxima disponible · 320 Kbps' },
      { value: '320', label: 'Alta · 320 Kbps' },
      { value: '256', label: 'Media · 256 Kbps' },
      { value: '128', label: 'Baja · 128 Kbps' }
    ];
  }

  if (currentMode === 'video') {
    return [
      { value: 'max', label: 'Máxima disponible' },
      { value: '1080', label: 'Alta · 1080p' },
      { value: '720', label: 'Media · 720p' },
      { value: '480', label: 'Baja · 480p' }
    ];
  }

  return THUMBNAIL_OPTIONS.map((option) => ({
    value: option.key,
    label: `${option.label} · ${option.width} × ${option.height}`
  }));
}

function getPlaylistSelectionSummary(item) {
  if (currentMode === 'audio') {
    return getSelectedQualityLabel({ quality: { audio: item.quality.audio } }, 'audio');
  }

  if (currentMode === 'video') {
    const value = item.quality.video;
    return value === 'max' ? 'Máxima por item' : `${value}p objetivo`;
  }

  const option = THUMBNAIL_OPTIONS.find((entry) => entry.key === item.quality.thumbnail) || THUMBNAIL_OPTIONS[3];
  return `${option.label} ${option.width} × ${option.height}`;
}

function changeItemQuality(index, value) {
  const item = items[index];
  if (!item) return;

  applyQualityToEntry(item, currentMode, value);
  render();
}

function changeSubItemQuality(index, subIndex, value) {
  const subItem = items[index]?.playlistItems?.[subIndex];
  if (!subItem) return;

  applyQualityToEntry(subItem, currentMode, value);
  render();
}

function changePlaylistQuality(index, value) {
  const item = items[index];
  if (!item?.playlistItems) return;

  item.quality[currentMode] = value;
  item.playlistItems.forEach((subItem) => applyQualityToEntry(subItem, currentMode, value));
  render();
}

function applyQualityToEntry(entry, mode, value) {
  if (mode === 'audio') {
    entry.quality.audio = resolveAudioSelection(value);
    return;
  }

  if (mode === 'video') {
    entry.quality.video = resolveVideoSelection(entry, value);
    return;
  }

  entry.quality.thumbnail = resolveThumbnailSelection(entry, value);
}

function applyGlobalQuality(level) {
  closeGlobalQualityMenu();

  items.forEach((entry) => {
    if (entry.isPlaylist && entry.playlistItems) {
      const mappedValue = getGlobalQualityValue(level);
      entry.quality[currentMode] = mappedValue;
      entry.playlistItems.forEach((subItem) => applyQualityToEntry(subItem, currentMode, mappedValue));
      return;
    }

    applyQualityToEntry(entry, currentMode, getGlobalQualityValue(level));
  });

  render();
}

function getGlobalQualityValue(level) {
  if (currentMode === 'audio') {
    const mapping = { max: '320', high: '320', medium: '256', low: '128' };
    return mapping[level] || '320';
  }

  if (currentMode === 'video') {
    const mapping = { max: 'max', high: '1080', medium: '720', low: '480' };
    return mapping[level] || 'max';
  }

  const mapping = { max: 'hd', high: 'max', medium: 'high', low: 'medium' };
  return mapping[level] || 'max';
}

function toggleGlobalQualityMenu(event) {
  event.stopPropagation();
  document.getElementById('global-quality-menu').classList.toggle('open');
}

function closeGlobalQualityMenu() {
  document.getElementById('global-quality-menu').classList.remove('open');
}

function toggleVideoThumbnail(index, checked, subIndex = null) {
  const target = subIndex === null ? items[index] : items[index]?.playlistItems?.[subIndex];
  if (!target) return;
  target.videoIncludeThumbnail = checked;
  render();
}

function togglePlaylistVideoThumbnail(index, checked) {
  const item = items[index];
  if (!item?.playlistItems) return;

  item.videoIncludeThumbnail = checked;
  item.playlistItems.forEach((subItem) => {
    subItem.videoIncludeThumbnail = checked;
  });
  render();
}

function openCommandModal(index, subIndex = null) {
  const target = subIndex === null ? items[index] : items[index]?.playlistItems?.[subIndex];
  if (!target) return;

  activeCommandText = getCommand(target);
  document.getElementById('cmd-text').textContent = activeCommandText;
  document.getElementById('modal-subtitle').textContent = `${MODE_CONFIG[currentMode].icon} ${MODE_CONFIG[currentMode].label} · ${getSelectedQualityLabel(target, currentMode)}`;
  document.getElementById('modal-save-note').textContent = getSaveNote(target);
  document.getElementById('modal').classList.add('open');
}

function getCommand(item) {
  if (currentMode === 'audio') {
    const bitrate = item.quality.audio;
    return `yt-dlp -x --audio-format mp3 --audio-quality ${bitrate}K -o "~/Descargas/%(title)s.%(ext)s" "${item.url}"`;
  }

  if (currentMode === 'video') {
    const resolution = resolveVideoSelection(item, item.quality.video);
    const format = resolution === 'max'
      ? 'bestvideo+bestaudio/best'
      : `bestvideo[height<=${resolution}]+bestaudio/best[height<=${resolution}]`;
    const thumbnailFlags = item.videoIncludeThumbnail ? ' --write-thumbnail --convert-thumbnails jpg' : '';
    return `yt-dlp -f "${format}" --merge-output-format mp4${thumbnailFlags} -o "~/Descargas/%(title)s.%(ext)s" "${item.url}"`;
  }

  return `yt-dlp --write-thumbnail --skip-download --convert-thumbnails jpg -o "~/Descargas/%(title)s.%(ext)s" "${item.url}"`;
}

function getSaveNote(item) {
  if (currentMode === 'audio') {
    return `El archivo se guardará en ~/Descargas/ como MP3 con ${getSelectedQualityLabel(item, 'audio')}.`;
  }

  if (currentMode === 'video') {
    const thumbSuffix = item.videoIncludeThumbnail
      ? ` También se añadirá una miniatura en ${getSelectedQualityLabel(item, 'thumbnail')}.`
      : '';
    return `El video se guardará en ~/Descargas/ como MP4 en ${getSelectedQualityLabel(item, 'video')}.${thumbSuffix}`;
  }

  return `La miniatura se guardará en ~/Descargas/ usando el tamaño visual ${getSelectedQualityLabel(item, 'thumbnail')}.`;
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
}

async function copyCmd() {
  if (!activeCommandText) return;

  await navigator.clipboard.writeText(activeCommandText);
  const button = document.getElementById('copy-btn');
  button.textContent = 'Copiado';
  button.classList.add('copied');

  setTimeout(() => {
    button.textContent = 'Copiar';
    button.classList.remove('copied');
  }, 1400);
}

/**
 * openPreview
 * Abre el modal de preview embebido usando el `videoId` de YouTube.
 * - Busca el `iframe#preview-frame` y setea `src` con `embed/<videoId>?autoplay=1`.
 * - Actualiza el subtitle del modal.
 */
function openPreview(index, subIndex = null) {
  const target = subIndex === null ? items[index] : items[index]?.playlistItems?.[subIndex];
  if (!target) return;

  const videoId = getYTId(target.url);
  if (!videoId) return showToast('No hay preview disponible para este item.', 'warn');

  const iframe = document.getElementById('preview-frame');
  iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
  document.getElementById('preview-subtitle').textContent = target.title;
  document.getElementById('preview-modal').classList.add('open');
}

function closePreviewModal() {
  const iframe = document.getElementById('preview-frame');
  if (iframe) iframe.src = 'about:blank';
  document.getElementById('preview-modal').classList.remove('open');
}

function formatTime(sec) {
  sec = Math.floor(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function loadYouTubeApi() {
  return new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve();
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onload = () => {
      // wait for YT to be ready
      const check = () => {
        if (window.YT && window.YT.Player) return resolve();
        setTimeout(check, 100);
      };
      check();
    };
    tag.onerror = reject;
    document.head.appendChild(tag);
  });
}

function showDownloadOptions() {
  document.getElementById('options-modal').classList.add('open');
}

function closeOptionsModal() {
  document.getElementById('options-modal').classList.remove('open');
}

function handleBatchDownloadClick() {
  const hasFinishedItems = items.some((item) => {
    if (item.status === 'done') return true;
    return item.isPlaylist && item.playlistItems?.some((subItem) => subItem.status === 'done');
  });

  if (hasFinishedItems) {
    showDownloadOptions();
    return;
  }

  startBatchDownload('new');
}

function startBatchDownload(mode) {
  closeOptionsModal();

  items.forEach((item, index) => {
    if (!item.isPlaylist) {
      if (mode === 'all' || item.status !== 'done') {
        downloadItem(index);
      }
      return;
    }

    item.playlistItems?.forEach((subItem, subIndex) => {
      if (mode === 'all' || subItem.status !== 'done') {
        downloadSubItem(index, subIndex);
      }
    });
  });
}

function buildDownloadPayload(item) {
  const selectedThumbnail = getSelectedThumbnailOption(item);
  return {
    url: item.url,
    title: item.title,
    mode: currentMode,
    qualityValue:
      currentMode === 'audio'
        ? item.quality.audio
        : currentMode === 'video'
          ? resolveVideoSelection(item, item.quality.video)
          : item.quality.thumbnail,
    includeThumbnail: currentMode === 'video' ? item.videoIncludeThumbnail : false,
    thumbnailSelection: selectedThumbnail ? {
      key: selectedThumbnail.key,
      url: selectedThumbnail.url,
      width: selectedThumbnail.width,
      height: selectedThumbnail.height
    } : null
  };
}

function downloadItem(index) {
  const item = items[index];
  if (!item) return;

  if (item.isPlaylist) {
    item.playlistItems?.forEach((subItem, subIndex) => {
      downloadSubItem(index, subIndex);
    });
    recalculatePlaylistState(item);
    render();
    return;
  }

  item.status = 'downloading';
  item.percent = 0;
  socket.emit('download', buildDownloadPayload(item));
  render();
}

function downloadSubItem(index, subIndex) {
  const subItem = items[index]?.playlistItems?.[subIndex];
  if (!subItem || subItem.status === 'downloading') return;

  subItem.status = 'downloading';
  subItem.percent = 0;
  socket.emit('download', buildDownloadPayload(subItem));
  recalculatePlaylistState(items[index]);
  render();
}

function cancelDownload(url, index) {
  socket.emit('cancel-download', url);
  const item = items[index];
  if (!item) return;
  item.status = 'pending';
  item.percent = 0;
  render();
}

function cancelSubDownload(index, subIndex) {
  const subItem = items[index]?.playlistItems?.[subIndex];
  if (!subItem) return;
  socket.emit('cancel-download', subItem.url);
  subItem.status = 'pending';
  subItem.percent = 0;
  recalculatePlaylistState(items[index]);
  render();
}

function recalculatePlaylistState(item) {
  if (!item?.playlistItems?.length) return;

  if (item.playlistItems.some((subItem) => subItem.status === 'downloading')) {
    item.status = 'downloading';
    return;
  }

  if (item.playlistItems.every((subItem) => subItem.status === 'done')) {
    item.status = 'done';
    return;
  }

  if (item.playlistItems.some((subItem) => subItem.status === 'error')) {
    item.status = 'error';
    return;
  }

  item.status = 'pending';
}

function updateProgressBar(url, percent) {
  const container = document.getElementById(`progress-${getSafeId(url)}`);
  if (!container) return;

  container.innerHTML = `
    <div class="bar-bg">
      <div class="bar-fill" style="width: ${percent}%"></div>
    </div>
    <div class="progress-text">${percent.toFixed(1)}%</div>
  `;
}

function getSafeId(url) {
  try {
    return btoa(unescape(encodeURIComponent(url))).replace(/[/=+]/g, '');
  } catch (error) {
    return url.replace(/[^a-z0-9]/gi, '');
  }
}

function toggleExpand(index) {
  const item = items[index];
  if (!item) return;
  item.expanded = !item.expanded;
  render();
}

function removeItem(index) {
  const item = items[index];
  if (!item) return;

  saveState();

  if (item.status === 'downloading') {
    socket.emit('cancel-download', item.url);
  }

  if (item.isPlaylist && item.playlistItems) {
    item.playlistItems.forEach((subItem) => {
      if (subItem.status === 'downloading') {
        socket.emit('cancel-download', subItem.url);
      }
    });
  }

  items.splice(index, 1);
  render();
}

function clearAll() {
  if (!confirm('¿Limpiar toda la lista?')) return;
  saveState();
  items = [];
  render();
  showToast('Lista limpiada.', 'success');
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  setTimeout(() => toast.classList.remove('show'), 2600);
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('.global-quality-wrap')) {
    closeGlobalQualityMenu();
  }

  if (event.target.id === 'modal') {
    closeModal();
  }

  if (event.target.id === 'preview-modal') {
    closePreviewModal();
  }

  if (event.target.id === 'options-modal') {
    closeOptionsModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
  }

  if (event.ctrlKey && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
  }

  if (event.key === 'Escape') {
    closeModal();
    closePreviewModal();
    closeOptionsModal();
    closeGlobalQualityMenu();
  }
});

document.getElementById('main-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') handleInput();
});

document.getElementById('youtube-search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') searchYouTube();
});

updateModeUI();
render();
