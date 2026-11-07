import { createContext, useContext } from 'react'

/** Fleet data areas that move from the simulator to the real backend one at a time (phase 2). */
export type FleetArea = 'nodes' | 'deployments' | 'gateway' | 'usage' | 'keys' | 'logs' | 'alerts' | 'updates' | 'benchmarks' | 'cooling' | 'network'

export const FLEET_AREAS: FleetArea[] = ['nodes', 'deployments', 'gateway', 'usage', 'keys', 'logs', 'alerts', 'updates', 'benchmarks', 'cooling', 'network']

/** Where fleet data comes from: the in-browser simulator, the real backend, or (during phase 2) both. */
export type FleetDataSource = 'simulated' | 'live' | 'mixed'

export interface DataSourceValue {
  /** areas served by the real backend */
  live: ReadonlySet<FleetArea>
  /** areas that aren't live come from the simulator (dev, e2e) or are simply not connected yet (production) */
  simulator: boolean
}

const DataSourceContext = createContext<DataSourceValue>({ live: new Set(), simulator: true })

export const DataSourceProvider = DataSourceContext.Provider

/** Whether areas that aren't live are simulated (true) or not connected yet (false). */
export const useSimulatorOn = () => useContext(DataSourceContext).simulator

/** One area's source, or the whole console's when no area is given. */
export function useFleetDataSource(area?: FleetArea): FleetDataSource {
  const { live } = useContext(DataSourceContext)
  if (area) return live.has(area) ? 'live' : 'simulated'
  if (live.size === 0) return 'simulated'
  return FLEET_AREAS.every((a) => live.has(a)) ? 'live' : 'mixed'
}
