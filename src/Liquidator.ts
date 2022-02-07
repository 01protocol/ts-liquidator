import {Program} from '@project-serum/anchor';
import {PublicKey, SYSVAR_RENT_PUBKEY, Transaction} from '@solana/web3.js';
import BN from 'bn.js';
import {
    Cluster,
    Margin,
    MarginsCluster,
    MarketInfo,
    sleep,
    USDC_DECIMALS,
    USDC_DEVNET_MINT_ADDRESS,
    USDC_MAINNET_MINT_ADDRESS,
    Zo,
    ZO_DEX_DEVNET_PROGRAM_ID,
    ZO_DEX_MAINNET_PROGRAM_ID,
    ZO_FUTURE_TAKER_FEE,
    ZO_OPTION_TAKER_FEE,
    ZO_SQUARE_TAKER_FEE,
    ZoMarket
} from '@zero_one/client'
import {Swapper} from './swapUtils'
import Decimal from 'decimal.js'
import {UpdateEvents} from '@zero_one/client/dist/cjs/accounts/margin/UpdateEvents'
import {
    LIQUIDATION_CHECK_INTERVAL,
    LIQUIDATION_TOLERANCE,
    MAX_ACTIVE_LIQUIDATIONS,
    MAX_LEVERAGE,
    MAX_NOTIONAL_PER_POSITION_CLOSE,
    MAX_UNLIQUIDATED_TIME,
    REBALANCE_THRESHOLD
} from './config'
import bunyan from 'bunyan'

const log = bunyan.createLogger({name: 'liquidator'});


export default class Liquidator {
    private swapper;
    // @ts-ignore
    private liquidatorMarginKey: string;

    constructor(private readonly cluster: Cluster, private readonly program: Program<Zo>) {
    }


    getTxString(tx) {
        return `https://solscan.io/tx/${tx}${this.cluster == Cluster.Devnet ? '?cluster=devnet/' : ''}`
    }

    // @ts-ignore
    private marginsCluster: MarginsCluster;
    private accountsToLiquidate: string[] = [];
    private toLiquidate: { [key: string]: Date | null } = {};
    private liquidationsActive = true;

    get state() {
        return this.marginsCluster.state;
    }

    get margins() {
        return this.marginsCluster.margins;
    }

    get liquidatorMargin() {
        return this.margins[this.liquidatorMarginKey]!;
    }

    /**
     * Liquidate an account
     * @param accountToLiquidate
     * @private
     */
    private async liquidateOrBankrupt(accountToLiquidate: string) {
        this.activeLiquidations++;
        const liqeeMargin = this.margins[accountToLiquidate]!;
        while (liqeeMargin.isLiquidatableWithTolerance(LIQUIDATION_TOLERANCE)) {
            log.info(`[${liqeeMargin.pubkey.toString()}]`,'Liquidating: ', liqeeMargin.data.authority.toString());
            if (liqeeMargin.isBankrupt) {
                await this.bankruptAccount(liqeeMargin)
                continue;
            }
            await this.liquidateAccount(liqeeMargin)
        }
        this.toLiquidate[accountToLiquidate] = null;
        this.activeLiquidations--;
        log.info(`[${liqeeMargin.pubkey.toString()}]`,'Finished liquidating: ', liqeeMargin.pubkey.toString());
    }

    private async liquidateAccount(liqeeMargin: Margin) {
        const isPerpLiq = liqeeMargin.isPerpLiquidation;
        try {
            if (isPerpLiq) {
                await this.liquidatePerp(
                    liqeeMargin,
                    liqeeMargin.largestWeightedPosition.symbol
                );
            } else {
                const assetSymbol = liqeeMargin.largestWeightedBorrow.symbol
                const assetMint = this.state.getMintBySymbol(
                    assetSymbol
                );
                const quoteSymbol = liqeeMargin.largestBalanceSymbol
                const quoteMint = this.state.getMintBySymbol(
                    quoteSymbol
                );
                await this.liquidateSpot(liqeeMargin, assetMint, quoteMint, assetSymbol, quoteSymbol);
            }
        } catch (_) {
            log.error(_);
        }
        await liqeeMargin.refresh(false);
    }

