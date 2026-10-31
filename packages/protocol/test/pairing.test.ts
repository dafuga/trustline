import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAIRING_TTL_MS,
  ProtocolError,
  abortPairing,
  confirmPairing,
  deviceIdFor,
  formatPairingCode,
  fromBase64,
  generateIdentity,
  generatePairingCode,
  joinPairing,
  normalizePairingCode,
  pairedPeer,
  receivePairingPost,
  roomIdFor,
  startPairing,
  type PairingState,
} from '../src/index.js'

const NOW = 1_000_000
const person = generateIdentity()
const helper = generateIdentity()

/** Runs the exchange up to the point where both sides show a safety string. */
function handshake() {
  const started = startPairing({ identity: person, name: 'Mom', now: NOW })
  const joined = joinPairing({ identity: helper, name: 'Sam', code: started.code, now: NOW })
  const afterJoin = receivePairingPost(started.state, joined.outbound[0] as string, NOW)
  const afterAccept = receivePairingPost(joined.state, afterJoin.outbound[0] as string, NOW)
  const afterReveal = receivePairingPost(afterJoin.state, afterAccept.outbound[0] as string, NOW)
  return {
    code: started.code,
    joinPost: joined.outbound[0] as string,
    acceptPost: afterJoin.outbound[0] as string,
    revealPost: afterAccept.outbound[0] as string,
    personState: afterReveal.state,
    helperState: afterAccept.state,
    afterJoinState: afterJoin.state,
    joinedState: joined.state,
  }
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    if (error instanceof ProtocolError) return error.code
    throw error
  }
  return undefined
}

const safety = (state: PairingState) => state.safetyString as string

