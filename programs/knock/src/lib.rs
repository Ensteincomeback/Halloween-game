//! Knock on-chain program (Anchor).
//!
//! Moves the parts of the game that hold other people's value out of the game
//! server's hands and into code anyone can read:
//!
//! * **Fee split**: `pay_sol` / `pay_boo` take a payment and split its fee
//!   between the house owners' pool, the raffle prize pool, a burn ($BOO only)
//!   and the treasury, by the rates in `Config`.
//! * **House market escrow**: `list_nft` locks a deed NFT in a program-owned
//!   account; `buy_nft` pays the seller (minus the fee) and hands the buyer the
//!   NFT in one transaction; `cancel_listing` returns it.
//! * **Raffle escrow**: player raffles lock the prize (an NFT or $BOO) here.
//!   Slots are bought with off-chain candy, so the game's authority names the
//!   winner (`raffle_settle`) or refunds the seller (`raffle_refund`), and can
//!   only send the prize to one of those two places.
//! * **Monster bond**: `stake` / `unstake` hold the Monster License bond, with
//!   a time-weighted `since` so a just-borrowed stake can't pass for an old one.
//!   `slash` (authority only) is for proven cheating, and is capped by `Config`.
//!
//! Build and deploy with Solana Playground (beta.solpg.io) or `anchor build`.
//! The program ID below is a placeholder; replace it with your deployed ID.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, BurnChecked, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("5pScjwBKXZ1DNCEMWHFB5Hk7yNcXTMw5CAwZCtNwxmYB");

pub const BPS: u64 = 10_000;
pub const CONFIG_SEED: &[u8] = b"config";
pub const OWNERS_POOL_SEED: &[u8] = b"owners_pool";
pub const PRIZE_POOL_SEED: &[u8] = b"prize_pool";
pub const LISTING_SEED: &[u8] = b"listing";
pub const RAFFLE_SEED: &[u8] = b"raffle";
pub const BOND_SEED: &[u8] = b"bond";
pub const BOND_VAULT_SEED: &[u8] = b"bond_vault";

/// Pure math, unit-tested below.
pub mod math {
    use super::BPS;

    /// How a payment's fee is divided. `burn` is only used for $BOO.
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub struct Split {
        pub fee: u64,
        pub owners: u64,
        pub prize: u64,
        pub burn: u64,
        pub treasury: u64,
    }

    pub fn split(amount: u64, fee_bps: u16, owners_bps: u16, prize_bps: u16, burn_bps: u16, can_burn: bool) -> Option<Split> {
        let fee = amount.checked_mul(fee_bps as u64)? / BPS;
        let part = |bps: u16| -> Option<u64> { Some(fee.checked_mul(bps as u64)? / BPS) };
        let owners = part(owners_bps)?;
        let prize = part(prize_bps)?;
        let burn = if can_burn { part(burn_bps)? } else { 0 };
        let treasury = fee.checked_sub(owners)?.checked_sub(prize)?.checked_sub(burn)?;
        Some(Split { fee, owners, prize, burn, treasury })
    }

    /// Adding to a stake pulls its start time toward now, weighted by amount.
    pub fn weighted_since(old_amount: u64, old_since: i64, added: u64, now: i64) -> Option<i64> {
        let total = (old_amount as i128).checked_add(added as i128)?;
        if total == 0 {
            return Some(now);
        }
        let w = (old_amount as i128).checked_mul(old_since as i128)?.checked_add((added as i128).checked_mul(now as i128)?)?;
        i64::try_from(w / total).ok()
    }

    /// Rates must leave something for the treasury and stay below 100%.
    pub fn valid_rates(fee_bps: u16, owners_bps: u16, prize_bps: u16, burn_bps: u16, max_slash_bps: u16) -> bool {
        (fee_bps as u64) <= 2_000
            && (owners_bps as u64) + (prize_bps as u64) + (burn_bps as u64) <= BPS
            && (max_slash_bps as u64) <= BPS
    }
}

