# Third-party notices

DefiMind is under the Business Source License 1.1 (`LICENSE`). These files are not, and keep their
own terms:

- **`vendor/bigint-buffer/`**: derived from
  [bigint-buffer](https://github.com/no2chem/bigint-buffer) 1.1.5, Apache License 2.0
  (`vendor/bigint-buffer/LICENSE`). Only its JavaScript path is kept.
- **`packages/onchain/test/fixtures/squads_v4.so`**: the Squads Protocol v4 program as deployed on
  Solana mainnet, unmodified, used only by the tests to run the real program in a local VM. Its
  source and license are at [Squads-Protocol/v4](https://github.com/Squads-Protocol/v4).
- **`packages/onchain/test/fixtures/jupiter-swap.json`**: account data and a swap transaction
  recorded from Solana mainnet, used only by the tests.

npm dependencies keep their own licenses, as listed in `pnpm-lock.yaml`.
