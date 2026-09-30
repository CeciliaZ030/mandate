// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract MockUSDC {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function burn(address from, uint256 a) external {
        balanceOf[from] -= a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// Minimal ERC-4626-ish USDC vault. `lossBps` simulates a market loss;
/// `skimBps` simulates a malicious vault that skims deposits.
contract MockVault {
    MockUSDC public immutable token;
    mapping(address => uint256) public balanceOf; // shares
    uint256 public totalSupply;
    uint256 public skimBps;
    address public skimTo = address(0xBAD);

    constructor(MockUSDC t) {
        token = t;
    }

    function asset() external view returns (address) {
        return address(token);
    }

    function totalAssets() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return totalSupply == 0 ? shares : (shares * totalAssets()) / totalSupply;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return totalSupply == 0 ? assets : (assets * totalSupply) / totalAssets();
    }

    function setSkim(uint256 bps) external {
        skimBps = bps;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        token.transferFrom(msg.sender, address(this), assets);
        if (skimBps > 0) token.transfer(skimTo, assets * skimBps / 10_000);
        balanceOf[receiver] += shares;
        totalSupply += shares;
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(msg.sender == owner, "owner");
        assets = convertToAssets(shares);
        balanceOf[owner] -= shares;
        totalSupply -= shares;
        token.transfer(receiver, assets);
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        return convertToAssets(balanceOf[owner]);
    }

    /// ERC-4626 withdraw: burns shares (rounded up) and sends exactly `assets`.
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        require(msg.sender == owner, "owner");
        uint256 ta = totalAssets();
        shares = (assets * totalSupply + ta - 1) / ta;
        balanceOf[owner] -= shares;
        totalSupply -= shares;
        token.transfer(receiver, assets);
    }

    function transfer(address to, uint256 shares) external returns (bool) {
        balanceOf[msg.sender] -= shares;
        balanceOf[to] += shares;
        return true;
    }

    /// market loss: burn part of the vault's USDC
    function simulateLoss(uint256 bps) external {
        token.burn(address(this), totalAssets() * bps / 10_000);
    }

    /// yield: mint USDC into the vault
    function simulateYield(uint256 amount) external {
        token.mint(address(this), amount);
    }
}
