// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Reports the USDC value (6 decimals) an account holds at ONE venue.
/// One valuer instance per venue. Set by the mandate owner, never by the agent.
interface IValuer {
    function valueOf(address account) external view returns (uint256);
}
