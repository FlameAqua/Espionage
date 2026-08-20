// Reading a Call Flow Designer script for DNs it mentions.
//
// The value of this is entirely in what it refuses to claim, so most of these
// tests are about NOT matching: numbers that aren't DNs, DNs that are only part
// of a longer number, and DNs sitting in comments.

import { describe, it, expect } from 'vitest'
import {
  scanScriptForDns,
  groupRefs,
  parseCfdTransfers
} from '../src/renderer/src/graph/script-refs'

const DNS = ['2001', '2002', '8000', '800', '7771']

describe('scanScriptForDns', () => {
  it('finds a DN and reports the line it sat on', () => {
    const refs = scanScriptForDns('var x = 1;\ncall.TransferTo("8000");', DNS)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ number: '8000', line: 2 })
    expect(refs[0].text).toBe('call.TransferTo("8000");')
  })

  it('ignores numbers that are not DNs on this system', () => {
    // Timeouts, ports and sizes are the bulk of the numbers in any script.
    const refs = scanScriptForDns('Thread.Sleep(30000);\nvar port = 5060;', DNS)
    expect(refs).toEqual([])
  })

  it('will not match a DN inside a longer number', () => {
    // 8000 must not be found in 18000 or 80001 — this is the difference between
    // a lead and a coincidence.
    const refs = scanScriptForDns('var a = 18000; var b = 80001;', DNS)
    expect(refs).toEqual([])
  })

  it('prefers the longest DN when one contains another', () => {
    const refs = scanScriptForDns('TransferTo("8000");', ['800', '8000'])
    expect(refs.map((r) => r.number)).toEqual(['8000'])
  })

  it('skips comment-only lines', () => {
    const script = ['// old flow sent these to 8000', '# was 2001', 'TransferTo("2002");'].join(
      '\n'
    )
    expect(scanScriptForDns(script, DNS).map((r) => r.number)).toEqual(['2002'])
  })

  it('does not report the route point mentioning its own DN', () => {
    const refs = scanScriptForDns('if (dn == "7771") { }', DNS, { self: '7771' })
    expect(refs).toEqual([])
  })

  it('ignores DNs too short to mean anything', () => {
    // A one- or two-digit DN matches array indices and years everywhere.
    expect(scanScriptForDns('var a = [0]; var y = 20;', ['0', '20'])).toEqual([])
  })

  it('reports one reference per DN per line', () => {
    const refs = scanScriptForDns('Route("2001", "2001");', DNS)
    expect(refs).toHaveLength(1)
  })

  it('finds the same DN again on a later line', () => {
    const refs = scanScriptForDns('TransferTo("2001");\nlog();\nTransferTo("2001");', DNS)
    expect(refs.map((r) => r.line)).toEqual([1, 3])
  })

  it('clips a very long line of evidence', () => {
    const refs = scanScriptForDns(`x("8000"); ${'y'.repeat(500)}`, DNS)
    expect(refs[0].text.length).toBeLessThan(200)
    expect(refs[0].text.endsWith('…')).toBe(true)
  })

  it('caps how many references it will report', () => {
    const script = Array.from({ length: 500 }, () => 'TransferTo("2001");').join('\n')
    expect(scanScriptForDns(script, DNS, { maxRefs: 10 })).toHaveLength(10)
  })

  it('handles an empty or absent script', () => {
    expect(scanScriptForDns('', DNS)).toEqual([])
    expect(scanScriptForDns('anything', [])).toEqual([])
  })
})

describe('groupRefs', () => {
  it('collapses to one entry per DN, keeping every line', () => {
    const refs = scanScriptForDns('a("2001");\nb("2002");\nc("2001");', DNS)
    const grouped = groupRefs(refs)
    expect(grouped.map((g) => g.number).sort()).toEqual(['2001', '2002'])
    expect(grouped.find((g) => g.number === '2001')!.refs.map((r) => r.line)).toEqual([1, 3])
  })
})

describe('parseCfdTransfers', () => {
  // Lifted verbatim from a real Call Flow Designer app on a live system.
  const cfd = [
    '            CreateDateTimeCondition1.ContainerList.Add(new SequenceContainerComponent("CreateDateTimeCondition1_0", callflow, myCall, logHeader));',
    '            TransferComponent TransferTo8023MainIVRDay = new TransferComponent("TransferTo8023MainIVRDay", callflow, myCall, logHeader);',
    '            TransferTo8023MainIVRDay.DestinationHandler = () => { return Convert.ToString(8023); };',
    '            TransferTo8023MainIVRDay.DelayMilliseconds = 500;',
    '            TransferComponent TransferTo8023MainIVRNight = new TransferComponent("TransferTo8023MainIVRNight", callflow, myCall, logHeader);',
    '            TransferTo8023MainIVRNight.DestinationHandler = () => { return Convert.ToString(8023); };',
    '            TransferComponent TransferTo8057WeekendIVR = new TransferComponent("TransferTo8057WeekendIVR", callflow, myCall, logHeader);',
    '            TransferTo8057WeekendIVR.DestinationHandler = () => { return Convert.ToString(8057); };'
  ].join('\n')

  it('pulls the destination out of every transfer component', () => {
    const t = parseCfdTransfers(cfd)
    expect(t.map((x) => x.number)).toEqual(['8023', '8023', '8057'])
  })

  it('reads the branch name the CFD author gave it', () => {
    const t = parseCfdTransfers(cfd)
    expect(t.map((x) => x.label)).toEqual(['Main IVR Day', 'Main IVR Night', 'Weekend IVR'])
  })

  it('reports the line that set each destination', () => {
    expect(parseCfdTransfers(cfd).map((x) => x.line)).toEqual([3, 6, 8])
  })

  it('is not fooled by DelayMilliseconds or container names', () => {
    // 500 and CreateDateTimeCondition1_0 are on neighbouring lines; neither is
    // a destination.
    expect(parseCfdTransfers(cfd).some((x) => x.number === '500')).toBe(false)
  })

  it('handles a plain quoted return as well as Convert.ToString', () => {
    const t = parseCfdTransfers('X.DestinationHandler = () => { return "8000"; };')
    expect(t[0]).toMatchObject({ number: '8000' })
  })

  it('finds nothing in a script with no transfers', () => {
    expect(parseCfdTransfers('var x = 1;')).toEqual([])
  })
})
