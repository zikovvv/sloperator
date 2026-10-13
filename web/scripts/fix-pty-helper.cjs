// node-pty ships its macOS spawn-helper without the executable bit, so every pty spawn fails
// with "posix_spawnp failed". Restore it after each install.
const { chmodSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const base = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds')
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(base, arch, 'spawn-helper')
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
