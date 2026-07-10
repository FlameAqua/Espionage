// Strip credentials from 3CX entity data before it reaches the renderer or a
// saved snapshot. These fields (SIP/deskphone passwords, voicemail PIN, SIP
// auth id) are never used by the graph and must never be shown or persisted —
// a snapshot is a shareable file, so leaking them would be a real exposure.

// Match: any *Password, plus AuthID and VMPIN (exact, case-insensitive).
const SENSITIVE = /password$|^(?:authid|vmpin)$/i

const REDACTED = '[redacted]'

/** Deep-copy `value`, replacing any credential field's non-empty string with a
 *  placeholder. Non-sensitive data is preserved. */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) && typeof v === 'string' && v !== '' ? REDACTED : redactSecrets(v)
    }
    return out as unknown as T
  }
  return value
}
