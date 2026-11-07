import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '@/api/types'
import { fitProblem } from './fit'

const big: CatalogModel = { id: 'deepseek-v3.1', displayName: 'DeepSeek V3.1', sizeGB: 380, quant: 'NVFP4', contextLength: 131072, engines: ['SGLang', 'vLLM'] }
const small: CatalogModel = { id: 'gpt-oss-20b', displayName: 'gpt-oss 20B', sizeGB: 14, quant: 'MXFP4', contextLength: 131072, engines: ['vLLM', 'Ollama'] }

describe('fitProblem', () => {
  it('asks for a model, engine and nodes first', () => {
    expect(fitProblem(undefined, undefined, 0)).toBe('Choose a model')
    expect(fitProblem(small, undefined, 0)).toBe('Choose an engine')
    expect(fitProblem(small, 'vLLM', 0)).toBe('Select at least one node')
  })
  it('rejects engines that are not packaged or cannot span nodes', () => {
    expect(fitProblem(small, 'NIM', 1)).toBe('gpt-oss 20B is not packaged for NIM')
    expect(fitProblem(small, 'Ollama', 2)).toBe('Ollama cannot span multiple nodes')
  })
  it('explains memory fit', () => {
    expect(fitProblem(big, 'SGLang', 1)).toBe('DeepSeek V3.1 (380 GB) needs at least 4 nodes')
    expect(fitProblem(big, 'SGLang', 4)).toBeNull()
    expect(fitProblem(small, 'vLLM', 1)).toBeNull()
  })
})
