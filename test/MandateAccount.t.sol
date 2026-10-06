// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MandateAccount} from "../src/MandateAccount.sol";
import {MandateFactory} from "../src/MandateFactory.sol";
import {ERC4626Valuer} from "../src/valuers/ERC4626Valuer.sol";
import {MockUSDC, MockVault} from "./mocks/Mocks.sol";

contract MandateAccountTest is Test {
    MockUSDC usdc;
    MockVault vault;
    MockVault rogue; // a vault the owner never allowlisted
    MandateFactory factory;
    MandateAccount m;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address attacker = makeAddr("attacker");

    uint256 constant ONE = 1e6;
    bytes4 constant DEPOSIT = bytes4(keccak256("deposit(uint256,address)"));
    bytes4 constant REDEEM = bytes4(keccak256("redeem(uint256,address,address)"));
    bytes4 constant SHARE_TRANSFER = bytes4(keccak256("transfer(address,uint256)"));

    function setUp() public {
        usdc = new MockUSDC();
        vault = new MockVault(usdc);
        rogue = new MockVault(usdc);
        factory = new MandateFactory(address(usdc));

        MandateAccount.Limits memory l = MandateAccount.Limits({
            maxDeployed: uint128(800 * ONE),
            maxDrawdownBps: 500, // 5%
            maxLossPerCallBps: 10, // 0.10%
            expiry: uint64(block.timestamp + 30 days)
        });

        vm.startPrank(owner);
        m = MandateAccount(payable(factory.create(agent, l)));
        m.setVenue(address(vault), true, uint128(600 * ONE), address(new ERC4626Valuer(address(vault), address(usdc))));
        m.setRule(address(vault), DEPOSIT, true, 0x02); // word1 = receiver must be self
        m.setRule(address(vault), REDEEM, true, 0x06); // word1 receiver, word2 owner
        usdc.mint(owner, 1_000 * ONE);
        usdc.approve(address(m), type(uint256).max);
        m.deposit(1_000 * ONE);
        vm.stopPrank();
    }

    // ── helpers ──
    function _approve(address spender, uint256 amt) internal returns (bool) {
        vm.prank(agent);
        return m.execute(address(usdc), abi.encodeWithSelector(usdc.approve.selector, spender, amt));
    }

    function _deposit(uint256 amt, address receiver) internal returns (bool) {
        vm.prank(agent);
        return m.execute(address(vault), abi.encodeWithSelector(DEPOSIT, amt, receiver));
    }

    // ── happy path ──
    function test_agentDepositsIntoVenue() public {
        assertTrue(_approve(address(vault), 500 * ONE));
        assertTrue(_deposit(500 * ONE, address(m)));
        assertEq(m.deployed(), 500 * ONE);
        assertEq(m.nav(), 1_000 * ONE);
        assertFalse(m.frozen());
    }

    function test_agentRedeems() public {
        _approve(address(vault), 500 * ONE);
        _deposit(500 * ONE, address(m));
        uint256 shares = vault.balanceOf(address(m));
        vm.prank(agent);
        assertTrue(m.execute(address(vault), abi.encodeWithSelector(REDEEM, shares, address(m), address(m))));
        assertEq(usdc.balanceOf(address(m)), 1_000 * ONE);
    }

    function test_yieldRaisesHighWaterMark() public {
        _approve(address(vault), 500 * ONE);
        _deposit(500 * ONE, address(m));
        vault.simulateYield(20 * ONE);
        m.poke();
        assertEq(m.highWaterMark(), 1_020 * ONE);
    }

    // ── theft attempts: all blocked, account frozen, funds intact ──
    function test_blocks_depositToAttackerReceiver() public {
        _approve(address(vault), 500 * ONE);
        assertFalse(_deposit(500 * ONE, attacker));
        assertTrue(m.frozen());
        assertEq(vault.balanceOf(attacker), 0);
        assertEq(m.nav(), 1_000 * ONE);
    }

    function test_blocks_redeemToAttacker() public {
        _approve(address(vault), 500 * ONE);
        _deposit(500 * ONE, address(m));
        uint256 shares = vault.balanceOf(address(m));
        vm.prank(agent);
        assertFalse(m.execute(address(vault), abi.encodeWithSelector(REDEEM, shares, attacker, address(m))));
        assertTrue(m.frozen());
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_blocks_directUsdcTransfer() public {
        vm.prank(agent);
        assertFalse(m.execute(address(usdc), abi.encodeWithSelector(usdc.transfer.selector, attacker, 1_000 * ONE)));
        assertTrue(m.frozen());
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_blocks_approveToNonVenue() public {
        assertFalse(_approve(attacker, 1));
        assertTrue(m.frozen());
    }

    function test_blocks_approveAboveVenueCap() public {
        assertFalse(_approve(address(vault), 601 * ONE));
        assertTrue(m.frozen());
    }

    function test_blocks_unlistedVenue() public {
        vm.prank(agent);
        assertFalse(m.execute(address(rogue), abi.encodeWithSelector(DEPOSIT, ONE, address(m))));
        assertTrue(m.frozen());
    }

    function test_blocks_unlistedSelectorOnVenue() public {
        _approve(address(vault), 500 * ONE);
        _deposit(500 * ONE, address(m));
        vm.prank(agent);
        assertFalse(m.execute(address(vault), abi.encodeWithSelector(SHARE_TRANSFER, attacker, 1)));
        assertTrue(m.frozen());
    }

    // ── post-call limits: call rolled back, account frozen ──
    function test_venueCap_rollsBackAndFreezes() public {
        // approve within cap, then ask for more than the cap in two steps
        _approve(address(vault), 600 * ONE);
        _deposit(600 * ONE, address(m));
        _approve(address(vault), 100 * ONE);
        assertFalse(_deposit(100 * ONE, address(m)));
        assertTrue(m.frozen());
        assertEq(m.deployed(), 600 * ONE); // second deposit rolled back
    }

    function test_lossPerCall_skimmingVenue() public {
        vault.setSkim(100); // venue silently steals 1% of deposits
        _approve(address(vault), 500 * ONE);
        assertFalse(_deposit(500 * ONE, address(m)));
        assertTrue(m.frozen());
        assertEq(m.nav(), 1_000 * ONE); // rolled back, nothing lost
    }

    function test_marketDrawdown_pokeFreezes_ownerExits() public {
        _approve(address(vault), 600 * ONE);
        _deposit(600 * ONE, address(m));
        vault.simulateLoss(1_000); // -10% at venue => -6% NAV > 5% limit

        vm.prank(attacker); // anyone can poke
        m.poke();
        assertTrue(m.frozen());

        vm.prank(agent);
        vm.expectRevert(MandateAccount.IsFrozen.selector);
        m.execute(address(vault), "");

        // owner exits through the escape hatch
        uint256 shares = vault.balanceOf(address(m));
        vm.startPrank(owner);
        m.ownerExecute(address(vault), 0, abi.encodeWithSelector(REDEEM, shares, address(m), address(m)));
        m.withdraw(usdc.balanceOf(address(m)), owner);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 940 * ONE);
    }

    // ── venue revert is not a breach ──
    function test_venueRevert_notABreach() public {
        // no approval => transferFrom underflows in the vault
        assertFalse(_deposit(100 * ONE, address(m)));
        assertFalse(m.frozen());
    }

    // ── access control & lifecycle ──
    function test_onlyAgentExecutes() public {
        vm.prank(attacker);
        vm.expectRevert(MandateAccount.NotAgent.selector);
        m.execute(address(vault), "");
    }

    function test_runOnlyCallableBySelf() public {
        vm.prank(agent);
        vm.expectRevert(MandateAccount.NotSelf.selector);
        m.__run(address(vault), "");
    }

    /// Every owner-only path to value or to the rules, tried with the agent's key.
    function test_agentCannotUseOwnerSurface() public {
        MandateAccount.Limits memory loose =
            MandateAccount.Limits({maxDeployed: type(uint128).max, maxDrawdownBps: 10_000, maxLossPerCallBps: 10_000, expiry: uint64(block.timestamp + 365 days)});
        bytes memory steal = abi.encodeWithSelector(usdc.transfer.selector, agent, 1_000 * ONE);
        vm.startPrank(agent);
        vm.expectRevert(MandateAccount.NotOwner.selector);
        m.withdraw(1_000 * ONE, agent);
        vm.expectRevert(MandateAccount.NotOwner.selector);
        m.ownerExecute(address(usdc), 0, steal);
        vm.expectRevert(MandateAccount.NotOwner.selector);
        m.setRule(address(usdc), usdc.transfer.selector, true, 0);
        vm.expectRevert(MandateAccount.NotOwner.selector);
        m.setVenue(address(rogue), true, type(uint128).max, address(0));
        vm.expectRevert(MandateAccount.NotOwner.selector);
        m.setLimits(loose);
        vm.expectRevert(MandateAccount.NotOwner.selector);
        m.setAgent(attacker);
        vm.expectRevert(MandateAccount.NotOwner.selector);
        m.resetHighWaterMark();
        vm.expectRevert(MandateAccount.NotOwner.selector);
        m.unfreeze();
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(m)), 1_000 * ONE);
        assertEq(m.agent(), agent);
    }

    function test_expiry() public {
        vm.warp(block.timestamp + 31 days);
        vm.prank(agent);
        vm.expectRevert(MandateAccount.MandateExpired.selector);
        m.execute(address(usdc), abi.encodeWithSelector(usdc.approve.selector, address(vault), 1));
    }

    function test_ownerWithdrawsWhileFrozen() public {
        vm.prank(owner);
        m.freeze();
        vm.prank(owner);
        m.withdraw(1_000 * ONE, owner);
        assertEq(usdc.balanceOf(owner), 1_000 * ONE);
    }

    function test_withdrawScalesHighWaterMark() public {
        vm.prank(owner);
        m.withdraw(400 * ONE, owner);
        assertEq(m.highWaterMark(), 600 * ONE);
        m.poke();
        assertFalse(m.frozen());
    }

    function test_breachEmitsEvent() public {
        vm.expectEmit(true, true, false, true, address(m));
        emit MandateAccount.Breach(m.R_BAD_APPROVE(), address(usdc), usdc.approve.selector);
        _approve(attacker, 1);
    }

    function test_factoryIndexes() public view {
        assertEq(factory.count(), 1);
        assertEq(factory.mandatesOf(owner)[0], address(m));
        assertEq(factory.mandatesRunBy(agent)[0], address(m));
    }

    // ── fuzz: in-policy deposits never freeze, NAV conserved ──
    function testFuzz_inPolicyDepositsNeverFreeze(uint256 amt) public {
        amt = bound(amt, 1, 600 * ONE);
        assertTrue(_approve(address(vault), amt));
        assertTrue(_deposit(amt, address(m)));
        assertFalse(m.frozen());
        assertEq(m.nav(), 1_000 * ONE);
    }

    // ── fuzz: any receiver other than self is blocked ──
    function testFuzz_foreignReceiverAlwaysBlocked(address receiver) public {
        vm.assume(receiver != address(m));
        _approve(address(vault), 100 * ONE);
        assertFalse(_deposit(100 * ONE, receiver));
        assertTrue(m.frozen());
        assertEq(m.nav(), 1_000 * ONE);
    }
}
