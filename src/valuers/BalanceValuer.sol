// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IValuer} from "../interfaces/IValuer.sol";
import {IERC20} from "../interfaces/IERC20.sol";

/// @notice Values a 1:1 USDC receipt token (e.g. a rebasing aToken). Only use
/// when the receipt token is redeemable 1:1 for USDC (6 decimals).
contract BalanceValuer is IValuer {
    IERC20 public immutable receipt;

    constructor(address receipt_) {
        receipt = IERC20(receipt_);
    }

    function valueOf(address account) external view returns (uint256) {
        return receipt.balanceOf(account);
    }
}
