import { describe, expect, it } from 'vitest'
import { formatForAi } from './log-detail-sheet'

describe('formatForAi', () => {
  it('produces a self-contained markdown block', () => {
    const md = formatForAi({
      id: '1', ts: Date.UTC(2026, 9, 8, 14, 16, 31, 640), level: 'error', source: 'kernel', host: 'spark-05', service: 'kernel',
      message: 'NVRM: Xid 31', pattern: 'abcdef0123456789', attributes: { pid: '4242' },
    })
    expect(md).toContain('host: spark-05')
    expect(md).toContain('time: 2026-10-08T14:16:31.640Z')
    expect(md).toContain('```\nNVRM: Xid 31\n```')
    expect(md).toContain('"pid": "4242"')
  })
})
