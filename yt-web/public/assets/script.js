let items = [];
let undoStack = [];
let redoStack = [];
// Initialize socket safely — if the Socket.IO client failed to load, avoid throwing.
let socket;
if (typeof io !== 'undefined') {
  // Intenta conectar explícitamente al backend local (útil si la página se sirve desde otra URL)
  try {
    socket = io('http://localhost:3000');
  } catch (e) {
    socket = io();
  }
} else {
  console.warn('Socket.IO client not available; running in offline mode');
  socket = {
    connected: false,
    on: () => {},
    emit: () => {}
  };
}
let youtubeSearchResults = [];
let youtubeSearchQuery = '';
let displayedResultCount = 0;

console.log('Socket initialized, connected:', socket.connected);

socket.on('connect', () => {
  console.log('Socket connected to server');
});

socket.on('search-results', (results) => {
  console.log('Received search-results:', results);
  youtubeSearchResults = results;
  displayedResultCount = 0;
  renderYouTubeResults();
  showToast(`Se encontraron ${results.length} resultados! ✓`, 'success');
});

socket.on('search-error', (data) => {
  console.log('Received search-error:', data);
  showToast(data.message || 'Error en la búsqueda ❌', 'error');
});

function saveState() {
  // Guardamos una copia profunda del estado actual
  undoStack.push(JSON.stringify(items));
  redoStack = []; // Al realizar una nueva acción, limpiamos el historial de "rehacer"
  updateHistoryButtons();
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(JSON.stringify(items));
  items = JSON.parse(undoStack.pop());
  render();
  updateHistoryButtons();
  showToast('Acción deshecha ↩️');
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(JSON.stringify(items));
  items = JSON.parse(redoStack.pop());
  render();
  updateHistoryButtons();
  showToast('Acción rehecha ↪️');
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

function searchYouTube() {
  console.log('searchYouTube() called');
  
  const input = document.getElementById('youtube-search-input');
  if (!input) {
    console.error('No se encontró el campo de búsqueda de YouTube');
    return;
  }
  
  const query = input.value.trim();
  console.log('Query:', query);
  
  if (!query) {
    showToast('Escribe algo para buscar 🔍', 'warn');
    return;
  }

  youtubeSearchQuery = query;
  youtubeSearchResults = [];
  displayedResultCount = 0;
  
  showToast('Buscando en YouTube... ⏳');
  console.log('Emitting search-youtube event');
  socket.emit('search-youtube', { query, count: 25 }); // Cargamos más resultados inicialmente para la paginación local
}

function loadMoreResults() {
  displayedResultCount += 5;
  renderYouTubeResults();
}

function renderYouTubeResults() {
  const container = document.getElementById('youtube-search-results');
  if (youtubeSearchResults.length === 0) {
    container.innerHTML = '';
    return;
  }

  const resultsToShow = youtubeSearchResults.slice(0, displayedResultCount + 5);
  displayedResultCount = resultsToShow.length;

  let html = '';
  resultsToShow.forEach(result => {
    html += `
      <div class="youtube-result-card">
        <img src="${result.thumb}" class="result-thumb" alt="">
        <div class="result-info">
          <div class="result-title">${result.title}</div>
        </div>
        <button class="add-result-btn" onclick="addResultToItems('${result.url.replace(/'/g,"\\'")}', '${result.title.replace(/'/g,"\\'")}')">
          + Agregar
        </button>
      </div>
    `;
  });

  // Add "Más..." button only if there are more results to show
  if (displayedResultCount < youtubeSearchResults.length) {
    html += `
      <button class="load-more-btn" onclick="loadMoreResults()">
        ↪️ Más...
      </button>
    `;
  }

  container.innerHTML = html;
}

function addResultToItems(url, title) {
  if (url.includes('playlist') || url.includes('list=')) {
    showToast('Obteniendo información de la playlist... ⏳');
    socket.emit('get-playlist-info', url);
  } else {
    addItem(url, title);
  }
}

function getYTId(url) {
  const m = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function getThumbnail(url) {
  const id = getYTId(url);
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
}

function getTitle(url) {
  const id = getYTId(url);
  if (id) return `Video · ${id}`;
  if (url.includes('playlist')) {
    const m = url.match(/list=([a-zA-Z0-9_-]+)/);
    return m ? `Playlist · ${m[1].substring(0,12)}...` : 'Playlist de YouTube';
  }
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch { return url; }
}

function isValidYT(url) {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

function handleInput() {
  const input = document.getElementById('main-input');
  const url = input.value.trim();

  if (!url) return showToast('Pega un link primero ⚠️', 'warn');
  if (!isValidYT(url)) return showToast('Solo se aceptan links de YouTube', 'warn');

  if (url.includes('playlist') || url.includes('list=')) {
    showToast('Obteniendo información de la playlist... ⏳');
    socket.emit('get-playlist-info', url);
  } else {
    addItem(url);
  }
  input.value = '';
}

function addItem(url, title = null, thumb = null, isPlaylist = false, playlistItems = null) {
  if (items.find(i => i.url === url)) return showToast('Ese link ya está en la lista', 'warn');

  saveState(); // Guardamos el estado antes de agregar

  const newItem = {
    url,
    title: title || getTitle(url),
    thumb: thumb || getThumbnail(url),
    isPlaylist,
    playlistItems: playlistItems ? playlistItems.map(sub => ({
      ...sub,
      status: 'pending',
      percent: 0,
      thumb: `https://img.youtube.com/vi/${getYTId(sub.url)}/mqdefault.jpg`
    })) : null,
    status: 'pending', // pending, downloading, done, error
    percent: 0,
    timestamp: Date.now(),
    expanded: false,
    isNew: true // Etiqueta para la animación inicial
  };

  items.push(newItem);
  sortItems();
  render();
  
  // Quitar la etiqueta después de la animación
  setTimeout(() => {
    newItem.isNew = false;
  }, 500);

  showToast('✓ Agregado a la lista');
}

function sortItems() {
  // Sort: Songs first, then Playlists. Maintain order of arrival within types.
  items.sort((a, b) => {
    if (a.isPlaylist !== b.isPlaylist) {
      return a.isPlaylist ? 1 : -1;
    }
    return a.timestamp - b.timestamp;
  });
}

socket.on('playlist-info', (data) => {
  const { url, items: plItems, title, id } = data;
  // Represent the playlist by its first item's title if available, otherwise playlist title
  const displayTitle = plItems.length > 0 ? plItems[0].title : title;
  addItem(url, displayTitle, `https://img.youtube.com/vi/${plItems[0]?.id || id}/mqdefault.jpg`, true, plItems);
});

function removeItem(idx) {
  const item = items[idx];
  if (!item) return;

  saveState(); // Guardamos el estado antes de eliminar

  if (item.status === 'downloading') {
    socket.emit('cancel-download', item.url);
  }
  // Also cancel sub-items if it's a playlist
  if (item.isPlaylist && item.playlistItems) {
    item.playlistItems.forEach(sub => {
      if (sub.status === 'downloading') socket.emit('cancel-download', sub.url);
    });
  }
  items.splice(idx, 1);
  render();
}

function getSafeId(url) {
  try {
    return btoa(unescape(encodeURIComponent(url))).replace(/[/=+]/g, '');
  } catch (e) {
    return url.replace(/[^a-z0-9]/gi, '');
  }
}

function toggleExpand(idx) {
  items[idx].expanded = !items[idx].expanded;
  render();
}

function render() {
  const container = document.getElementById('items-container');
  const empty = document.getElementById('main-empty');
  const count = document.getElementById('main-count');
  const batch = document.getElementById('main-batch');

  count.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;
  batch.style.display = items.length > 0 ? 'flex' : 'none';
  empty.style.display = items.length === 0 ? 'block' : 'none';

  container.innerHTML = '';
  items.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = `item-card ${item.status === 'downloading' ? 'downloading' : ''} ${item.isNew ? 'new-item' : ''}`;
    card.setAttribute('data-id', getSafeId(item.url));

    const thumbHtml = item.thumb
      ? `<img class="item-thumb" src="${item.thumb}" alt="">`
      : `<div class="item-thumb-placeholder">${item.isPlaylist ? '📋' : '🎵'}</div>`;

    let actionButtons = '';
    if (item.status === 'downloading') {
      actionButtons = `<button class="cancel-btn" onclick="cancelDownload('${item.url.replace(/'/g,"\\'")}', ${i})">🛑 Cancelar</button>`;
    } else if (item.status === 'done') {
      actionButtons = `
        <div class="done-icon">✔</div>
        <button class="download-again-btn" onclick="downloadItem(${i})">Descargar Nuevamente</button>
      `;
    } else {
      actionButtons = `<button class="dl-btn" onclick="downloadItem(${i})">⬇ Descargar</button>`;
    }

    const expandBtn = item.isPlaylist 
      ? `<button class="playlist-expand-btn" onclick="toggleExpand(${i})">⋮</button>` 
      : '';

    let subItemsHtml = '';
    if (item.isPlaylist && item.expanded && item.playlistItems) {
      subItemsHtml = `<div class="playlist-songs-container show">`;
      // Skip the first item because it's represented by the main card
      item.playlistItems.slice(1).forEach((sub, subIdx) => {
        const actualSubIdx = subIdx + 1; // because of slice(1)
        const subId = getSafeId(sub.url);
        
        let subActionButtons = '';
        if (sub.status === 'downloading') {
          subActionButtons = `<button class="cancel-btn" onclick="cancelSubDownload(${i}, ${actualSubIdx})">🛑</button>`;
        } else if (sub.status === 'done') {
          subActionButtons = `<div class="done-icon">✔</div>`;
        } else {
          subActionButtons = `<button class="dl-btn" onclick="downloadSubItem(${i}, ${actualSubIdx})">⬇</button>`;
        }

        subItemsHtml += `
          <div class="item-card sub-card ${sub.status === 'downloading' ? 'downloading' : ''}" data-id="${subId}" style="margin-top: 8px;">
            <div class="item-main-content">
              <img class="item-thumb" src="${sub.thumb}" alt="" style="width: 48px; height: 36px;">
              <div class="item-info">
                <div class="item-title" title="${sub.title}" style="font-size: 0.8rem;">${sub.title}</div>
                <div class="item-url" title="${sub.url}" style="font-size: 0.65rem;">${sub.url}</div>
                <span class="item-type-badge badge-playlist">📋 Playlist</span>
                ${sub.status === 'downloading' ? `<div class="progress" id="progress-${subId}"></div>` : ''}
              </div>
              <div class="item-actions">
                ${subActionButtons}
              </div>
            </div>
          </div>
        `;
      });
      subItemsHtml += `</div>`;
    }

    card.innerHTML = `
      <div class="item-main-content">
        ${thumbHtml}
        <div class="item-info">
          <div class="item-title" title="${item.title}">${item.title}</div>
          <div class="item-url" title="${item.url}">${item.url}</div>
          <span class="item-type-badge ${item.isPlaylist ? 'badge-playlist' : 'badge-song'}">
            ${item.isPlaylist ? '📋 Playlist' : '🎵 Canción'}
          </span>
          ${item.status === 'downloading' ? `<div class="progress" id="progress-${getSafeId(item.url)}"></div>` : ''}
        </div>
        <div class="item-actions">
          <div style="display:flex; align-items:center; gap:8px;">
            ${expandBtn}
            <button class="remove-btn" onclick="removeItem(${i})">✕</button>
          </div>
          ${actionButtons}
        </div>
      </div>
      ${subItemsHtml}
    `;
    container.appendChild(card);
    
    if (item.status === 'downloading') {
      updateProgressBar(item.url, item.percent);
    }
    if (item.isPlaylist && item.expanded && item.playlistItems) {
      item.playlistItems.forEach(sub => {
        if (sub.status === 'downloading') updateProgressBar(sub.url, sub.percent);
      });
    }
  });
  updateHistoryButtons();
}

function showDownloadOptions() {
  document.getElementById('options-modal').classList.add('open');
}

function closeOptionsModal() {
  document.getElementById('options-modal').classList.remove('open');
}

function handleBatchDownloadClick() {
  const hasFinishedItems = items.some(item => {
    if (item.status === 'done') return true;
    if (item.isPlaylist && item.playlistItems && item.playlistItems.some(sub => sub.status === 'done')) return true;
    return false;
  });

  if (hasFinishedItems) {
    showDownloadOptions();
  } else {
    startBatchDownload('new');
  }
}

function startBatchDownload(mode) {
  closeOptionsModal();
  items.forEach((item, i) => {
    if (item.isPlaylist) {
      item.playlistItems.forEach((sub, subIdx) => {
        if (mode === 'all' || sub.status !== 'done') {
          downloadSubItem(i, subIdx);
        }
      });
    } else {
      if (mode === 'all' || item.status !== 'done') {
        downloadItem(i);
      }
    }
  });
}

function downloadItem(idx) {
  const item = items[idx];
  if (item.isPlaylist) {
    // For playlists, download all sub-items
    item.playlistItems.forEach((sub, subIdx) => {
      downloadSubItem(idx, subIdx);
    });
    item.status = 'downloading'; // Mark playlist as downloading if at least one item is
    render();
  } else {
    item.status = 'downloading';
    item.percent = 0;
    socket.emit('download', { url: item.url, title: item.title });
    render();
  }
}

function downloadSubItem(playlistIdx, subIdx) {
  const sub = items[playlistIdx].playlistItems[subIdx];
  if (sub.status === 'downloading') return;
  sub.status = 'downloading';
  sub.percent = 0;
  socket.emit('download', { url: sub.url, title: sub.title });
  render();
}

function cancelDownload(url, idx) {
  socket.emit('cancel-download', url);
  items[idx].status = 'pending';
  items[idx].percent = 0;
  render();
}

function cancelSubDownload(playlistIdx, subIdx) {
  const sub = items[playlistIdx].playlistItems[subIdx];
  socket.emit('cancel-download', sub.url);
  sub.status = 'pending';
  sub.percent = 0;
  render();
}

function updateProgressBar(url, percent) {
  const id = getSafeId(url);
  const container = document.getElementById(`progress-${id}`);
  if (!container) return;

  container.innerHTML = `
    <div class="bar-bg">
      <div class="bar-fill" style="width: ${percent}%"></div>
    </div>
    <div class="progress-text">${percent.toFixed(1)}%</div>
  `;
}

socket.on('progress', (data) => {
  const { url, percent } = data;
  
  // Check main items
  const item = items.find(i => i.url === url);
  if (item) {
    item.status = 'downloading';
    item.percent = percent;
    updateProgressBar(url, percent);
    return;
  }

  // Check sub-items in playlists
  items.forEach(it => {
    if (it.isPlaylist && it.playlistItems) {
      const subIndex = it.playlistItems.findIndex(s => s.url === url);
      if (subIndex !== -1) {
        const sub = it.playlistItems[subIndex];
        sub.status = 'downloading';
        sub.percent = percent;
        
        // If it's the first item, update the main card's progress bar too
        if (subIndex === 0) {
          it.status = 'downloading';
          it.percent = percent;
          updateProgressBar(it.url, percent);
        } else {
          updateProgressBar(url, percent);
        }
      }
    }
  });
});

socket.on('done', (data) => {
  const { url } = data;
  
  // Check main items
  const item = items.find(i => i.url === url);
  if (item) {
    item.status = 'done';
    item.percent = 100;
    render();
    return;
  }

  // Check sub-items
  items.forEach(it => {
    if (it.isPlaylist && it.playlistItems) {
      const subIndex = it.playlistItems.findIndex(s => s.url === url);
      if (subIndex !== -1) {
        const sub = it.playlistItems[subIndex];
        sub.status = 'done';
        sub.percent = 100;
        
        // If it's the first item, update main card state
        if (subIndex === 0) {
          // We don't necessarily mark the whole playlist as done yet
          // but we might want to update the UI
        }
        
        // Check if all items in playlist are done
        const allDone = it.playlistItems.every(s => s.status === 'done');
        if (allDone) it.status = 'done';
        
        render();
      }
    }
  });
});

socket.on('error', (data) => {
  const { url, message } = data;
  
  // Check main items
  const item = items.find(i => i.url === url);
  if (item) {
    item.status = 'error';
    render();
  }

  // Check sub-items
  items.forEach(it => {
    if (it.isPlaylist && it.playlistItems) {
      const subIndex = it.playlistItems.findIndex(s => s.url === url);
      if (subIndex !== -1) {
        const sub = it.playlistItems[subIndex];
        sub.status = 'error';
        
        if (subIndex === 0) it.status = 'error';
        
        render();
      }
    }
  });
  
  showToast(message || 'Error en descarga ❌', 'error');
});

function clearAll() {
  if (!confirm('¿Limpiar toda la lista?')) return;
  items = [];
  render();
  showToast('Lista limpiada');
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  // Ctrl + Z (Undo)
  if (e.ctrlKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  }
  // Ctrl + Y (Redo)
  if (e.ctrlKey && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  }
});

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => t.classList.remove('show'), 2800);
}

// Enter key to add
document.getElementById('main-input').addEventListener('keydown', e => { 
  if (e.key === 'Enter') handleInput(); 
});

// Enter key for YouTube search
document.getElementById('youtube-search-input').addEventListener('keydown', e => { 
  if (e.key === 'Enter') searchYouTube(); 
});



// Init render
render();