// Sokoban solver for make.fun's sokoban-solver-01: push-optimal by construction of the levels.
// Every level is a hallway with independent rooms off it (a box pushed into the hallway can never
// come back), and the level's push optimum P* is the sum of its rooms' optima. So: cut the level
// into rooms exactly as the generator's geometry implies, solve each room push-optimally with an
// A* over pushes (cost 1 a push; the estimate is a minimum-cost matching of boxes to goals over
// true push distances, which never overestimates), then stitch the rooms together with walks.
// Two sound deadlock prunes keep the search small: a box pushed onto a square from which no goal
// is reachable (dead square) and a box frozen in a 2x2 block of walls and boxes off its goal.
// All budgets are counted in expanded states, never the clock, so two runs answer byte for byte.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];
/** Work budgets, in expanded states: per search, and across the whole set. */
const ROOM_BUDGET = 1_000_000;
const SET_BUDGET = 6_000_000;

/** A level in XSB text: width, height, walls (the outer frame is wall), goals, boxes, player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** Push distances to one goal over open floor (other boxes ignored): dist[s] is the fewest pushes
 *  that bring a box from s onto the goal, or -1 when no push can. Pulled back from the goal: a box
 *  at y is pushed by d onto x when the square y - d, where the player stands, is open floor. */
function pushDistances(w, wall, goal) {
  const dist = new Int32Array(wall.length).fill(-1);
  dist[goal] = 0;
  const queue = [goal];
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (dist[y] === -1 && !wall[y] && !wall[y - d]) {
        dist[y] = dist[x] + 1;
        queue.push(y);
      }
    }
  }
  return dist;
}

/** The squares the player reaches from `from` around walls and the boxes in `occupied`, marked in
 *  `seen` with `stamp`; returns the region's lowest square, the state's canonical player mark. */
function reach(w, wall, occupied, from, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (!wall[q0] && !occupied[q0] && seen[q0] !== stamp) { seen[q0] = stamp; stack[n++] = q0; }
    if (!wall[q1] && !occupied[q1] && seen[q1] !== stamp) { seen[q1] = stamp; stack[n++] = q1; }
    if (!wall[q2] && !occupied[q2] && seen[q2] !== stamp) { seen[q2] = stamp; stack[n++] = q2; }
    if (!wall[q3] && !occupied[q3] && seen[q3] !== stamp) { seen[q3] = stamp; stack[n++] = q3; }
  }
  return low;
}

/** Whether the box just pushed to `t` sits frozen in a 2x2 block of walls and boxes, off a goal. */
function frozenBlock(w, wall, occupied, goal, t) {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Every assignment of the boxes to distinct goals, as permutations of goal indexes. */
function permutations(n) {
  const out = [];
  const cur = [];
  const used = new Array(n).fill(false);
  const build = () => {
    if (cur.length === n) { out.push(cur.slice()); return; }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      build();
      cur.pop();
      used[i] = false;
    }
  };
  build();
  return out;
}

/**
 * The push-optimal solution of one (sub-)level: {pushes, sequence} where sequence is the list of
 * pushes [from, to], or null when the budget runs out first. A* over pushes: a state is the boxes
 * plus the player's reachable region (named by its lowest square); the estimate is the cheapest
 * matching of boxes to goals over the push distances, admissible, so the first solved state the
 * heap hands over is push-optimal.
 */
