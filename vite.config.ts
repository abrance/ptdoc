import { defineConfig, loadEnv } from 'vite';
import { uploadMiddleware } from './src/server/upload-api';
import { apiMiddleware } from './src/server/api';
import { initQiniu } from './src/server/qiniu-uploader';
import { initDB } from './src/server/db';

// 在配置加载阶段读取 .env，初始化七牛（图床仅在 Node 服务端使用）与 SQLite。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  initQiniu(env);
  initDB();

  // 监听 0.0.0.0：局域网 / 容器内均可访问（页面与自定义 API 一起生效）。
  // 端口可用环境变量覆盖，不设时回落到默认值。
  const devPort = Number(process.env.PORT ?? 5173);
  const previewPort = Number(process.env.PREVIEW_PORT ?? 4173);

  return {
    root: '.',
    publicDir: 'public',
    server: { host: '0.0.0.0', port: devPort },
    preview: { host: '0.0.0.0', port: previewPort },
    plugins: [
      {
        name: 'ptdoc-server-api',
        configureServer(server) {
          server.middlewares.use(uploadMiddleware());
          server.middlewares.use(apiMiddleware());
        },
        configurePreviewServer(server) {
          server.middlewares.use(uploadMiddleware());
          server.middlewares.use(apiMiddleware());
        },
      },
    ],
  };
});
