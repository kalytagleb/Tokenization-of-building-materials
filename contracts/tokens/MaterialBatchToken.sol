// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC3525} from "@solvprotocol/erc-3525/ERC3525.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IERC5192} from "../interfaces/IERC5192.sol";
import {Roles} from "../access/Roles.sol";

contract MaterialBatchToken is ERC3525, IERC5192 {
    error NotOrchestrator(address caller);
    error TokenIsLocked(uint256 tokenId);
    error AlreadyLocked(uint256 tokenId);

    IAccessControl public immutable actors;
    mapping(uint256 => bool) private _locked;

    constructor(address actorRegistry) ERC3525("Material Batch", "MBT", 0) {
        actors = IAccessControl(actorRegistry);
    }

    modifier onlyOrchestrator() {
        if (!actors.hasRole(Roles.ORCHESTRATOR_ROLE, msg.sender)) {
            revert NotOrchestrator(msg.sender);
        }
        _;
    }

    function mintBatch(address to, uint256 slot, uint256 value) 
        external 
        onlyOrchestrator 
        returns (uint256 tokenId)
    {
        tokenId = _mint(to, slot, value);
    }

    function splitBatch(uint256 fromTokenId, address to, uint256 value)
        external
        onlyOrchestrator
        returns (uint256 newTokenId)
    {
        newTokenId = _createDerivedTokenId(fromTokenId);
        _mint(to, newTokenId, slotOf(fromTokenId), 0);

        _transferValue(fromTokenId, newTokenId, value);
    }

    function moveToken(address from, address to, uint256 tokenId)
        external
        onlyOrchestrator
    {
        _transferTokenId(from, to, tokenId);
    }

    function lockToken(uint256 tokenId) external onlyOrchestrator {
        _requireMinted(tokenId);

        if (_locked[tokenId]) {
            revert AlreadyLocked(tokenId);
        }

        _locked[tokenId] = true;
        emit Locked(tokenId);
    }

    // ERC-5192
    function locked(uint256 tokenId) external view override returns (bool) {
        _requireMinted(tokenId);
        return _locked[tokenId];
    }

    // ERC-165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return interfaceId == type(IERC5192).interfaceId || super.supportsInterface(interfaceId);
    }

    function _beforeValueTransfer(
        address from_, 
        address to_, 
        uint256 fromTokenId_, 
        uint256 toTokenId_, 
        uint256 slot_, 
        uint256 value_
    ) internal virtual override {
        // a locked token is frozen, as the source and as the target.
        if (fromTokenId_ != 0 && _locked[fromTokenId_]) {
            revert TokenIsLocked(fromTokenId_);
        }

        if (toTokenId_ != 0 && _locked[toTokenId_]) {
            revert TokenIsLocked(toTokenId_);
        }

        bool isMovement = from_ != address(0) && to_ != address(0);
        if (isMovement && !actors.hasRole(Roles.ORCHESTRATOR_ROLE, msg.sender)) {
            revert NotOrchestrator(msg.sender);
        }

        slot_;
        value_;
    }
}