/* ==========================================================
   Server: server.js
   - Express static server + Socket.io API
   - Responsibilities:
     * Run yt-dlp/ffmpeg subprocesses
     * Queue and manage downloads
     * Provide search, media and playlist metadata via sockets
     * Emit progress/done/error events to clients
   - Sections marked below: imports, config, helpers, yt-dlp runners,
     download pipeline, socket handlers, server start
 ========================================================== */

const express = require('express');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = Number(process.env.PORT) || 3001;

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const publicDir = path.join(__dirname, 'public');

const THUMBNAIL_PRESETS = [
  { key: 'small', label: 'Pequeña', width: 120, height: 90, file: 'default.jpg' },
  { key: 'medium', label: 'Media', width: 320, height: 180, file: 'mqdefault.jpg' },
  { key: 'high', label: 'Alta', width: 640, height: 480, file: 'sddefault.jpg' },
  { key: 'max', label: 'Máxima', width: 1280, height: 720, file: 'hq720.jpg' },
  { key: 'hd', label: 'HD', width: 1920, height: 1080, file: 'maxresdefault.jpg' }
];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

const activeDownloads = new Map();
const cancelledDownloads = new Set();
const downloadQueue = [];
let isProcessingQueue = false;

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

/**
 * sanitizeTitle(title)
 * Normaliza un título para usarlo como nombre de archivo:
 * - elimina caracteres inválidos en rutas
 * - normaliza espacios
 * - recorta a 80 caracteres
 */
function sanitizeTitle(title = 'descarga') {
  return String(title)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80) || 'descarga';
}

/**
 * formatDuration(seconds)
 * Convierte segundos a una cadena legible: H:MM:SS o M:SS.
 */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Sin duración';

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

/**
 * getPrimaryExtension(mode)
 * Devuelve la extensión de archivo principal según el `mode` solicitado.
 */
function getPrimaryExtension(mode, audioFormat = 'mp3') {
  if (mode === 'video') return 'mp4';
  if (mode === 'thumbnail') return 'jpg';
  return audioFormat === 'm4a' ? 'm4a' : 'mp3';
}

/**
 * getAvailableBaseName(baseName, primaryExt)
 * Evita colisiones en la carpeta `downloads` añadiendo sufijos `(n)` cuando
 * ya existe un fichero con el mismo nombre.
 */
function getAvailableBaseName(baseName, primaryExt) {
  let attempt = baseName;
  let index = 1;

  while (fs.existsSync(path.join(DOWNLOAD_DIR, `${attempt}.${primaryExt}`))) {
    attempt = `${baseName} (${index})`;
    index += 1;
  }

  return attempt;
}

/**
 * getVideoId(url)
 * Extrae el videoId de una URL de YouTube si está presente.
 */
