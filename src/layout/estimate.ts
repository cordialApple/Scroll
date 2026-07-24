import type { BlockType } from '../doc/model'

const SHEET_TEXT_WIDTH = 736
const CHAR_PX = 6.2
const LINE_H = 24

export interface EstimateInput {
  type: BlockType
  textLength: number
}

export function estimateHeight({ type, textLength }: EstimateInput): number {
  const width = type === 'heading' ? SHEET_TEXT_WIDTH * 0.9 : SHEET_TEXT_WIDTH
  const perLine = Math.max(1, Math.floor(width / CHAR_PX))
  const lines = Math.max(1, Math.ceil(textLength / perLine))
  const base = type === 'heading' ? 40 : type === 'quote' ? 12 : 0
  return lines * (type === 'heading' ? 34 : LINE_H) + base + 8
}
