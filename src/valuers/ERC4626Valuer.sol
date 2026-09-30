// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IValuer} from "../interfaces/IValuer.sol";

interface IERC4626View {
    function asset() external view returns (address);
    function balanceOf(address) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

/// @notice Values a position in a USDC-denominated ERC-4626 vault (e.g. a Morpho vault).
contract ERC4626Valuer is IValuer {
    IERC4626View public immutable vault;

    error WrongAsset();

    constructor(address vault_, address usdc) {
        vault = IERC4626View(vault_);
        if (vault.asset() != usdc) revert WrongAsset();
    }

    function valueOf(address account) external view returns (uint256) {
        return vault.convertToAssets(vault.balanceOf(account));
    }
}
