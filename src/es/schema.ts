export const DOC_ES_SCHEMA_VERSION = 1 as const
export const IDE_ES_SCHEMA_VERSION = 1 as const

export type ProgrammaticPreset = 'on' | 'off'
export type LifecycleOwner = 'human' | 'consumer'

export type SeedBlock = {
  type: 'paragraph' | 'heading'
  text: string
}

export type DocEsSchema = {
  schemaVersion: typeof DOC_ES_SCHEMA_VERSION
  kind: 'doc-es'
  title: string
  lifecycleOwner: LifecycleOwner
  programmatic: ProgrammaticPreset
  initialContent?: SeedBlock[]
}

export type IdeTestCase = {
  name?: string
  input: string
  expectedOutput: string
  hidden: boolean
}

export type IdeHint = {
  afterFailedAttempts?: number
  text: string
}

export type IdeEsEntry = {
  language: 'javascript'
  functionName: string
}

export type IdeEsSchema = {
  schemaVersion: typeof IDE_ES_SCHEMA_VERSION
  kind: 'ide-es'
  title: string
  lifecycleOwner: LifecycleOwner
  programmatic: ProgrammaticPreset
  goalCondition: string
  problem: string
  entry: IdeEsEntry
  tests: IdeTestCase[]
  tleBudgetMs: number
  complexityBudget?: string
  hints?: IdeHint[]
  resultCallbackUrl?: string
}

export type EndpointSchema = DocEsSchema | IdeEsSchema

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] }

const PRESETS: ProgrammaticPreset[] = ['on', 'off']
const OWNERS: LifecycleOwner[] = ['human', 'consumer']

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

export function isHttpUrl(v: unknown): v is string {
  return typeof v === 'string' && /^https?:\/\//.test(v)
}

function rejectUnknown(o: Record<string, unknown>, allowed: string[], errors: string[], path: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) errors.push(`${path} has unknown key '${k}'`)
  }
}

const DOC_KEYS = ['schemaVersion', 'kind', 'title', 'lifecycleOwner', 'programmatic', 'initialContent', 'resultCallbackUrl']
const IDE_KEYS = ['schemaVersion', 'kind', 'title', 'lifecycleOwner', 'programmatic', 'goalCondition', 'problem', 'entry', 'tests', 'tleBudgetMs', 'complexityBudget', 'hints', 'resultCallbackUrl']
const SEED_KEYS = ['type', 'text']
const ENTRY_KEYS = ['language', 'functionName']
const TEST_KEYS = ['name', 'input', 'expectedOutput', 'hidden']
const HINT_KEYS = ['afterFailedAttempts', 'text']

function checkCommon(o: Record<string, unknown>, errors: string[]): void {
  if (!isNonEmptyString(o.title)) errors.push('title must be a non-empty string')
  if (!OWNERS.includes(o.lifecycleOwner as LifecycleOwner))
    errors.push("lifecycleOwner must be 'human' or 'consumer'")
  if (!PRESETS.includes(o.programmatic as ProgrammaticPreset))
    errors.push("programmatic must be 'on' or 'off'")
}

export function validateDocEsSchema(input: unknown): ValidationResult<DocEsSchema> {
  const errors: string[] = []
  if (!isObject(input)) return { ok: false, errors: ['schema must be an object'] }
  rejectUnknown(input, DOC_KEYS, errors, 'schema')
  if (input.kind !== 'doc-es') errors.push("kind must be 'doc-es'")
  if (input.schemaVersion !== DOC_ES_SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${DOC_ES_SCHEMA_VERSION}`)
  checkCommon(input, errors)
  // F-04: doc-es has no grade lifecycle, callback never fires — reject (kept in DOC_KEYS so this msg
  // beats generic unknown-key error) instead of silently accepting; callbacks are ide-es only
  if (input.resultCallbackUrl !== undefined)
    errors.push('resultCallbackUrl is not supported on doc-es (it produces no graded result); use ide-es')
  if (input.initialContent !== undefined) {
    if (!Array.isArray(input.initialContent)) errors.push('initialContent must be an array')
    else
      input.initialContent.forEach((b, i) => {
        if (!isObject(b) || (b.type !== 'paragraph' && b.type !== 'heading') || typeof b.text !== 'string')
          errors.push(`initialContent[${i}] must be { type: 'paragraph'|'heading', text: string }`)
        else rejectUnknown(b, SEED_KEYS, errors, `initialContent[${i}]`)
      })
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as DocEsSchema }
}

export function validateIdeEsSchema(input: unknown): ValidationResult<IdeEsSchema> {
  const errors: string[] = []
  if (!isObject(input)) return { ok: false, errors: ['schema must be an object'] }
  rejectUnknown(input, IDE_KEYS, errors, 'schema')
  if (input.kind !== 'ide-es') errors.push("kind must be 'ide-es'")
  if (input.schemaVersion !== IDE_ES_SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${IDE_ES_SCHEMA_VERSION}`)
  checkCommon(input, errors)
  if (input.resultCallbackUrl !== undefined && !isHttpUrl(input.resultCallbackUrl))
    errors.push('resultCallbackUrl must be an http(s) URL when present')
  if (!isNonEmptyString(input.goalCondition)) errors.push('goalCondition must be a non-empty string')
  if (!isNonEmptyString(input.problem)) errors.push('problem must be a non-empty string')
  if (!isObject(input.entry) || input.entry.language !== 'javascript' || !isNonEmptyString(input.entry.functionName))
    errors.push("entry must be { language: 'javascript', functionName: string }")
  else {
    rejectUnknown(input.entry, ENTRY_KEYS, errors, 'entry')
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input.entry.functionName as string))
      errors.push('entry.functionName must be a valid JS identifier')
  }
  if (typeof input.tleBudgetMs !== 'number' || !(input.tleBudgetMs > 0))
    errors.push('tleBudgetMs must be a positive number')
  if (!Array.isArray(input.tests) || input.tests.length === 0) errors.push('tests must be a non-empty array')
  else {
    let hidden = 0
    input.tests.forEach((t, i) => {
      if (!isObject(t) || typeof t.input !== 'string' || typeof t.expectedOutput !== 'string' || typeof t.hidden !== 'boolean')
        errors.push(`tests[${i}] must be { input: string, expectedOutput: string, hidden: boolean }`)
      else {
        rejectUnknown(t, TEST_KEYS, errors, `tests[${i}]`)
        if (t.hidden) hidden++
      }
    })
    if (hidden === 0) errors.push('at least one test must be hidden (the graded oracle)')
  }
  if (input.hints !== undefined) {
    if (!Array.isArray(input.hints)) errors.push('hints must be an array')
    else
      input.hints.forEach((h, i) => {
        if (!isObject(h) || typeof h.text !== 'string')
          errors.push(`hints[${i}] must be { text: string, afterFailedAttempts?: number }`)
        else rejectUnknown(h, HINT_KEYS, errors, `hints[${i}]`)
      })
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as IdeEsSchema }
}

export function validateEndpointSchema(input: unknown): ValidationResult<EndpointSchema> {
  if (isObject(input) && input.kind === 'ide-es') return validateIdeEsSchema(input)
  if (isObject(input) && input.kind === 'doc-es') return validateDocEsSchema(input)
  return { ok: false, errors: ["kind must be 'doc-es' or 'ide-es'"] }
}
