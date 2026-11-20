// Query polling for the server stats view, kept free of framework imports
// so it can be tested with node --test like the other frontend helpers.

// Creates a poller for a server's query endpoint.
// The first request runs immediately, later requests follow every intervalMs.
// A failed request stops polling for good, so an unreachable game server or a
// dead session cannot repeat a failing request every interval; no error is
// rendered here, which keeps translation keys out of this path entirely.
export function createQueryPoller(server, {
  intervalMs = 30000,
  onUpdate = () => {},
  schedule = (fn, ms) => setInterval(fn, ms),
  cancel = handle => clearInterval(handle)
} = {}) {
  let handle = null
  let stopped = false
  let inFlight = false

  function stop() {
    stopped = true
    if (handle !== null) {
      cancel(handle)
      handle = null
    }
  }

  const tick = async () => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      onUpdate(await server.getQuery())
    } catch {
      stop()
      return
    } finally {
      inFlight = false
    }
    if (!stopped && handle === null) {
      handle = schedule(tick, intervalMs)
    }
  }

  return {
    // polls only when the server supports the query protocol
    start: async () => {
      try {
        if (await server.canQuery()) await tick()
      } catch {
        stop()
      }
    },
    stop
  }
}
