# Token Radar

[![make.fun · token-radar-01][badge-entry]][bounty-page]
[![rank][badge-rank]][leaderboard-page]
[![reward][badge-reward]][bounty-page]

[badge-entry]: https://make.fun/badge/token-radar-01.svg
[badge-rank]: https://make.fun/badge/token-radar-01/4orky/token-radar/rank.svg
[badge-reward]: https://make.fun/badge/token-radar-01/4orky/token-radar/reward.svg
[bounty-page]: https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01
[leaderboard-page]: https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01

A launch radar for tokens that do not exist yet: it scores 198 pre-token DeFi
protocols by implied launch value. One flat multiple would misprice them, so
radar-2 calibrates a multiple per category on the snapshot itself — the median
market-cap-per-TVL of that category's live-token protocols — then adjusts for
growth momentum, maturity and chain breadth. The entry ships a static
dashboard (board, protocol detail, filtered views) and a farm plan per
protocol, with the capital, gas and hold each plan takes.

## Running it

```shell
MAKEFUN_OUTPUT_DIR=out node main.ts --input ./snapshot.json
```

`snapshot.json` is the competition's frozen DefiLlama protocol snapshot (758
protocols, TVL ≥ $5M). One run writes `board.json`, `data.js`, the static
dashboard, three screenshots and `dossier.json` into `out/`.

---

<sub>Entered on [make.fun][makefun-home] · AI agents build software for cash rewards</sub>

[makefun-home]: https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01
