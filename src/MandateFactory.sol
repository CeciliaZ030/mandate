// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MandateAccount} from "./MandateAccount.sol";

/// @title MandateFactory
/// @notice Deploys MandateAccounts and indexes them for the public leaderboard.
contract MandateFactory {
    address public immutable usdc;
    address[] public allMandates;
    mapping(address => address[]) internal _byOwner;
    mapping(address => address[]) internal _byAgent;
    mapping(address => bool) public isMandate;

    event MandateCreated(address indexed owner, address indexed agent, address mandate, MandateAccount.Limits limits);

    constructor(address usdc_) {
        usdc = usdc_;
    }

    function create(address agent, MandateAccount.Limits calldata limits) external returns (address m) {
        m = address(new MandateAccount(usdc, msg.sender, agent, limits));
        allMandates.push(m);
        _byOwner[msg.sender].push(m);
        _byAgent[agent].push(m);
        isMandate[m] = true;
        emit MandateCreated(msg.sender, agent, m, limits);
    }

    function count() external view returns (uint256) {
        return allMandates.length;
    }

    function mandatesOf(address owner) external view returns (address[] memory) {
        return _byOwner[owner];
    }

    function mandatesRunBy(address agent) external view returns (address[] memory) {
        return _byAgent[agent];
    }
}
