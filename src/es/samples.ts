import type { IdeEsSchema, DocEsSchema } from './schema'

export function sampleIdeSchema(): IdeEsSchema {
  return {
    schemaVersion: 1,
    kind: 'ide-es',
    title: 'Sum of integers',
    lifecycleOwner: 'consumer',
    programmatic: 'on',
    goalCondition: 'Return the sum of all whitespace-separated integers in the input.',
    problem:
      'The input is a string of whitespace-separated integers (they may span multiple lines). Return their sum as a string.',
    entry: { language: 'javascript', functionName: 'solve' },
    tleBudgetMs: 1000,
    complexityBudget: 'O(n)',
    tests: [
      { name: 'sample-basic', input: '1 2 3', expectedOutput: '6', hidden: false },
      { name: 'sample-negatives', input: '10 -4 4', expectedOutput: '10', hidden: false },
      { name: 'hidden-single', input: '5', expectedOutput: '5', hidden: true },
      { name: 'hidden-multiline', input: '2 2\n2 2', expectedOutput: '8', hidden: true },
    ],
    hints: [
      { afterFailedAttempts: 1, text: 'Split the input on whitespace with input.trim().split(/\\s+/).' },
      { afterFailedAttempts: 2, text: 'Map each token to Number and reduce with addition; return String(sum).' },
    ],
  }
}

export function sampleDocSchema(): DocEsSchema {
  return {
    schemaVersion: 1,
    kind: 'doc-es',
    title: 'Untitled endpoint',
    lifecycleOwner: 'consumer',
    programmatic: 'off',
    initialContent: [
      { type: 'heading', text: 'Untitled endpoint' },
      { type: 'paragraph', text: '' },
    ],
  }
}