describe('pairing codes', () => {
  it('are 60-bit, unambiguous, and unique', () => {
    const codes = new Set(Array.from({ length: 200 }, generatePairingCode))
    expect(codes.size).toBe(200)
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/)
  })

  it('normalizes what a person might actually type', () => {
    expect(normalizePairingCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN')
    expect(normalizePairingCode('O1IL 0000 0000')).toBe('011100000000')
    expect(formatPairingCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN')
  })

  it('rejects malformed codes', () => {
    expect(codeOf(() => normalizePairingCode('short'))).toBe('invalid_code')
    expect(codeOf(() => normalizePairingCode('https://evil.example/pair'))).toBe('invalid_code')
  })

  it('never puts the code in the room id', () => {
    const code = generatePairingCode()
    expect(roomIdFor(code)).toMatch(/^[0-9a-f]{64}$/)
    expect(roomIdFor(code)).not.toContain(code.toLowerCase())
  })
})

describe('pairing handshake', () => {
  it('gives both sides the same safety string', () => {
    const { personState, helperState } = handshake()
    expect(safety(personState)).toMatch(/^\d{3}-\d{3}$/)
    expect(safety(personState)).toBe(safety(helperState))
    expect(personState.stage).toBe('awaiting_confirmation')
    expect(helperState.stage).toBe('awaiting_confirmation')
  })

  it('gives different pairings different safety strings', () => {
    const transcripts = new Set(Array.from({ length: 5 }, () => handshake().personState.transcript))
    expect(transcripts.size).toBe(5)
  })

  it('completes only after both sides confirm', () => {
    const { personState, helperState } = handshake()
    const personConfirm = confirmPairing({ state: personState, identity: person, entered: safety(helperState), now: NOW })
    expect(personConfirm.matched).toBe(true)
    expect(personConfirm.state.stage).toBe('awaiting_confirmation')

    const helperConfirm = confirmPairing({ state: helperState, identity: helper, entered: safety(personState), now: NOW })
    expect(helperConfirm.state.stage).toBe('awaiting_confirmation')

    const person2 = receivePairingPost(personConfirm.state, helperConfirm.outbound[0] as string, NOW)
    const helper2 = receivePairingPost(helperConfirm.state, personConfirm.outbound[0] as string, NOW)
    expect(person2.state.stage).toBe('completed')
    expect(helper2.state.stage).toBe('completed')
    expect(pairedPeer(person2.state).deviceId).toBe(helper.deviceId)
    expect(pairedPeer(helper2.state).deviceId).toBe(person.deviceId)
    expect(pairedPeer(person2.state).deviceId).toBe(deviceIdFor(fromBase64(helper.signPublicKey)))
  })

  it("won't complete on the helper's confirmation alone", () => {
    const { personState, helperState } = handshake()
    const helperConfirm = confirmPairing({ state: helperState, identity: helper, entered: safety(helperState), now: NOW })
    const after = receivePairingPost(personState, helperConfirm.outbound[0] as string, NOW)
    expect(after.state.stage).toBe('awaiting_confirmation')
    expect(after.state.peerConfirmed).toBe(true)
    expect(codeOf(() => pairedPeer(after.state))).toBe('invalid_stage')
  })

  it('aborts on a mismatched confirmation and tells the other side', () => {
    const { personState, helperState } = handshake()
    const wrong = safety(personState) === '000-000' ? '000-001' : '000-000'
    const result = confirmPairing({ state: personState, identity: person, entered: wrong, now: NOW })
    expect(result.matched).toBe(false)
    expect(result.state.stage).toBe('aborted')
    expect(result.state.abortReason).toBe('safety_mismatch')
    expect(result.state.localConfirmed).toBe(false)

    const notified = receivePairingPost(helperState, result.outbound[0] as string, NOW)
    expect(notified.state.stage).toBe('aborted')
    expect(notified.state.abortReason).toBe('safety_mismatch')
  })

  it('rejects a confirmation signed by the wrong device', () => {
    const { personState, helperState } = handshake()
    const forged = confirmPairing({ state: helperState, identity: generateIdentity(), entered: safety(helperState), now: NOW })
    expect(codeOf(() => receivePairingPost(personState, forged.outbound[0] as string, NOW))).toBe('bad_pairing_message')
  })

  it("rejects a reflected confirmation of the person's own", () => {
    const { personState } = handshake()
    const own = confirmPairing({ state: personState, identity: person, entered: safety(personState), now: NOW })
    expect(codeOf(() => receivePairingPost(own.state, own.outbound[0] as string, NOW))).toBe('bad_pairing_message')
  })

  it('rejects helper keys that differ from its commitment', () => {
    const { acceptPost, afterJoinState } = handshake()
    const rogue = joinPairing({ identity: generateIdentity(), name: 'Sam', code: 'ZZZZZZZZZZZZ', now: NOW })
    const forged = { ...rogue.state, pairKey: afterJoinState.pairKey, roomId: afterJoinState.roomId }
    const reveal = receivePairingPost(forged, acceptPost, NOW).outbound[0] as string
    expect(codeOf(() => receivePairingPost(afterJoinState, reveal, NOW))).toBe('commitment_mismatch')
  })

  it('rejects posts sealed with a different code', () => {
    const { state } = startPairing({ identity: person, name: 'Mom', now: NOW })
    const wrongCode = joinPairing({ identity: helper, name: 'Sam', code: generatePairingCode(), now: NOW })
    expect(codeOf(() => receivePairingPost(state, wrongCode.outbound[0] as string, NOW))).toBe('bad_pairing_message')
  })
})

describe('code lifetime', () => {
  it('rejects a join after the code expires', () => {
    const { code, state } = startPairing({ identity: person, name: 'Mom', now: NOW })
    const joined = joinPairing({ identity: helper, name: 'Sam', code, now: NOW })
    const late = state.expiresAt
    expect(state.expiresAt).toBe(NOW + DEFAULT_PAIRING_TTL_MS)
    expect(codeOf(() => receivePairingPost(state, joined.outbound[0] as string, late))).toBe('code_expired')
  })

  it('rejects confirming after expiry', () => {
    const { personState } = handshake()
    const late = personState.expiresAt
    expect(codeOf(() => confirmPairing({ state: personState, identity: person, entered: safety(personState), now: late }))).toBe('code_expired')
  })

  it('caps the lifetime even when asked for longer', () => {
    const { state } = startPairing({ identity: person, name: 'Mom', now: NOW, ttlMs: 24 * 60 * 60 * 1000 })
    expect(state.expiresAt - NOW).toBe(15 * 60 * 1000)
  })

  it('rejects a second join of a used code', () => {
    const { code, afterJoinState } = handshake()
    const second = joinPairing({ identity: generateIdentity(), name: 'Eve', code, now: NOW })
    expect(codeOf(() => receivePairingPost(afterJoinState, second.outbound[0] as string, NOW))).toBe('code_used')
  })

  it('has a finished pairing refuse further posts', () => {
    const { helperState, joinPost } = handshake()
    const { state } = abortPairing(helperState, 'cancelled')
    expect(codeOf(() => receivePairingPost(state, joinPost, NOW))).toBe('invalid_stage')
  })
})

describe('hostile pairing input', () => {
  it('refuses names with control characters', () => {
    expect(() => startPairing({ identity: person, name: 'Sam\u001b[2J', now: NOW })).toThrow()
    expect(() => startPairing({ identity: person, name: 'Sam\u202egnp', now: NOW })).toThrow()
  })
})
