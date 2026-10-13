// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Test-only helpers for EscrowSettlement. Not deployed by any script.

interface IEscrowSettlement {
    function createAgreement(address farmer, string calldata produceType, uint256 quantityKg)
        external payable returns (uint256);
    function cancelAgreement(uint256 agreementId) external;
    function withdraw() external;
}

/// A buyer whose receive() tries to re-enter withdraw() while being paid.
contract ReentrantBuyer {
    IEscrowSettlement public immutable escrow;
    uint256 public reentryAttempts;
    uint256 public reentrySuccesses;

    constructor(IEscrowSettlement _escrow) {
        escrow = _escrow;
    }

    function create(address farmer) external payable returns (uint256) {
        return escrow.createAgreement{value: msg.value}(farmer, "wheat", 10);
    }

    function cancel(uint256 agreementId) external {
        escrow.cancelAgreement(agreementId);
    }

    function attackWithdraw() external {
        escrow.withdraw();
    }

    receive() external payable {
        if (reentryAttempts < 3) {
            reentryAttempts++;
            try escrow.withdraw() {
                reentrySuccesses++;
            } catch {}
        }
    }
}

/// A buyer that cannot receive ETH (no receive/fallback).
contract RejectingBuyer {
    IEscrowSettlement public immutable escrow;

    constructor(IEscrowSettlement _escrow) {
        escrow = _escrow;
    }

    function create(address farmer) external payable returns (uint256) {
        return escrow.createAgreement{value: msg.value}(farmer, "rice", 5);
    }

    function cancel(uint256 agreementId) external {
        escrow.cancelAgreement(agreementId);
    }

    function tryWithdraw() external {
        escrow.withdraw();
    }
}
