// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { NodeLiveStats } from '../../src/api/types.ts'
import { engineOf, firmwareRows, healthChecks, healthStatus, parsePackages, parseProcesses, parseToolOutput, toEnvelope } from './tools.ts'

const live: NodeLiveStats = { gpuUtil: 50, memUsedGB: 100, gpuPowerW: 60, gpuTempC: 70, acpiTempC: 45, cpuUtil: 10, diskUsedPct: 70, throttling: false }

describe('tool output', () => {
  it('parses the JSON after any noise and maps it to an envelope', () => {
    const out = parseToolOutput('warning: something\n{"ok": true, "data": {"tarball": "/var/tmp/b.tgz"}, "errors": [], "meta": {"tool": "spark_diagctl", "collected_at_utc": "2026-01-01T00:00:00Z"}}')
    const env = toEnvelope('spark_diagctl.py', 'spark-01', out, 0, 1200, { level: 'L2' })
    expect(env.status).toBe('ok')
    expect(env.ts).toBe('2026-01-01T00:00:00Z')
    expect(env.artifacts).toEqual(['/var/tmp/b.tgz'])
  })
  it("doesn't count fwupd's 'No updates available' as a failure", () => {
    const out = parseToolOutput('{"ok": false, "data": {}, "errors": ["fwupdmgr get-updates failed: No updates available"]}')
    expect(toEnvelope('spark_updatectl.py', 'h', out, 1, 1, {}).status).toBe('ok')
  })
  it('reports missing JSON as an error', () => {
    const env = toEnvelope('x', 'h', parseToolOutput('Traceback ...'), 1, 1, {})
    expect(env.status).toBe('error')
    expect(env.warnings[0]).toContain('no JSON')
  })
})

describe('health checks', () => {
  it('passes a healthy node and flags pending reboots', () => {
    const checks = healthChecks({
      live, memoryGB: 128, diskGB: 4000,
      facts: { cpus: 20, kernel: 'k', driver: '580', cuda: '13.0', cx7: ['enp1s0f0np0'], mgmt: 'eth0' },
      sample: { t: 0, cpu: [], mem: {}, gpu: '50, 60, 70, 1, 2', acpi: [], hwmon: { nvme: [45000], mlx5: [60000] }, net: {}, disk: {}, fs: [1, 1], links: { enp1s0f0np0: 'up' }, up: 1 },
      updateStatus: { pending_reboot: { pending: true, indicators: ['/run/reboot-required'] } },
      diag: { cpu: { load_average: { '5min': 1.2 } } },
    })
    expect(checks.find((c) => c.name === 'ConnectX-7 link')?.detail).toBe('enp1s0f0np0 up')
    expect(checks.find((c) => c.name === 'Pending reboot')?.status).toBe('warn')
    expect(healthStatus(checks)).toBe('warn')
  })
  it('fails an unreachable node', () => {
    const checks = healthChecks({ live: null, memoryGB: 128, diskGB: 4000, facts: null, sample: null, updateStatus: null, diag: null })
    expect(healthStatus(checks)).toBe('error')
  })
})

describe('inventory and processes', () => {
  it('lists BIOS and fwupd devices', () => {
    expect(firmwareRows({ platform_dmi: { bios_version: '5.36' }, fwupd: { devices: [{ name: 'MT2910 Family (ConnectX-7)', current_version: '28.45.4028' }, { name: 'no version' }] } })).toEqual([
      { component: 'UEFI / BIOS', version: '5.36' },
      { component: 'MT2910 Family (ConnectX-7)', version: '28.45.4028' },
    ])
  })
  it('keeps the packages that matter', () => {
    expect(parsePackages('nvidia-driver-580-open\t580.1\nlibreoffice\t24\ncuda-toolkit-13-0\t13.0\n').map((p) => p.name)).toEqual(['cuda-toolkit-13-0', 'nvidia-driver-580-open'])
  })
  it('parses processes, falling back to RSS when the GPU reports none', () => {
    const ps = parseProcesses('572823\troot\t11174216\t96777\t/usr/bin/python3 -m vllm serve x\n99\tadmin\t2048\t0\tollama serve\nbad line\n')
    expect(ps).toEqual([
      { pid: 572823, user: 'root', name: '/usr/bin/python3 -m vllm serve x', engine: 'vLLM', gpuMemMiB: 96777 },
      { pid: 99, user: 'admin', name: 'ollama serve', engine: 'Ollama', gpuMemMiB: 2 },
    ])
    expect(engineOf('sglang.launch_server')).toBe('SGLang')
  })
})
