# makefun-sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/davidkiwil271-maker/makefun-sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/davidkiwil271-maker/makefun-sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver. It decomposes each generated level into its rooms (boxes never leave their room, so a level's optimum is the sum of its rooms' optima) and solves every room with A* over pushes — state is the box set plus the player's reachable region — guided by a minimum-cost box-to-goal matching over true push distances, with dead-square and frozen 2x2 pruning. The heuristic is admissible, so the first solution found is push-optimal. Found pushes are replayed on the full board with BFS walks between pushes. All budgets are counted in expanded states, never wall-clock time, so runs are deterministic. On the kit's practice set it scores the maximum 1,000,000 (every instance at the optimal push count), in about 0.3 seconds for the whole set.

## Run it

```sh
node main.ts
```

The make.fun harness runs `node /bot/main.ts`, reading levels from `MAKEFUN_INPUT_DIR` and writing solutions to `MAKEFUN_OUTPUT_DIR`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=x0gs0vn1&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
