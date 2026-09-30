// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "./interfaces/IERC20.sol";
import {IValuer} from "./interfaces/IValuer.sol";

/// @title MandateAccount
/// @notice A USDC account owned by a human, operated by an AI agent under
///         hard on-chain limits. The owner can always withdraw; the agent can
///         only call allowlisted venue functions, and every call is checked
///         against the mandate before and after it runs.
///
///         Pre-call policy violations and post-call limit breaches do NOT
///         revert the agent's transaction: the offending call is rolled back,
///         the account is frozen, and a `Breach` event is persisted on-chain.
///         Every attempt to break the mandate leaves a public trace.
contract MandateAccount {
    // ─────────────────────────────── constants ───────────────────────────────
    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_VENUES = 8;

    bytes32 public constant R_NOT_ALLOWED = "NOT_ALLOWED"; // target/selector not allowlisted
    bytes32 public constant R_BAD_ARG = "BAD_ARG"; // a guarded arg != this account
    bytes32 public constant R_BAD_APPROVE = "BAD_APPROVE"; // USDC approve to non-venue / above cap
    bytes32 public constant R_LOSS_PER_CALL = "LOSS_PER_CALL"; // NAV dropped too much in one call
    bytes32 public constant R_DRAWDOWN = "DRAWDOWN"; // NAV below high-water-mark limit
    bytes32 public constant R_VENUE_CAP = "VENUE_CAP"; // venue exposure above its cap
    bytes32 public constant R_DEPLOYED_CAP = "DEPLOYED_CAP"; // total exposure above maxDeployed
    bytes32 public constant R_OWNER = "OWNER"; // manual freeze

    // ──────────────────────────────── types ──────────────────────────────────
    struct Limits {
        uint128 maxDeployed; // max total USDC value held at venues (6 dec)
        uint16 maxDrawdownBps; // max NAV drop vs high-water mark
        uint16 maxLossPerCallBps; // max NAV drop inside a single agent call
        uint64 expiry; // agent loses all rights at this timestamp
    }

    struct Venue {
        bool active;
        uint128 cap; // max USDC value at this venue
        IValuer valuer;
    }

    struct Rule {
        bool allowed;
        uint8 selfArgMask; // bit i set => ABI word i of calldata must equal address(this)
    }

    // ──────────────────────────────── storage ────────────────────────────────
    IERC20 public immutable usdc;
    address public immutable factory;

    address public owner;
    address public agent;
    bool public frozen;
    uint256 public highWaterMark;
    Limits public limits;

    address[] internal _venueList;
    mapping(address => Venue) public venues;
    mapping(address => mapping(bytes4 => Rule)) public rules;

    uint256 private _lock = 1;

    // ──────────────────────────────── events ─────────────────────────────────
    event Executed(address indexed target, bytes4 indexed selector, uint256 navBefore, uint256 navAfter);
    event CallReverted(address indexed target, bytes4 indexed selector, bytes returnData);
    event Breach(bytes32 indexed reason, address indexed target, bytes4 selector);
    event Frozen(bytes32 indexed reason);
    event Unfrozen(uint256 nav);
    event Checkpoint(uint256 nav, uint256 highWaterMark, uint256 deployed);
    event Note(bytes32 indexed tag, bytes32 contentHash, string uri);
    event Deposited(uint256 amount, uint256 highWaterMark);
    event Withdrawn(address indexed to, uint256 amount, uint256 highWaterMark);
    event AgentSet(address indexed agent);
    event LimitsSet(Limits limits);
    event VenueSet(address indexed venue, bool active, uint128 cap, address valuer);
    event RuleSet(address indexed target, bytes4 indexed selector, bool allowed, uint8 selfArgMask);

    // ──────────────────────────────── errors ─────────────────────────────────
    error NotOwner();
    error NotAgent();
    error NotSelf();
    error IsFrozen();
    error MandateExpired();
    error Reentrancy();
    error BadLimits();
    error TooManyVenues();
    error ZeroAddress();
    error TransferFailed();
    error InsufficientIdle();
    error PolicyBreach(bytes32 reason);
    error VenueCallFailed(bytes returnData);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address usdc_, address owner_, address agent_, Limits memory limits_) {
        if (usdc_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        factory = msg.sender;
        owner = owner_;
        agent = agent_;
        _setLimits(limits_);
        emit AgentSet(agent_);
    }

    // ═════════════════════════════ AGENT SURFACE ═════════════════════════════

    /// @notice The agent's only way to move funds. Returns false (without
    ///         reverting) when the call is blocked, breaches the mandate, or
    ///         the venue itself reverts.
    function execute(address target, bytes calldata data) external nonReentrant returns (bool) {
        if (msg.sender != agent) revert NotAgent();
        if (frozen) revert IsFrozen();
        if (block.timestamp >= limits.expiry) revert MandateExpired();

        bytes4 sel = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);

        bytes32 reason = _checkPolicy(target, sel, data);
        if (reason != bytes32(0)) {
            _breach(reason, target, sel);
            return false;
        }

        try this.__run(target, data) returns (uint256 navBefore, uint256 navAfter) {
            if (navAfter > highWaterMark) highWaterMark = navAfter;
            emit Executed(target, sel, navBefore, navAfter);
            return true;
        } catch (bytes memory err) {
            bytes32 breachReason = _policyReason(err);
            if (breachReason != bytes32(0)) {
                _breach(breachReason, target, sel);
            } else {
                emit CallReverted(target, sel, err);
            }
            return false;
        }
    }

    /// @notice Agent reasoning log: hash of the decision + pointer to full text.
    function note(bytes32 tag, bytes32 contentHash, string calldata uri) external {
        if (msg.sender != agent) revert NotAgent();
        emit Note(tag, contentHash, uri);
    }

    /// @dev Runs the venue call and post-checks. Only callable by this contract
    ///      (from `execute`), so any revert here rolls the call back cleanly.
    function __run(address target, bytes calldata data) external returns (uint256 navBefore, uint256 navAfter) {
        if (msg.sender != address(this)) revert NotSelf();

        uint256 n = _venueList.length;
        uint256[] memory before = new uint256[](n);
        uint256 deployedBefore;
        for (uint256 i; i < n; ++i) {
            before[i] = venues[_venueList[i]].valuer.valueOf(address(this));
            deployedBefore += before[i];
        }
        navBefore = usdc.balanceOf(address(this)) + deployedBefore;

        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) revert VenueCallFailed(ret);

        uint256 dep;
        for (uint256 i; i < n; ++i) {
            Venue storage v = venues[_venueList[i]];
            uint256 val = v.valuer.valueOf(address(this));
            // Only fail a cap if this call increased exposure (yield accrual never trips it).
            if (val > v.cap && val > before[i]) revert PolicyBreach(R_VENUE_CAP);
            dep += val;
        }
        navAfter = usdc.balanceOf(address(this)) + dep;

        Limits memory l = limits;
        // same rule as venue caps: only trips if this call grew total exposure
        if (dep > l.maxDeployed && dep > deployedBefore) revert PolicyBreach(R_DEPLOYED_CAP);
        if (navAfter * BPS < navBefore * (BPS - l.maxLossPerCallBps)) revert PolicyBreach(R_LOSS_PER_CALL);
        if (_drawdownBreached(navAfter)) revert PolicyBreach(R_DRAWDOWN);
    }

    // ═══════════════════════════ PERMISSIONLESS ══════════════════════════════

    /// @notice Anyone can checkpoint NAV. Freezes the account if the market
    ///         has pushed NAV past the drawdown limit between agent calls.
    function poke() external nonReentrant returns (uint256 nav_) {
        uint256 dep;
        (nav_, dep) = _navAndDeployed();
        if (!frozen && _drawdownBreached(nav_)) {
            _breach(R_DRAWDOWN, address(0), bytes4(0));
        } else if (nav_ > highWaterMark) {
            highWaterMark = nav_;
        }
        emit Checkpoint(nav_, highWaterMark, dep);
    }

    // ═════════════════════════════ OWNER SURFACE ═════════════════════════════

    function deposit(uint256 amount) external onlyOwner nonReentrant {
        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        highWaterMark += amount;
        emit Deposited(amount, highWaterMark);
    }

    /// @notice Always available, even when frozen or expired.
    function withdraw(uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (usdc.balanceOf(address(this)) < amount) revert InsufficientIdle();
        (uint256 navBefore,) = _navAndDeployed();
        if (!usdc.transfer(to, amount)) revert TransferFailed();
        // scale HWM so a withdrawal is never mistaken for a loss
        highWaterMark = navBefore == 0 ? 0 : (highWaterMark * (navBefore - amount)) / navBefore;
        emit Withdrawn(to, amount, highWaterMark);
    }

    /// @notice Unrestricted escape hatch: it's the owner's account. Use it to
    ///         pull funds out of a venue, then `resetHighWaterMark` if needed.
    function ownerExecute(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        nonReentrant
        returns (bytes memory)
    {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert VenueCallFailed(ret);
        return ret;
    }

    function freeze() external onlyOwner {
        if (!frozen) {
            frozen = true;
            emit Frozen(R_OWNER);
        }
    }

    /// @notice Unfreezing re-bases the high-water mark to current NAV.
    function unfreeze() external onlyOwner {
        frozen = false;
        (uint256 nav_,) = _navAndDeployed();
        highWaterMark = nav_;
        emit Unfrozen(nav_);
    }

    function resetHighWaterMark() external onlyOwner {
        (uint256 nav_, uint256 dep) = _navAndDeployed();
        highWaterMark = nav_;
        emit Checkpoint(nav_, nav_, dep);
    }

    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentSet(agent_);
    }

    function setLimits(Limits calldata l) external onlyOwner {
        _setLimits(l);
    }

    function setVenue(address venue, bool active, uint128 cap, address valuer) external onlyOwner {
        if (venue == address(0) || venue == address(usdc) || venue == address(this)) revert ZeroAddress();
        Venue storage v = venues[venue];
        if (address(v.valuer) == address(0)) {
            if (valuer == address(0)) revert ZeroAddress();
            if (_venueList.length >= MAX_VENUES) revert TooManyVenues();
            _venueList.push(venue);
        }
        v.active = active;
        v.cap = cap;
        if (valuer != address(0)) v.valuer = IValuer(valuer);
        emit VenueSet(venue, active, cap, address(v.valuer));
    }

    function setRule(address target, bytes4 selector, bool allowed, uint8 selfArgMask) external onlyOwner {
        rules[target][selector] = Rule(allowed, selfArgMask);
        emit RuleSet(target, selector, allowed, selfArgMask);
    }

    // ═══════════════════════════════ VIEWS ═══════════════════════════════════

    function nav() external view returns (uint256 nav_) {
        (nav_,) = _navAndDeployed();
    }

    function deployed() external view returns (uint256 d) {
        (, d) = _navAndDeployed();
    }

    function venueList() external view returns (address[] memory) {
        return _venueList;
    }

    function drawdownFloor() external view returns (uint256) {
        return (highWaterMark * (BPS - limits.maxDrawdownBps)) / BPS;
    }

    // ═════════════════════════════ INTERNALS ═════════════════════════════════

    function _checkPolicy(address target, bytes4 sel, bytes calldata data) internal view returns (bytes32) {
        if (data.length < 4) return R_NOT_ALLOWED;

        // USDC: the agent may only approve an active venue, up to that venue's cap.
        if (target == address(usdc)) {
            if (sel != IERC20.approve.selector || data.length < 68) return R_BAD_APPROVE;
            address spender = _argAddress(data, 0);
            uint256 amount = uint256(_word(data, 1));
            Venue storage v = venues[spender];
            if (!v.active || amount > v.cap) return R_BAD_APPROVE;
            return bytes32(0);
        }

        if (!venues[target].active) return R_NOT_ALLOWED;
        Rule memory r = rules[target][sel];
        if (!r.allowed) return R_NOT_ALLOWED;

        uint8 mask = r.selfArgMask;
        for (uint256 i; i < 8; ++i) {
            if (mask & (1 << i) == 0) continue;
            if (data.length < 4 + 32 * (i + 1)) return R_BAD_ARG;
            if (_word(data, i) != bytes32(uint256(uint160(address(this))))) return R_BAD_ARG;
        }
        return bytes32(0);
    }

    function _navAndDeployed() internal view returns (uint256 nav_, uint256 deployed_) {
        uint256 n = _venueList.length;
        for (uint256 i; i < n; ++i) {
            deployed_ += venues[_venueList[i]].valuer.valueOf(address(this));
        }
        nav_ = usdc.balanceOf(address(this)) + deployed_;
    }

    function _drawdownBreached(uint256 nav_) internal view returns (bool) {
        return nav_ * BPS < highWaterMark * (BPS - limits.maxDrawdownBps);
    }

    function _breach(bytes32 reason, address target, bytes4 sel) internal {
        frozen = true;
        emit Breach(reason, target, sel);
        emit Frozen(reason);
    }

    function _policyReason(bytes memory err) internal pure returns (bytes32 reason) {
        if (err.length != 36) return bytes32(0);
        bytes4 s;
        assembly {
            s := mload(add(err, 32))
            reason := mload(add(err, 36))
        }
        if (s != PolicyBreach.selector) return bytes32(0);
    }

    function _setLimits(Limits memory l) internal {
        if (l.maxDrawdownBps > BPS || l.maxLossPerCallBps > BPS || l.expiry <= block.timestamp) revert BadLimits();
        limits = l;
        emit LimitsSet(l);
    }

    function _word(bytes calldata data, uint256 i) internal pure returns (bytes32) {
        uint256 off = 4 + 32 * i;
        return bytes32(data[off:off + 32]);
    }

    function _argAddress(bytes calldata data, uint256 i) internal pure returns (address) {
        return address(uint160(uint256(_word(data, i))));
    }

    receive() external payable {}
}