    private async bankruptAccount(liqeeMargin: Margin) {
        const assetMint = this.state.getMintBySymbol(
            liqeeMargin.largestWeightedBorrow.symbol
        );
        try {
            log.info(`[${liqeeMargin.pubkey.toString()}]`,'Bankrupting ', liqeeMargin.largestWeightedBorrow.symbol);
            await this.cancelAllOrders(liqeeMargin)
            const tx = await this.program.rpc.settleBankruptcy({
                accounts: {
                    state: this.state.pubkey,
                    cache: this.state.cache.pubkey,
                    stateSigner: this.state.signer,
                    liqor: this.program.provider.wallet.publicKey,
                    liqorMargin: this.liquidatorMargin.pubkey,
                    liqorControl: this.liquidatorMargin.control.pubkey,
                    liqeeMargin: liqeeMargin.pubkey,
                    liqeeControl: liqeeMargin.control.pubkey,
                    assetMint: assetMint
                }
            });
            log.info(`[${liqeeMargin.pubkey.toString()}]`,'Bankruptcy complete for:' + liqeeMargin.pubkey.toString() + ' tx:' + this.getTxString(tx));
        } catch (_) {
            log.error(_);
        }
        await liqeeMargin.refresh(false);
    }

    /**
     * Get max notional size available for the liquidation
     * @private
     */
    private getMaxNotionalOperationalSize() {
        return new BN(Decimal.max(this.liquidatorMargin.weightedCollateralValue.mul(MAX_LEVERAGE).minus(this.liquidatorMargin.totalPositionNotional), new Decimal(0)).toNumber())
    }

    /**
     * Liquidate spot position
     * @param margin
     * @param assetMint
     * @param quoteMint
     * @param assetSymbol
     * @param quoteSymbol
     * @private
     */
    private async liquidateSpot(
        margin: Margin,
        assetMint: PublicKey,
        quoteMint: PublicKey,
        assetSymbol: string,
        quoteSymbol: string
    ) {
        const maxReducibleAssets = new BN(margin.getMaxSpotReducibleAsset(assetSymbol, quoteSymbol).mul(10 ** this.state.assets[assetSymbol]!.decimals).toNumber())
        const finalTransfer = BN.min(
            maxReducibleAssets,
            this.getMaxNotionalOperationalSize().mul(new BN(10 ** this.state.assets[assetSymbol]!.decimals))
                .div(new BN(this.state.assets[assetSymbol]!.indexPrice.number))
        )
        const postInstructions = await this.getSpotRebalancePostInstructions(quoteMint, quoteSymbol, assetMint, assetSymbol, finalTransfer)
        const tx = await this.program.rpc.liquidateSpotPosition!((new BN(-1).mul(finalTransfer)), {
            accounts: {
                state: this.state.pubkey,
                cache: this.state.cache.pubkey,
                liqor: this.program.provider.wallet.publicKey,
                liqorMargin: this.liquidatorMargin.pubkey,
                liqorControl: this.liquidatorMargin.control.pubkey,
                liqeeMargin: margin.pubkey,
                liqeeControl: margin.control.pubkey,
                assetMint: assetMint,
                quoteMint: quoteMint
            },
            postInstructions: postInstructions
        });
        log.info(`[${margin.pubkey.toString()}]`,'Liquidated spot position' + assetSymbol + ' for ' + quoteSymbol + ': ', `${this.getTxString(tx)}`);
    }

