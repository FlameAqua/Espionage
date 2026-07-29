declare module 'cytoscape-dagre' {
  import type { Ext } from 'cytoscape'
  const ext: Ext
  export default ext
}

declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape'
  const ext: Ext
  export default ext
}

// Vite raw-text imports (e.g. the bundled tariff CSV).
declare module '*?raw' {
  const content: string
  export default content
}
