import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/** Open the TLS connection to Supabase while the bundle is still parsing. */
function supabasePreconnect(origin: string) {
  return {
    name: 'nosih-supabase-preconnect',
    transformIndexHtml(html: string) {
      if (!origin) return html;
      return {
        html,
        tags: [
          { tag: 'link', attrs: { rel: 'preconnect', href: origin, crossorigin: 'anonymous' }, injectTo: 'head-prepend' as const },
          { tag: 'link', attrs: { rel: 'dns-prefetch', href: origin }, injectTo: 'head-prepend' as const },
        ],
      };
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  let origin = '';
  try {
    origin = env.VITE_SUPABASE_URL ? new URL(env.VITE_SUPABASE_URL).origin : '';
  } catch {
    origin = '';
  }
  return {
    plugins: [react(), supabasePreconnect(origin)],
    server: { port: 5174, strictPort: true },
    preview: { port: 5174, strictPort: true },
    build: {
      target: 'es2022',
      sourcemap: true,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three', '@react-three/fiber', '@react-three/drei', '@react-three/postprocessing'],
            charts: ['recharts'],
          },
        },
      },
    },
  };
});