#[program]
pub mod knock {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: ConfigArgs) -> Result<()> {
        require!(math::valid_rates(args.fee_bps, args.owners_bps, args.prize_bps, args.burn_bps, args.max_slash_bps), KnockError::BadRates);
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.treasury = args.treasury;
        c.boo_mint = ctx.accounts.boo_mint.key();
        c.fee_bps = args.fee_bps;
        c.owners_bps = args.owners_bps;
        c.prize_bps = args.prize_bps;
        c.burn_bps = args.burn_bps;
        c.max_slash_bps = args.max_slash_bps;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: ConfigArgs) -> Result<()> {
        require!(math::valid_rates(args.fee_bps, args.owners_bps, args.prize_bps, args.burn_bps, args.max_slash_bps), KnockError::BadRates);
        let c = &mut ctx.accounts.config;
        c.treasury = args.treasury;
        c.fee_bps = args.fee_bps;
        c.owners_bps = args.owners_bps;
        c.prize_bps = args.prize_bps;
        c.burn_bps = args.burn_bps;
        c.max_slash_bps = args.max_slash_bps;
        Ok(())
    }

    // ---------------- payments with an on-chain fee split ----------------

    /// Pay `amount` lamports to the game (e.g. a house deed). `memo` lets the
    /// game server match the payment to what was bought.
    pub fn pay_sol(ctx: Context<PaySol>, amount: u64, memo: [u8; 16]) -> Result<()> {
        let c = &ctx.accounts.config;
        let s = math::split(amount, c.fee_bps, c.owners_bps, c.prize_bps, c.burn_bps, false).ok_or(KnockError::Overflow)?;
        let payer = ctx.accounts.payer.to_account_info();
        let sys = ctx.accounts.system_program.to_account_info();
        sol_transfer(&sys, &payer, &ctx.accounts.treasury.to_account_info(), amount - s.fee + s.treasury)?;
        sol_transfer(&sys, &payer, &ctx.accounts.owners_pool.to_account_info(), s.owners)?;
        sol_transfer(&sys, &payer, &ctx.accounts.prize_pool.to_account_info(), s.prize)?;
        emit!(Paid { payer: payer.key(), mint: None, amount, fee: s.fee, memo });
        Ok(())
    }

    /// Pay `amount` $BOO to the game, with part of the fee burned.
    pub fn pay_boo(ctx: Context<PayBoo>, amount: u64, memo: [u8; 16]) -> Result<()> {
        let c = &ctx.accounts.config;
        let s = math::split(amount, c.fee_bps, c.owners_bps, c.prize_bps, c.burn_bps, true).ok_or(KnockError::Overflow)?;
        let a = &ctx.accounts;
        let decimals = a.boo_mint.decimals;
        let payer = a.payer.to_account_info();
        move_tokens(&a.token_program, &a.payer_boo, &a.boo_mint, &a.treasury_boo, &payer, amount - s.fee + s.treasury, None)?;
        move_tokens(&a.token_program, &a.payer_boo, &a.boo_mint, &a.owners_pool_boo, &payer, s.owners, None)?;
        move_tokens(&a.token_program, &a.payer_boo, &a.boo_mint, &a.prize_pool_boo, &payer, s.prize, None)?;
        if s.burn > 0 {
            token_interface::burn_checked(
                CpiContext::new(a.token_program.to_account_info(), BurnChecked {
                    mint: a.boo_mint.to_account_info(),
                    from: a.payer_boo.to_account_info(),
                    authority: a.payer.to_account_info(),
                }),
                s.burn,
                decimals,
            )?;
        }
        emit!(Paid { payer: a.payer.key(), mint: Some(a.boo_mint.key()), amount, fee: s.fee, memo });
        Ok(())
    }

    /// Authority: pay out of a SOL pool (owners' daily share, raffle prizes).
    pub fn withdraw_pool(ctx: Context<WithdrawPool>, pool: Pool, amount: u64) -> Result<()> {
        let (seed, bump) = match pool {
            Pool::Owners => (OWNERS_POOL_SEED, ctx.bumps.owners_pool),
            Pool::Prize => (PRIZE_POOL_SEED, ctx.bumps.prize_pool),
        };
        let from = match pool {
            Pool::Owners => ctx.accounts.owners_pool.to_account_info(),
            Pool::Prize => ctx.accounts.prize_pool.to_account_info(),
        };
        let rent_floor = Rent::get()?.minimum_balance(0);
        require!(from.lamports().saturating_sub(amount) >= rent_floor || from.lamports() == amount, KnockError::PoolTooLow);
        system_program::transfer(
            CpiContext::new_with_signer(ctx.accounts.system_program.to_account_info(), system_program::Transfer { from, to: ctx.accounts.to.to_account_info() }, &[&[seed, &[bump]]]),
            amount,
        )
    }

    // ---------------- house market escrow ----------------

    pub fn list_nft(ctx: Context<ListNft>, price: u64) -> Result<()> {
        require!(price > 0, KnockError::ZeroAmount);
        require!(ctx.accounts.nft_mint.decimals == 0 && ctx.accounts.nft_mint.supply == 1, KnockError::NotAnNft);
        let (seller, mint) = (ctx.accounts.seller.key(), ctx.accounts.nft_mint.key());
        {
            let l = &mut ctx.accounts.listing;
            l.seller = seller;
            l.mint = mint;
            l.price = price;
            l.bump = ctx.bumps.listing;
        }
        let a = &ctx.accounts;
        move_tokens(&a.token_program, &a.seller_nft, &a.nft_mint, &a.escrow_nft, &a.seller.to_account_info(), 1, None)?;
        emit!(Listed { seller, mint, price });
        Ok(())
    }

    pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
        let a = &ctx.accounts;
        let mint = a.nft_mint.key();
        let seeds: &[&[u8]] = &[LISTING_SEED, mint.as_ref(), &[a.listing.bump]];
        move_tokens(&a.token_program, &a.escrow_nft, &a.nft_mint, &a.seller_nft, &a.listing.to_account_info(), 1, Some(seeds))?;
        close_token_account(&a.token_program, &a.escrow_nft, &a.seller.to_account_info(), &a.listing.to_account_info(), seeds)
    }

    /// Buyer pays the price in SOL: seller gets price − fee, the fee is split,
    /// and the NFT moves to the buyer. All or nothing.
    pub fn buy_nft(ctx: Context<BuyNft>, max_price: u64) -> Result<()> {
        let a = &ctx.accounts;
        let price = a.listing.price;
        require!(price <= max_price, KnockError::PriceChanged);
        require_keys_neq!(a.buyer.key(), a.listing.seller, KnockError::OwnListing);
        let c = &a.config;
        let s = math::split(price, c.fee_bps, c.owners_bps, c.prize_bps, c.burn_bps, false).ok_or(KnockError::Overflow)?;
        let sys = a.system_program.to_account_info();
        let buyer = a.buyer.to_account_info();
        sol_transfer(&sys, &buyer, &a.seller.to_account_info(), price - s.fee)?;
        sol_transfer(&sys, &buyer, &a.treasury.to_account_info(), s.treasury)?;
        sol_transfer(&sys, &buyer, &a.owners_pool.to_account_info(), s.owners)?;
        sol_transfer(&sys, &buyer, &a.prize_pool.to_account_info(), s.prize)?;
        let mint = a.nft_mint.key();
        let seeds: &[&[u8]] = &[LISTING_SEED, mint.as_ref(), &[a.listing.bump]];
        move_tokens(&a.token_program, &a.escrow_nft, &a.nft_mint, &a.buyer_nft, &a.listing.to_account_info(), 1, Some(seeds))?;
        close_token_account(&a.token_program, &a.escrow_nft, &a.seller.to_account_info(), &a.listing.to_account_info(), seeds)?;
        emit!(Sold { seller: a.listing.seller, buyer: a.buyer.key(), mint, price, fee: s.fee });
        Ok(())
    }

    // ---------------- raffle escrow ----------------

    /// Lock a raffle prize: an NFT (amount 1) or some $BOO.
    pub fn raffle_deposit(ctx: Context<RaffleDeposit>, raffle_id: u64, amount: u64) -> Result<()> {
        require!(amount > 0, KnockError::ZeroAmount);
        let (seller, mint) = (ctx.accounts.seller.key(), ctx.accounts.mint.key());
        {
            let r = &mut ctx.accounts.raffle;
            r.seller = seller;
            r.mint = mint;
            r.raffle_id = raffle_id;
            r.amount = amount;
            r.bump = ctx.bumps.raffle;
        }
        let a = &ctx.accounts;
        move_tokens(&a.token_program, &a.seller_tokens, &a.mint, &a.escrow, &a.seller.to_account_info(), amount, None)
    }

    /// Authority: the prize goes to the winner the game drew.
    pub fn raffle_settle(ctx: Context<RaffleSettle>) -> Result<()> {
        release_raffle(&ctx.accounts.raffle, &ctx.accounts.token_program, &ctx.accounts.escrow, &ctx.accounts.mint, &ctx.accounts.winner_tokens, &ctx.accounts.seller)?;
        emit!(RaffleSettled { raffle: ctx.accounts.raffle.key(), winner: ctx.accounts.winner.key() });
        Ok(())
    }

    /// Authority: nobody entered, the prize goes back to the seller.
    pub fn raffle_refund(ctx: Context<RaffleRefund>) -> Result<()> {
        release_raffle(&ctx.accounts.raffle, &ctx.accounts.token_program, &ctx.accounts.escrow, &ctx.accounts.mint, &ctx.accounts.seller_tokens, &ctx.accounts.seller)
    }

    // ---------------- monster bond ----------------

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, KnockError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let owner = ctx.accounts.owner.key();
        let (total, since) = {
            let b = &mut ctx.accounts.bond;
            b.owner = owner;
            b.bump = ctx.bumps.bond;
            b.since = math::weighted_since(b.amount, b.since, amount, now).ok_or(KnockError::Overflow)?;
            b.amount = b.amount.checked_add(amount).ok_or(KnockError::Overflow)?;
            (b.amount, b.since)
        };
        let a = &ctx.accounts;
        move_tokens(&a.token_program, &a.owner_boo, &a.boo_mint, &a.bond_vault, &a.owner.to_account_info(), amount, None)?;
        emit!(BondChanged { owner, amount: total, since });
        Ok(())
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        let b = &mut ctx.accounts.bond;
        require!(amount > 0 && amount <= b.amount, KnockError::NotEnoughStaked);
        b.amount -= amount;
        let a = &ctx.accounts;
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[a.config.bump]];
        move_tokens(&a.token_program, &a.bond_vault, &a.boo_mint, &a.owner_boo, &a.config.to_account_info(), amount, Some(seeds))?;
        emit!(BondChanged { owner: a.bond.owner, amount: a.bond.amount, since: a.bond.since });
        Ok(())
    }

    /// Authority: slash a bond for proven botting or collusion (never for losing
    /// a scare). Capped at `max_slash_bps` of the bond per call; goes to the treasury.
    pub fn slash(ctx: Context<Slash>, amount: u64, reason: [u8; 32]) -> Result<()> {
        let max = ctx.accounts.bond.amount.checked_mul(ctx.accounts.config.max_slash_bps as u64).ok_or(KnockError::Overflow)? / BPS;
        require!(amount > 0 && amount <= max, KnockError::SlashTooBig);
        ctx.accounts.bond.amount -= amount;
        let a = &ctx.accounts;
        let seeds: &[&[u8]] = &[CONFIG_SEED, &[a.config.bump]];
        move_tokens(&a.token_program, &a.bond_vault, &a.boo_mint, &a.treasury_boo, &a.config.to_account_info(), amount, Some(seeds))?;
        emit!(Slashed { owner: a.bond.owner, amount, reason });
        Ok(())
    }
}

