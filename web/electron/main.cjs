// Electron shell: a real .app window whose contents are the React UI.
// The agent server runs inside this process, so there is one process tree and quitting the
// window takes every spawned agent with it.
const { app, BrowserWindow, Notification, shell, Menu } = require('electron')
const path = require('node:path')
const net = require('node:net')

const isDev = !app.isPackaged

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function startServer() {
  const port = await freePort()
  process.env.PORT = String(port)
  process.env.SERVE_STATIC = path.join(__dirname, '..', 'dist')
  // Bundled at build time; in dev the Vite server proxies to a separately run tsx server.
  require(path.join(__dirname, 'server.cjs'))
  return port
}

/** Whether something already answers at this URL, within a second. */
function reachable(url) {
  return new Promise((resolve) => {
    const request = require('node:http').get(url, (response) => { response.resume(); resolve(response.statusCode === 200) })
    request.on('error', () => resolve(false))
    request.setTimeout(1000, () => { request.destroy(); resolve(false) })
  })
}

async function createWindow() {
  // The dev instance (npm run dev) is this same app on the working tree. While it runs, this
  // window shows it instead of starting a second server that would write the same state.json.
  // A state directory of its own (the ship smoke test) means: never share.
  const attach = !process.env.ORCHESTRATOR_STATE_DIR && await reachable('http://localhost:5273')
  if (attach) console.log('[shell] attached to the dev instance on http://localhost:5273')
  const url = isDev || attach ? 'http://localhost:5273' : `http://127.0.0.1:${await startServer()}`

  const window = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    title: 'Sloperator',
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  // Links to real websites belong in the browser, not in this window.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })

  await window.loadURL(url)
  if (isDev) window.webContents.openDevTools({ mode: 'detach' })
}

/**
 * Native notifications with sound. The server calls this for a finished turn and for new
 * comments on the user's pull requests; clicking one brings the window forward.
 */
globalThis.orchestratorNotify = (notice) => {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: String(notice.title ?? 'Sloperator'),
    body: String(notice.body ?? ''),
    sound: notice.sound || 'Glass',
    silent: false,
  })
  notification.on('click', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    window.webContents.send('orchestrator:open', notice)
  })
  notification.show()
  console.log(`[notify] ${notice.sound || 'Glass'} — ${notice.title}`)
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// No agent outlives the app: take the whole tree down before the process goes away.
app.on('before-quit', () => {
  const shutdown = globalThis.orchestratorShutdown
  if (typeof shutdown === 'function') shutdown()
})

app.on('window-all-closed', () => app.quit())