    /**
     * Get spot rebalance post instructions
     * @param quoteMint
     * @param quoteSymbol
     * @param assetMint
     * @param assetSymbol
     * @param finalTransfer
     * @private
     */
    private async getSpotRebalancePostInstructions(quoteMint: PublicKey, quoteSymbol: string, assetMint: PublicKey, assetSymbol: string, finalTransfer: BN) {
        const usdcMintAddress = this.cluster == Cluster.Devnet ? USDC_DEVNET_MINT_ADDRESS : USDC_MAINNET_MINT_ADDRESS
        const postInstructions: any[] = [];
        if (quoteMint.toString() != usdcMintAddress.toString()) {
            const quoteSerumMarket = this.getSerumMarket(quoteSymbol)
            const sellProceedsIx = await this.swapper.getSwapIx({
                buy: false,
                tokenMint: quoteMint,
                fromSize: new BN(10000000).toNumber(),
                allowBorrow: false,
                serumMarket: quoteSerumMarket
            })
            postInstructions.push(sellProceedsIx);
        }
        if (assetMint.toString() != usdcMintAddress.toString()) {
            const assetSerumMarket = this.getSerumMarket(assetSymbol)
            const borrowedSwapIx = await this.swapper.getSwapIx({
                buy: true,
                tokenMint: assetMint,
                fromSize: finalTransfer
                    .mul(new BN(this.state.assets[assetSymbol]!.indexPrice.number))
                    .mul(new BN(10 ** USDC_DECIMALS))
                    .div(new BN(10 ** this.state.assets[assetSymbol]!.decimals))
                    .toNumber(),
                allowBorrow: false,
                serumMarket: assetSerumMarket
            })
            const sellExtraRemainder = await this.swapper.getSwapIx({
                buy: false,
                tokenMint: assetMint,
                fromSize: new BN(10000000).toNumber(),
                allowBorrow: false,
                serumMarket: assetSerumMarket
            })
            postInstructions.push(borrowedSwapIx);
            postInstructions.push(sellExtraRemainder);
        }
        return postInstructions
    }

    private getSerumMarket(symbol: string) {
        if (this.cluster == Cluster.Devnet)
            return new PublicKey('9vNzQmmG7c3aXuTdKKULQW2oGrYsfGZ1uRsMtgZ2APJF')
        throw new Error(symbol + ' not found')
    }

    /**
     * Liquidate perp position
     * @param margin
     * @param symbol
     * @private
     */
    private async liquidatePerp(margin: Margin, symbol: string) {
        const assetTransferLots = new BN(this.getMaxNotionalOperationalSize().toNumber() / this.state.markets[symbol]!.markPrice.number * 10 ** (this.state.markets[symbol]!.assetDecimals)).div(new BN(10 ** this.state.markets[symbol]!.assetLotSize))
        const liqorOo = await this.liquidatorMargin.getOpenOrdersInfoBySymbol(
            symbol
        );
        const market = await this.state.getMarketBySymbol(symbol);
        const isLong = margin.position(symbol).isLong;
        const liqeeOo = await margin.getOpenOrdersInfoBySymbol(symbol);
        const cancelOrdersInstruction = this.getCancelOrdersInstruction(margin, liqeeOo, market)
        const closePositionInstruction = this.getClosePositionInstruction(symbol, isLong, market, liqorOo)
        const tx = await this.program.rpc.liquidatePerpPosition!(assetTransferLots, {
            accounts: {
                state: this.state.pubkey,
                cache: this.state.cache.pubkey,
                stateSigner: this.state.signer,
                liqor: this.program.provider.wallet.publicKey,
                liqorMargin: this.liquidatorMargin.pubkey,
                liqorControl: this.liquidatorMargin.control.pubkey,
                liqorOo: liqorOo!.key,
                liqee: margin.data.authority,
                liqeeMargin: margin.pubkey,
                liqeeControl: margin.control.pubkey,
                liqeeOo: liqeeOo!.key,
                reqQ: market.requestQueueAddress,
                dexMarket: market.address,
                marketBids: market.bidsAddress,
                marketAsks: market.asksAddress,
                eventQ: market.eventQueueAddress,
                dexProgram: this.cluster != Cluster.Mainnet ? ZO_DEX_DEVNET_PROGRAM_ID : ZO_DEX_MAINNET_PROGRAM_ID
            },
            //cancel all orders b4 liquidation
            preInstructions: [
                cancelOrdersInstruction
            ],
            // repeating close position instruction in case matching limit is not enough
            postInstructions: [
                closePositionInstruction,
                closePositionInstruction,
                closePositionInstruction
            ]
        });
        log.info(`[${margin.pubkey.toString()}]`,'Liquidated Perp' + symbol + ':', `${this.getTxString(tx)}`);
        await this.liquidatorMargin.refresh(false);
    }


