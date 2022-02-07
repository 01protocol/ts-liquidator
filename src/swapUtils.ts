import {Connection, PublicKey, SYSVAR_RENT_PUBKEY} from '@solana/web3.js'
import {Buffer} from 'buffer'
import {TOKEN_PROGRAM_ID} from '@solana/spl-token'
import {Market as SerumMarket} from '@zero_one/lite-serum';
import {
    getMintDecimals,
    Margin,
    SERUM_DEVNET_SPOT_PROGRAM_ID,
    SERUM_MAINNET_SPOT_PROGRAM_ID,
    State,
    USDC_DECIMALS,
    ZERO_ONE_DEVNET_PROGRAM_ID,
    Zo
} from '@zero_one/client'
import {Program} from '@project-serum/anchor'
import BN from 'bn.js'


export class Swapper {

    constructor(
        private readonly state: State,
        private readonly program: Program<Zo>,
        private readonly margin: Margin) {
    }

    async getSwapIx({
                        buy,
                        tokenMint,
                        fromSize,
                        allowBorrow,
                        serumMarket
                    }: Readonly<{
        buy: boolean;
        tokenMint: PublicKey;
        fromSize: number;
        allowBorrow: boolean;
        serumMarket: PublicKey;
    }>) {
        const connection = this.program.provider.connection;
        const program = this.program;
        const margin = this.margin;
        const state = this.state;
        if (state.data.totalCollaterals < 1) {
            throw new Error(
                `<State ${state.pubkey.toString()}> does not have a base collateral`
            );
        }

        const market = await this.getMarket(connection, serumMarket, program);

        const colIdx = state.getCollateralIndex(tokenMint);
        const stateQuoteMint = state.data.collaterals[0]!.mint;
// TODO: optimize below to avoid fetching
        const baseDecimals = await this.getMintDecimals(connection, tokenMint);

        const amount = buy
            ? new BN(fromSize).mul(new BN(10 ** USDC_DECIMALS))
            : new BN(fromSize).mul(new BN(10 ** baseDecimals));
        const minRate = new BN(1);


        const vaultSigner: PublicKey = await PublicKey.createProgramAddress(
            [
                market.address.toBuffer(),
                market.decoded.vaultSignerNonce.toArrayLike(Buffer, 'le', 8)
            ],
            program.programId.equals(ZERO_ONE_DEVNET_PROGRAM_ID)
                ? SERUM_DEVNET_SPOT_PROGRAM_ID
                : SERUM_MAINNET_SPOT_PROGRAM_ID
        );

        return program.instruction.swap(buy, allowBorrow, amount, minRate, {
            accounts: {
                authority: program.provider.wallet.publicKey,
                state: state.pubkey,
                stateSigner: state.signer,
                cache: state.data.cache,
                margin: margin.pubkey,
                control: margin.control.pubkey,
                quoteMint: stateQuoteMint,
                quoteVault: state.data.vaults[0]!,
                assetMint: tokenMint,
                assetVault: state.getVaultCollateralByMint(tokenMint)[0],
                swapFeeVault: state.data.swapFeeVault,
                serumOpenOrders: state.data.collaterals[colIdx]!.serumOpenOrders,
                serumMarket,
                serumRequestQueue: market.decoded.requestQueue,
                serumEventQueue: market.decoded.eventQueue,
                serumBids: market.bidsAddress,
                serumAsks: market.asksAddress,
                serumCoinVault: market.decoded.baseVault,
                serumPcVault: market.decoded.quoteVault,
                serumVaultSigner: vaultSigner,
                srmSpotProgram: program.programId.equals(
                    ZERO_ONE_DEVNET_PROGRAM_ID
                )
                    ? SERUM_DEVNET_SPOT_PROGRAM_ID
                    : SERUM_MAINNET_SPOT_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY
            }
        });
    }


    mintDecimals = {}

    private async getMintDecimals(connection: Connection, tokenMint: PublicKey) {
        if (this.mintDecimals[tokenMint.toString()]) {
            return this.mintDecimals[tokenMint.toString()]
        }
        this.mintDecimals[tokenMint.toString()] = await getMintDecimals(connection, tokenMint)
        return this.mintDecimals[tokenMint.toString()]
    }

    serumMarkets = {}

    private async getMarket(connection: Connection, serumMarket: PublicKey, program: Program<Zo>) {
        if (this.serumMarkets[serumMarket.toString()])
            return this.serumMarkets[serumMarket.toString()]
        this.serumMarkets[serumMarket.toString()] = await SerumMarket.load(
            connection,
            serumMarket,
            {},
            program.programId.equals(ZERO_ONE_DEVNET_PROGRAM_ID)
                ? SERUM_DEVNET_SPOT_PROGRAM_ID
                : SERUM_MAINNET_SPOT_PROGRAM_ID
        )
        return this.serumMarkets[serumMarket.toString()]
    }
}
