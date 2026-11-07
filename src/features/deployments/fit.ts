import type { CatalogModel, Engine } from '@/api/types'

/** Usable model memory per GB10 node after OS + KV-cache headroom. Must match the simulator (110 GB). */
export const USABLE_GB_PER_NODE = 110

export function fitProblem(model: CatalogModel | undefined, engine: Engine | undefined, nodeCount: number): string | null {
  if (!model) return 'Choose a model'
  if (!engine) return 'Choose an engine'
  if (nodeCount === 0) return 'Select at least one node'
  if (!model.engines.includes(engine)) return `${model.displayName} is not packaged for ${engine}`
  if (nodeCount > 1 && engine !== 'vLLM' && engine !== 'SGLang') return `${engine} cannot span multiple nodes`
  const needed = Math.ceil(model.sizeGB / USABLE_GB_PER_NODE)
  if (nodeCount < needed) return `${model.displayName} (${model.sizeGB} GB) needs at least ${needed} nodes`
  return null
}