    /**
     * Get position close ix
     * @param symbol
     * @param isLong
     * @param market
     * @param liqorOo
     * @private
     */
    private getClosePositionInstruction(symbol: string, isLong: boolean, market: ZoMarket, liqorOo: any) {
        const assetTransferLots = market.baseSizeNumberToLots(MAX_NOTIONAL_PER_POSITION_CLOSE / this.state.markets[symbol]!.markPrice.number)
        const price = this.state.markets[symbol]!.indexPrice.number * (isLong ? 0.1 : 10);
        const limitPriceBn = market.priceNumberToLots(price);
        const takerFee =
            market.decoded.perpType.toNumber() === 1
                ? ZO_FUTURE_TAKER_FEE
                : market.decoded.perpType.toNumber() === 2
                    ? ZO_OPTION_TAKER_FEE
                    : ZO_SQUARE_TAKER_FEE;
        const feeMultiplier = isLong ? 1 + takerFee : 1 - takerFee;
        const maxQuoteQty = new BN(
            limitPriceBn
                .mul(assetTransferLots)
                .mul(market.decoded['quoteLotSize'])
                .mul(new BN(feeMultiplier * 1000)).div(new BN(1000))
        );
        return this.program.instruction.placePerpOrder(
            !isLong,
            limitPriceBn,
            assetTransferLots,
            maxQuoteQty,
            {reduceOnlyIoc: {}},
            10,
            new BN(0),
            {
                accounts: {
                    state: this.state.pubkey,
                    stateSigner: this.state.signer,
                    cache: this.state.cache.pubkey,
                    authority: this.program.provider.wallet.publicKey,
                    margin: this.liquidatorMargin.pubkey,
                    control: this.liquidatorMargin.control.pubkey,
                    openOrders: liqorOo!.key,
                    dexMarket: market.address,
                    reqQ: market.requestQueueAddress,
                    eventQ: market.eventQueueAddress,
                    marketBids: market.bidsAddress,
                    marketAsks: market.asksAddress,
                    dexProgram: this.cluster != Cluster.Mainnet ? ZO_DEX_DEVNET_PROGRAM_ID : ZO_DEX_MAINNET_PROGRAM_ID,
                    rent: SYSVAR_RENT_PUBKEY
                }
            }
        )
    }

    private async cancelAllOrders(margin: Margin) {
        for (const marketInfo of Object.values(this.state.markets)) {
            if (margin.orders.filter(order => order.symbol === marketInfo.symbol).length > 0) {
                await this.cancelOrdersOnTheMarket(marketInfo, margin)
            }
        }
    }

    private async cancelOrdersOnTheMarket(marketInfo: MarketInfo, margin: Margin) {
        const {dexMarket} = await this.state.getZoMarketAccounts(marketInfo);
        const liqeeOo = await margin.getOpenOrdersInfoBySymbol(marketInfo.symbol);
        let transaction = new Transaction()
        const ix = this.getCancelOrdersInstruction(margin, liqeeOo, dexMarket)
        transaction.add(ix)
        const tx = await this.program.provider.send(transaction);
        log.info(`[${margin.pubkey.toString()}]`,`Cancelled orders for ${marketInfo} : ${this.getTxString(tx)}`)
    }

