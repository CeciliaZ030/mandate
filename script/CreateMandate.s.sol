// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {MandateFactory} from "../src/MandateFactory.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {ERC4626Valuer} from "../src/valuers/ERC4626Valuer.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// Creates a mandate owned by the broadcaster, allowlists one ERC-4626 USDC
/// vault (e.g. a Morpho vault on Arc) and funds it.
///
/// Required env: FACTORY, AGENT, VAULT
/// Optional env: DEPOSIT (6 dec, default 5 USDC), VENUE_CAP, MAX_DEPLOYED,
///               MAX_DD_BPS (500), MAX_LOSS_BPS (10), DAYS (30)
contract CreateMandate is Script {
    bytes4 constant DEPOSIT = bytes4(keccak256("deposit(uint256,address)"));
    bytes4 constant WITHDRAW = bytes4(keccak256("withdraw(uint256,address,address)"));
    bytes4 constant REDEEM = bytes4(keccak256("redeem(uint256,address,address)"));

    function run() external returns (address m) {
        MandateFactory factory = MandateFactory(vm.envAddress("FACTORY"));
        address agent = vm.envAddress("AGENT");
        address vault = vm.envAddress("VAULT");
        uint256 amount = vm.envOr("DEPOSIT", uint256(5e6));

        MandateAccount.Limits memory l = MandateAccount.Limits({
            maxDeployed: uint128(vm.envOr("MAX_DEPLOYED", amount)),
            maxDrawdownBps: uint16(vm.envOr("MAX_DD_BPS", uint256(500))),
            maxLossPerCallBps: uint16(vm.envOr("MAX_LOSS_BPS", uint256(10))),
            expiry: uint64(block.timestamp + vm.envOr("DAYS", uint256(30)) * 1 days)
        });

        vm.startBroadcast();
        m = factory.create(agent, l);
        MandateAccount acct = MandateAccount(payable(m));
        ERC4626Valuer valuer = new ERC4626Valuer(vault, factory.usdc());
        acct.setVenue(vault, true, uint128(vm.envOr("VENUE_CAP", amount)), address(valuer));
        acct.setRule(vault, DEPOSIT, true, 0x02); // receiver == self
        acct.setRule(vault, WITHDRAW, true, 0x06); // receiver, owner == self
        acct.setRule(vault, REDEEM, true, 0x06); // receiver, owner == self
        if (vm.envOr("FUND", true)) {
            IERC20(factory.usdc()).approve(m, amount);
            acct.deposit(amount);
        }
        vm.stopBroadcast();

        console2.log("Mandate:", m);
        console2.log("Valuer:", address(valuer));
    }
}