function getVideoId(url) {
  const match = String(url).match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

/**
 * getFallbackThumbnailUrl(videoId, presetKey)
 * Construye una URL de miniatura `img.youtube.com` en caso de no haber
 * miniaturas detectadas en la metadata.
 */
function getFallbackThumbnailUrl(videoId, presetKey) {
  const preset = THUMBNAIL_PRESETS.find((entry) => entry.key === presetKey);
  if (!videoId || !preset) return null;
  return `https://img.youtube.com/vi/${videoId}/${preset.file}`;
}

/**
 * buildThumbnailOptions(videoId, thumbnails)
 * Normaliza la lista de miniaturas y la mapea a los presets disponibles,
 * devolviendo objetos con `available` y `url` para cada preset.
 */
function buildThumbnailOptions(videoId, thumbnails = []) {
  const normalized = thumbnails
    .filter((thumb) => thumb && thumb.url)
    .map((thumb) => ({
      url: thumb.url,
      width: Number(thumb.width) || 0,
      height: Number(thumb.height) || 0
    }))
    .sort((a, b) => (a.width * a.height) - (b.width * b.height));

  return THUMBNAIL_PRESETS.map((preset) => {
    const exact = normalized.find((thumb) => thumb.width >= preset.width && thumb.height >= preset.height);
    const fallback = normalized[normalized.length - 1] || null;
    const chosen = exact || fallback;

    return {
      key: preset.key,
      label: preset.label,
      width: preset.width,
      height: preset.height,
      available: Boolean(exact || (videoId && preset.key !== 'hd')),
      url: exact?.url || getFallbackThumbnailUrl(videoId, preset.key) || fallback?.url || null
    };
  });
}

/**
 * normalizeVideoQualities(formats)
 * Extrae alturas únicas (p) de `formats` provistos por yt-dlp y retorna
 * un array ordenado con `value` y `label` que consume el frontend.
 */
function normalizeVideoQualities(formats = []) {
  const seen = new Set();
  const heights = [];

  formats.forEach((format) => {
    const hasVideo = format && format.vcodec && format.vcodec !== 'none';
    const height = Number(format?.height);

    if (!hasVideo || !Number.isFinite(height) || height <= 0 || seen.has(height)) {
      return;
    }

    seen.add(height);
    heights.push(height);
  });

  heights.sort((a, b) => a - b);

  return heights.map((height) => ({
    value: String(height),
    height,
    label:
      height === 720 ? '720p (HD)' :
      height === 1080 ? '1080p (FHD)' :
      `${height}p`
  }));
}

/**
 * extractMediaInfo(json)
 * A partir del JSON que devuelve `yt-dlp --dump-single-json`, construye un
 * objeto con: id, title, channel, duración, opciones de video y miniaturas.
 */
function extractMediaInfo(json) {
  const videoId = json.id || getVideoId(json.webpage_url || json.original_url || '');
  const thumbnailOptions = buildThumbnailOptions(videoId, json.thumbnails || []);
  const availableThumbnail = thumbnailOptions.find((option) => option.available && option.url) || thumbnailOptions[0] || null;

  return {
    id: videoId,
    title: json.title || 'Video de YouTube',
    channel: json.channel || json.uploader || 'Canal desconocido',
    duration: Number(json.duration) || 0,
    durationText: formatDuration(Number(json.duration) || 0),
    videoQualities: normalizeVideoQualities(json.formats || []),
    thumbnailOptions,
    thumbnailPreviewUrl: availableThumbnail?.url || null
  };
}

/**
 * runYtDlp(args)
 * Ejecuta `yt-dlp` con los argumentos dados y recoge `stdout`/`stderr`.
 * Retorna un objeto { code, stdout, stderr } cuando el proceso termina.
 */
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * createAudioArgs(url, outputTemplate, bitrate)
 * Construye el array de argumentos para `yt-dlp` cuando se solicita audio.
 */
function createAudioArgs(url, outputTemplate, bitrate, audioFormat = 'mp3') {
  const format = ['m4a', 'mp3'].includes(String(audioFormat).toLowerCase())
    ? String(audioFormat).toLowerCase()
    : 'mp3';

  return [
    '--no-playlist',
    '-x',
    '--audio-format', format,
    '--audio-quality', `${bitrate}K`,
    '--newline',
    '--progress',
    '--no-color',
    '-o', outputTemplate,
    url
  ];
}

/**
 * createVideoArgs(url, outputTemplate, resolution)
 * Construye el selector de formatos para `yt-dlp` según la resolución
 * deseada y genera la lista de argumentos para descargar y unir streams.
 */
function createVideoArgs(url, outputTemplate, resolution) {
  const formatSelector = resolution === 'max'
    ? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'
    : `bestvideo[height<=${resolution}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${resolution}]+bestaudio/best[height<=${resolution}]`;

  return [
    '--no-playlist',
    '-f', formatSelector,
    '--merge-output-format', 'mp4',
    '--newline',
    '--progress',
    '--no-color',
    '-o', outputTemplate,
    url
  ];
}

function getThumbnailExtension(selection) {
  const source = selection?.url || '';
  if (/\.png($|\?)/i.test(source)) return 'png';
  return 'jpg';
}

function downloadFile(url, destination, onRequest) {
  return new Promise((resolve, reject) => {
    const requestUrl = (targetUrl) => {
    /**
     * downloadFile(url, destination, onRequest)
     * Descarga un recurso HTTP(S) y lo escribe en `destination`.
     * Soporta redirecciones 3xx y expone el request vía `onRequest` para poder
     * cancelar la descarga desde el exterior.
     */
    const request = https.get(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          requestUrl(new URL(response.headers.location, targetUrl).toString());
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`No se pudo descargar la miniatura (${response.statusCode})`));
          return;
        }

        const file = fs.createWriteStream(destination);
        response.pipe(file);

        file.on('finish', () => {
          file.close(resolve);
        });

        file.on('error', (error) => {
          fs.unlink(destination, () => reject(error));
        });
      });

      onRequest(request);
      request.on('error', reject);
    };

    requestUrl(url);
  });
}

