import {Cluster} from '@zero_one/client'

export const MAX_ACTIVE_LIQUIDATIONS = 10;
export const LIQUIDATION_CHECK_INTERVAL = 100;
export const MAX_LEVERAGE = 5;
export const LIQUIDATION_TOLERANCE = 0.99;
export const MAX_NOTIONAL_PER_POSITION_CLOSE = 100_000;
export const REBALANCE_THRESHOLD = 0.05;
export const MAX_UNLIQUIDATED_TIME = 700000;
export const RPC_ENDPOINT = 'https://api.devnet.rpcpool.com/'
export const CLUSTER = Cluster.Devnet
