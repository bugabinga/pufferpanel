import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createQueryPoller } from '../src/components/server/query-helpers.js'

// Minimal repeating-interval double: advance(ms) fires every timer whose
// period elapsed, re-arming it like setInterval would.
function manualTimers() {
  const entries = []
  let nextHandle = 1
  let now = 0
  return {
    entries,
    schedule: (fn, ms) => {
      const entry = { fn, period: ms, next: now + ms, cancelled: false, handle: nextHandle++ }
      entries.push(entry)
      return entry.handle
    },
    cancel: (handle) => {
      const entry = entries.find((e) => e.handle === handle)
      if (entry) entry.cancelled = true
    },
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const due = entries
          .filter((e) => !e.cancelled && e.next <= target)
          .sort((a, b) => a.next - b.next)[0]
        if (!due) break
        due.next += due.period
        await due.fn()
      }
      now = target
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

function makeServer({ canQuery = async () => true, getQuery = async () => ({ minecraft: { numPlayers: 1 } }) } = {}) {
  return { canQuery, getQuery }
}

const sample = { minecraft: { numPlayers: 1 } }

describe('createQueryPoller', () => {
  it('does not poll servers without query support', async () => {
    const timers = manualTimers()
    const server = makeServer({ canQuery: async () => false })
    const updates = []
    const poller = createQueryPoller(server, { onUpdate: (d) => updates.push(d), ...timers })

    await poller.start()
    await timers.advance(120000)

    assert.deepEqual(updates, [])
    assert.equal(timers.entries.length, 0)
  })

  it('updates immediately and on every interval tick', async () => {
    const timers = manualTimers()
    const updates = []
    const poller = createQueryPoller(makeServer(), { intervalMs: 30000, onUpdate: (d) => updates.push(d), ...timers })

    await poller.start()
    await timers.advance(30000)
    await timers.advance(30000)

    assert.deepEqual(updates, [sample, sample, sample])
  })

  it('stops polling for good when a query request fails', async () => {
    const timers = manualTimers()
    let calls = 0
    const server = makeServer({
      getQuery: async () => {
        calls++
        if (calls === 2) throw new Error('query endpoint failed')
        return { minecraft: { numPlayers: calls } }
      }
    })
    const updates = []
    const poller = createQueryPoller(server, { intervalMs: 30000, onUpdate: (d) => updates.push(d), ...timers })

    await poller.start()
    await timers.advance(30000)
    // the failing request must cancel the timer instead of retrying every interval
    await timers.advance(30000)
    await timers.advance(30000)

    assert.equal(calls, 2)
    assert.deepEqual(updates, [{ minecraft: { numPlayers: 1 } }])
    assert.ok(timers.entries.every((e) => e.cancelled))
  })

  it('does not schedule a timer when the very first request fails', async () => {
    const timers = manualTimers()
    const server = makeServer({ getQuery: async () => { throw new Error('down') } })
    const updates = []
    const poller = createQueryPoller(server, { onUpdate: (d) => updates.push(d), ...timers })

    await poller.start()
    await timers.advance(120000)

    assert.deepEqual(updates, [])
    assert.equal(timers.entries.length, 0)
  })

  it('stops polling when the query support check itself fails', async () => {
    const timers = manualTimers()
    const server = makeServer({ canQuery: async () => { throw new Error('no session') } })
    const updates = []
    const poller = createQueryPoller(server, { onUpdate: (d) => updates.push(d), ...timers })

    await poller.start()
    await timers.advance(120000)

    assert.deepEqual(updates, [])
    assert.equal(timers.entries.length, 0)
  })

  it('skips a tick while the previous request is still in flight', async () => {
    const timers = manualTimers()
    const pending = []
    let calls = 0
    const server = makeServer({
      getQuery: () => {
        calls++
        if (calls === 1) return Promise.resolve(sample)
        return new Promise((resolve) => pending.push(resolve))
      }
    })
    const updates = []
    const poller = createQueryPoller(server, { intervalMs: 30000, onUpdate: (d) => updates.push(d), ...timers })

    await poller.start()
    const tick = timers.entries[0].fn
    const second = tick()
    await new Promise((resolve) => setImmediate(resolve))
    await tick()

    assert.equal(calls, 2)
    assert.equal(updates.length, 1)

    pending.pop()(sample)
    await second
    assert.deepEqual(updates, [sample, sample])
  })

  it('stop cancels the timer and a later start is a no-op', async () => {
    const timers = manualTimers()
    const updates = []
    const poller = createQueryPoller(makeServer(), { onUpdate: (d) => updates.push(d), ...timers })

    await poller.start()
    const entry = timers.entries[0]
    poller.stop()
    assert.ok(entry.cancelled)

    await poller.start()
    await timers.advance(120000)
    assert.deepEqual(updates, [sample])
  })
})
