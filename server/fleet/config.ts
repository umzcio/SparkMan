import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { NodeModel, RackPosition, UpdateRing } from '../../src/api/types.ts'
import type { SwitchConfig } from './switches.ts'

/**
 * Site config. Lives outside the repo (default /etc/sparkman/fleet.json, override with
 * SPARKMAN_FLEET_CONFIG) so hostnames and addresses never land in git. See deploy/fleet.example.json.
 */
export interface FleetFileConfig {
  /** account on the boxes (passwordless sudo) */
  sshUser: string
  sshKeyPath: string
  /** dnsmasq fixed leases, `MAC,IP,host,lease` per line */
  leasesFile?: string
  /** per-host enrollment snapshots: <dir>/<host>/{host,hardware,firmware}.json */
  stateDir?: string
  /** where NVIDIA's lifecycle tools are installed on every box */
  toolsDir?: string
  /** ConnectX-7 groups (pairs, rings), head node first: a model served by the head spans the group */
  groups?: { id: string; nodeIds: string[] }[]
  /** update rings default to ring1 */
  nodes: { id: string; rack: RackPosition; model?: NodeModel; ip?: string; ring?: UpdateRing }[]
  /** switches the network page reads (read-only): the fleet LAN switch, the ConnectX-7 fabric switch */
  switches?: SwitchConfig[]
}

export interface FleetHost {
  id: string
  ip: string
  mac: string | null
  rack: RackPosition
  ring: UpdateRing
  model: NodeModel
  serial: string
  assetTag: string
  dgxOs: string
  uefi: string
}

export interface FleetConfigResolved {
  groups: { id: string; nodeIds: string[] }[]
  sshUser: string
  sshKeyPath: string
  toolsDir: string
  hosts: FleetHost[]
  switches: SwitchConfig[]
}

export const DEFAULT_CONFIG_PATH = '/etc/sparkman/fleet.json'

/** dnsmasq `dhcp-hostsfile` lines → host → { ip, mac }. */
export function parseLeases(text: string): Map<string, { ip: string; mac: string }> {
  const out = new Map<string, { ip: string; mac: string }>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [mac, ip, host] = line.split(',').map((s) => s.trim())
    if (mac && ip && host) out.set(host, { ip, mac: mac.toLowerCase() })
  }
  return out
}

/** DGX_PLATFORM / DMI product names → the UI's three models. */
export function modelFromPlatform(platform: string | undefined): NodeModel {
  const p = (platform ?? '').toLowerCase()
  if (p.includes('gx10') || p.includes('asus')) return 'ASUS GX10'
  if (p.includes('dell')) return 'Dell Pro Max GB10'
  return 'DGX Spark FE'
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function loadFleetConfig(file = process.env.SPARKMAN_FLEET_CONFIG ?? DEFAULT_CONFIG_PATH): FleetConfigResolved | null {
  if (!existsSync(file)) return null
  const cfg = readJson(file) as unknown as FleetFileConfig | null
  if (!cfg || !Array.isArray(cfg.nodes)) throw new Error(`${file}: expected { sshUser, sshKeyPath, nodes: [...] }`)
  const leases = cfg.leasesFile && existsSync(cfg.leasesFile) ? parseLeases(readFileSync(cfg.leasesFile, 'utf8')) : new Map()
  const hosts: FleetHost[] = cfg.nodes.map((n) => {
    const lease = leases.get(n.id)
    const ip = n.ip ?? lease?.ip
    if (!ip) throw new Error(`${file}: no address for ${n.id} (set "ip" or add it to ${cfg.leasesFile ?? 'leasesFile'})`)
    const snap = cfg.stateDir ? path.join(cfg.stateDir, n.id) : null
    const host = snap ? readJson(path.join(snap, 'host.json')) : null
    const release = (host?.release ?? {}) as Record<string, unknown>
    const fw = snap ? ((readJson(path.join(snap, 'firmware.json'))?.data ?? {}) as Record<string, unknown>) : {}
    const dmi = (fw.platform_dmi ?? {}) as Record<string, unknown>
    return {
      id: n.id,
      ip,
      mac: lease?.mac ?? null,
      rack: n.rack,
      ring: n.ring === 'canary' || n.ring === 'ring2' ? n.ring : 'ring1',
      model: n.model ?? modelFromPlatform(str(release.DGX_PLATFORM) || str(dmi.product_name)),
      serial: str(release.DGX_SERIAL_NUMBER) || str(dmi.product_serial),
      assetTag: str(fw.asset_id) || str(release.DGX_SERIAL_NUMBER),
      // SWBUILD is the factory image; each OTA appends its own version, and the snapshot keeps the last
      dgxOs: str(release.DGX_OTA_VERSION) || str(release.DGX_SWBUILD_VERSION),
      uefi: str(dmi.bios_version),
    }
  })
  const switches = (cfg.switches ?? []).map((s) => {
    if (!s.id || !s.host || !s.secretFile || (s.role !== 'fleet' && s.role !== 'fabric') || (s.kind !== 'snmp' && s.kind !== 'routeros')) {
      throw new Error(`${file}: each switch needs id, host, secretFile, role (fleet | fabric) and kind (snmp | routeros)`)
    }
    return s
  })
  return { groups: (cfg.groups ?? []).filter((g) => Array.isArray(g.nodeIds) && g.nodeIds.length > 1), sshUser: cfg.sshUser, sshKeyPath: cfg.sshKeyPath, toolsDir: cfg.toolsDir ?? '/opt/dgx_spark_management', hosts, switches }
}
