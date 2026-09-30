// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {MandateFactory} from "../src/MandateFactory.sol";

/// forge script script/Deploy.s.sol --rpc-url arc --broadcast --verify
contract Deploy is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (MandateFactory f) {
        address usdc = vm.envOr("USDC", ARC_USDC);
        vm.startBroadcast();
        f = new MandateFactory(usdc);
        vm.stopBroadcast();
        console2.log("MandateFactory:", address(f));
    }
}
