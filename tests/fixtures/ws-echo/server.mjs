#!/usr/bin/env node
// Serves index.html and echoes short WebSocket text frames on the same port.
//   node server.mjs <port>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';

const port = Number(process.argv[2]);
const page = readFileSync(new URL('./index.html', import.meta.url));
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(page);
});
server.on('upgrade', (request, socket) => {
  const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (frame) => {
    const length = frame[1] & 127;
    const mask = frame.subarray(2, 6);
    const text = Buffer.from(frame.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4])).toString();
    const reply = Buffer.from(`server got ${text}`);
    socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
  });
});
server.listen(port, '127.0.0.1');
