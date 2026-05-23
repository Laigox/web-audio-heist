# YT Audio Heist

YT Audio Heist es una app web para gestionar links de YouTube, armar una lista de descargas y bajar contenido con `yt-dlp` desde una interfaz visual. El proyecto está hecho con frontend vanilla (`HTML`, `CSS`, `JS`) y backend en `Node.js` con `Express` y `Socket.IO`.

La idea principal es que el usuario no tenga que pelearse todo el tiempo con comandos largos de terminal: la app permite buscar videos, agregar URLs manualmente, revisar la lista, elegir calidad por item y lanzar descargas desde la propia página.

## Estado actual

La página está en **v2.0.1** (Detalles de la ultima actualizacion en el archivo [CHANGES.md]).

La v2 amplía la app para trabajar con:

- `Audio`
- `Video`
- `Miniaturas`

Además agrega selección de calidad por item, controles globales y una UI más flexible para playlists y previews.

## Qué hacía la v1

Antes de la v2, la app estaba enfocada casi por completo en **descargar audio en MP3**.

La v1 incluía principalmente:

- Agregar links manualmente
- Buscar videos en YouTube desde la interfaz
- Detectar playlists y agregarlas a la lista
- Ver el progreso de descarga
- Descargar por item o por lote
- Cancelar descargas
- Historial básico con `undo` y `redo`
- Generación visual del comando para descargar audio

En otras palabras: la v1 funcionaba bien como una herramienta para pasar contenido de YouTube a MP3, pero todavía no estaba pensada como una interfaz multi-formato.

## Qué cambia en la v2

La v2 convierte YT Audio Heist (ahora YT Heist) en una app más completa y más cercana a un pequeño gestor de descargas multimedia.

### Cambios principales

- Selector global de modo:
  - `🎵 Audio`
  - `🎬 Video`
  - `🖼 Miniatura`
- Calidad individual por item según el modo activo
- Obtención de metadata real del video para mostrar:
  - canal
  - duración
  - resoluciones disponibles
  - miniaturas disponibles
- Descarga de video en `MP4`
- Descarga de miniaturas como archivo independiente
- Opción en modo video para descargar `con` o `sin` miniatura adicional
- Botón de calidad global para aplicar cambios masivos a la lista
- Preview embebido para items de audio
- Nuevas variantes visuales de tarjetas según el modo

### Resumen v1 vs v2

| Área | v1 | v2 |
|---|---|---|
| Modos | Solo audio | Audio, video y miniatura |
| Calidad | Básica y centrada en audio | Calidad por item según el modo |
| Video | No | Sí, con resolución por item |
| Miniaturas | Solo visuales | Descarga real de miniaturas |
| Metadata | Limitada | Canal, duración, resoluciones y thumbnails |
| UI de tarjetas | Compacta | Cambia según el modo activo |
| Descarga por lote | Sí | Sí, con control de calidad más granular |

## Funcionalidades actuales

### 1. Búsqueda y agregado

- Buscar en YouTube desde la barra superior
- Agregar links manualmente
- Soporte para links de video y playlists

### 2. Lista de items

- Vista central con todos los items agregados
- Reordenamiento lógico entre videos y playlists
- Expansión de playlists para controlar sus sub-items

### 3. Modos de trabajo

#### Audio

- Descarga en `MP3`
- Selector de bitrate por item:
  - `96 Kbps`
  - `128 Kbps`
  - `256 Kbps`
  - `320 Kbps`

#### Video

- Descarga en `MP4`
- Selector de resolución por item según lo que el video realmente ofrece
- Opción para incluir miniatura adicional junto al video

#### Miniatura

- Descarga de miniaturas como archivo independiente
- Selector de tamaño visual:
  - `120x90`
  - `320x180`
  - `640x480`
  - `1280x720`
  - `1920x1080`

### 4. Calidad global

En modo `Audio` y `Video`, la app permite aplicar calidad masiva a toda la lista desde un menú global.

### 5. Descarga y progreso

- Descarga individual
- Descarga por lote
- Cancelación de descargas
- Barra de progreso por item

### 6. Historial básico

- `Ctrl + Z` para deshacer
- `Ctrl + Y` para rehacer

## Tecnologías usadas

### Frontend

- `HTML`
- `CSS`
- `JavaScript` vanilla

### Backend

