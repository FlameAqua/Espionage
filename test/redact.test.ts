import { describe, it, expect } from 'vitest'
import { redactSecrets } from '../src/shared/redact'

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
