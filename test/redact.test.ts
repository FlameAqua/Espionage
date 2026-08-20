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
