// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal ERC-20 mock with mint, used only in tests.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // Reentrancy-attack hook: if set, call this target with this calldata on every transfer.
    address public reentrantTarget;
    bytes public reentrantCalldata;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    /// @dev Set a reentrant hook: on the NEXT transfer call, call `target` with `data`.
    function setReentrantHook(address target, bytes calldata data) external {
        reentrantTarget = target;
        reentrantCalldata = data;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);

        // Fire the reentrant hook once, then clear it to avoid infinite recursion.
        if (reentrantTarget != address(0)) {
            address t = reentrantTarget;
            bytes memory d = reentrantCalldata;
            reentrantTarget = address(0);
            reentrantCalldata = "";
            (bool ok,) = t.call(d);
            // Propagate revert so vm.expectRevert can catch it.
            if (!ok) {
                assembly {
                    let ptr := mload(0x40)
                    returndatacopy(ptr, 0, returndatasize())
                    revert(ptr, returndatasize())
                }
            }
        }
    }
}
