export type NetworkMode = 'testnet' | 'mainnet'

export interface GameRound {
  /** Unique match identifier. Demo IDs use a UUID; on-chain IDs include chain, contract, and round. */
  roundId: string
  stake: string
  won: boolean
  multiplier: string
  payout: string
  txHash: `0x${string}` | null
  chainId: number
  /** Local creation time for history display; absent on records saved by older app versions. */
  createdAt?: number
}
