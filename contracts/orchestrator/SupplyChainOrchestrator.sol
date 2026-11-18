// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Roles} from "../access/Roles.sol";
import {MaterialBatchToken} from "../tokens/MaterialBatchToken.sol";
import {BatchLedger} from "../ledger/BatchLedger.sol";
import {BuildingRegistry} from "../buildings/BuildingRegistry.sol";
import {EnvironmentalRegistry} from "../environment/EnvironmentalRegistry.sol";

contract SupplyChainOrchestrator is Pausable, ReentrancyGuard {
    using SafeCast for uint256;

    error MissingRole(bytes32 role, address account);
    error NotAdmin(address account);
    error BatchNotFound(uint32 batchId);
    error BatchNotCertified(uint32 batchId);
    error UnknownBuilding(uint32 buildingId);
    error NotBatchManufacturer(uint32 batchId, address caller);
    error NotAssignedTransporter(uint256 pieceId, address caller);
    error NotBuildingOwner(uint32 buildingId, address caller);
    error NotTokenOwner(uint256 tokenId, address caller);
    error TransporterWithoutRole(address transporter);
    error VerifierIsManufacturer(address account);
    error NotPartyOfPiece(uint256 pieceId, address caller);

    IAccessControl public immutable actors;
    MaterialBatchToken public immutable token;
    BatchLedger public immutable ledger;
    BuildingRegistry public immutable buildings;
    EnvironmentalRegistry public immutable environment;

    constructor(address actorRegistry, address tokenAddress, address ledgerAddress, address buildingAddress, address environmentAddress) {
        actors = IAccessControl(actorRegistry);
        token = MaterialBatchToken(tokenAddress);
        ledger = BatchLedger(ledgerAddress);
        buildings = BuildingRegistry(buildingAddress);
        environment = EnvironmentalRegistry(environmentAddress);
    }

    modifier onlyRole(bytes32 role) {
        if (!actors.hasRole(role, msg.sender)) revert MissingRole(role, msg.sender);
        _;
    }

    modifier safe() {
        _requireNotPaused();
        _;
    }

    function _requireAdmin() internal view {
        if (!actors.hasRole(0x00, msg.sender)) revert NotAdmin(msg.sender);
    }

    function pause() external {
        _requireAdmin();
        _pause();
    }

    function unpause() external {
        _requireAdmin();
        _unpause();
    }

    function registerBuilding(bytes32 documentHash)
        external safe nonReentrant onlyRole(Roles.BUILDER_ROLE) returns (uint32)
    {
        return buildings.registerBuilding(msg.sender, documentHash);
    }

    function recordRawMaterial(bytes32 documentHash)
        external safe nonReentrant onlyRole(Roles.MINER_ROLE) returns (uint32)
    {
        return ledger.recordRawMaterial(msg.sender, documentHash);
    }

    function proposeBatch(uint32 rawMaterialId, uint96 claimedAmount, bytes32 documentHash)
        external safe nonReentrant onlyRole(Roles.MANUFACTURER_ROLE) returns (uint32)
    {
        return ledger.createBatch(msg.sender, rawMaterialId, claimedAmount, documentHash);
    }

    function approveBatch(uint32 batchId, uint96 attestedAmount, uint48 validUntil, bytes32 reportHash)
        external safe nonReentrant onlyRole(Roles.CERTIFIER_ROLE)
    {
        (address manufacturer,,,,,,,) = ledger.batches(batchId);
        if (manufacturer == address(0)) revert BatchNotFound(batchId);

        (bool certified, uint96 finalAmount) = ledger.voteApprove(batchId, msg.sender, attestedAmount, validUntil, reportHash);

        if (certified) {
            uint256 tokenId = token.mintBatch(manufacturer, batchId, finalAmount);
            ledger.attachToken(batchId, tokenId.toUint64());
        }
    }

    function rejectBatch(uint32 batchId, bytes32 reportHash)
        external safe nonReentrant onlyRole(Roles.CERTIFIER_ROLE)
    {
        ledger.voteReject(batchId, msg.sender, reportHash);
    }

    function revokeBatch(uint32 batchId, bytes32 reasonHash)
        external safe nonReentrant
    {
        bool allowed = actors.hasRole(Roles.CERTIFIER_ROLE, msg.sender) || actors.hasRole(0x00, msg.sender);
        if (!allowed) revert MissingRole(Roles.CERTIFIER_ROLE, msg.sender);
        ledger.revokeBatch(batchId, msg.sender, reasonHash);
    }

    function dispatchPiece(uint32 batchId, uint96 amount, address transporter, uint32 buildingId)
        external safe nonReentrant onlyRole(Roles.MANUFACTURER_ROLE) returns (uint256 pieceId)
    {
        (address manufacturer,, BatchLedger.BatchState state,,,,, uint64 mainTokenId) = ledger.batches(batchId);

        if (manufacturer != msg.sender) revert NotBatchManufacturer(batchId, msg.sender);
        if (state != BatchLedger.BatchState.Certified) revert BatchNotCertified(batchId);
        if (!actors.hasRole(Roles.TRANSPORTER_ROLE, transporter)) revert TransporterWithoutRole(transporter);
        if (!buildings.exists(buildingId)) revert UnknownBuilding(buildingId);

        pieceId = token.splitBatch(mainTokenId, msg.sender, amount);
        ledger.createPiece(pieceId, batchId, transporter, buildingId, amount, msg.sender);
    }

    function confirmDelivery(uint256 pieceId, bytes32 evidenceHash)
        external safe nonReentrant onlyRole(Roles.TRANSPORTER_ROLE)
    {
        (address transporter,,,,) = ledger.pieces(pieceId);

        if (transporter != msg.sender) revert NotAssignedTransporter(pieceId, msg.sender);
        ledger.markDelivered(pieceId, msg.sender, evidenceHash);
    }

    function acceptDelivery(uint256 pieceId, bytes32 evidenceHash)
        external safe nonReentrant onlyRole(Roles.BUILDER_ROLE)
    {
        (,, uint32 buildingId,, ) = ledger.pieces(pieceId);
        if (buildings.ownerOf(buildingId) != msg.sender) revert NotBuildingOwner(buildingId, msg.sender);

        ledger.markAccepted(pieceId, msg.sender, evidenceHash);
        token.moveToken(token.ownerOf(pieceId), msg.sender, pieceId);
    }

    function installPiece(uint256 pieceId, bytes32 evidenceHash)
        external safe nonReentrant onlyRole(Roles.BUILDER_ROLE)
    {
        if (token.ownerOf(pieceId) != msg.sender) revert NotTokenOwner(pieceId, msg.sender);

        ledger.markInstalled(pieceId, msg.sender, evidenceHash);
        token.lockToken(pieceId);
    }

    function disputeDelivery(uint256 pieceId, bytes32 reasonHash)
        external safe nonReentrant onlyRole(Roles.BUILDER_ROLE)
    {
        (,, uint32 buildingId,,) = ledger.pieces(pieceId);
        if (buildings.ownerOf(buildingId) != msg.sender) revert NotBuildingOwner(buildingId, msg.sender);

        ledger.markDisputed(pieceId, msg.sender, reasonHash);
    }

    function resolveDispute(uint256 pieceId, bool accept, bytes32 reasonHash)
        external safe nonReentrant
    {
        _requireAdmin();

        (,, uint32 buildingId,,) = ledger.pieces(pieceId);
        ledger.resolveDispute(pieceId, msg.sender, accept, reasonHash);

        if (accept) _moveToBuilder(pieceId, buildingId);
    }

    function acceptByTimeout(uint256 pieceId) external safe nonReentrant {
        (address transporter, uint32 batchId, uint32 buildingId,,) = ledger.pieces(pieceId);
        (address manufacturer,,,,,,,) = ledger.batches(batchId);

        if (msg.sender != transporter && msg.sender != manufacturer) revert NotPartyOfPiece(pieceId, msg.sender);

        ledger.markAcceptedByTimeout(pieceId, msg.sender);
        _moveToBuilder(pieceId, buildingId); 
    }

    function defineIndicator(string calldata name, bytes32 unit) 
        external safe nonReentrant returns (bytes32)
    {
        _requireAdmin();
        return environment.defineIndicator(name, unit);
    }

    function recordEnvironmentalData(
        uint32 batchId,
        bytes32[] calldata indicatorIds,
        uint128[] calldata values,
        uint48 validUntil,
        bytes32 evidenceHash
    ) external safe nonReentrant onlyRole(Roles.EPD_VERIFIER_ROLE) {
        (address manufacturer,, BatchLedger.BatchState state,,,,,) = ledger.batches(batchId);

        if (manufacturer == address(0)) revert BatchNotFound(batchId);
        if (state != BatchLedger.BatchState.Certified) revert BatchNotCertified(batchId);
        if (manufacturer == msg.sender) revert VerifierIsManufacturer(msg.sender);

        environment.recordMeasurements(batchId, indicatorIds, values, validUntil, msg.sender, evidenceHash);
    }

    function revokeEnvironmentalData(uint32 batchId, bytes32 indicatorId, bytes32 reasonHash)
        external safe nonReentrant
    {
        bool allowed = actors.hasRole(Roles.EPD_VERIFIER_ROLE, msg.sender) || actors.hasRole(0x00, msg.sender);
        if (!allowed) revert MissingRole(Roles.EPD_VERIFIER_ROLE, msg.sender);

        environment.revokeMeasurement(batchId, indicatorId, msg.sender, reasonHash);
    }

    function _moveToBuilder(uint256 pieceId, uint32 buildingId) internal {
        token.moveToken(token.ownerOf(pieceId), buildings.ownerOf(buildingId), pieceId);
    }
}