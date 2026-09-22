import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

test('the voice key component initializes without Timeline controls', async () => {
  const source = await readFile(new URL('./studio.js', import.meta.url), 'utf8')
  const start = source.indexOf('function apiKeyBlock(')
  assert.notEqual(start, -1)
  const end = source.indexOf('\n}\n', start)
  assert.notEqual(end, -1)
  const root = { style: {} }
  const fields = { input: {}, save: {}, note: {} }
  const component = runInNewContext(`${source.slice(start, end + 2)}; apiKeyBlock`, {
    mountRow: () => ({ root, el: fields }),
    fetch: async () => ({ status: { elevenlabs: true } }),
    responseJson: async (response) => response,
    tone: () => {},
  })
  const mounted = []
  const keys = component({ append: (node) => mounted.push(node) })
  assert.deepEqual(mounted, [root])
  assert.equal(await keys.refresh(), true)
  assert.equal(fields.save.textContent, 'Replace the key')
  assert.equal(typeof fields.save.onclick, 'function')
  keys.show(false)
  assert.equal(root.style.display, 'none')
  keys.show(true)
  assert.equal(root.style.display, '')
})
