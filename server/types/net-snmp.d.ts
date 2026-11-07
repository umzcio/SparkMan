// The parts of net-snmp (no bundled types) that server/fleet/switches.ts uses.
declare module 'net-snmp' {
  export interface Varbind {
    oid: string
    type: number
    value: unknown
  }
  export interface V3User {
    name: string
    level: number
    authProtocol?: number
    authKey?: string
    privProtocol?: number
    privKey?: string
  }
  export interface SessionOptions {
    port?: number
    timeout?: number
    retries?: number
  }
  export interface Session {
    get(oids: string[], cb: (err: Error | null, varbinds: Varbind[]) => void): void
    subtree(oid: string, maxRepetitions: number, feed: (varbinds: Varbind[]) => boolean | void, done: (err: Error | null) => void): void
    close(): void
    on(event: 'error', cb: (err: Error) => void): void
  }
  export function createV3Session(target: string, user: V3User, options?: SessionOptions): Session
  export function isVarbindError(vb: Varbind): boolean
  export const SecurityLevel: { noAuthNoPriv: number; authNoPriv: number; authPriv: number }
  export const AuthProtocols: { none: number; md5: number; sha: number; sha224: number; sha256: number; sha384: number; sha512: number }
  export const PrivProtocols: { none: number; des: number; aes: number; aes256b: number; aes256r: number }
  const snmp: {
    createV3Session: typeof createV3Session
    isVarbindError: typeof isVarbindError
    SecurityLevel: typeof SecurityLevel
    AuthProtocols: typeof AuthProtocols
    PrivProtocols: typeof PrivProtocols
  }
  export default snmp
}
