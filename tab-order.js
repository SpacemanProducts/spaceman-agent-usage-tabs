.pragma library
// Tab order. `wanted` is the saved/configured list of agent ids; ids it leaves out (new agents) go after
// the listed ones in default order, then anything unknown at the very end, so no tab is ever lost.
function ordered(allIds, wanted, defaultOrder) {
  var known = {}, out = []
  allIds.forEach(function(id) { known[id] = true })
  var seq = (wanted || []).concat(defaultOrder || []).concat(allIds)
  seq.forEach(function(id) { if (known[id] && out.indexOf(id) < 0) out.push(id) })
  return out
}
// Moves `id` one place (delta -1 left, +1 right) within `order`; returns a new list.
function moveBy(order, id, delta) {
  var i = order.indexOf(id), j = i + delta, out = order.slice()
  if (i < 0 || j < 0 || j >= order.length) return out
  out[i] = order[j]; out[j] = id
  return out
}
// Moves `id` so it sits at position `to` (dragging a chip onto another).
function moveTo(order, id, to) {
  var i = order.indexOf(id), out = order.slice()
  if (i < 0 || to < 0 || to >= order.length || i === to) return out
  out.splice(i, 1); out.splice(to, 0, id)
  return out
}
// The visible tabs were reordered: put them back into the slots the visible tabs held in the full
// order, so hidden tabs keep their places.
function mergeVisible(allOrder, newVisible) {
  var vis = {}, k = 0
  newVisible.forEach(function(id) { vis[id] = true })
  return allOrder.map(function(id) { return vis[id] ? newVisible[k++] : id })
}
// A drop that changes which tab is first also changes the default agent, so the
// panel selects the new first tab. Returns its id, or "" when the first tab is
// unchanged (the selection stays where it is).
function selectAfterDrop(firstBefore, newVisibleOrder) {
  var first = newVisibleOrder.length > 0 ? newVisibleOrder[0] : ""
  return first !== "" && first !== firstBefore ? first : ""
}
