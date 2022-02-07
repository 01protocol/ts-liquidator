import {Connection, Keypair, PublicKey, Transaction} from '@solana/web3.js';
import {bs58} from '@project-serum/anchor/dist/cjs/utils/bytes';
import {Provider} from '@project-serum/anchor';
import Liquidator from './Liquidator';
import {createProgram} from '@zero_one/client'
import {PRIVATE_KEY} from './privateKey'
import {CLUSTER, RPC_ENDPOINT} from './config'
import bunyan from 'bunyan'
const log = bunyan.createLogger({name: "liquidator-wrapper"});


async function run() {
    try {
        log.info('*** LIQUIDATOR STARTED ***')
        const keyPair = Keypair.fromSecretKey(
            bs58.decode(
                PRIVATE_KEY
            )
        );
        const WALLET = {
            // @ts-ignore
            payer: keyPair,
            signTransaction: async (tx: Transaction) => {
                await tx.sign(keyPair);
                return tx;
            },
            signAllTransactions: async (txs: Transaction[]) => {
                for (const tx of txs) await tx.sign(keyPair);
                return txs;
            },
            publicKey: new PublicKey(keyPair.publicKey)
        };

        const provider = new Provider(
            new Connection(
                RPC_ENDPOINT,
                'recent'
            ),
            WALLET,
            {
                skipPreflight: true,
                preflightCommitment: 'recent',
                commitment: 'recent'
            }
        );
        const program = createProgram(provider, CLUSTER);
        const liquidator = new Liquidator(CLUSTER, program);
        await liquidator.launch();
    } catch (_) {
        log.error('*** LIQUIDATOR FAILED ***')
        log.error(_)
        log.error('*** LIQUIDATOR RESTARTING ***')
        run().then()
    }
}

log.info('*** starting liquidator ***');
run().then();
