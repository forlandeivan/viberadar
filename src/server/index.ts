import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { ScanResult } from '../scanner';

interface ServerOptions {
  data: ScanResult;
  port: number;
  projectRoot: string;
}

const DASHBOARD_HTML = fs.readFileSync(
  path.join(__dirname, '../ui/dashboard.html'),
  'utf-8'
);

export function startServer({ data, port, projectRoot }: ServerOptions): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';

      if (url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;
      }

      if (url === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Is VibeRadar already running?`));
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n👋 VibeRadar stopped.');
      server.close(() => process.exit(0));
    });
  });
}