async function downloadThumbnailAsset({
  queueUrl,
  baseName,
  selection,
  socket,
  suffix = ''
}) {
  /**
   * downloadThumbnailAsset({ queueUrl, baseName, selection, socket, suffix })
   * Descarga la miniatura seleccionada y la guarda en `downloads` usando
   * `baseName` + `suffix`. Emite progreso a través del socket.
   */
  if (!selection?.url) {
    throw new Error('No hay una miniatura disponible para descargar.');
  }

  socket.emit('progress', { url: queueUrl, percent: 15 });

  const extension = getThumbnailExtension(selection);
  const fileName = `${baseName}${suffix}.${extension}`;
  const destination = path.join(DOWNLOAD_DIR, fileName);
  let requestHandle = null;

  activeDownloads.set(queueUrl, {
    type: 'request',
    destroy: () => requestHandle?.destroy()
  });

  await downloadFile(selection.url, destination, (request) => {
    requestHandle = request;
  });

  if (cancelledDownloads.has(queueUrl)) {
    cancelledDownloads.delete(queueUrl);
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    return null;
  }

  activeDownloads.delete(queueUrl);
  socket.emit('progress', { url: queueUrl, percent: 100 });
  return fileName;
}

function emitProgressFromStdout(text, url, socket) {
  /**
   * emitProgressFromStdout(text, url, socket)
   * Extrae porcentajes del texto de salida de procesos (ej: ffmpeg/yt-dlp)
   * y emite eventos `progress` por socket para actualizar la UI.
   */
  const match = text.match(/(\d+(?:\.\d+)?)%/);
  if (match) {
    socket.emit('progress', { url, percent: parseFloat(match[1]) });
  }
}

async function inspectAudioCodec(filePath) {
  /**
   * inspectAudioCodec(filePath)
   * Ejecuta `ffmpeg -i <file>` y analiza la salida para detectar el códec
   * de audio que contiene el archivo. Retorna el nombre del códec en minúsculas
   * o `null` si no se pudo determinar.
   */
  return new Promise((resolve) => {
    try {
      const ff = spawn('ffmpeg', ['-i', filePath]);
      let stderr = '';
      ff.stderr.on('data', (d) => { stderr += d.toString(); });
      ff.on('close', () => {
        const match = stderr.match(/Audio:\s*([^,\s]+)/i);
        resolve(match ? String(match[1]).toLowerCase() : null);
      });
      ff.on('error', () => resolve(null));
    } catch (e) {
      resolve(null);
    }
  });
}

