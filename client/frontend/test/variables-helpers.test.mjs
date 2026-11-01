import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renameVariableInGroups, visibleVariables } from '../src/components/template/variables-helpers.js'

describe('renameVariableInGroups', () => {
  it('renames the reference inside the containing group', () => {
    const groups = [{ display: 'g1', order: 1, variables: ['mem', 'ip'] }]
    const result = renameVariableInGroups(groups, 'mem', 'memory')
    assert.deepEqual(result[0].variables, ['memory', 'ip'])
  })

  it('updates the reference in every group that contains it', () => {
    const groups = [
      { display: 'g1', order: 1, variables: ['mem'] },
      { display: 'g2', order: 2, variables: ['mem', 'port'] }
    ]
    const result = renameVariableInGroups(groups, 'mem', 'memory')
    assert.deepEqual(result[0].variables, ['memory'])
    assert.deepEqual(result[1].variables, ['memory', 'port'])
  })

  it('is a no-op when no group references the old name', () => {
    const groups = [{ display: 'g1', order: 1, variables: ['port'] }]
    const result = renameVariableInGroups(groups, 'mem', 'memory')
    assert.deepEqual(result[0].variables, ['port'])
  })

  it('returns the input unchanged when groups is not an array', () => {
    assert.equal(renameVariableInGroups(undefined, 'a', 'b'), undefined)
    assert.deepEqual(renameVariableInGroups([], 'a', 'b'), [])
  })

  it('does not mutate the original groups', () => {
    const groups = [{ display: 'g1', order: 1, variables: ['mem'] }]
    renameVariableInGroups(groups, 'mem', 'memory')
    assert.deepEqual(groups[0].variables, ['mem'])
  })
})

describe('visibleVariables', () => {
  it('drops references to variables missing from data', () => {
    const group = { display: 'g1', order: 1, variables: ['mem', 'ghost', 'ip'] }
    const data = { mem: { display: 'Memory' }, ip: { display: 'IP' } }
    assert.deepEqual(visibleVariables(group, data), ['mem', 'ip'])
  })

  it('keeps every reference when data matches', () => {
    const group = { display: 'g1', order: 1, variables: ['mem', 'ip'] }
    const data = { mem: {}, ip: {} }
    assert.deepEqual(visibleVariables(group, data), ['mem', 'ip'])
  })

  it('ignores inherited object properties', () => {
    const group = { display: 'g1', order: 1, variables: ['toString'] }
    assert.deepEqual(visibleVariables(group, {}), [])
  })

  it('tolerates a group without variables', () => {
    assert.deepEqual(visibleVariables({ display: 'g1', order: 1 }, {}), [])
  })
})
