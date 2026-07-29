// A single undo/redo timeline mixing two kinds of user action: dragging nodes to
// new positions, and navigating between nodes. Ctrl+Z pops whichever happened
// most recently, so one shortcut both "puts a node back" and "jumps back to the
// node I was looking at", as requested.

import type { NodeMove } from '../graph/view'

export type UndoEntry =
  | { type: 'move'; moves: NodeMove[] }
  /** A navigation change: `from`/`to` are node ids, or null for the "All" (whole
   *  graph, no focus) view. */
  | { type: 'nav'; from: string | null; to: string | null }
  /** Nodes and/or edges being hidden or restored. `hidden: true` means the action
   *  hid them, so undoing restores them (and vice versa for "show all"). */
  | { type: 'hide'; nodeIds: string[]; edgeIds: string[]; edgeKinds: string[]; hidden: boolean }

export class UndoManager {
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  /** Suppresses recording while an undo/redo is itself applying changes. */
  private applying = false

  /** Record a new action, discarding any redo history (a fresh branch). */
  push(entry: UndoEntry): void {
    if (this.applying) return
    // Collapse consecutive navigations to the same target (e.g. a tap that also
    // re-centres) so undo doesn't need two presses for one visible jump.
    const top = this.undoStack[this.undoStack.length - 1]
    if (entry.type === 'nav' && top?.type === 'nav' && top.to === entry.to) return
    this.undoStack.push(entry)
    this.redoStack = []
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }
  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** Pop the most recent action for the caller to reverse. Returns null when the
   *  stack is empty. The caller applies the change inside `run()`. */
  undo(): UndoEntry | null {
    const entry = this.undoStack.pop()
    if (!entry) return null
    this.redoStack.push(entry)
    return entry
  }

  /** Pop the most recently undone action for the caller to re-apply. */
  redo(): UndoEntry | null {
    const entry = this.redoStack.pop()
    if (!entry) return null
    this.undoStack.push(entry)
    return entry
  }

  /** Run `fn` with recording suppressed, so re-applying an action's side effects
   *  (moving nodes, navigating) doesn't push new timeline entries. */
  run(fn: () => void): void {
    this.applying = true
    try {
      fn()
    } finally {
      this.applying = false
    }
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }
}