// ---------------- helpers ----------------

fn sol_transfer<'info>(sys: &AccountInfo<'info>, from: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(CpiContext::new(sys.clone(), system_program::Transfer { from: from.clone(), to: to.clone() }), amount)
}

fn move_tokens<'info>(
    program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer_seeds: Option<&[&[u8]]>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accounts = TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: authority.clone() };
    match signer_seeds {
        Some(seeds) => token_interface::transfer_checked(CpiContext::new_with_signer(program.to_account_info(), accounts, &[seeds]), amount, mint.decimals),
        None => token_interface::transfer_checked(CpiContext::new(program.to_account_info(), accounts), amount, mint.decimals),
    }
}

fn close_token_account<'info>(
    program: &Interface<'info, TokenInterface>,
    account: &InterfaceAccount<'info, TokenAccount>,
    rent_to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    token_interface::close_account(CpiContext::new_with_signer(
        program.to_account_info(),
        CloseAccount { account: account.to_account_info(), destination: rent_to.clone(), authority: authority.clone() },
        &[seeds],
    ))
}

fn release_raffle<'info>(
    raffle: &Account<'info, RaffleEscrow>,
    program: &Interface<'info, TokenInterface>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    seller: &AccountInfo<'info>,
) -> Result<()> {
    let id = raffle.raffle_id.to_le_bytes();
    let seeds: &[&[u8]] = &[RAFFLE_SEED, raffle.seller.as_ref(), &id, &[raffle.bump]];
    move_tokens(program, escrow, mint, to, &raffle.to_account_info(), raffle.amount, Some(seeds))?;
    close_token_account(program, escrow, seller, &raffle.to_account_info(), seeds)
}

