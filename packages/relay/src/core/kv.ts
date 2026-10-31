/** The subset of Durable Object storage the relay uses; the dev relay implements it in memory. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(keys: string | string[]): Promise<unknown>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
}

export type Result<T> = { ok: true; value: T } | { ok: false; code: import('@dafuga/trustline-protocol').RelayErrorCode }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = (code: import('@dafuga/trustline-protocol').RelayErrorCode): Result<never> => ({ ok: false, code })
