// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OrchestratorGuard} from "../access/OrchestratorGuard.sol";

contract BatchLedger is OrchestratorGuard {

    enum BatchState {
        None,
        Proposed,
        Certified,
        Rejected,
        Revoked
    }

    enum PieceState {
        None,
        InTransit, // cut from the batch and sent
        Delivered, // the transported says: delivered
        Accepted, // the builder says: received
        Installed // built into the building
    }

    struct RawMaterial {
        address miner; // 20 bytes
        uint48 recordedAt; // 6 bytes
    }

    struct Batch {
        address manufacturer;
        uint48 validUntil;
        BatchState state;
        uint96 claimedAmount;
        uint96 attestedAmount;
        uint64 mainTokenId;
    }

    struct Piece {
        address transporter;
        uint32 batchId;
        uint32 buildingId;
        PieceState state;
    }

    uint32 public lastRawMaterialId;
    uint32 public lastBatchId;

    mapping(uint32 => RawMaterial) public rawMaterials;
    mapping(uint32 => Batch) public batches;
    mapping(uint256 => Piece) public pieces;

    event RawMaterialRecorded(uint32 indexed rawMaterialId, address indexed miner, bytes32 documentHash);

    event BatchProposed(
        uint32 indexed batchId,
        address indexed manufacturer,
        uint32 rawMaterialId,
        uint96 claimedAmount,
        bytes32 documentHash
    );

    event BatchCertified(
        uint32 indexed batchId,
        address indexed certifier,
        uint96 attestedAmount,
        uint48 validUntil,
        bytes32 reportHash
    );

    event BatchRejected(
        uint32 indexed batchId,
        address indexed certifier,
        bytes32 reportHash
    );

    event BatchRevoked(
        uint32 indexed batchId,
        address indexed actor,
        bytes32 reasonHash
    );

    event PieceDispatched(
        uint256 indexed pieceId,
        uint32 indexed batchId,
        uint32 indexed buildingId,
        address transporter,
        uint96 amount,
        address actor
    );

    event PieceDelivered(
        uint256 indexed pieceId,
        address indexed actor,
        bytes32 evidenceHash
    );

    event PieceAccepted(
        uint256 indexed pieceId,
        address indexed actor,
        bytes32 evidenceHash
    );

    event PieceInstalled(
        uint256 indexed pieceId,
        uint32 indexed batchId,
        uint32 indexed buildingId,
        address actor,
        bytes32 evidenceHash
    );

    error ZeroAddress();
    error ZeroAmount();
    error RawMaterialNotFound(uint32 rawMaterialId);
    error WrongBatchState(uint32 batchId, BatchState actual);
    error WrongPieceState(uint256 pieceId, PieceState actual);
    error CertifierIsManufacturer(address account);
    error AmountAboveClaim(uint96 attested, uint96 claimed);
    error ValidityInThePast(uint48 validUntil);
    error CertificateExpired(uint32 batchId, uint48 validUntil);
    error PieceAlreadyExists(uint256 pieceId);

    constructor(address actorRegistry) OrchestratorGuard(actorRegistry) {}

    function recordRawMaterial(address miner, bytes32 documentHash) 
        external
        onlyOrchestrator
        returns (uint32 rawMaterialId)
    {
        if (miner == address(0)) revert ZeroAddress();

        rawMaterialId = ++lastRawMaterialId;
        rawMaterials[rawMaterialId] = RawMaterial(miner, uint48(block.timestamp));

        emit RawMaterialRecorded(rawMaterialId, miner, documentHash);
    }

    function createBatch(address manufacturer, uint32 rawMaterialId, uint96 claimedAmount, bytes32 documentHash)
        external
        onlyOrchestrator
        returns (uint32 batchId)
    {
        if (manufacturer == address(0)) revert ZeroAddress();
        if (claimedAmount == 0) revert ZeroAmount();
        if (rawMaterials[rawMaterialId].miner == address(0)) revert RawMaterialNotFound(rawMaterialId);

        batchId = ++lastBatchId;

        Batch storage batch = batches[batchId];
        batch.manufacturer = manufacturer;
        batch.state = BatchState.Proposed;
        batch.claimedAmount = claimedAmount;

        emit BatchProposed(batchId, manufacturer, rawMaterialId, claimedAmount, documentHash);
    }

    function approveBatch(
        uint32 batchId,
        address certifier,
        uint96 attestedAmount,
        uint48 validUntil,
        uint64 mainTokenId,
        bytes32 reportHash
    ) external onlyOrchestrator {
        Batch storage batch = _requireBatchState(batchId, BatchState.Proposed);

        if (certifier == batch.manufacturer) revert CertifierIsManufacturer(certifier);

        if (attestedAmount == 0) revert ZeroAmount();
        if (attestedAmount > batch.claimedAmount) revert AmountAboveClaim(attestedAmount, batch.claimedAmount);
        if (validUntil <= block.timestamp) revert ValidityInThePast(validUntil);

        batch.state = BatchState.Certified;
        batch.attestedAmount = attestedAmount;
        batch.validUntil = validUntil;
        batch.mainTokenId = mainTokenId;

        emit BatchCertified(batchId, certifier, attestedAmount, validUntil, reportHash);
    }

    function rejectBatch(uint32 batchId, address certifier, bytes32 reportHash) external onlyOrchestrator {
        Batch storage batch = _requireBatchState(batchId, BatchState.Proposed);
        if (certifier == batch.manufacturer) revert CertifierIsManufacturer(certifier);

        batch.state = BatchState.Rejected;
        emit BatchRejected(batchId, certifier, reportHash);
    }

    function revokeBatch(uint32 batchId, address actor, bytes32 reasonHash) external onlyOrchestrator {
        Batch storage batch = _requireBatchState(batchId, BatchState.Certified);

        batch.state = BatchState.Revoked;
        emit BatchRevoked(batchId, actor, reasonHash);
    }

    function createPiece(
        uint256 pieceId,
        uint32 batchId,
        address transporter,
        uint32 buildingId,
        uint96 amount,
        address actor
    ) external onlyOrchestrator {
        if (transporter == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        Batch storage batch = _requireBatchState(batchId, BatchState.Certified);

        if (block.timestamp > batch.validUntil) revert CertificateExpired(batchId, batch.validUntil);
        
        if (pieces[pieceId].state != PieceState.None) revert PieceAlreadyExists(pieceId);
        pieces[pieceId] = Piece(transporter, batchId, buildingId, PieceState.InTransit);
        emit PieceDispatched(pieceId, batchId, buildingId, transporter, amount, actor);
    }

    function markDelivered(uint256 pieceId, address actor, bytes32 evidenceHash) external onlyOrchestrator {
        _movePiece(pieceId, PieceState.InTransit, PieceState.Delivered);

        emit PieceDelivered(pieceId, actor, evidenceHash);
    }

    function markAccepted(uint256 pieceId, address actor, bytes32 evidenceHash) external onlyOrchestrator {
        _movePiece(pieceId, PieceState.Delivered, PieceState.Accepted);

        emit PieceAccepted(pieceId, actor, evidenceHash);
    }

    function markInstalled(uint256 pieceId, address actor, bytes32 evidenceHash) external onlyOrchestrator {
        Piece storage piece = _movePiece(pieceId, PieceState.Accepted, PieceState.Installed);

        emit PieceInstalled(pieceId, piece.batchId, piece.buildingId, actor, evidenceHash);
    }

    function _requireBatchState(uint32 batchId, BatchState expected) internal view returns (Batch storage batch) {
        batch = batches[batchId];
        if (batch.state != expected) revert WrongBatchState(batchId, batch.state);
    }

    function _movePiece(uint256 pieceId, PieceState from, PieceState to) internal returns (Piece storage piece) {
        piece = pieces[pieceId];
        if (piece.state != from) revert WrongPieceState(pieceId, piece.state);

        BatchState batchState = batches[piece.batchId].state;
        if (batchState != BatchState.Certified) revert WrongBatchState(piece.batchId, batchState);

        piece.state = to;
    }
}