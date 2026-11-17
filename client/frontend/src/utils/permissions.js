
// Helpers for the user permission editor.
// Kept pure so the scope invariants are testable without a browser.

// Scopes an account needs to stay usable after it loses admin, where admin
// previously implied every scope and hid the rest of the toggles (upstream
// issue #1505: unchecking Administrator left an empty list, so saving right
// away produced an account that could not log in).
export const MINIMAL_SCOPES = ['login', 'self.edit']

export function toggleScope(scopes, scope) {
  if (!Array.isArray(scopes)) {
    return scopes
  }
  if (scopes.indexOf(scope) === -1) {
    return [...scopes, scope]
  }
  const next = scopes.filter((item) => item !== scope)
  if (scope === 'admin') {
    for (const minimal of MINIMAL_SCOPES) {
      if (next.indexOf(minimal) === -1) {
        next.push(minimal)
      }
    }
  }
  return next
}
