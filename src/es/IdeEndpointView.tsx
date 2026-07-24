import { useEffect, useMemo, useRef, useState } from 'react'
import type * as Y from 'yjs'
import type { IdeEsSchema } from './schema'
import {
  endpointCode,
  readAttempts,
  readVerdict,
  recordVerdict,
} from './endpoint'
import { createWorkerExecutor } from './workerExecutor'
import { grade, matchesExpected, toResultPayload, type Verdict } from './grader'
import { setResult } from './registry'
import { resultUrl } from './factory'
import { notifyResult } from './notify'

type SampleRun = { name: string; ok: boolean; got: string }

const STATUS_LABEL: Record<Verdict['status'], string> = {
  pass: 'Accepted',
  fail: 'Wrong answer',
  tle: 'Time limit exceeded',
  error: 'Runtime error',
}

export function IdeEndpointView({ doc, id, schema }: { doc: Y.Doc; id: string; schema: IdeEsSchema }) {
  const codeText = useMemo(() => endpointCode(doc), [doc])
  const exec = useMemo(() => createWorkerExecutor(), [])
  const [code, setCode] = useState(() => codeText.toString())
  const [verdict, setVerdict] = useState<Verdict | null>(() => readVerdict(doc))
  const [attempts, setAttempts] = useState(() => readAttempts(doc))
  const [samples, setSamples] = useState<SampleRun[]>([])
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => void (mounted.current = false), [])

  const sampleTests = schema.tests.filter((t) => !t.hidden)
  const hiddenCount = schema.tests.length - sampleTests.length

  const write = (v: string) => {
    setCode(v)
    doc.transact(() => {
      codeText.delete(0, codeText.length)
      if (v) codeText.insert(0, v)
    })
  }

  const runSamples = async () => {
    setBusy(true)
    try {
      const out: SampleRun[] = []
      for (const t of sampleTests) {
        const o = await exec(code, schema.entry.functionName, t.input, schema.tleBudgetMs)
        const got =
          o.status === 'ok' ? o.stdout : o.status === 'timeout' ? '⏱ timed out' : `⚠ ${o.message}`
        out.push({ name: t.name ?? 'sample', ok: o.status === 'ok' && matchesExpected(got, t.expectedOutput), got })
      }
      if (mounted.current) setSamples(out)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const submit = async () => {
    setBusy(true)
    try {
      const v = await grade(id, schema, code, exec, Date.now())
      if (!mounted.current) return
      const payload = toResultPayload(v)
      recordVerdict(doc, v)
      setResult(id, payload)
      void notifyResult(schema, payload)
      setVerdict(v)
      setAttempts(readAttempts(doc))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const hints = (schema.hints ?? []).filter((h) => (h.afterFailedAttempts ?? 1) <= attempts)

  return (
    <div className="es-ide">
      <header className="es-topbar">
        <a className="es-back" href="#/es">
          ← Endpoints
        </a>
        <span className="es-title">{schema.title}</span>
        <span className="es-badge">ide-es</span>
      </header>
      <div className="es-cols">
        <section className="es-problem">
          <h2>Problem</h2>
          <p>{schema.problem}</p>
          <h3>Goal</h3>
          <p className="es-muted">{schema.goalCondition}</p>
          <h3>Budget</h3>
          <p className="es-muted">
            {schema.tleBudgetMs} ms / test{schema.complexityBudget ? ` · target ${schema.complexityBudget}` : ''}
          </p>
          <h3>Samples</h3>
          <ul className="es-tests">
            {sampleTests.map((t, i) => (
              <li key={i}>
                <code>{t.input.replace(/\n/g, '⏎')}</code> → <code>{t.expectedOutput}</code>
              </li>
            ))}
            <li className="es-muted">+ {hiddenCount} hidden</li>
          </ul>
          {hints.length > 0 && (
            <>
              <h3>Hints</h3>
              <ol className="es-hints">
                {hints.map((h, i) => (
                  <li key={i}>{h.text}</li>
                ))}
              </ol>
            </>
          )}
        </section>
        <section className="es-work">
          <textarea
            className="es-editor"
            spellCheck={false}
            value={code}
            onChange={(e) => write(e.target.value)}
          />
          <div className="es-actions">
            <button className="es-btn" onClick={runSamples} disabled={busy}>
              Run samples
            </button>
            <button className="es-btn es-btn-primary" onClick={submit} disabled={busy}>
              Submit
            </button>
            <span className="es-muted es-attempts">attempts: {attempts}</span>
          </div>
          {samples.length > 0 && (
            <div className="es-samples">
              {samples.map((s, i) => (
                <div key={i} className={s.ok ? 'es-ok' : 'es-no'}>
                  {s.ok ? '✓' : '✗'} {s.name}: <code>{s.got.replace(/\n/g, '⏎')}</code>
                </div>
              ))}
            </div>
          )}
          {verdict && (
            <div className={`es-verdict es-verdict-${verdict.status}`}>
              <strong>{STATUS_LABEL[verdict.status]}</strong> — {verdict.passed}/{verdict.total} tests
              {verdict.withinBudget ? '' : ' · over budget'}
            </div>
          )}
          <div className="es-result-url">
            result: <a href={resultUrl(id)}>{resultUrl(id)}</a>
          </div>
        </section>
      </div>
    </div>
  )
}
