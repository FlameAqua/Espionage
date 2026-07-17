import { describe, it, expect } from 'vitest'
import { UndoManager, type UndoEntry } from '../src/renderer/src/ui/history'

const nav = (from: string | null, to: string | null): UndoEntry => ({ type: 'nav', from, to })
const move = (id: string): UndoEntry => ({
  type: 'move',
  moves: [{ id, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } }]
})

describe('UndoManager', () => {
  it('undoes and redoes entries in LIFO order', () => {
    const m = new UndoManager()
    m.push(nav(null, 'a'))
    m.push(nav('a', 'b'))
    expect(m.canUndo()).toBe(true)
    expect(m.undo()).toEqual(nav('a', 'b'))
    expect(m.undo()).toEqual(nav(null, 'a'))
    expect(m.undo()).toBeNull()
    expect(m.canRedo()).toBe(true)
    expect(m.redo()).toEqual(nav(null, 'a'))
    expect(m.redo()).toEqual(nav('a', 'b'))
    expect(m.redo()).toBeNull()
  })

  it('clears the redo stack when a new action is pushed', () => {
    const m = new UndoManager()
    m.push(nav(null, 'a'))
    m.undo()
    expect(m.canRedo()).toBe(true)
    m.push(nav(null, 'b'))
    expect(m.canRedo()).toBe(false)
  })

  it('collapses consecutive navigations to the same target', () => {
    const m = new UndoManager()
    m.push(nav(null, 'a'))
    m.push(nav('a', 'a')) // e.g. a tap immediately followed by a focus of the same node
    expect(m.undo()).toEqual(nav(null, 'a'))
    expect(m.undo()).toBeNull()
  })

  it('suppresses recording inside run()', () => {
    const m = new UndoManager()
    m.run(() => m.push(move('x')))
    expect(m.canUndo()).toBe(false)
  })

  it('keeps moves and navigations on one timeline', () => {
    const m = new UndoManager()
    m.push(nav(null, 'a'))
    m.push(move('x'))
    expect(m.undo()?.type).toBe('move')
    expect(m.undo()?.type).toBe('nav')
  })

  it('clears both stacks', () => {
    const m = new UndoManager()
    m.push(nav(null, 'a'))
    m.undo()
    m.clear()
    expect(m.canUndo()).toBe(false)
    expect(m.canRedo()).toBe(false)
  })
})
