import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Account, Keypair, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import { NETWORKS } from '@/lib/stellar'
import { fetchStream } from '@/lib/contract'

// Issue #928: coverage for scValToStreamData (lib/contract.ts). The decoder is
// module-private, so it is exercised through fetchStream's live path with a
// fake RPC server whose simulation returns a contract-shaped Stream ScVal.

const fakeServer = vi.hoisted(() => ({
  getAccount: vi.fn(),
  simulateTransaction: vi.fn(),
}))

vi.mock('@/lib/stellar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stellar')>()),
  getServer: () => fakeServer,
}))

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1))
const UNKNOWN_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 2))
const SENDER = Keypair.random().publicKey()
const RECIPIENT = Keypair.random().publicKey()
const XLM = NETWORKS.testnet.knownTokens[0]

// Larger than Number.MAX_SAFE_INTEGER — would lose precision if routed through Number.
const HUGE = 2n ** 70n + 12_345n

interface RawStream {
  id: bigint
  sender: string
  recipient: string
  token: string
  deposited_amount: bigint
  withdrawn_amount: bigint
  start_time: bigint
  end_time: bigint
  cliff_time: bigint
  cliff_amount: bigint
  amount_per_second: bigint
  cancelled: boolean
  linear_amount: bigint
  duration: bigint
  [extra: string]: unknown
}

function makeRaw(overrides: Partial<RawStream> = {}): RawStream {
  return {
    id: 42n,
    sender: SENDER,
    recipient: RECIPIENT,
    token: XLM.address,
    deposited_amount: 10_000_000_000n,
    withdrawn_amount: 2_500_000_000n,
    start_time: 1_700_000_000n,
    end_time: 1_700_086_400n,
    cliff_time: 1_700_003_600n,
    cliff_amount: 1_000_000_000n,
    amount_per_second: 104_166n,
    cancelled: false,
    linear_amount: 9_000_000_000n,
    duration: 86_400n,
    ...overrides,
  }
}

/** Encode a stream the way the Soroban `Stream` contracttype is laid out. */
function toScVal(raw: RawStream): xdr.ScVal {
  return nativeToScVal(raw, {
    type: {
      id: ['symbol', 'u64'],
      sender: ['symbol', 'address'],
      recipient: ['symbol', 'address'],
      token: ['symbol', 'address'],
      deposited_amount: ['symbol', 'i128'],
      withdrawn_amount: ['symbol', 'i128'],
      start_time: ['symbol', 'u64'],
      end_time: ['symbol', 'u64'],
      cliff_time: ['symbol', 'u64'],
      cliff_amount: ['symbol', 'i128'],
      amount_per_second: ['symbol', 'i128'],
      cancelled: ['symbol', null],
      linear_amount: ['symbol', 'i128'],
      duration: ['symbol', 'i128'],
      metadata: ['symbol', null],
    },
  })
}

async function decode(val: xdr.ScVal) {
  fakeServer.simulateTransaction.mockResolvedValue({ result: { retval: val } })
  return fetchStream('testnet', '42')
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_STREAM_CONTRACT_ID_TESTNET', CONTRACT_ID)
  fakeServer.getAccount.mockImplementation(async (id: string) => new Account(id, '0'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('scValToStreamData (via fetchStream)', () => {
  it('round-trips a stream built with nativeToScVal', async () => {
    const raw = makeRaw()
    const stream = await decode(toScVal(raw))

    expect(stream).toEqual({
      id: '42',
      sender: SENDER,
      recipient: RECIPIENT,
      token: XLM,
      depositedAmount: raw.deposited_amount,
      withdrawnAmount: raw.withdrawn_amount,
      startTime: raw.start_time,
      endTime: raw.end_time,
      cliffTime: raw.cliff_time,
      cliffAmount: raw.cliff_amount,
      amountPerSecond: raw.amount_per_second,
      linearAmount: raw.linear_amount,
      duration: raw.duration,
      cancelled: false,
    })
  })

  it('queries get_stream once per fetch', async () => {
    await decode(toScVal(makeRaw()))
    expect(fakeServer.simulateTransaction).toHaveBeenCalledTimes(1)
  })

  it('keeps every amount and timestamp field as bigint without precision loss', async () => {
    const raw = makeRaw({
      deposited_amount: HUGE,
      withdrawn_amount: HUGE - 1n,
      cliff_amount: HUGE - 2n,
      amount_per_second: HUGE - 3n,
      linear_amount: HUGE - 4n,
      duration: HUGE - 5n,
      start_time: 2n ** 63n,
      end_time: 2n ** 64n - 1n, // u64::MAX
      cliff_time: 2n ** 63n + 1n,
    })
    const stream = await decode(toScVal(raw))
    expect(stream).not.toBeNull()

    const bigintFields = [
      'depositedAmount',
      'withdrawnAmount',
      'startTime',
      'endTime',
      'cliffTime',
      'cliffAmount',
      'amountPerSecond',
      'linearAmount',
      'duration',
    ] as const
    for (const field of bigintFields) {
      expect(typeof stream![field], field).toBe('bigint')
    }

    expect(stream!.depositedAmount).toBe(HUGE)
    expect(stream!.duration).toBe(HUGE - 5n)
    expect(stream!.endTime).toBe(2n ** 64n - 1n)
  })

  it('decodes the cancelled flag', async () => {
    const stream = await decode(toScVal(makeRaw({ cancelled: true })))
    expect(stream!.cancelled).toBe(true)
  })

  it('falls back to an UNK token for an unknown token address', async () => {
    const stream = await decode(toScVal(makeRaw({ token: UNKNOWN_TOKEN })))
    expect(stream!.token).toEqual({ address: UNKNOWN_TOKEN, symbol: 'UNK', decimals: 7 })
  })

  it('leaves metadata undefined when the ScVal has none', async () => {
    const stream = await decode(toScVal(makeRaw()))
    expect(stream).not.toHaveProperty('metadata')
  })

  it('still decodes when a metadata entry is present, without mapping it', async () => {
    // The contract's Stream struct carries no metadata — it is stored under a
    // separate key and read via get_stream_metadata — so the decoder ignores
    // any extra entry rather than failing on it.
    const raw = makeRaw({
      metadata: { name: 'Q1 Salary', category: 'payroll', memo: 'Monthly' },
    })
    const stream = await decode(toScVal(raw))

    expect(stream).toMatchObject({ id: '42', depositedAmount: raw.deposited_amount })
    expect(stream!.metadata).toBeUndefined()
  })

  it('returns null when the ScVal is not a stream', async () => {
    // Void retval (e.g. missing stream) → scValToNative gives null → decode throws → null.
    const stream = await decode(xdr.ScVal.scvVoid())
    expect(stream).toBeNull()
  })
})
