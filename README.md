# 01 Typescript Liquidator

This is an example of a Typescript liquidator. In production, we recommend using our Rust version of the liquidator for
the best performance: https://github.com/01protocol/zo-keeper

## Installation

1. Installation

```
npm i
```

2. Add bunyan for better logging

```
npm i -g bunyan
```

3. Create src/privateKey.ts:

```
PRIVATE_KEY = 'INSERT YOUR PRIVATE KEY'

```

4. Adjust src/config.ts as desired:

```
MAX_ACTIVE_LIQUIDATIONS - Max concurrent liquidations
LIQUIDATION_CHECK_INTERVAL - How often to check for liquidations accross margin accounts
MAX_LEVERAGE - Max leverage that liquidator can take on
LIQUIDATION_TOLERANCE - how sensitive liquidator is (0.99 recommended)
MAX_NOTIONAL_PER_POSITION_CLOSE - Max notional per position to close
REBALANCE_THRESHOLD - At what fraction of the margin account's notional relative to account value, account should rebalance
MAX_UNLIQUIDATED_TIME  - for how long can account stay unliquidated before liquidator will print an error
RPC_ENDPOINT - RPC endpoint for the liquidator
CLUSTER  - devnet -> Cluster.Devnet , mainnet -> Cluster.Mainnet
```

5. Run the liquidator:

```
esr src/runLiquidator.ts | bunyan
```

