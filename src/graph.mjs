export const COLORS = ['#0098e9', '#d000a8', '#00c830', '#e08000', '#9933e8', '#e53935'];
export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 22;
export const GRAPH_PADDING = 18;

// A full-row vertical-tangent curve, split at the row boundary.
function halfCurve(from, to, top) {
  const x1 = GRAPH_PADDING + from * LANE_WIDTH, x2 = GRAPH_PADDING + to * LANE_WIDTH;
  const mid = (x1 + x2) / 2, h = ROW_HEIGHT / 2;
  return top
    ? 'M ' + mid + ' 0 C ' + (x1 * .25 + x2 * .75) + ' ' + (h * .175) + ', ' + x2 + ' ' + (h * .35) + ', ' + x2 + ' ' + h
    : 'M ' + x1 + ' ' + h + ' C ' + x1 + ' ' + (h * 1.65) + ', ' + (x1 * .75 + x2 * .25) + ' ' + (h * 1.825) + ', ' + mid + ' ' + ROW_HEIGHT;
}

export function edgePath(edge) {
  const x1 = GRAPH_PADDING + edge.from * LANE_WIDTH, x2 = GRAPH_PADDING + edge.to * LANE_WIDTH;
  const y1 = edge.start === 'top' ? 0 : ROW_HEIGHT / 2, y2 = edge.end === 'node' ? ROW_HEIGHT / 2 : ROW_HEIGHT;
  if (x1 === x2) return 'M ' + x1 + ' ' + y1 + ' V ' + y2;
  return 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + (y2 - y1) * .65) + ', ' + x2 + ' ' + (y2 - (y2 - y1) * .65) + ', ' + x2 + ' ' + y2;
}

export function graphPaths(rows, index, expanded = '') {
  const row = rows[index], previous = rows[index - 1], next = rows[index + 1], paths = [];
  for (const edge of row.edges) {
    if (edge.start === 'top') {
      const prior = previous?.edges.find(e => e.end === 'bottom' && e.to === edge.from && e.color === edge.color);
      paths.push({ color: edge.color, workingTree: !!previous?.workingTree,
        d: prior && previous.hash !== expanded ? halfCurve(prior.from, edge.to, true) : edgePath({ ...edge, end: 'node' }) });
    }
    if (edge.end === 'bottom') {
      const following = next?.edges.find(e => e.start === 'top' && e.from === edge.to && e.color === edge.color);
      paths.push({ color: edge.color, workingTree: !!row.workingTree,
        d: following && row.hash !== expanded ? halfCurve(edge.from, following.to, false) : edgePath({ ...edge, start: 'node' }) });
    }
  }
  return paths;
}

export function layoutGraph(commits) {
  let lanes = [];
  let nextColor = 0;
  let width = 1;
  return commits.map(commit => {
    const before = lanes.slice();
    let column = before.findIndex(lane => lane?.hash === commit.hash);
    if (column < 0) {
      column = before.findIndex(lane => !lane);
      if (column < 0) column = before.length;
    }
    const node = before[column] || { hash: commit.hash, color: nextColor++ % COLORS.length };
    const after = before.map(lane => lane?.hash === commit.hash ? null : lane);
    const parents = [...new Set(commit.parents)];
    after[column] = parents.length ? { hash: parents[0], color: node.color } : null;
    const edges = [];
    for (let i = 0; i < before.length; i++) {
      const lane = before[i];
      if (!lane) continue;
      edges.push({ from: i, to: lane.hash === commit.hash ? column : i, start: 'top', end: lane.hash === commit.hash ? 'node' : 'bottom', color: lane.color });
    }
    if (parents.length) edges.push({ from: column, to: column, start: 'node', end: 'bottom', color: node.color });
    // Keep each ancestry line in its lane until the parent node, not the preceding row.
    for (const hash of parents.slice(1)) {
      let to = after.findIndex((lane, i) => !lane && !before[i] && i !== column);
      if (to < 0) to = after.length;
      const color = nextColor++ % COLORS.length;
      after[to] = { hash, color };
      edges.push({ from: column, to, start: 'node', end: 'bottom', color });
    }
    while (after.length && !after.at(-1)) after.pop();
    width = Math.max(width, column + 1, before.length, after.length);
    lanes = after;
    return { hash: commit.hash, column, color: node.color, edges, width, ...(commit.workingTree ? { workingTree: true } : {}) };
  });
}
