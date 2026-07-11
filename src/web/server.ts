import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectorConfig } from '../config.js';
import { validateRequest, writeProjectFiles, projectPaths, type NewProjectRequest } from './bootstrap.js';
import { deleteProject, listProjects, loadState, readLog, startJob } from './jobs.js';

/**
 * `connect web` — localhost-only project-factory UI (v1).
 * Single-user tool: binds 127.0.0.1, no auth, form values whitelisted in
 * bootstrap.ts. Serves one static page + a small JSON API polled by it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString('utf8');
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolvePromise(data));
    req.on('error', reject);
  });
}

const NAME_IN_PATH = /^\/api\/projects\/([a-z][a-z0-9-]{0,39})(\/log)?$/;

export function createWebServer(config: ConnectorConfig, connectorRoot: string): Server {
  return createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      json(res, 500, { error: (e as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(HERE, 'index.html'), 'utf8'));
      return;
    }

    if (req.method === 'GET' && url === '/api/projects') {
      json(res, 200, { projects: listProjects(config) });
      return;
    }

    if (req.method === 'POST' && url === '/api/projects') {
      const body = JSON.parse(await readBody(req)) as NewProjectRequest;
      const problems = validateRequest(body);
      if (!config.web.templateRepo) {
        problems.push('web.templateRepo chưa cấu hình trong connector.config.yaml');
      }
      if (problems.length > 0) {
        json(res, 400, { problems });
        return;
      }
      const existing = loadState(config, body.name);
      if (existing?.status === 'running') {
        json(res, 409, { problems: [`Project "${body.name}" đang có job chạy`] });
        return;
      }
      writeProjectFiles(config, body, projectPaths(config, body.name));
      const state = startJob(config, body, connectorRoot);
      json(res, 201, { state });
      return;
    }

    const m = NAME_IN_PATH.exec(url);
    if (req.method === 'DELETE' && m && !m[2]) {
      try {
        const result = await deleteProject(config, m[1]!);
        json(res, 200, result);
      } catch (e) {
        json(res, 409, { error: (e as Error).message });
      }
      return;
    }
    if (req.method === 'GET' && m) {
      const name = m[1]!;
      if (m[2]) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(readLog(config, name));
        return;
      }
      const state = loadState(config, name);
      if (!state) {
        json(res, 404, { error: 'not found' });
        return;
      }
      json(res, 200, { state });
      return;
    }

    json(res, 404, { error: 'not found' });
  }
}

export function startWebServer(config: ConnectorConfig, connectorRoot: string, port?: number): Server {
  const server = createWebServer(config, connectorRoot);
  server.listen(port ?? config.web.port, '127.0.0.1');
  return server;
}
