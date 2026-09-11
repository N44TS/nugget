// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title NuggetBatchEscrow
/// @notice Holds a buyer's batch payment and lets eligible contributor wallets claim once.
/// @dev No health data, raw contribution, or contributor identity is stored on-chain.
contract NuggetBatchEscrow {
    enum BatchStatus { None, Funded, Settled, Refunded }

    struct Batch {
        uint128 deposited;
        uint64 eligibleCount;
        uint64 claimedCount;
        uint64 claimDeadline;
        bytes32 merkleRoot;
        BatchStatus status;
    }

    address public immutable owner;
    address public settlementReporter;
    uint64 public immutable claimWindow;
    mapping(bytes32 => Batch) public batches;
    mapping(bytes32 => mapping(address => bool)) public claimed;

    event BatchFunded(bytes32 indexed batchId, address indexed buyer, uint256 amount);
    event BatchSettled(bytes32 indexed batchId, bytes32 merkleRoot, uint256 eligibleCount, uint256 rewardPerWallet, uint256 claimDeadline);
    event RewardClaimed(bytes32 indexed batchId, address indexed wallet, uint256 amount);
    event UnclaimedFundsRefunded(bytes32 indexed batchId, address indexed recipient, uint256 amount);
    event SettlementReporterUpdated(address indexed reporter);

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidBatchState();
    error InvalidProof();
    error AlreadyClaimed();
    error ClaimWindowClosed();
    error TransferFailed();

    constructor(address reporter, uint64 claimWindowSeconds) {
        if (reporter == address(0)) revert InvalidAddress();
        if (claimWindowSeconds == 0) revert InvalidAmount();
        owner = msg.sender;
        settlementReporter = reporter;
        claimWindow = claimWindowSeconds;
    }

    function setSettlementReporter(address reporter) external {
        if (msg.sender != owner) revert Unauthorized();
        if (reporter == address(0)) revert InvalidAddress();
        settlementReporter = reporter;
        emit SettlementReporterUpdated(reporter);
    }

    /// @notice Buyer funds a unique batch commitment. The data batch itself remains off-chain.
    function fundBatch(bytes32 batchId) external payable {
        if (msg.value == 0 || batches[batchId].status != BatchStatus.None) revert InvalidBatchState();
        batches[batchId] = Batch({
            deposited: uint128(msg.value),
            eligibleCount: 0,
            claimedCount: 0,
            claimDeadline: 0,
            merkleRoot: bytes32(0),
            status: BatchStatus.Funded
        });
        emit BatchFunded(batchId, msg.sender, msg.value);
    }

    /// @notice Publishes only the TEE-approved reward commitment, never health data.
    function settleBatch(bytes32 batchId, bytes32 merkleRoot, uint64 eligibleCount) external {
        if (msg.sender != settlementReporter) revert Unauthorized();
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.Funded || merkleRoot == bytes32(0) || eligibleCount == 0) revert InvalidBatchState();
        batch.merkleRoot = merkleRoot;
        batch.eligibleCount = eligibleCount;
        batch.claimDeadline = uint64(block.timestamp) + claimWindow;
        batch.status = BatchStatus.Settled;
        emit BatchSettled(batchId, merkleRoot, eligibleCount, uint256(batch.deposited) / eligibleCount, batch.claimDeadline);
    }

    function claim(bytes32 batchId, bytes32[] calldata proof) external {
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.Settled) revert InvalidBatchState();
        if (block.timestamp > batch.claimDeadline) revert ClaimWindowClosed();
        if (claimed[batchId][msg.sender]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender));
        if (!verify(proof, batch.merkleRoot, leaf)) revert InvalidProof();
        uint256 amount = uint256(batch.deposited) / batch.eligibleCount;
        claimed[batchId][msg.sender] = true;
        batch.claimedCount += 1;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit RewardClaimed(batchId, msg.sender, amount);
    }

    /// @notice Lets the owner recover division dust and unclaimed rewards after the claim window.
    function refundUnclaimed(bytes32 batchId, address payable recipient) external {
        if (msg.sender != owner) revert Unauthorized();
        Batch storage batch = batches[batchId];
        if (batch.status != BatchStatus.Settled || block.timestamp <= batch.claimDeadline) revert InvalidBatchState();
        if (recipient == address(0)) revert InvalidAddress();
        uint256 paidOrReserved = (uint256(batch.deposited) / batch.eligibleCount) * batch.claimedCount;
        uint256 amount = uint256(batch.deposited) - paidOrReserved;
        batch.status = BatchStatus.Refunded;
        (bool sent,) = recipient.call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit UnclaimedFundsRefunded(batchId, recipient, amount);
    }

    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) public pure returns (bool) {
        bytes32 hash = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            hash = hash < sibling
                ? keccak256(abi.encodePacked(hash, sibling))
                : keccak256(abi.encodePacked(sibling, hash));
        }
        return hash == root;
    }
}