function reencodeAudioToAac(baseName, primaryExt, socket, url) {
  /**
   * reencodeAudioToAac(baseName, primaryExt, socket, url)
   * Re-encodea el archivo de salida conservando el video (`-c:v copy`) y
   * convirtiendo el audio a `aac` con bitrate constante. Emite progreso
   * extraído de la salida de `ffmpeg`.
   */
  return new Promise((resolve, reject) => {
    const origPath = path.join(DOWNLOAD_DIR, `${baseName}.${primaryExt}`);
    const tmpName = `${baseName}.reencoded.${primaryExt}`;
    const tmpPath = path.join(DOWNLOAD_DIR, tmpName);

    const args = ['-i', origPath, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', tmpPath, '-y'];
    const ff = spawn('ffmpeg', args);

    ff.stderr.on('data', (data) => {
      try {
        emitProgressFromStdout(data.toString(), url, socket);
      } catch (e) {}
    });

    ff.on('error', (err) => {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      reject(err);
    });

    ff.on('close', (code) => {
      if (code !== 0) {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        return reject(new Error('ffmpeg exited with code ' + code));
      }

      try {
        if (fs.existsSync(origPath)) fs.unlinkSync(origPath);
        fs.renameSync(tmpPath, origPath);
        resolve(`${baseName}.${primaryExt}`);
      } catch (e) {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        reject(e);
      }
    });
  });
}

function executeYtDlpDownload(queueItem, socket) {
    /**
     * executeYtDlpDownload(queueItem, socket)
     * Ejecuta la descarga de un item con `yt-dlp`. Dependiendo del `mode`
     * construye args de audio/video, mide progreso, y al finalizar puede
     * descargar miniatura adicional o re-encodear audio si el códec es Opus.
     */
  const {
    url,
    title,
    mode = 'audio',
    qualityValue = 'max',
    includeThumbnail = false,
    thumbnailSelection = null
  } = queueItem;

  const safeTitle = sanitizeTitle(title);
  const primaryExt = getPrimaryExtension(mode, queueItem.audioFormat);
  const baseName = getAvailableBaseName(safeTitle, primaryExt);
  const outputTemplate = path.join('downloads', `${baseName}.%(ext)s`);

  const args = mode === 'video'
    ? createVideoArgs(url, outputTemplate, qualityValue)
    : createAudioArgs(url, outputTemplate, qualityValue || 320, queueItem.audioFormat);

  return new Promise((resolve) => {
    const yt = spawn('yt-dlp', args);
    activeDownloads.set(url, {
      type: 'process',
      destroy: () => yt.kill()
    });

    yt.stdout.on('data', (data) => {
      emitProgressFromStdout(data.toString(), url, socket);
    });

    yt.stderr.on('data', (data) => {
      emitProgressFromStdout(data.toString(), url, socket);
    });

    yt.on('error', (error) => {
      activeDownloads.delete(url);
      socket.emit('error', {
        url,
        message: error?.message || 'No se pudo iniciar yt-dlp. Verifica que yt-dlp esté instalado y accesible.'
      });
      resolve();
    });

    yt.on('close', async (code) => {
      activeDownloads.delete(url);

      if (cancelledDownloads.has(url)) {
        cancelledDownloads.delete(url);
        resolve();
        return;
      }

      if (code !== 0) {
        socket.emit('error', { url, message: `No se pudo completar la descarga (${mode}).` });
        resolve();
        return;
      }

      let extraFileName = null;

      try {
        if (mode === 'video' && includeThumbnail && thumbnailSelection?.url) {
          socket.emit('progress', { url, percent: 97 });
          extraFileName = await downloadThumbnailAsset({
            queueUrl: url,
            baseName,
            selection: thumbnailSelection,
            socket,
            suffix: '-thumb'
          });
        }
      } catch (error) {
        socket.emit('error', { url, message: error.message || 'Se descargó el video, pero falló la miniatura.' });
        socket.emit('done', { url, fileName: `${baseName}.${primaryExt}`, extraFileName: null });
        resolve();
        return;
      }

      // Si el modo es video, comprobar el códec de audio y re-encodear si es Opus
      try {
        if (mode === 'video') {
          const outPath = path.join(DOWNLOAD_DIR, `${baseName}.${primaryExt}`);
          if (fs.existsSync(outPath)) {
            const codec = await inspectAudioCodec(outPath);
            if (codec === 'opus') {
              socket.emit('progress', { url, percent: 95 });
              try {
                await reencodeAudioToAac(baseName, primaryExt, socket, url);
              } catch (e) {
                socket.emit('error', { url, message: `Fallo en la conversión automática: ${e.message || e}` });
              }
            }
          }
        }
      } catch (e) {
        // no bloquear la finalización si la inspección/conversión falla
      }

      socket.emit('done', {
        url,
        fileName: `${baseName}.${primaryExt}`,
        extraFileName
      });
      resolve();
    });
  });
}

async function processQueue() {
    /**
     * processQueue
     * Procesa la cola de descargas en `downloadQueue` de forma secuencial.
     * Soporta descarga de thumbnails via `downloadThumbnailAsset` o
     * descargas complejas mediante `executeYtDlpDownload`.
     */
  if (isProcessingQueue || downloadQueue.length === 0) return;
  isProcessingQueue = true;

  const queueItem = downloadQueue.shift();
  const { socket, payload } = queueItem;

  try {
    if (payload.mode === 'thumbnail') {
      const safeTitle = sanitizeTitle(payload.title);
      const baseName = getAvailableBaseName(safeTitle, 'jpg');
      const fileName = await downloadThumbnailAsset({
        queueUrl: payload.url,
        baseName,
        selection: payload.thumbnailSelection,
        socket
      });

      if (!cancelledDownloads.has(payload.url) && fileName) {
        socket.emit('done', { url: payload.url, fileName });
      } else {
        cancelledDownloads.delete(payload.url);
      }
    } else {
      await executeYtDlpDownload(payload, socket);
    }
  } catch (error) {
    if (!cancelledDownloads.has(payload.url)) {
      socket.emit('error', {
        url: payload.url,
        message: error.message || 'La descarga falló.'
      });
    } else {
      cancelledDownloads.delete(payload.url);
    }
  } finally {
    activeDownloads.delete(payload.url);
    isProcessingQueue = false;
    processQueue();
  }
}

io.on('connection', (socket) => {
  console.log('Cliente conectado');

  socket.on('search-youtube', async (data) => {
    const { query, count = 5 } = data;

    try {
      const result = await runYtDlp([
        `ytsearch${count}:${query}`,
        '--dump-single-json',
        '--no-warnings',
        '--no-color',
        '--flat-playlist'
      ]);

      if (result.code !== 0) {
        socket.emit('search-error', { message: 'No se pudo realizar la búsqueda.' });
        return;
      }

      const json = JSON.parse(result.stdout);
      const results = (json.entries || []).map((entry) => ({
        url: `https://www.youtube.com/watch?v=${entry.id}`,
        title: entry.title,
        id: entry.id,
        thumb: `https://img.youtube.com/vi/${entry.id}/mqdefault.jpg`
      }));
      socket.emit('search-results', results);
    } catch (error) {
      socket.emit('search-error', { message: error?.message || 'No se pudo realizar la búsqueda.' });
    }
  });

  socket.on('get-playlist-info', async (url) => {
    try {
      const result = await runYtDlp([
        '--dump-single-json',
        '--no-warnings',
        '--no-color',
        '--flat-playlist',
        url
      ]);

      if (result.code !== 0) {
        socket.emit('error', { url, message: 'No se pudo obtener la información de la playlist.' });
        return;
      }

      const json = JSON.parse(result.stdout);
      const items = (json.entries || []).map((entry) => ({
        url: entry.url?.startsWith('http') ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`,
        title: entry.title,
        id: entry.id
      }));

      socket.emit('playlist-info', {
        url,
        items,
        title: json.title,
        id: json.id
      });
    } catch (error) {
      socket.emit('error', { url, message: error?.message || 'Error al procesar la playlist.' });
    }
  });

  socket.on('get-media-info', async ({ url }) => {
    try {
      const result = await runYtDlp([
        '--dump-single-json',
        '--no-playlist',
        '--no-warnings',
        '--no-color',
        url
      ]);

      if (result.code !== 0) {
        socket.emit('media-info-error', { url, message: 'No se pudo obtener la información del video.' });
        return;
      }

      const json = JSON.parse(result.stdout);
      socket.emit('media-info', {
        url,
        info: extractMediaInfo(json)
      });
    } catch (error) {
      socket.emit('media-info-error', { url, message: error?.message || 'No se pudo interpretar la metadata del video.' });
    }
  });

  socket.on('download', (payload) => {
    const { url } = payload;

    if (activeDownloads.has(url) || downloadQueue.some((entry) => entry.payload.url === url)) {
      return;
    }

    downloadQueue.push({ socket, payload });
    processQueue();
  });

  socket.on('cancel-download', (url) => {
    const queueIndex = downloadQueue.findIndex((entry) => entry.payload.url === url);
    if (queueIndex !== -1) {
      downloadQueue.splice(queueIndex, 1);
      socket.emit('error', { url, message: 'Descarga cancelada (en cola).' });
      return;
    }

    const active = activeDownloads.get(url);
    if (active) {
      cancelledDownloads.add(url);
      active.destroy();
      activeDownloads.delete(url);
      socket.emit('error', { url, message: 'Descarga cancelada.' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
});

server.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});