// ---------------- state ----------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub boo_mint: Pubkey,
    pub fee_bps: u16,
    pub owners_bps: u16,
    pub prize_bps: u16,
    pub burn_bps: u16,
    pub max_slash_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub price: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RaffleEscrow {
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub raffle_id: u64,
    pub amount: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Bond {
    pub owner: Pubkey,
    pub amount: u64,
    pub since: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigArgs {
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub owners_bps: u16,
    pub prize_bps: u16,
    pub burn_bps: u16,
    pub max_slash_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Pool {
    Owners,
    Prize,
}

// ---------------- accounts ----------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub boo_mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct PaySol<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury)]
    pub config: Account<'info, Config>,
    /// CHECK: the configured treasury (checked by `has_one`).
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [OWNERS_POOL_SEED], bump)]
    pub owners_pool: SystemAccount<'info>,
    #[account(mut, seeds = [PRIZE_POOL_SEED], bump)]
    pub prize_pool: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayBoo<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = boo_mint)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub boo_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = boo_mint, token::authority = payer, token::token_program = token_program)]
    pub payer_boo: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = boo_mint, token::authority = config.treasury, token::token_program = token_program)]
    pub treasury_boo: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: PDA that owns the owners' $BOO pool.
    #[account(seeds = [OWNERS_POOL_SEED], bump)]
    pub owners_pool: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = boo_mint, associated_token::authority = owners_pool, associated_token::token_program = token_program)]
    pub owners_pool_boo: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: PDA that owns the prize $BOO pool.
    #[account(seeds = [PRIZE_POOL_SEED], bump)]
    pub prize_pool: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = boo_mint, associated_token::authority = prize_pool, associated_token::token_program = token_program)]
    pub prize_pool_boo: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawPool<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [OWNERS_POOL_SEED], bump)]
    pub owners_pool: SystemAccount<'info>,
    #[account(mut, seeds = [PRIZE_POOL_SEED], bump)]
    pub prize_pool: SystemAccount<'info>,
    /// CHECK: any destination the authority pays.
    #[account(mut)]
    pub to: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ListNft<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub nft_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = nft_mint, associated_token::authority = seller, associated_token::token_program = token_program)]
    pub seller_nft: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = seller, space = 8 + Listing::INIT_SPACE, seeds = [LISTING_SEED, nft_mint.key().as_ref()], bump)]
    pub listing: Account<'info, Listing>,
    #[account(init, payer = seller, associated_token::mint = nft_mint, associated_token::authority = listing, associated_token::token_program = token_program)]
    pub escrow_nft: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelListing<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub nft_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, close = seller, has_one = seller, seeds = [LISTING_SEED, nft_mint.key().as_ref()], bump = listing.bump)]
    pub listing: Account<'info, Listing>,
    #[account(mut, associated_token::mint = nft_mint, associated_token::authority = listing, associated_token::token_program = token_program)]
    pub escrow_nft: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = seller, associated_token::mint = nft_mint, associated_token::authority = seller, associated_token::token_program = token_program)]
    pub seller_nft: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyNft<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = treasury)]
    pub config: Account<'info, Config>,
    /// CHECK: the configured treasury (checked by `has_one`).
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [OWNERS_POOL_SEED], bump)]
    pub owners_pool: SystemAccount<'info>,
    #[account(mut, seeds = [PRIZE_POOL_SEED], bump)]
    pub prize_pool: SystemAccount<'info>,
    /// CHECK: the listing's seller (checked by `has_one`); receives the payment and rent.
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    pub nft_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, close = seller, has_one = seller, seeds = [LISTING_SEED, nft_mint.key().as_ref()], bump = listing.bump)]
    pub listing: Account<'info, Listing>,
    #[account(mut, associated_token::mint = nft_mint, associated_token::authority = listing, associated_token::token_program = token_program)]
    pub escrow_nft: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = buyer, associated_token::mint = nft_mint, associated_token::authority = buyer, associated_token::token_program = token_program)]
    pub buyer_nft: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(raffle_id: u64)]
