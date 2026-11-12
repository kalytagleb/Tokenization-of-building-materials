// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OrchestratorGuard} from "../access/OrchestratorGuard.sol";

contract BuildingRegistry is OrchestratorGuard {
    struct Building {
        address owner;
        uint48 registeredAt;
    }

    uint32 public lastBuildingId;
    mapping(uint32 => Building) public buildings;

    event BuildingRegistered(uint32 indexed buildingId, address indexed owner, bytes32 documentHash);

    error ZeroAddress();
    error BuildingNotFound(uint32 buildingId);

    constructor(address actorRegistry) OrchestratorGuard(actorRegistry) {}

    function registerBuilding(address owner, bytes32 documentHash) 
        external
        onlyOrchestrator
        returns (uint32 buildingId)
    {
        if (owner == address(0)) revert ZeroAddress();

        buildingId = ++lastBuildingId;
        buildings[buildingId] = Building(owner, uint48(block.timestamp));

        emit BuildingRegistered(buildingId, owner, documentHash);
    }

    function ownerOf(uint32 buildingId) external view returns (address) {
        address owner = buildings[buildingId].owner;
        if (owner == address(0)) revert BuildingNotFound(buildingId);
        return owner;
    }

    function exists(uint32 buildingId) external view returns (bool) {
        return buildings[buildingId].owner != address(0);
    }
}