import { Hocuspocus } from '@hocuspocus/server'
import { createPool } from './db/pool'
import { bootstrapSchema, createPostgresStore } from './db/store'
import { createPersistenceExtension } from './db/persistenceExtension'
import { createIngressExtension, type IngressOptions } from './db/ingressExtension'
import { createProposeCommitExtension, type ProposalGuard } from './db/proposeCommit'

export interface ScrollServerOptions {
  port: number
  quiet?: boolean
  databaseUrl?: string
  maxUpdateBytes?: number
  authenticate?: IngressOptions['authenticate']
  // contract-1 propose/commit apply-time guard (spatial/pinned/lease). Injected so the capability stays
  // generic; default allows every proposal (the concrete predicate lands with the P6 doc model).
  proposalGuard?: ProposalGuard
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
// short-circuits before the durable append. P4.3: propose/commit (onStateless) is the op-grain path —
// a proposal is checked at apply time and committed (persist-before-apply) or refused without teardown.
export async function createScrollServer(opts: ScrollServerOptions): Promise<Hocuspocus> {
  const pool = createPool(opts.databaseUrl)
  await bootstrapSchema(pool)
  const store = createPostgresStore(pool)
  const persistence = createPersistenceExtension(store)

  return new Hocuspocus({
    port: opts.port,
    quiet: opts.quiet ?? true,
    ...(opts.debounce !== undefined ? { debounce: opts.debounce } : {}),
    ...(opts.maxDebounce !== undefined ? { maxDebounce: opts.maxDebounce } : {}),
    extensions: [
      createIngressExtension({ maxUpdateBytes: opts.maxUpdateBytes, authenticate: opts.authenticate }),
      persistence.extension,
      createProposeCommitExtension(persistence.commitProposal, { guard: opts.proposalGuard, maxUpdateBytes: opts.maxUpdateBytes }),
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
