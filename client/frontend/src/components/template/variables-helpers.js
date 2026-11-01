// Helpers for the template variable editor.
// Kept pure so the group/reference invariants are testable without a browser.

export function renameVariableInGroups(groups, oldName, newName) {
  if (!Array.isArray(groups)) {
    return groups
  }
  return groups.map((group) => ({
    ...group,
    variables: (group.variables || []).map((name) => (name === oldName ? newName : name))
  }))
}

export function visibleVariables(group, data) {
  return (group.variables || []).filter((name) => Object.hasOwn(data, name))
}
