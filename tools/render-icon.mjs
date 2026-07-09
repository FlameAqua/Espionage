// Rasterize build/icon.svg to PNGs using Electron's Chromium (no native deps).
// Run: npx electron tools/render-icon.mjs
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

app.disableHardwareAcceleration()

const root = new URL('../', import.meta.url)
const svg = readFileSync(new URL('build/icon.svg', root), 'utf8')
const html = `<!doctype html><html><head><style>
  *{margin:0;padding:0} html,body{width:1024px;height:1024px;overflow:hidden;background:transparent}
  svg{width:1024px;height:1024px;display:block}
</style></head><body>${svg}</body></html>`

const write = (relPath, image) =>
  writeFileSync(fileURLToPath(new URL(relPath, root)), image.toPNG())

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 500))
  const img = await win.webContents.capturePage()
  write('build/icon.png', img)
  write('resources/icon.png', img.resize({ width: 512, height: 512, quality: 'best' }))
  console.log('icon.png written:', img.getSize())
  app.quit()
})
