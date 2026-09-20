import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const denied = () => Object.assign(new Error('Image source is not allowed'), { status: 400 });
const contained = (directory, file) => file.startsWith(`${directory}${path.sep}`);

// Use public IPv4 destinations only and pin the DNS result for the actual request.
// This avoids DNS rebinding and IPv4-mapped IPv6 bypasses without another dependency.
export function isPublicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

export async function resolveImageSource(imageUrl, { sourceImagesDir, products = [] }) {
  if (typeof imageUrl !== 'string' || !imageUrl || imageUrl.length > 4096 || /[\x00-\x1f\\]/.test(imageUrl)) throw denied();
  if (imageUrl.startsWith('/uploads/images/')) {
    let relative;
    try { relative = decodeURIComponent(imageUrl.slice('/uploads/images/'.length)); } catch { throw denied(); }
    if (!relative || /[\x00-\x1f\\]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') || !/\.(?:jpe?g|png|webp|gif)$/i.test(relative)) throw denied();
    const root = await fs.realpath(sourceImagesDir);
    const candidate = path.resolve(root, relative);
    if (!contained(root, candidate)) throw denied();
    const file = await fs.realpath(candidate);
    if (!contained(root, file) || !/\.(?:jpe?g|png|webp|gif)$/i.test(file)) throw denied();
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw denied();
    return { type: 'local', file };
  }
  // Legacy remote catalog images remain supported, but /img is not an open proxy.
  if (!products.some(product => product.image === imageUrl)) throw denied();
  let url;
  try { url = new URL(imageUrl); } catch { throw denied(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.port || url.hostname.startsWith('[')) throw denied();
  return { type: 'remote', url };
}

export async function readImageSource(source, { lookup = dns.lookup } = {}) {
  if (source.type === 'local') return fs.readFile(source.file);
  const records = await lookup(source.url.hostname, { family: 4, all: true });
  if (!records.length || records.some(record => !isPublicIPv4(record.address))) throw denied();
  const address = records[0].address;
  return new Promise((resolve, reject) => {
    const request = (source.url.protocol === 'https:' ? https : http).get(source.url, {
      headers: { 'user-agent': 'Mobile Order Images', accept: 'image/*' },
      lookup: (_hostname, options, callback) => callback(null, options?.all ? [{ address, family: 4 }] : address, 4)
    }, response => {
      // Never follow redirects to an unvalidated destination or pass HTML through.
      if (response.statusCode !== 200 || !/^image\/(?:jpeg|png|gif|webp|avif|bmp|tiff)(?:;|$)/i.test(response.headers['content-type'] || '') || Number(response.headers['content-length'] || 0) > MAX_IMAGE_BYTES) {
        response.destroy(); request.destroy(new Error('Image fetch failed')); return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_IMAGE_BYTES) { request.destroy(new Error('Image too large')); return; }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => resolve(Buffer.concat(chunks)));
    });
    const timeout = setTimeout(() => request.destroy(new Error('Image fetch timed out')), 10_000);
    timeout.unref();
    request.once('error', reject);
    request.once('close', () => clearTimeout(timeout));
  });
}
