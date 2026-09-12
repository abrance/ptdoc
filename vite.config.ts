import { defineConfig, loadEnv } from 'vite';
import { uploadMiddleware } from './src/server/upload-api';
import { apiMiddleware } from './src/server/api';
import { authApiMiddleware } from './src/server/auth-api';
import { initDB } from './src/server/db';
import { loadServerEnv } from './src/server/env';
import { agentApiMiddleware } from './src/server/agent-api';
import { initAgentRuntime } from './src/server/agent-runtime';

function bootServer(env: Record<string, string | undefined>): void {
  loadServerEnv({ ...process.env, ...env });
  initDB();
  void initAgentRuntime();
}

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
      // 关闭 Host 白名单校验：正式环境经任意域名/反向代理访问，不限制来源 Host。
      allowedHosts: true,
    },
    preview: {
      host: '0.0.0.0',
      port: previewPort,
      allowedHosts: true,
    },
    plugins: [
      {
        name: 'ptdoc-server-api',
        configureServer(server) {
          server.middlewares.use(authApiMiddleware());
          server.middlewares.use(agentApiMiddleware());
          server.middlewares.use(uploadMiddleware());
          server.middlewares.use(apiMiddleware());
        },
        configurePreviewServer(server) {
          bootServer(env);
          server.middlewares.use(authApiMiddleware());
          server.middlewares.use(agentApiMiddleware());
          server.middlewares.use(uploadMiddleware());
          server.middlewares.use(apiMiddleware());
        },
      },
    ],
  };
});
