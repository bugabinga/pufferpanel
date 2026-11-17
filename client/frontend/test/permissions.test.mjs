
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MINIMAL_SCOPES, toggleScope } from '../src/utils/permissions.js'

describe('toggleScope', () => {
  it('adds a scope that is not present yet', () => {
    assert.deepEqual(toggleScope(['login'], 'server.create'), ['login', 'server.create'])
  })

  it('removes an ordinary scope without touching the rest', () => {
    assert.deepEqual(toggleScope(['login', 'server.create', 'self.edit'], 'server.create'), ['login', 'self.edit'])
  })

  it('keeps a minimal scope set when admin is removed', () => {
    const result = toggleScope(['admin'], 'admin')
    assert.deepEqual(result, MINIMAL_SCOPES)
    assert.ok(result.indexOf('login') !== -1, 'login survives so the account can still sign in')
    assert.ok(result.indexOf('self.edit') !== -1, 'self.edit survives so the account stays editable')
  })

  it('preserves other scopes that were granted before admin', () => {
    const result = toggleScope(['server.create', 'admin'], 'admin')
    assert.deepEqual(result, ['server.create', 'login', 'self.edit'])
  })

  it('does not duplicate minimal scopes that are already present', () => {
    const result = toggleScope(['admin', 'login', 'self.edit', 'nodes.view'], 'admin')
    assert.deepEqual(result, ['login', 'self.edit', 'nodes.view'])
  })

  it('returns the input unchanged when scopes is not an array', () => {
    assert.equal(toggleScope(undefined, 'admin'), undefined)
    assert.equal(toggleScope(null, 'login'), null)
  })
})
