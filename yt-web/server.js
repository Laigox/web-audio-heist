const express = require('express');
const http = require('http');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Enable CORS so clients served from other origins (Live Preview, file://, etc.) can connect
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static files using an absolute path so starting the server from
// a different working directory won't create duplicate path issues.
const publicDir = path.join(__dirname, 'public');
console.log('Serving static files from:', publicDir);
app.use(express.static(publicDir));

const activeDownloads = new Map();
const downloadQueue = [];
let isProcessingQueue = false;

// Helper to find next available filename with (n)
async function getAvailableFilename(baseName, downloadsDir) {
  let fileName = `${baseName}.mp3`;
  let filePath = path.join(downloadsDir, fileName);
  
  if (!fs.existsSync(filePath)) {
    return fileName;
  }

  // Find gaps or next number
  let n = 1;
  while (true) {
    fileName = `${baseName} (${n}).mp3`;
    filePath = path.join(downloadsDir, fileName);
    if (!fs.existsSync(filePath)) {
      return fileName;
    }
    n++;
  }
}

async function processQueue(socket) {
  if (isProcessingQueue || downloadQueue.length === 0) return;
  isProcessingQueue = true;

  const item = downloadQueue.shift();
  const { url, title } = item;

  const downloadsDir = path.join(__dirname, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });

  // Clean title for filename
  const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '-').substring(0, 50);
  const finalFileName = await getAvailableFilename(safeTitle, downloadsDir);

  const yt = spawn('yt-dlp', [
    '-x',
    '--audio-format', 'mp3',
    '--newline',
    '--progress',
    '--no-color',
    '-o',
    path.join('downloads', finalFileName),
    url
  ]);

  activeDownloads.set(url, yt);

  yt.stdout.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/(\d+(\.\d+)?)%/);
    if (match) {
      socket.emit('progress', { url, percent: parseFloat(match[1]) });
    }
  });

  yt.on('close', (code) => {
    activeDownloads.delete(url);
    if (code === 0) {
      socket.emit('done', { url, fileName: finalFileName });
    } else {
      socket.emit('error', { url, code });
    }
    
    isProcessingQueue = false;
    processQueue(socket); // Process next in queue
  });
}

io.on('connection', (socket) => {
  console.log('Cliente conectado');

  socket.on('search-youtube', (data) => {
    const { query, count = 5 } = data;
    console.log('Buscando en YouTube:', query, `(${count} resultados)`);
    
    const yt = spawn('yt-dlp', [
      `ytsearch${count}:${query}`,
      '--dump-single-json',
      '--flat-playlist'
    ]);

    let output = '';
    let errorOutput = '';
    
    yt.stdout.on('data', (data) => {
      output += data.toString();
      console.log('yt-dlp stdout chunk received');
    });
    
    yt.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.log('yt-dlp stderr:', data.toString());
    });

    yt.on('close', (code) => {
      console.log('yt-dlp exited with code:', code);
      console.log('Full stdout:', output);
      if (errorOutput) console.log('Full stderr:', errorOutput);
      
      if (code === 0) {
        try {
          const json = JSON.parse(output);
          console.log('Parsed JSON has entries:', json.entries ? json.entries.length : 'none');
          
          if (!json.entries) {
            socket.emit('search-error', { message: 'No se encontraron resultados' });
            return;
          }
          
          const results = json.entries.map(entry => ({
            url: `https://www.youtube.com/watch?v=${entry.id}`,
            title: entry.title,
            id: entry.id,
            thumb: `https://img.youtube.com/vi/${entry.id}/mqdefault.jpg`
          }));
          socket.emit('search-results', results);
        } catch (e) {
          console.error('Error parsing JSON:', e);
          socket.emit('search-error', { message: 'Error al procesar los resultados: ' + e.message });
        }
      } else {
        socket.emit('search-error', { message: 'No se pudo realizar la búsqueda. Código de error: ' + code });
      }
    });
  });

  socket.on('get-playlist-info', (url) => {
    console.log('Obteniendo info de playlist:', url);
    const yt = spawn('yt-dlp', [
      '--dump-single-json',
      '--flat-playlist',
      url
    ]);

    let output = '';
    yt.stdout.on('data', (data) => {
      output += data.toString();
    });

    yt.on('close', (code) => {
      if (code === 0) {
        try {
          const json = JSON.parse(output);
          const items = json.entries.map(entry => ({
            url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
            title: entry.title,
            id: entry.id
          }));
          socket.emit('playlist-info', { url, items, title: json.title, id: json.id });
        } catch (e) {
          socket.emit('error', { url, message: 'Error al procesar la lista' });
        }
      } else {
        socket.emit('error', { url, message: 'No se pudo obtener la información de la lista' });
      }
    });
  });

  socket.on('download', (data) => {
    const { url, title } = data;
    // Check if already in queue or downloading
    if (activeDownloads.has(url) || downloadQueue.some(i => i.url === url)) return;

    downloadQueue.push({ url, title });
    processQueue(socket);
  });

  socket.on('cancel-download', (url) => {
    // Remove from queue if present
    const qIdx = downloadQueue.findIndex(i => i.url === url);
    if (qIdx !== -1) {
      downloadQueue.splice(qIdx, 1);
      socket.emit('error', { url, message: 'Descarga cancelada (en cola)' });
      return;
    }

    const yt = activeDownloads.get(url);
    if (yt) {
      yt.kill();
      activeDownloads.delete(url);
      socket.emit('error', { url, message: 'Descarga cancelada' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
});

server.listen(3000, () => {
  console.log('Servidor en http://localhost:3000');
});