    /**
     * Cancel all orders on the market for the liqee
     * @param margin
     * @param liqeeOo
     * @param market
     * @private
     */
    private getCancelOrdersInstruction(margin: Margin, liqeeOo: any, market: ZoMarket) {
        return this.program.instruction.forceCancelAllPerpOrders(300, {
                accounts: {
                    pruner: this.program.provider.wallet.publicKey,
                    state: this.state.pubkey,
                    cache: this.state.cache.pubkey,
                    stateSigner: this.state.signer,
                    liqeeMargin: margin.pubkey,
                    liqeeControl: margin.control.pubkey,
                    liqeeOo: liqeeOo!.key,
                    dexMarket: market.address,
                    reqQ: market.requestQueueAddress,
                    eventQ: market.eventQueueAddress,
                    marketBids: market.bidsAddress,
                    marketAsks: market.asksAddress,
                    dexProgram: this.cluster != Cluster.Mainnet ? ZO_DEX_DEVNET_PROGRAM_ID : ZO_DEX_MAINNET_PROGRAM_ID
                }
            }
        )
    }

    private liquidationPaused = false;
    private activeLiquidations = 0;

    /**
     * Function which pauses liquidator if there are too many simultaneous liquidations or liquidations are paused externally
     * @private
     */
    private async liquidationPause() {
        if (!this.isBalanced()) {
            await this.rebalance()
        }
        while (MAX_ACTIVE_LIQUIDATIONS <= this.activeLiquidations || this.liquidationPaused) {
            await sleep(100)
        }
    }

    /**
     * check if user's account is balanced(no perps, no non-usdc spot positions)
     * @private
     */
    private isBalanced() {
        return this.liquidatorMargin.totalPositionNotional.lt(this.liquidatorMargin.unweightedCollateralValue.mul(REBALANCE_THRESHOLD))
    }

    /**
     * Rebalance user's account
     * @private
     */
    private async rebalance() {
        log.info('Rebalancing')
        while (!this.isBalanced()) {
            for (const position of this.liquidatorMargin.positions) {
                if (position.coins.number != 0) {
                    try {
                        await this.closePerpPosition(position.marketKey)
                    } catch (_) {
                        log.error('Failed to close perp balance')
                        log.error(_)
                    }
                }
            }
            for (const assetSymbol of Object.keys(this.liquidatorMargin.balances)) {
                if (assetSymbol != 'USDC' && this.liquidatorMargin.balances[assetSymbol]!.number != 0) {
                    try {
                        await this.closeSpotBalance(assetSymbol)
                    } catch (_) {
                        log.error('Failed to close spot balance')
                        log.error(_)
                    }
                }
            }
            await this.liquidatorMargin.refresh()
        }
        log.info('Rebalanced')
    }

    /**
     * Close perp position
     * @param marketKey
     * @private
     */
    private async closePerpPosition(marketKey: string) {
        const liqorOo = await this.liquidatorMargin.getOpenOrdersInfoBySymbol(
            marketKey
        );
        const market = await this.state.getMarketBySymbol(marketKey);
        let transaction = new Transaction()
        transaction.add(this.getClosePositionInstruction(
            marketKey,
            this.liquidatorMargin.positions.filter(p => p.marketKey == marketKey)[0]!.isLong,
            market,
            liqorOo
        ))
        const tx = await this.program.provider.send(transaction);
        log.info(`Closed position ${marketKey} : ${this.getTxString(tx)}`)
    }

