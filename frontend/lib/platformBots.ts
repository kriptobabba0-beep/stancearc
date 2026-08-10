// lib/platformBots.ts — the platform's own operational wallets (keeper, price keepers,
// swapbots, stakerbots, owner/reserve). The leaderboard badges these so visitors can't
// mistake house activity for organic users. Addresses are public on-chain — listing them
// here is transparency, not exposure. External actors (e.g. the 2026-07-01 whale contract)
// are deliberately NOT on this list: they are real third parties.
const PLATFORM_BOTS: ReadonlyArray<`0x${string}`> = [
  '0xB964fC0BB9d4226935Bb316E602c7E93455F359B', // keeper (gas signer)
  '0x891bbabB7d9ab43aBDb2cEE2a24A25C97D80eFFE', // owner / reserve
  '0x3cB717f1a19F45D54Eb82f918185eFAbB5108B79', // arb-usdc price keeper
  '0x03c5BAbf40151AE2F1Be6a1080A1Fa501a95c05c', // arb-eurc price keeper
  '0x32e149E1e7A514992c8DE27E859605eDad5E7f42', // swapbot-usdc
  '0xa261A4afF197f1147282613DF29BBcfa9871D020', // swapbot-eurc
  '0x214853bC3B5D1dCE2091b83dAF562fB9c9Ffb8d0', // stakerbot UP
  '0x0b3A9aE0dCF6e8b3A547470fBb14D4689C2936AF', // stakerbot DOWN
  '0xFDA48E931Dc4653c10fEf133069b739401Ad4Ae3', // stakerbot RANGE
];

const BOT_SET = new Set(PLATFORM_BOTS.map((a) => a.toLowerCase()));

/** True when the address is one of the platform's own bots. */
export function isPlatformBot(address: string): boolean {
  return BOT_SET.has(address.toLowerCase());
}
