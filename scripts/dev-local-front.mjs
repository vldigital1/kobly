// Front em modo local, apontando /api para a kobly-api do server/tools/dev-local.mjs (porta 4120).
//   node scripts/dev-local-front.mjs   → http://localhost:5173   (funciona a partir de qualquer pasta)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root); // o vite.config.js e o index.html ficam na raiz do projeto
process.env.VITE_API_PROXY = process.env.VITE_API_PROXY || 'http://127.0.0.1:4120';
const { createServer } = await import('vite');
const server = await createServer({ root, configFile: join(root, 'vite.config.js'), server: { port: 5173, strictPort: true } });
await server.listen();
server.printUrls();
