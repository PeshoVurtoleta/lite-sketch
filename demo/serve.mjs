// @zakkster/lite-sketch -- demo static file server (repo-only dev artifact, NEVER shipped).
//
//   npm run demo:serve            (then open http://localhost:8040/)
//   node demo/serve.mjs [port]
//
// A zero-dependency Node http server (node:http + node:fs only). Its web root is the LiteSketch
// REPO ROOT, so the page at /demo/index.html and its `../Sketch.js` + `./kernels.mjs` imports all
// resolve from one origin. There is no dynamic route -- lite-sketch's demo drives the REAL shipped
// classes in the browser directly (no Node-side workload to hand over), so this server only serves
// static files and fails CLOSED on every bad path (null -> 404).
//
// Zero runtime deps ship: this file is a dev artifact, never in the tarball.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, sep, extname } from 'node:path';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(DEMO_DIR); // repo root -- so `../Sketch.js` from /demo resolves to /Sketch.js

/** The default port. Overridable via `node demo/serve.mjs [port]`. */
export const DEFAULT_PORT = 8040;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};

/** Resolve a URL path to a real file under ROOT, or null if it is malformed or escapes ROOT.
 *  decodeURIComponent throws URIError on a malformed percent-encoding (e.g. "/%" or "/%zz"); we
 *  catch it and fail CLOSED (null -> 404) rather than let it crash the process. */
export function safePath(urlPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(urlPath);
    } catch {
        return null; // malformed percent-encoding -> fail closed
    }
    const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    const abs = join(ROOT, rel);
    if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null; // path traversal guard
    return abs;
}

/** The one-line request handler. Exported so a test can drive it without a socket. */
export async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    // "/" -> 302 REDIRECT to the page's real path (NOT an in-place serve). Serving the HTML at
    // "/" leaves the document base URL at "/", so the page's relative module imports
    // (../Sketch.js, ./kernels.mjs) would resolve wrong. Redirecting makes the browser re-request
    // /demo/index.html, so the base URL becomes /demo/ and every import resolves.
    if (url.pathname === '/') {
        res.writeHead(302, { location: '/demo/index.html' });
        res.end();
        return;
    }

    // Static files. A malformed path, a traversal escape, or a missing file all fail CLOSED
    // with a 404 -- never a throw that escapes the handler.
    const pathname = url.pathname;
    try {
        const abs = safePath(pathname);
        if (abs !== null) {
            const data = await readFile(abs);
            const type = MIME[extname(abs)] || 'application/octet-stream';
            res.writeHead(200, { 'content-type': type });
            res.end(data);
            return;
        }
    } catch {
        // fall through to the 404 below (missing file / read error)
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 ' + pathname);
}

/** Create (but do not start) the http server. The handler is async; a rejection from any
 *  unforeseen path is caught here and turned into a 500, so it can NEVER surface as an
 *  unhandled promise rejection that crashes the process. */
export function createServer() {
    return http.createServer((req, res) => {
        handle(req, res).catch((err) => {
            try {
                if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('500 ' + String((err && err.message) || err));
            } catch {
                /* the response is already gone -- nothing more to do */
            }
        });
    });
}

/** Start listening. Returns the server. */
export function start(port) {
    const server = createServer();
    server.listen(port, () => {
        process.stdout.write('lite-sketch demo server on http://localhost:' + port + '/\n');
        process.stdout.write('  page:  http://localhost:' + port + '/demo/index.html\n');
    });
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    start(Number(process.argv[2]) || DEFAULT_PORT);
}
