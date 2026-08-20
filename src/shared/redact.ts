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

/** A Call Flow Designer script's own source, as carried on a route point. */
const SCRIPT_FIELDS = ['ScriptCode', 'RejectedCode'] as const
const WITHHELD = '[script withheld from snapshot]'

/**
 * Drop route-point script sources from a topology about to be written to disk.
 *
 * The source is wanted on screen — it is the only thing that says what a route
 * point actually does — so it travels to the renderer intact. A snapshot is a
 * different matter: it is a file people send each other, and a script that talks
 * to a CRM or an API routinely has the key for it written into the source.
 *
 * Kept apart from redactSecrets because it is a different judgement: that names
 * fields which are definitely credentials, this withholds a whole document for
 * what it might contain. The placeholder is deliberate — "no script deployed"
 * and "script not in this file" have to stay tellable apart.
 */
export function stripScriptSource<T extends { callFlowApps?: { value: unknown[] } }>(
  topology: T
): T {
  const set = topology.callFlowApps
  if (!set?.value?.length) return topology
  return {
    ...topology,
    callFlowApps: {
      ...set,
      value: set.value.map((raw) => {
        if (!raw || typeof raw !== 'object') return raw
        const out = { ...(raw as Record<string, unknown>) }
        for (const f of SCRIPT_FIELDS) if (typeof out[f] === 'string' && out[f]) out[f] = WITHHELD
        return out
      })
    }
  }
}
