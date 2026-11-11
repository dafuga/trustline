import type { Env as WorkerEnv } from '../src/index.types';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof import('../src/index');
      durableNamespaces: 'Channel';
    }
  }
}