- `Node.js`
- `Express`
- `Socket.IO`
- `yt-dlp`

### Dependencias externas del sistema

- `yt-dlp`
- `ffmpeg`

## Requisitos para usarlo en otro equipo

Antes de ejecutar el proyecto en otro computador, asegúrate de tener instalado:

### 1. Node.js

Recomendado: versión moderna LTS.

Verificar:

```bash
node -v
npm -v
```

### 2. yt-dlp

Instalación recomendada:

```bash
pip install yt-dlp
```

Verificar:

```bash
yt-dlp --version
```

### 3. ffmpeg

Necesario para:

- extraer audio a `MP3`
- fusionar audio y video en `MP4`

Verificar:

```bash
ffmpeg -version
```

## Instalación del proyecto

Desde la carpeta del repositorio:

```bash
cd yt-web
npm install
```

## Cómo ejecutar la app

Desde `yt-web`:

```bash
npm start
```

El servidor arranca por defecto en:

```text
http://localhost:3001
```

Luego abre esa URL en tu navegador.

## Cómo usar la página

### Flujo básico

1. Abre la app en el navegador.
2. Elige el modo:
   - `Audio`
   - `Video`
   - `Miniatura`
3. Busca un video en la barra superior o pega un link manualmente.
4. Agrega el video o playlist a la lista.
5. Ajusta la calidad de cada item.
6. Si estás en modo video, decide si quieres incluir miniatura adicional.
7. Descarga un item individual o toda la lista.

### Uso recomendado por modo

#### Si quieres música o audio

- Usa modo `Audio`
- Elige bitrate por item
- Descarga en MP3

#### Si quieres el video

- Usa modo `Video`
- Elige resolución
- Activa miniatura si quieres guardar también la portada

#### Si solo quieres la imagen del thumbnail

- Usa modo `Miniatura`
- Elige el tamaño
- Descarga la imagen directamente

## Dónde se guardan los archivos

Cuando la descarga se hace desde la interfaz de la app, el backend guarda los archivos en:

```text
yt-web/downloads/
```

Esto es importante porque en el modal de comando todavía se muestran comandos pensados para uso manual con salida en `~/Descargas/`, pero la descarga disparada desde la app usa la carpeta local `downloads` del proyecto.

## Estructura básica del proyecto

```text
MULTIMEDIA_DOWLOAD/
├─ README.md
└─ yt-web/
   ├─ server.js
   ├─ package.json
   ├─ downloads/
   └─ public/
      ├─ index.html
      └─ assets/
         ├─ script.js
         └─ style.css
```

## Detalles técnicos importantes

- El backend consulta metadata real de YouTube con `yt-dlp`
- La app usa `Socket.IO` para comunicar:
  - progreso
  - resultados de búsqueda
  - info de playlists
  - metadata de medios
  - estado de descargas
- Las resoluciones de video mostradas dependen de lo que YouTube ofrezca para cada video
- La descarga de miniaturas usa la mejor URL disponible detectada para ese contenido

## Problemas comunes

### La app abre pero no descarga

Revisa que `yt-dlp` y `ffmpeg` estén disponibles en el sistema:

```bash
yt-dlp --version
ffmpeg -version
```

### El puerto está ocupado

El proyecto usa por defecto el puerto `3001`.

Si quieres cambiarlo:

```bash
# PowerShell
$env:PORT=3010
npm start
```

```bash
# CMD
set PORT=3010
npm start
```

### No aparecen algunas resoluciones

Eso normalmente significa que ese video no ofrece esas variantes en YouTube. La v2 intenta mostrar solo las opciones reales detectadas.

## Objetivo de esta versión

La v2 busca que YT Heist deje de sentirse como una utilidad solo para MP3 y pase a ser una interfaz más completa para:

- coleccionar links
- revisar contenido
- elegir calidad
- descargar audio
- descargar video
- descargar miniaturas

## Nota final

Si alguien clona este proyecto para usarlo en su equipo, lo mínimo que necesita recordar es esto:

1. Instalar `Node.js`
2. Instalar `yt-dlp`
3. Instalar `ffmpeg`
4. Entrar a `yt-web`
5. Ejecutar `npm install`
6. Ejecutar `npm start`
7. Abrir `http://localhost:3001`

Con eso ya debería poder usar la app localmente.
