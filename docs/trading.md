# Trading

An agent can buy and sell tokens on **Solana mainnet, through Jupiter**, under limits you set. You
can also trade by hand from the panel. Trading is off for every agent until you turn it on.

> **Not financial advice.** DefiMind checks a trade's mechanics: limits, the token's onchain facts, and
> what the transaction really does. It does not judge whether a token is a good buy. A token can lose
> all its value.

## Before the first trade

DefiMind's spending wallet pays each trade's network fee, and about 0.002 SOL the first time it
holds a new token. Keep about 1 dollar of SOL in it: the panel shows its address and balance
under **Add money** and in **Settings**, as in [getting-started](./getting-started.md). The vault needs USDC for the buys.

## Turn trading on for an agent

In the panel, open the agent and find **Trading**:

1. Tick **Let this agent trade**.
2. Set its three limits, in dollars:
   - **Each buy**: the most one buy may spend;
   - **All buys in a day**: the most its buys may spend in a day. Sells do not count;
   - **Held in one token**: the most it may hold in one token, at what it paid.
3. Set **Slippage up to** and **Price impact up to**, in percent. The defaults are 1% and 3%.
4. Allow the tokens it may buy, below. Or tick **Any token that passes the risk checks**, which is
   looser.
5. Press **Save trading**. Turning trading on, adding a token or raising a limit asks for your
   passkey.

The vault's onchain daily limit still applies: dollars for a buy come out of the same daily limit
as payments.

**Start in shadow mode.** In shadow mode the agent's trades are checked and test-run in full, but
nothing is signed. The agent page shows what it would have bought, and how often a live trade would
have asked you first. Press **Go live with passkey** once you are happy with what you see.

## Allow a token: search, then read the risk card

Under **Find a token**, search by name, symbol or mint address. Names and symbols are what Jupiter
lists, and anyone can copy them. **The mint address is what identifies a token**: compare all of
it. Unverified tokens are hidden until you tick **Show unverified tokens**.

**Check risk** opens the token's card:

- **Read from the chain by DefiMind:**
  - whether its issuer can freeze holders, or still mint more;
  - its Token-2022 extensions, if any;
  - whether there is a route to sell it back, and at what price impact.
- **What Jupiter says (not checked):** verified or not, holders, liquidity, and listing date.

**Allow this token with passkey** adds it to that agent's list.

## Trade by hand

On an agent with trading on and at least one token allowed, **Trade by hand** opens a trade for that
agent:

1. Choose **Buy with dollars** or **Sell back to dollars**, the token, and the amount.
2. **Get quote** shows what you would receive at least, the slippage, the price impact, and the cost
   of selling it back now.
3. **Trade with passkey** signs it. The trade runs through that agent's own limits and checks, so it
   counts in its day, and nothing waits for a second approval.

If the price moved and the trade would now give less than the quote showed, it is refused, and
nothing is signed.

## When an agent's buy waits for you

An agent's buy comes to you for approval, in the panel and on Telegram, when:

- it is at or above the agent's approval threshold;
- **NEW_TOKEN**: it is the first buy of this token by any of your agents;
- **MINT_AUTHORITY**: the token can still be minted, so its supply is not fixed.

Nothing leaves the vault while a buy waits. Sells never wait.

## Why a trade is refused

| Code                  | In plain words                                                     |
| --------------------- | ------------------------------------------------------------------ |
| TRADING_DISABLED      | Trading is off for this agent.                                     |
| TOKEN_NOT_TRADABLE    | The token is not on this agent's list.                             |
| TRADE_EXCEEDED        | The buy is above **Each buy**.                                     |
| TRADE_DAILY_EXCEEDED  | Today's buys would go above **All buys in a day**.                 |
| POSITION_EXCEEDED     | The agent would hold more than **Held in one token**.              |
| SLIPPAGE_TOO_HIGH     | The quote allows more slippage than the limit, or the price moved. |
| PRICE_IMPACT_TOO_HIGH | The trade would move the price more than the limit.                |
| TOKEN_FREEZABLE       | Its issuer can freeze holders, so the tokens could be locked.      |
| TOKEN_EXTENSION_RISK  | It has a Token-2022 extension that can take or lock tokens.        |
| NO_EXIT_ROUTE         | There is no way to sell it back at an acceptable price.            |
| PAUSED                | The agent is paused.                                               |

A trade whose test run shows anything other than what was asked is refused too, and nothing is
signed.

## Close positions

In an emergency, **Stop everything** pauses every agent. On the same page, **Close positions with
passkey** sells every token your agents hold back to the dollar, through the same checks. It works
while agents are paused. **Portfolio** shows what your agents hold, at what they paid.

## For agent builders

Agents trade through the MCP tools `quote`, `swap` and `get_portfolio`. See "For agent builders" in
[`packages/mcp-server/README.md`](../packages/mcp-server/README.md).
