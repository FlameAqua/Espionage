import { describe, it, expect } from 'vitest'
import { redactSecrets, stripScriptSource } from '../src/shared/redact'

describe('redactSecrets', () => {
  it('redacts passwords, AuthID and VMPIN at any depth', () => {
    const out = redactSecrets({
      Name: 'Reception',
      SIPPassword: 'secret',
      AuthID: 'abc123',
      VMPIN: '4242',
      nested: { WebPassword: 'hunter2' }
    })
    expect(out.SIPPassword).toBe('[redacted]')
    expect(out.AuthID).toBe('[redacted]')
    expect(out.VMPIN).toBe('[redacted]')
    expect((out.nested as { WebPassword: string }).WebPassword).toBe('[redacted]')
    expect(out.Name).toBe('Reception')
  })

  it('leaves empty credential fields untouched', () => {
    expect(redactSecrets({ Password: '' }).Password).toBe('')
  })

  it('preserves arrays and non-sensitive data', () => {
    const out = redactSecrets({ Agents: [{ Number: '2001' }, { Number: '2002' }] })
    expect(out.Agents).toHaveLength(2)
    expect(out.Agents[0].Number).toBe('2001')
  })
})

describe('stripScriptSource', () => {
  const topo = {
    baseUrl: 'https://pbx.example.com',
    callFlowApps: {
      path: '/xapi/v1/CallFlowApps',
      value: [
        { Number: '7771', Name: 'onecontact', ScriptCode: 'var apiKey = "sk-live-abc123";' },
        { Number: '7772', Name: 'no script yet' }
      ]
    }
  }

  it('withholds the script source a snapshot would otherwise carry', () => {
    // The reason this exists: a CFD script that talks to a CRM routinely has the
    // key written into it, and a snapshot is a file people send each other.
    const out = stripScriptSource(topo)
    const app = out.callFlowApps.value[0] as Record<string, unknown>
    expect(app.ScriptCode).toBe('[script withheld from snapshot]')
    expect(JSON.stringify(out)).not.toContain('sk-live-abc123')
  })

  it('keeps everything else about the route point', () => {
    const app = stripScriptSource(topo).callFlowApps.value[0] as Record<string, unknown>
    expect(app.Number).toBe('7771')
    expect(app.Name).toBe('onecontact')
  })

  it('leaves "no script deployed" tellable apart from "script withheld"', () => {
    const app = stripScriptSource(topo).callFlowApps.value[1] as Record<string, unknown>
    expect(app.ScriptCode).toBeUndefined()
  })

  it('does not touch the original', () => {
    stripScriptSource(topo)
    const app = topo.callFlowApps.value[0] as Record<string, unknown>
    expect(app.ScriptCode).toContain('sk-live-abc123')
  })

  it('is a no-op on a topology without route points', () => {
    const bare = { baseUrl: 'x' }
    expect(stripScriptSource(bare)).toBe(bare)
  })
})

// Field names taken from a live v20 PBX's own responses. The first two were
// reaching the renderer and being written into shared snapshots: the old pattern
// matched `password$` and the exact words `authid` / `vmpin`, and neither of
// these is either.
describe('redactSecrets — credentials the old pattern let through', () => {
  it('redacts a trunk\u2019s SeparateAuthId', () => {
    const out = redactSecrets({ SeparateAuthId: 'abc123', Number: '8001' })
    expect(out.SeparateAuthId).toBe('[redacted]')
    expect(out.Number).toBe('8001')
  })

  it('redacts a trunk\u2019s messaging API key, nested', () => {
    const out = redactSecrets({ Messaging: { MESSAGING_API_KEY: 'k-live-1', Provider: 'generic' } })
    expect(out.Messaging.MESSAGING_API_KEY).toBe('[redacted]')
    expect(out.Messaging.Provider).toBe('generic')
  })

  it('redacts an FXS gateway\u2019s Secret and a transcription key', () => {
    const out = redactSecrets({ Secret: 's', TranscribeSecretKey: 'k', Model: 'SIP-W70B' })
    expect(out.Secret).toBe('[redacted]')
    expect(out.TranscribeSecretKey).toBe('[redacted]')
    expect(out.Model).toBe('SIP-W70B')
  })

  it('redacts a conference PIN', () => {
    expect(redactSecrets({ PinNumber: '123456' }).PinNumber).toBe('[redacted]')
  })

  // The type guard is what keeps the broad name match from eating real data.
  it('leaves non-string fields alone however they are named', () => {
    const out = redactSecrets({ PinProtected: false, PinProtectTimeout: 0, Key: 1 })
    expect(out.PinProtected).toBe(false)
    expect(out.PinProtectTimeout).toBe(0)
    expect(out.Key).toBe(1)
  })
})