    /**
     * Close non-usdc spot position
     * @param symbol
     * @private
     */
    private async closeSpotBalance(symbol: string) {
        const usdcMintAddress = this.cluster == Cluster.Devnet ? USDC_DEVNET_MINT_ADDRESS : USDC_MAINNET_MINT_ADDRESS
        let quoteMint = usdcMintAddress
        let assetMint = usdcMintAddress
        let assetSymbol = 'USDC'
        let quoteSymbol = 'USDC'
        let finalTransfer = new BN(0)
        if (this.liquidatorMargin.balances[assetSymbol]!.number > 0) {
            quoteSymbol = symbol
            quoteMint = this.state.getMintBySymbol(quoteSymbol)
        } else {
            assetSymbol = symbol
            assetMint = this.state.getMintBySymbol(quoteSymbol)
            finalTransfer = new BN(this.liquidatorMargin.balances[assetSymbol]!.number).abs()
        }
        let transaction = new Transaction()
        let ixs = await this.getSpotRebalancePostInstructions(quoteMint, quoteSymbol, assetMint, assetSymbol, finalTransfer)
        for (const ix of ixs) {
            transaction.add(ix)
        }
        const tx = await this.program.provider.send(transaction);
        log.info(`Rebalanced spot ${symbol} : ${this.getTxString(tx)}`)
    }

    /**
     * Function which checks for liquidatable accounts every LIQUIDATION_CHECK_INTERVAL seconds
     * @private
     */
    private async liquidationCycle() {
        while (this.liquidationsActive) {
            await this.liquidationPause()
            while (this.accountsToLiquidate.length > 0) {
                await this.liquidationPause()
                const accountToLiquidate = this.accountsToLiquidate.pop();
                this.liquidateOrBankrupt(accountToLiquidate!).then();
            }
            await sleep(LIQUIDATION_CHECK_INTERVAL);
        }
    }


    /**
     * Listen to accounts changes
     * @private
     */
    private listen() {
        this.marginsCluster.eventEmitter!.on(UpdateEvents.marginModified, (key: string) => {
            this.checkMargin(this.margins[key]!)
        });
        this.marginsCluster.eventEmitter!.on(UpdateEvents.marginsReloaded, () => {
            this.findLiquidatableAccountsAndLiquidate()
        });
        this.marginsCluster.eventEmitter!.on(UpdateEvents.controlModified, () => {
            this.findLiquidatableAccountsAndLiquidate()
        });
        this.marginsCluster.eventEmitter!.on(UpdateEvents.stateModified, () => {
            this.findLiquidatableAccountsAndLiquidate()
        });
    }

    /**
     * Function which finds all liquidatable accounts
     */
    findLiquidatableAccountsAndLiquidate() {
        for (const margin of Object.values(this.marginsCluster.margins)) {
            this.checkMargin(margin)
        }
        log.info(this.accountsToLiquidate.length, 'accounts to liquidate');
    }

    /**
     * check if margin is liquidation
     * @param margin
     * @private
     */
    private checkMargin(margin: Margin) {
        if (
            margin.isLiquidatableWithTolerance(LIQUIDATION_TOLERANCE)
        ) {
            if (this.toLiquidate[margin.pubkey.toString()]) {
                if ((new Date()).getTime() - this.toLiquidate[margin.pubkey.toString()]!.getTime() > MAX_UNLIQUIDATED_TIME) {
                    log.error('Account is not liquidated after', MAX_UNLIQUIDATED_TIME, 'ms margin key:', margin.pubkey.toString())
                }
            } else {
                this.accountsToLiquidate.push(margin.pubkey.toString());
                this.toLiquidate[margin.pubkey.toString()] = new Date();
            }
        }
    }

    async launch() {
        log.info('[loading liquidator]');
        this.marginsCluster = new MarginsCluster(this.program, this.cluster);
        await this.marginsCluster.launch()
        log.info('[loaded margins cluster]');
        this.liquidatorMarginKey = (await Margin.getMarginKey(this.state, this.program.provider.wallet.publicKey, this.program))[0].toString();
        this.swapper = new Swapper(this.state, this.program, this.liquidatorMargin);
        this.listen();
        log.info('[started liquidation cycle]');
        this.findLiquidatableAccountsAndLiquidate();
        await this.liquidationCycle();
    }

    /**
     * Stop
     */
    async stop() {
        this.liquidationsActive = false;
        await this.marginsCluster.kill();
    }

}
