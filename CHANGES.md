## v2.0.0 -> v2.0.1 - Audio pipeline update

### Cambios

- Corrección de errores en descargas de audio y video (mejor manejo de procesos `yt-dlp`).
- Mejor compatibilidad multimedia al detectar y reconvertir automáticamente audio Opus a AAC cuando es necesario.
- Cambio del formato de audio interno para mejorar compatibilidad:
  - Antes: `Opus`
  - Ahora: `AAC` (re-encode automático con `ffmpeg` cuando se detecta Opus)
- Manejo más robusto de `ffmpeg` y `yt-dlp` (captura de errores, emisión de progreso y limpieza de archivos temporales).
- Preview universal restaurado: el modal de preview usa ahora un `iframe` embebido para reproducir el video en todos los modos.
- El botón `Preview` está disponible ahora en los modos `audio`, `video` y `miniatura` cuando el item tiene un `videoId`.
- Mejoras en la gestión de la cola de descargas y cancelaciones (cola FIFO con control de descargas activas y destrucción de procesos o requests en curso).

### Otros cambios y mejoras implementadas (resumen)

- Añadido manejo de errores al spawn de `yt-dlp` para informar la UI si `yt-dlp` no está en PATH.
- Implementadas funciones en el backend:
  - `inspectAudioCodec(filePath)` para detectar códec de audio usando `ffmpeg`.
  - `reencodeAudioToAac(baseName, primaryExt, socket, url)` para reconvertir audio a AAC cuando corresponde.
- Mejoras en el frontend (`public/assets/script.js`):
  - `Preview` aparece en todos los modos.
  - Mejor control de metadata, renderizado de tarjetas y estado de descarga.
  - Comentarios y documentación en español añadidos en funciones clave.
- Comentarios y marcadores añadidos a `index.html`, `style.css`, `script.js` y `server.js` para facilitar mantenimiento y navegación del código.

### Notas de despliegue

- Asegúrate de tener `yt-dlp` y `ffmpeg` instalados y accesibles en el `PATH` del sistema.
- El servidor sigue usando por defecto el puerto `3001`.