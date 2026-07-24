import type { Executor, ExecOutcome } from './grader'

export function createWorkerExecutor(): Executor {
  return (code, functionName, input, tleMs) =>
    new Promise<ExecOutcome>((resolve) => {
      const worker = new Worker(new URL('./executor.worker.ts', import.meta.url), { type: 'module' })
      const start = performance.now()
      let done = false
      const finish = (o: ExecOutcome) => {
        if (done) return
        done = true
        clearTimeout(timer)
        worker.terminate()
        resolve(o)
      }
      const timer = setTimeout(() => finish({ status: 'timeout' }), tleMs)
      worker.onmessage = (e: MessageEvent) => {
        const d = e.data as { status: string; stdout?: string; message?: string }
        if (d.status === 'ok') finish({ status: 'ok', stdout: d.stdout ?? '', ms: performance.now() - start })
        else finish({ status: 'error', message: d.message ?? 'error' })
      }
      worker.onerror = (e) => finish({ status: 'error', message: e.message || 'worker error' })
      worker.postMessage({ code, functionName, input })
    })
}
