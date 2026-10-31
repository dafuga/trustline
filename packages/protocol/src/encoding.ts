import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export { bytesToHex as toHex, concatBytes, hexToBytes as fromHex, utf8ToBytes as utf8 }

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Length-prefixes every field, so distinct field lists never encode to the same bytes. */
export function encodeFields(...fields: (Uint8Array | string)[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const field of fields) {
    const bytes = typeof field === 'string' ? utf8ToBytes(field) : field
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, bytes.length)
    parts.push(length, bytes)
  }
  return concatBytes(...parts)
}

/** JSON with recursively sorted object keys, so a value has exactly one encoding. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    )
  }
  return value
}
