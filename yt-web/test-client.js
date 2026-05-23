const io = require('socket.io-client');

const SERVER = process.env.SERVER_URL || 'http://localhost:3001';
const socket = io(SERVER, { reconnectionAttempts: 5, timeout: 10000 });

const videoUrl = 'https://www.youtube.com/watch?v=NCtzkaL2t_Y';

socket.on('connect', () => {
  console.log('Connected to server');
  const payload = {
    url: videoUrl,
    title: 'Test download',
    mode: 'video',
    qualityValue: 'max',
    includeThumbnail: false,
    thumbnailSelection: null
  };
  console.log('Emitting download for', videoUrl);
  socket.emit('download', payload);
});

socket.on('progress', (data) => {
  console.log('PROGRESS', data);
});

socket.on('done', (data) => {
  console.log('DONE', data);
  socket.close();
  process.exit(0);
});

socket.on('error', (data) => {
  console.error('ERROR', data);
});

socket.on('connect_error', (err) => {
  console.error('connect_error', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('Timeout waiting for download');
  process.exit(2);
}, 1000 * 60 * 5); // 5 min timeout
