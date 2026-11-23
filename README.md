# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/4orky/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/4orky/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar that scores 198 pre-token DeFi protocols by implied launch value. Instead of one flat multiple, radar-2 calibrates category multiples on the snapshot itself — median market-cap-per-TVL of live-token protocols per category — then adjusts for growth momentum, maturity and chain breadth. Ships with a static dashboard (board, protocol detail, filtered views) and a six-step farm plan per protocol.

## Run it

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

`snapshot.json` is the competition's frozen DefiLlama protocol snapshot (758 protocols, TVL ≥ $5M). The run writes `board.json`, `data.js`, the static dashboard, three screenshots and `dossier.json` into `out/`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
