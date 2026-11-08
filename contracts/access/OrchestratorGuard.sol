// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Roles} from "./Roles.sol";

abstract contract OrchestratorGuard {
    error NotOrchestrator(address caller);

    IAccessControl public immutable actors;

    constructor(address actorRegistry) {
        actors = IAccessControl(actorRegistry);
    }

    modifier onlyOrchestrator() {
        if (!_isOrchestrator(msg.sender)) {
            revert NotOrchestrator(msg.sender);
        }
        _;
    }

    function _isOrchestrator(address account) internal view returns (bool) {
        return actors.hasRole(Roles.ORCHESTRATOR_ROLE, account);
    }
}