pub struct RaffleDeposit<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = seller, token::token_program = token_program)]
    pub seller_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = seller, space = 8 + RaffleEscrow::INIT_SPACE, seeds = [RAFFLE_SEED, seller.key().as_ref(), &raffle_id.to_le_bytes()], bump)]
    pub raffle: Account<'info, RaffleEscrow>,
    #[account(init, payer = seller, associated_token::mint = mint, associated_token::authority = raffle, associated_token::token_program = token_program)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RaffleSettle<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    /// CHECK: receives the escrow's rent back (checked by `has_one` on the raffle).
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    #[account(mut, close = seller, has_one = seller, has_one = mint, seeds = [RAFFLE_SEED, raffle.seller.as_ref(), &raffle.raffle_id.to_le_bytes()], bump = raffle.bump)]
    pub raffle: Account<'info, RaffleEscrow>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = raffle, associated_token::token_program = token_program)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the winner the game drew; only receives the prize.
    pub winner: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = authority, associated_token::mint = mint, associated_token::authority = winner, associated_token::token_program = token_program)]
    pub winner_tokens: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RaffleRefund<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    /// CHECK: the raffle's seller (checked by `has_one`).
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    #[account(mut, close = seller, has_one = seller, has_one = mint, seeds = [RAFFLE_SEED, raffle.seller.as_ref(), &raffle.raffle_id.to_le_bytes()], bump = raffle.bump)]
    pub raffle: Account<'info, RaffleEscrow>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = raffle, associated_token::token_program = token_program)]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = authority, associated_token::mint = mint, associated_token::authority = seller, associated_token::token_program = token_program)]
    pub seller_tokens: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = boo_mint)]
    pub config: Account<'info, Config>,
    pub boo_mint: InterfaceAccount<'info, Mint>,
    #[account(init_if_needed, payer = owner, space = 8 + Bond::INIT_SPACE, seeds = [BOND_SEED, owner.key().as_ref()], bump)]
    pub bond: Account<'info, Bond>,
    #[account(mut, token::mint = boo_mint, token::authority = owner, token::token_program = token_program)]
    pub owner_boo: InterfaceAccount<'info, TokenAccount>,
    #[account(init_if_needed, payer = owner, seeds = [BOND_VAULT_SEED], bump, token::mint = boo_mint, token::authority = config, token::token_program = token_program)]
    pub bond_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = boo_mint)]
    pub config: Account<'info, Config>,
    pub boo_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, has_one = owner, seeds = [BOND_SEED, owner.key().as_ref()], bump = bond.bump)]
    pub bond: Account<'info, Bond>,
    #[account(mut, token::mint = boo_mint, token::authority = owner, token::token_program = token_program)]
    pub owner_boo: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [BOND_VAULT_SEED], bump)]
    pub bond_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Slash<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority, has_one = boo_mint)]
    pub config: Account<'info, Config>,
    pub boo_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, seeds = [BOND_SEED, bond.owner.as_ref()], bump = bond.bump)]
    pub bond: Account<'info, Bond>,
    #[account(mut, seeds = [BOND_VAULT_SEED], bump)]
    pub bond_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = boo_mint, token::authority = config.treasury, token::token_program = token_program)]
    pub treasury_boo: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ---------------- events and errors ----------------

