import { Cable, Cpu, Gauge, HardDrive, MemoryStick, Network, Thermometer, Zap } from 'lucide-react'
import { useNodeMetrics } from '@/api/hooks'
import type { FleetNode, TimeRange } from '@/api/types'
import { MetricChart } from '@/components/metric-chart'
import { QueryState } from '@/components/query-state'
import { Skeleton } from '@/components/ui/skeleton'
import { formatGB, formatPercent, formatRate, formatTemp, formatWatts } from '@/lib/format'
import { Ticker } from '@/components/ticker'
import { stagger } from '@/lib/motion'

export function NodeMetricsTab({ node, range }: { node: FleetNode; range: TimeRange }) {
  const metrics = useNodeMetrics(node.id, range)
  const live = node.live
  return (
    <QueryState
      query={metrics}
      skeleton={
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      }
    >
      {(data) => (
        <div className="flex flex-col gap-3">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <MetricChart className="enter-fade-up" style={stagger(0)} title="GPU utilization" icon={Gauge} data={data} range={range} domain={[0, 100]} format={(v) => formatPercent(v)} current={<Ticker value={live?.gpuUtil ?? null} format={(v) => formatPercent(v)} />} series={[{ key: 'gpuUtil', label: 'GPU', color: 'var(--gpu)' }]} />
            <MetricChart className="enter-fade-up" style={stagger(1)} title="Unified memory" icon={MemoryStick} data={data} range={range} domain={[0, 128]} format={(v) => formatGB(v)} current={<Ticker value={live?.memUsedGB ?? null} format={(v) => (v == null ? '—' : `${formatGB(v)} / 128 GB`)} />} series={[{ key: 'memUsedGB', label: 'Used', color: 'var(--memory)' }]} />
            <MetricChart className="enter-fade-up" style={stagger(2)} title="GPU power" icon={Zap} data={data} range={range} format={(v) => formatWatts(v)} current={<Ticker value={live?.gpuPowerW ?? null} format={formatWatts} />} series={[{ key: 'gpuPowerW', label: 'GPU power', color: 'var(--power)' }]} />
            <MetricChart className="enter-fade-up" style={stagger(3)}
              title="Temperature"
              icon={Thermometer}
              data={data}
              range={range}
              domain={[20, 'auto']}
              format={(v) => formatTemp(v)}
              current={
                live ? (
                  <>
                    <Ticker value={live.gpuTempC} format={formatTemp} /> · <Ticker value={live.acpiTempC} format={formatTemp} />
                  </>
                ) : (
                  '—'
                )
              }
              series={[
                { key: 'gpuTempC', label: 'GPU (nvidia-smi)', color: 'var(--power)' },
                { key: 'acpiTempC', label: 'ACPI zone', color: 'var(--level-error)' },
              ]}
            />
            <MetricChart className="enter-fade-up" style={stagger(4)}
              title="CPU"
              icon={Cpu}
              data={data}
              range={range}
              domain={[0, 100]}
              stacked
              format={(v) => formatPercent(v)}
              current={<Ticker value={live?.cpuUtil ?? null} format={(v) => formatPercent(v)} />}
              series={[
                { key: 'cpuUser', label: 'user', color: 'var(--cpu)' },
                { key: 'cpuSystem', label: 'system', color: 'var(--level-info)' },
              ]}
            />
            <MetricChart className="enter-fade-up" style={stagger(5)}
              title="Network (10GbE)"
              icon={Network}
              data={data}
              range={range}
              format={(v) => formatRate(v)}
              series={[
                { key: 'netRxBps', label: 'rx', color: 'var(--cpu)' },
                { key: 'netTxBps', label: 'tx', color: 'var(--memory)' },
              ]}
            />
            {node.groupId !== null && (
              <MetricChart className="enter-fade-up" style={stagger(6)}
                title="ConnectX-7 (200 GbE)"
                icon={Cable}
                data={data}
                range={range}
                format={(v) => formatRate(v)}
                series={[
                  { key: 'cx7RxBps', label: 'rx', color: 'var(--gpu)' },
                  { key: 'cx7TxBps', label: 'tx', color: 'var(--level-info)' },
                ]}
              />
            )}
            <MetricChart className="enter-fade-up" style={stagger(7)}
              title="NVMe I/O"
              icon={HardDrive}
              data={data}
              range={range}
              format={(v) => formatRate(v)}
              series={[
                { key: 'diskReadBps', label: 'read', color: 'var(--cpu)' },
                { key: 'diskWriteBps', label: 'write', color: 'var(--power)' },
              ]}
            />
            <MetricChart className="enter-fade-up" style={stagger(8)} title="Disk usage" icon={HardDrive} data={data} range={range} domain={[0, 100]} format={(v) => formatPercent(v)} current={<Ticker value={live?.diskUsedPct ?? null} format={(v) => formatPercent(v)} />} series={[{ key: 'diskUsedPct', label: 'used', color: 'var(--level-info)' }]} />
          </div>
          <p className="text-xs text-muted-foreground">
            GB10 shares 128 GB between CPU and GPU, so <code className="font-mono">nvidia-smi</code> reports memory as “Not Supported”. Memory comes from <code className="font-mono">/proc/meminfo</code> (MemAvailable). Power is GPU-only draw.
          </p>
        </div>
      )}
    </QueryState>
  )
}
