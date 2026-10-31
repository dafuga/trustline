export type ProtocolErrorCode =
  | 'invalid_message'
  | 'wrong_recipient'
  | 'wrong_sender'
  | 'bad_signature'
  | 'decrypt_failed'
  | 'replay'
  | 'invalid_code'
  | 'code_expired'
  | 'code_used'
  | 'bad_pairing_message'
  | 'commitment_mismatch'
  | 'invalid_stage'

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProtocolError'
  }
}
