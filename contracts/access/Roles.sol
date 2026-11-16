// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Every contract imports this file instead of writing its own
/// copy of the constants. If a role is ever renamed, we change it here only.

library Roles {
    bytes32 internal constant MINER_ROLE = keccak256("MINER_ROLE");
    bytes32 internal constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 internal constant CERTIFIER_ROLE = keccak256("CERTIFIER_ROLE");
    bytes32 internal constant TRANSPORTER_ROLE = keccak256("TRANSPORTER_ROLE");
    bytes32 internal constant BUILDER_ROLE = keccak256("BUILDER_ROLE");
    bytes32 internal constant ORCHESTRATOR_ROLE = keccak256("ORCHESTRATOR_ROLE");
    bytes32 internal constant EPD_VERTIFIER_ROLE = keccak256("EPD_VERIFIER_ROLE");
}