function solveOptimal(level, budget) {
  const { w, wall, goals, boxes: start, player } = level;
  const size = wall.length;
  const n = start.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dists = goals.map((g) => pushDistances(w, wall, g));
  const live = new Uint8Array(size);
  for (let s = 0; s < size; s++) for (let gi = 0; gi < n; gi++) if (dists[gi][s] >= 0) { live[s] = 1; break; }
  if (start.some((b) => !live[b])) return null;
  const perms = n <= 6 ? permutations(n) : null;
  const estimate = (boxes) => {
    if (perms !== null) {
      let bestEst = Infinity;
      for (const p of perms) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const d = dists[p[i]][boxes[i]];
          if (d < 0) { sum = Infinity; break; }
          sum += d;
        }
        if (sum < bestEst) bestEst = sum;
      }
      return bestEst;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let gi = 0; gi < n; gi++) { const d = dists[gi][boxes[i]]; if (d >= 0 && d < m) m = d; }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };
  const solved = (boxes) => boxes.every((b) => goal[b]);
  if (solved(start)) return { pushes: 0, sequence: [] };
  const h0 = estimate(start);
  if (h0 === Infinity) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes, low) => String.fromCharCode(low, ...boxes);
  for (const b of start) occupied[b] = 1;
  const low0 = reach(w, wall, occupied, player, seen, ++stamp, stack);
  for (const b of start) occupied[b] = 0;

  // The states, in the order found: boxes, the player's square, pushes so far, parent, key.
  const sBoxes = [start];
  const sPlayer = [player];
  const sG = [0];
  const sParent = [-1];
  const sKey = [keyOf(start, low0)];
  const best = new Map([[sKey[0], 0]]);
  const limit = Math.min(budget.left, ROOM_BUDGET);
  // The open heap on [f, -g, state]: least f, then most pushes made, then earliest found.
  const heap = [[h0, 0, 0]];
  const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const t = heap[i]; heap[i] = heap[p]; heap[p] = t;
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        const t = heap[i]; heap[i] = heap[c]; heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, negG, s] = heapPop();
    const g = -negG;
    const boxes = sBoxes[s];
    if (best.get(sKey[s]) !== g) continue;
    if (solved(boxes)) { found = s; break; }
    if (expanded >= limit) return null;
    expanded++;
    budget.left--;
    for (const b of boxes) occupied[b] = 1;
    reach(w, wall, occupied, sPlayer[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        let next = null;
        let key = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(w, wall, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        const g2 = g + 1;
        const seen2 = best.get(key);
        if (seen2 !== undefined && seen2 <= g2) continue;
        const h = estimate(next);
        if (h === Infinity) continue;
        best.set(key, g2);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sG.push(g2);
        sParent.push(s);
        sKey.push(key);
        heapPush([g2 + h, -g2, idx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  // The pushes, first to last: the box that moved at each step of the state path.
  const path = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  const sequence = [];
  let boxes = start;
  for (const s of path) {
    const next = sBoxes[s];
    const from = boxes.find((b) => !next.includes(b));
    const to = next.find((b) => !boxes.includes(b));
    sequence.push([from, to]);
    boxes = next;
  }
  return { pushes: sequence.length, sequence };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD (first dir first). */
function walkTo(w, wall, occupied, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there reaches no
 * goal) out of the floor, and each part left that holds a box is a room. Null when the level is no
 * set of rooms (a part holding more or fewer boxes than goals, or a box in the hallway).
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const dists = goals.map((g) => pushDistances(w, wall, g));
  const cut = new Uint8Array(wall.length);
  const row = Math.floor(player / w);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (wall[i]) continue;
    let live = false;
    for (const d of dists) if (d[i] >= 0) { live = true; break; }
    if (!live) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve a whole level: room by room when it is a set of rooms, else one search over it all. */
function solveLevel(text, budget) {
  const level = parseLevel(text);
  const { w, wall } = level;
  const goalSet = new Set(level.goals);
  if (level.boxes.every((b) => goalSet.has(b))) return '';
  const rooms = roomsOf(level);
  // Play the pushes out on the real board: walk to each push's square, then push.
  const occupied = new Uint8Array(wall.length);
  for (const b of level.boxes) occupied[b] = 1;
  let player = level.player;
  let moves = '';
  const play = (sequence) => {
    for (const [from, to] of sequence) {
      const d = to - from;
      const dir = DIRS.find(([dx, dy]) => dy * w + dx === d);
      moves += walkTo(w, wall, occupied, player, from - d);
      moves += dir[3];
      occupied[from] = 0;
      occupied[to] = 1;
      player = from;
    }
  };
  if (rooms === null) {
    const whole = solveOptimal(level, budget);
    if (whole === null) return '';
    play(whole.sequence);
    return moves;
  }
  for (const room of rooms) {
    const subWall = wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) subWall[b] = 1;
    }
    const sub = {
      w,
      h: level.h,
      wall: subWall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solvedRoom = solveOptimal(sub, budget);
    if (solvedRoom === null) return '';
    play(solvedRoom.sequence);
    room.done = true;
  }
  return moves;
}

const budget = { left: SET_BUDGET };
for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'), budget);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