#[event]
pub struct Paid {
    pub payer: Pubkey,
    pub mint: Option<Pubkey>,
    pub amount: u64,
    pub fee: u64,
    pub memo: [u8; 16],
}

#[event]
pub struct Listed {
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub price: u64,
}

#[event]
pub struct Sold {
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub price: u64,
    pub fee: u64,
}

#[event]
pub struct RaffleSettled {
    pub raffle: Pubkey,
    pub winner: Pubkey,
}

#[event]
pub struct BondChanged {
    pub owner: Pubkey,
    pub amount: u64,
    pub since: i64,
}

#[event]
pub struct Slashed {
    pub owner: Pubkey,
    pub amount: u64,
    pub reason: [u8; 32],
}

#[error_code]
pub enum KnockError {
    #[msg("Fee rates are out of range")]
    BadRates,
    #[msg("Math overflow")]
    Overflow,
    #[msg("Amount must be above zero")]
    ZeroAmount,
    #[msg("Only 1-of-1 NFTs can be listed")]
    NotAnNft,
    #[msg("The price changed since you looked")]
    PriceChanged,
    #[msg("You can't buy your own listing")]
    OwnListing,
    #[msg("Not enough staked")]
    NotEnoughStaked,
    #[msg("Slash is larger than the allowed share of the bond")]
    SlashTooBig,
    #[msg("Pool can't go below rent")]
    PoolTooLow,
}

