import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLocalSetting } from './use-local-setting'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('useLocalSetting', () => {
  it('reads the fallback, writes, and re-reads persisted values', () => {
    const { result } = renderHook(() => useLocalSetting<string>('sparkman.test', 'a'))
    expect(result.current[0]).toBe('a')
    act(() => result.current[1]('b'))
    expect(result.current[0]).toBe('b')
    expect(localStorage.getItem('sparkman.test')).toBe('b')
    const again = renderHook(() => useLocalSetting<string>('sparkman.test', 'a'))
    expect(again.result.current[0]).toBe('b')
  })
  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { result } = renderHook(() => useLocalSetting<string>('sparkman.test', 'x'))
    expect(result.current[0]).toBe('x')
    act(() => result.current[1]('y'))
    expect(result.current[0]).toBe('y')
  })
})
