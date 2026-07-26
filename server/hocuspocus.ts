import { Hocuspocus } from '@hocuspocus/server'
import { createPool } from './db/pool'
import { bootstrapSchema, createPostgresStore } from './db/store'
import { createPersistenceExtension } from './db/persistenceExtension'
import { createIngressExtension, type IngressOptions } from './db/ingressExtension'

export interface ScrollServerOptions {
  port: number
  quiet?: boolean
  databaseUrl?: string
  maxUpdateBytes?: number
  authenticate?: IngressOptions['authenticate']
  // Compaction (onStoreDocument) debounce cadence — Hocuspocus defaults 2000/10000ms. Exposed so a
  // durability harness can push it past the test window and prove recovery from the append log alone
  // (snapshot stays null), isolating persist-before-broadcast from snapshot-masking.
  debounce?: number
  maxDebounce?: number
}

// P3.4: persist-before-broadcast durable store. Ingress hook appends every update to Postgres before
// MessageReceiver applies/broadcasts it (see db/persistenceExtension.ts). P3.5: the compaction
// transaction is owner_epoch-fenced at the store (latent at single-owner localhost). P3.6: the ingress
// guard (size/malformed refuse-and-resync + contract-7 onAuthenticate seam) runs FIRST so a refusal
// short-circuits before the durable append.
export async function createScrollServer(opts: ScrollServerOptions): Promise<Hocuspocus> {
  const pool = createPool(opts.databaseUrl)
  await bootstrapSchema(pool)

  return new Hocuspocus({
    port: opts.port,
    quiet: opts.quiet ?? true,
    ...(opts.debounce !== undefined ? { debounce: opts.debounce } : {}),
    ...(opts.maxDebounce !== undefined ? { maxDebounce: opts.maxDebounce } : {}),
    extensions: [
      createIngressExtension({ maxUpdateBytes: opts.maxUpdateBytes, authenticate: opts.authenticate }),
      createPersistenceExtension(createPostgresStore(pool)),
      // Hocuspocus registers its own process-wide SIGINT/SIGTERM/SIGQUIT handler on every listen()
      // call and never removes it (even after destroy()) — in a test run that creates many servers,
      // one real termination signal fires all of them, each re-destroying its own already-destroyed
      // server. Guard so a second onDestroy for the same pool is a no-op instead of pg-pool's "Called
      // end on pool more than once" throw.
      { async onDestroy() { if (!pool.ended) await pool.end() } },
    ],
  })
}

export async function startScrollServer(opts: ScrollServerOptions): Promise<Hocuspocus> {
  const server = await createScrollServer(opts)
  await server.listen()
  return server
}