#[cfg(test)]
mod tests {
    use super::math::*;

    #[test]
    fn fee_split_matches_the_season_pack() {
        // 5% fee; of the fee: 2% owners, 40% prize pool, 30% burn, rest treasury.
        let s = split(1_000_000, 500, 200, 4_000, 3_000, true).unwrap();
        assert_eq!(s, Split { fee: 50_000, owners: 1_000, prize: 20_000, burn: 15_000, treasury: 14_000 });
        assert_eq!(s.owners + s.prize + s.burn + s.treasury, s.fee);
        // SOL can't be burned: that share goes to the treasury.
        let s = split(1_000_000, 500, 200, 4_000, 3_000, false).unwrap();
        assert_eq!((s.burn, s.treasury), (0, 29_000));
    }

    #[test]
    fn fee_split_never_loses_or_creates_lamports() {
        for amount in [0u64, 1, 19, 999, 123_456_789, u64::MAX / 10_000] {
            let s = split(amount, 500, 200, 4_000, 3_000, true).unwrap();
            assert_eq!(s.owners + s.prize + s.burn + s.treasury, s.fee);
            assert!(s.fee <= amount);
        }
        assert!(split(u64::MAX, 500, 200, 4_000, 3_000, true).is_none(), "overflow is an error, not a wrap");
    }

    #[test]
    fn stake_since_is_amount_weighted() {
        assert_eq!(weighted_since(0, 0, 100, 1_000), Some(1_000));
        // 100 held since t=0, add 100 at t=1000 → looks like it was held since t=500.
        assert_eq!(weighted_since(100, 0, 100, 1_000), Some(500));
        // A big fresh top-up drags the start almost to now (anti flash-loan).
        assert_eq!(weighted_since(10, 0, 990, 1_000), Some(990));
    }

    #[test]
    fn rate_limits() {
        assert!(valid_rates(500, 200, 4_000, 3_000, 5_000));
        assert!(!valid_rates(2_500, 0, 0, 0, 0), "fee above 20%");
        assert!(!valid_rates(500, 5_000, 5_000, 1, 0), "fee parts above 100%");
        assert!(!valid_rates(500, 0, 0, 0, 10_001), "slash above 100%");
    }
}
