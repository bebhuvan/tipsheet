import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve('dist');
const siteHosts = new Set(['tipsheet.markets', 'www.tipsheet.markets']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (path.endsWith('.html')) out.push(path);
  }
  return out;
}

function targetExists(pathname) {
  const clean = decodeURIComponent(pathname).replace(/\/+$/, '') || '/';
  if (clean === '/') return existsSync(join(dist, 'index.html'));

  const relative = clean.slice(1);
  if (relative.includes('.') && existsSync(join(dist, relative))) return true;
  if (existsSync(join(dist, relative, 'index.html'))) return true;
  if (existsSync(join(dist, `${relative}.html`))) return true;
  return false;
}

function internalPath(rawHref) {
  rawHref = String(rawHref)
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&');

  if (!rawHref || rawHref.startsWith('#')) return null;
  if (/^(mailto|tel|javascript):/i.test(rawHref)) return null;
  if (rawHref.startsWith('/api/')) return null;

  if (rawHref.startsWith('/')) {
    return rawHref.split(/[?#]/)[0] || '/';
  }

  try {
    const url = new URL(rawHref);
    if (!siteHosts.has(url.hostname)) return null;
    if (url.pathname.startsWith('/api/')) return null;
    return url.pathname || '/';
  } catch {
    return null;
  }
}

if (!existsSync(dist)) {
  console.error('[links] dist/ does not exist. Run npm run build first.');
  process.exit(1);
}

const failures = [];
for (const file of walk(dist)) {
  const html = readFileSync(file, 'utf8');
  const matches = html.matchAll(/\s(?:href|src)=["']([^"']+)["']/g);
  for (const match of matches) {
    const pathname = internalPath(match[1]);
    if (!pathname) continue;
    if (!targetExists(pathname)) {
      failures.push(`${file.replace(`${dist}/`, '')}: ${match[1]}`);
    }
  }
}

if (failures.length) {
  console.error(`[links] ${failures.length} broken internal links:`);
  for (const failure of failures.slice(0, 100)) console.error(`  ${failure}`);
  if (failures.length > 100) console.error(`  ...and ${failures.length - 100} more`);
  process.exit(1);
}

console.log('[links] ok');
