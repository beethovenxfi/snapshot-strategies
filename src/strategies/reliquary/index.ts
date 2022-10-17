import { BigNumber } from '@ethersproject/bignumber';
import { BlockTag, StaticJsonRpcProvider } from '@ethersproject/providers';
import { formatUnits } from '@ethersproject/units';
import { Multicaller } from '../../utils';
import { Contract } from '@ethersproject/contracts';

export const author = 'beethovenx';
export const version = '0.1.0';

type PositionInfo = {
  amount: BigNumber;
  rewardDebt: BigNumber;
  rewardCredit: BigNumber;
  entry: BigNumber;
  poolId: BigNumber;
  level: BigNumber;
};

/*
  TODO: add description
*/

const abi = [
  {
    inputs: [
      {
        internalType: 'address',
        name: 'from',
        type: 'address',
        indexed: true
      },
      {
        internalType: 'address',
        name: 'to',
        type: 'address',
        indexed: true
      },
      {
        internalType: 'uint256',
        name: 'tokenId',
        type: 'uint256',
        indexed: true
      }
    ],
    type: 'event',
    name: 'Transfer',
    anonymous: false
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'pid',
        type: 'uint256',
        indexed: true
      },
      {
        internalType: 'address',
        name: 'to',
        type: 'address',
        indexed: true
      },
      {
        internalType: 'uint256',
        name: 'relicId',
        type: 'uint256',
        indexed: true
      }
    ],
    type: 'event',
    name: 'CreateRelic',
    anonymous: false
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'tokenId',
        type: 'uint256'
      }
    ],
    name: 'ownerOf',
    outputs: [
      {
        internalType: 'address',
        name: '',
        type: 'address'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'relicId',
        type: 'uint256'
      }
    ],
    name: 'levelOnUpdate',
    outputs: [
      {
        internalType: 'uint256',
        name: 'level',
        type: 'uint256'
      }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: 'relicId',
        type: 'uint256'
      }
    ],
    stateMutability: 'view',
    type: 'function',
    name: 'getPositionForId',
    outputs: [
      {
        internalType: 'struct PositionInfo',
        name: 'position',
        type: 'tuple',
        components: [
          {
            internalType: 'uint256',
            name: 'amount',
            type: 'uint256'
          },
          {
            internalType: 'uint256',
            name: 'rewardDebt',
            type: 'uint256'
          },
          {
            internalType: 'uint256',
            name: 'rewardCredit',
            type: 'uint256'
          },
          {
            internalType: 'uint256',
            name: 'entry',
            type: 'uint256'
          },
          {
            internalType: 'uint256',
            name: 'poolId',
            type: 'uint256'
          },
          {
            internalType: 'uint256',
            name: 'level',
            type: 'uint256'
          }
        ]
      }
    ]
  }
];

export async function strategy(
  space: string,
  network: string,
  provider: StaticJsonRpcProvider,
  addresses: string[],
  options: {
    reliquaryAddress: string;
    reliquaryDeploymentBlock: BlockTag;
    poolId: number;
    maxVotingLevel: number;
    decimals?: number;
  },
  snapshot?: number | string
) {
  const blockTag = typeof snapshot === 'number' ? snapshot : 'latest';

  const lowerCaseAddresses = addresses.map((address) => address.toLowerCase());

  const reliquaryContract = new Contract(
    options.reliquaryAddress,
    abi,
    provider
  );

  const createRelicFilter = reliquaryContract.filters.CreateRelic(
    options.poolId
  );
  const burnRelicFilter = reliquaryContract.filters.Transfer(
    undefined,
    '0x0000000000000000000000000000000000000000'
  );

  const createRelicEvents = await reliquaryContract.queryFilter(
    createRelicFilter,
    options.reliquaryDeploymentBlock
  );

  const burnedRelicEvents = await reliquaryContract.queryFilter(
    burnRelicFilter,
    options.reliquaryDeploymentBlock
  );

  const burnedRelicIds = burnedRelicEvents.map((transferEvent) =>
    transferEvent.args!.tokenId.toNumber()
  );
  const existingRelicIds = createRelicEvents
    .map((relicEvent) => relicEvent.args!.relicId.toNumber())
    .filter((relicId) => !burnedRelicIds.includes(relicId));

  const multi = new Multicaller(network, provider, abi, { blockTag });

  for (let relicId of existingRelicIds) {
    multi.call(relicId, options.reliquaryAddress, 'ownerOf', [relicId]);
  }

  const relicsOwners: Record<string, string> = await multi.execute();

  // first we filter all relevant relics by the provided voters
  const relicsOwnedByVoters = Object.entries(relicsOwners).filter(
    ([_, owner]) => lowerCaseAddresses.includes(owner.toLowerCase())
  );

  // now we need to get their corresponding level and deposited amount
  for (const [relicId, owner] of relicsOwnedByVoters) {
    multi.call(
      `${owner}.${relicId}.level`,
      options.reliquaryAddress,
      'levelOnUpdate',
      [relicId]
    );
    multi.call(
      `${owner}.${relicId}.position`,
      options.reliquaryAddress,
      'getPositionForId',
      [relicId]
    );
  }

  const relicInfosByVoter: Record<
    string,
    { [relicId: string]: { level: BigNumber; position: PositionInfo } }
  > = await multi.execute();

  // now that we have all positions & levels, we add up deposited amounts of the configured
  // pool, weighted by its level in relation to the maxVotingLevel
  const userAmounts: Record<string, number> = {};

  Object.entries(relicInfosByVoter).forEach(([address, infoByRelic]) => {
    let amount = 0;
    for (let relicInfo of Object.values(infoByRelic)) {
      amount +=
        (Math.min(relicInfo.level.toNumber() + 1, options.maxVotingLevel + 1) /
          (options.maxVotingLevel + 1)) *
        parseFloat(
          formatUnits(relicInfo.position.amount, options.decimals ?? 18)
        );
    }
    userAmounts[address] = amount;
  });

  return userAmounts;
}
