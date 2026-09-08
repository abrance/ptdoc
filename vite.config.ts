import { defineConfig, loadEnv } from 'vite';
import { uploadMiddleware } from './src/server/upload-api';
import { apiMiddleware } from './src/server/api';
import { authApiMiddleware } from './src/server/auth-api';
import { initDB } from './src/server/db';
import { loadServerEnv } from './src/server/env';

function bootServer(env: Record<string, string | undefined>): void {
  loadServerEnv({ ...process.env, ...env });
  initDB();
}

// 允许以这些 Host 访问（含子域名，前导点匹配任意子域）。正式环境经反向代理访问，
// Host 是真实域名；未列入时 vite 会返回 "Blocked request. This host is not allowed"。
const ALLOWED_HOSTS = ['.xiaoyxq.top', '.monkeycode-ai.online'];

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (command === 'serve') bootServer(env);

  const devPort = Number(process.env.PORT ?? 5173);
  const previewPort = Number(process.env.PREVIEW_PORT ?? 4173);

  return {
    root: '.',
    publicDir: 'public',
    server: {
      host: '0.0.0.0',
      port: devPort,
      allowedHosts: ALLOWED_HOSTS,
    },
    preview: {
      host: '0.0.0.0',
      port: previewPort,
      allowedHosts: ALLOWED_HOSTS,
    },
    plugins: [
      {
        name: 'ptdoc-server-api',
        configureServer(server) {
          server.middlewares.use(authApiMiddleware());
          server.middlewares.use(uploadMiddleware());
          server.middlewares.use(apiMiddleware());
        },
        configurePreviewServer(server) {
          bootServer(env);
          server.middlewares.use(authApiMiddleware());
          server.middlewares.use(uploadMiddleware());
          server.middlewares.use(apiMiddleware());
        },
      },
    ],
  };
});
