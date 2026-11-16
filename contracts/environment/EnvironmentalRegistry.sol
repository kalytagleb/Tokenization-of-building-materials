// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OrchestratorGuard} from "../access/OrchestratorGuard.sol";

contract EnvironmetalRegistry is OrchestratorGuard {
    struct Measurement {
        uint128 value;
        uint48 validUntil;
        bool recorded;
        bool revoked;
    }

    // indicatorId -> unit
    mapping(bytes32 => bytes32) public unitOf;
    // batchId -> indicatorId -> Measurement
    mapping(uint32 => mapping(bytes32 => Measurement)) public measurements;

    event IndicatorDefined(bytes32 indexed indicatorId, bytes32 unit, string name);
    event MeasurementRecorded(
        uint32 indexed batchId, bytes32 indexed indicatorId,
        uint128 value, uint48 validUntil, address verifier, bytes32 evidenceHash
    );
    event MeasurementRevoked(uint32 indexed batchId, bytes32 indexed indicatorId, address actor, bytes32 reasonHash);

    error EmptyName();
    error ZeroUnit();
    error IndicatorAlreadyDefined(bytes32 indicatorId);
    error UnknownIndicator(bytes32 indicatorId);
    error ValidityInThePast(uint48 validUntil);
    error MeasurementAlreadyActive(uint32 batchId, bytes32 indicatorId);
    error MeasurementNotActive(uint32 batchId, bytes32 indicatorId);
    error ListsDoNotMatch();
    error EmptyList();

    constructor(address actorRegistry) OrchestratorGuard(actorRegistry) {}

    function defineIndicator(string calldata name, bytes32 unit)
        external onlyOrchestrator returns (bytes32 indicatorId)
    {
        if (bytes(name).length == 0) revert EmptyName();
        if (unit == bytes32(0)) revert ZeroUnit();
        
        indicatorId = keccak256(bytes(name)); 
        if (unitOf[indicatorId] != bytes32(0)) revert IndicatorAlreadyDefined(indicatorId);

        unitOf[indicatorId] = unit;
        emit IndicatorDefined(indicatorId, unit, name);
    }

    function recordMeasurements(
        uint32 batchId,
        bytes32[] calldata indicatorIds,
        uint128[] calldata values,
        uint48 validUntil,
        address verifier,
        bytes32 evidenceHash
    ) external onlyOrchestrator {
        if (indicatorIds.length == 0) revert EmptyList();
        if (indicatorIds.length != values.length) revert ListsDoNotMatch();
        if (validUntil <= block.timestamp) revert ValidityInThePast(validUntil);

        for (uint256 i=0; i < indicatorIds.length; i++) {
            bytes32 id = indicatorIds[i];
            if (unitOf[id] == bytes32(0)) revert UnknownIndicator(id);
            if (_isActive(measurements[batchId][id])) revert MeasurementAlreadyActive(batchId, id);

            measurements[batchId][id] = Measurement(values[i], validUntil, true, false);
            emit MeasurementRecorded(batchId, id, values[i], validUntil, verifier, evidenceHash);
        }
    }

    function revokeMeasurement(uint32 batchId, bytes32 indicatorId, address actor, bytes32 reasonHash)
        external onlyOrchestrator
    {
        Measurement storage m = measurements[batchId][indicatorId];
        if (!_isActive(m)) revert MeasurementNotActive(batchId, indicatorId);

        m.revoked = true;
        emit MeasurementRevoked(batchId, indicatorId, actor, reasonHash);
    }

    function isValid(uint32 batchId, bytes32 indicatorId) external view returns (bool) {
        return _isActive(measurements[batchId][indicatorId]);
    }

    function _isActive(Measurement storage m) private view returns (bool) {
        return m.recorded && !m.revoked && block.timestamp <= m.validUntil;
    }
}