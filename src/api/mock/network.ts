import type { FleetNode, NetworkState, NetworkSwitch, NodeLink, SwitchPort } from '../types'

const hex = (n: number) => n.toString(16).padStart(2, '0')
const macOf = (i: number, nic: number) => `02:5a:00:${hex(nic)}:${hex(i >> 8)}:${hex(i & 255)}`

function port(p: Partial<SwitchPort> & Pick<SwitchPort, 'id' | 'name' | 'label' | 'kind'>): SwitchPort {
  return {
    lane: null, up: false, speedMbps: null, mtu: 1518, rxBps: null, txBps: null, rxErrors: 0, txErrors: 0, drops: 0,
    pauseRx: null, pauseTx: null, fecUncorrected: null, module: null, peer: null, problem: null, ...p,
  }
}

/**
 * A plausible two-switch fleet for the simulator: every node's LAN port on a 24 + 8 port 10G switch (port 1 is
 * SparkMan's host), the first four nodes on a 4-port QSFP fabric switch at 200G, one node negotiated down to 5G.
 */
export function mockNetwork(nodes: FleetNode[], now: number): NetworkState {
  const sorted = [...nodes].sort((a, b) => a.rack.shelf - b.rack.shelf || a.rack.slot - b.rack.slot)
  const wave = (i: number, scale: number) => Math.round(scale * (0.55 + 0.45 * Math.sin(now / 9000 + i)))
  const up = (n: FleetNode) => n.status !== 'offline'
  const slow = sorted[Math.min(4, sorted.length - 1)]?.id
  const fabric = sorted.slice(0, 4)

  const lanPorts: SwitchPort[] = Array.from({ length: 32 }, (_, k) => {
    const n = k + 1
    const base = port({ id: String(49152 + n), name: `ten-gigabitEthernet 1/0/${n}`, label: String(n), kind: n > 24 ? 'sfp' : 'rj45' })
    if (n === 1) return { ...base, up: true, speedMbps: 10000, rxBps: wave(0, 2e9), txBps: wave(1, 4e8), peer: { nodeId: null, label: 'sparkman-host', iface: 'eth1', via: 'mac' } }
    const node = sorted[n - 2]
    if (!node) return base
    const speed = node.id === slow ? 5000 : 10000
    return {
      ...base, up: up(node), speedMbps: up(node) ? speed : null, rxBps: up(node) ? wave(n, 3e8) : null, txBps: up(node) ? wave(n + 1, 1.2e9) : null,
      peer: { nodeId: node.id, label: node.id, iface: 'enP7s7', via: 'mac' }, problem: up(node) && speed < 10000 ? '5 Gb/s, expected 10 Gb/s' : null,
    }
  })
  const fabPorts: SwitchPort[] = [
    ...[1, 2, 3, 4].map((cage) => {
      const node = fabric[cage - 1]
      const base = port({ id: `qsfp56-dd-${cage}-1`, name: `qsfp56-dd-${cage}-1`, label: String(cage), kind: 'qsfp', lane: 1, mtu: 9000, pauseRx: 0, pauseTx: 0, fecUncorrected: 0 })
      if (!node) return base
      return {
        ...base, up: up(node), speedMbps: up(node) ? 200000 : null, rxBps: up(node) ? wave(cage * 3, 6e10) : null, txBps: up(node) ? wave(cage * 3 + 1, 6e10) : null,
        pauseTx: 1200 * cage, module: { vendor: 'Generic', part: 'Q56-200G-CU1', type: 'QSFP28/QSFP56' },
        peer: { nodeId: node.id, label: node.id, iface: 'enp1s0f0np0 + enP2p1s0f0np0', via: 'mac' as const },
      }
    }),
    port({ id: 'ether1', name: 'ether1', label: 'e1', kind: 'mgmt', up: true, speedMbps: 1000, rxBps: 12_000, txBps: 30_000, peer: { nodeId: null, label: 'lan-switch', iface: null, via: 'lldp' } }),
    port({ id: 'ether2', name: 'ether2', label: 'e2', kind: 'mgmt' }),
  ]
  const switches: NetworkSwitch[] = [
    {
      id: 'lan-switch', name: 'lan-switch', role: 'fleet', kind: 'snmp', host: '10.0.0.2', model: 'SX3832', firmware: '1.0.19 Build 20260509', serial: 'Y25A00000001',
      uptimeS: 882_000, reachable: true, everReached: true, error: null, lastPollAt: now - 4000,
      health: [{ label: 'CPU', value: 1, unit: '%', status: 'ok' }, { label: 'Memory', value: 28, unit: '%', status: 'ok' }], ports: lanPorts,
      console: { device: '/dev/serial/by-id/usb-lan-switch-console', tty: '/dev/ttyACM1', jack: 'usb-c', connected: true, host: 'sparkman-host' },
    },
    {
      id: 'qsfp-switch', name: 'qsfp-switch', role: 'fabric', kind: 'routeros', host: '10.0.0.3', model: 'CRS804-4DDQ', firmware: '7.24.2 (stable)', serial: 'HN70000000',
      uptimeS: 86_400, reachable: true, everReached: true, error: null, lastPollAt: now - 6000,
      health: [
        { label: 'CPU temperature', value: 42, unit: '°C', status: 'ok' }, { label: 'Switch temperature', value: 35, unit: '°C', status: 'ok' },
        { label: 'Fan1 speed', value: 3150, unit: 'RPM', status: 'ok' }, { label: 'Fan2 speed', value: 3150, unit: 'RPM', status: 'ok' },
        { label: 'PSU 1 state', value: null, unit: '', state: 'ok', status: 'ok' }, { label: 'PSU 2 state', value: null, unit: '', state: 'ok', status: 'ok' },
        { label: 'PSU 1 power', value: 12, unit: 'W', status: 'ok' },
      ],
      ports: fabPorts,
      console: { device: '/dev/serial/by-id/usb-qsfp-switch-console', tty: null, jack: 'rj45', connected: false, host: 'sparkman-host' },
    },
  ]
  return {
    switches,
    nodes: sorted.map((n, i): { nodeId: string; links: NodeLink[] } => {
      const on = fabric.includes(n)
      const lan: NodeLink = { iface: 'enP7s7', role: 'fleet', up: up(n), speedMbps: up(n) ? (n.id === slow ? 5000 : 10000) : null, mtu: 1500, mac: macOf(i, 1), switchId: 'lan-switch', portName: `ten-gigabitEthernet 1/0/${i + 2}` }
      const cx = (iface: string, nic: number): NodeLink => ({
        iface, role: 'fabric', up: up(n) && (on || iface.startsWith('enp1')), speedMbps: up(n) ? 200000 : null, mtu: on ? 9000 : 1500, mac: macOf(i, nic),
        switchId: on ? 'qsfp-switch' : null, portName: on ? `qsfp56-dd-${fabric.indexOf(n) + 1}-1` : null,
      })
      return { nodeId: n.id, links: [lan, cx('enp1s0f0np0', 2), cx('enP2p1s0f0np0', 3)] }
    }),
  }
}
