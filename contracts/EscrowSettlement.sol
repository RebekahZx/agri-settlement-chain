// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title EscrowSettlement (v2)
/// @notice Same roles and lifecycle as SettlementSystem, but the buyer's payment
///         is actually held by the contract and released by the outcome:
///
///           buyer createAgreement{value: price}   -> FUNDED   (ETH escrowed)
///           buyer/admin cancelAgreement           -> CANCELLED (buyer refunded)
///           admin confirmDelivery                 -> DELIVERED, settlement token ACTIVE
///           farmer redeemToken                    -> REDEEMED  (farmer paid)
///           admin reclaimToken (dispute)          -> RECLAIMED (buyer refunded)
///
/// @dev    Payouts use the pull pattern: outcomes credit `pendingWithdrawals`, and
///         recipients call `withdraw()`. State is updated before the external call
///         (checks-effects-interactions), so a re-entrant `withdraw` finds nothing
///         to pay. Invariant (tested): address(this).balance == totalEscrowed + totalOwed.
///         Amounts are in wei; no price oracle or INR conversion is involved.
contract EscrowSettlement {

    // ── Roles ──────────────────────────────────────────────
    address public immutable admin;
    mapping(address => bool) public registeredFarmers;
    mapping(address => bool) public registeredBuyers;

    // ── State ──────────────────────────────────────────────
    enum AgreementStatus { NONE, FUNDED, DELIVERED, CANCELLED }
    enum TokenStatus     { NONE, ACTIVE, REDEEMED, RECLAIMED }

    struct Agreement {
        address farmer;
        address buyer;
        string  produceType;
        uint256 quantityKg;
        uint256 priceWei;
        uint256 agreedAt;
        uint256 confirmedAt;
        AgreementStatus status;
    }

    struct Token {
        uint256 agreementId;
        address farmer;
        address buyer;
        uint256 amountWei;
        uint256 issuedAt;
        TokenStatus status;
    }

    uint256 public agreementCounter;
    uint256 public tokenCounter;
    mapping(uint256 => Agreement) private agreements;
    mapping(uint256 => Token) private tokens;

    /// Funds owed to each address, claimable with withdraw().
    mapping(address => uint256) public pendingWithdrawals;
    /// Funds locked in FUNDED agreements and ACTIVE tokens.
    uint256 public totalEscrowed;
    /// Sum of all pendingWithdrawals.
    uint256 public totalOwed;

    // ── Events ─────────────────────────────────────────────
    event FarmerRegistered(address indexed farmer);
    event BuyerRegistered(address indexed buyer);
    event AgreementFunded(uint256 indexed agreementId, address indexed farmer, address indexed buyer, uint256 priceWei);
    event AgreementCancelled(uint256 indexed agreementId, address cancelledBy);
    event DeliveryConfirmed(uint256 indexed agreementId, uint256 indexed tokenId);
    event TokenRedeemed(uint256 indexed tokenId, address indexed farmer, uint256 amountWei);
    event TokenReclaimed(uint256 indexed tokenId, address indexed buyer, uint256 amountWei);
    event Withdrawal(address indexed to, uint256 amountWei);

    // ── Modifiers ──────────────────────────────────────────
    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    // ── Registration ───────────────────────────────────────
    function registerFarmer(address farmer) external onlyAdmin {
        require(farmer != address(0), "Zero address");
        registeredFarmers[farmer] = true;
        emit FarmerRegistered(farmer);
    }

    function registerBuyer(address buyer) external onlyAdmin {
        require(buyer != address(0), "Zero address");
        registeredBuyers[buyer] = true;
        emit BuyerRegistered(buyer);
    }

    // ── Agreement ──────────────────────────────────────────
    /// @notice Buyer creates an agreement and escrows the full price (msg.value).
    function createAgreement(address farmer, string calldata produceType, uint256 quantityKg)
        external
        payable
        returns (uint256 agreementId)
    {
        require(registeredBuyers[msg.sender], "Not a registered buyer");
        require(registeredFarmers[farmer], "Farmer not registered");
        require(quantityKg > 0, "Quantity must be > 0");
        require(msg.value > 0, "Price must be > 0");

        agreementId = ++agreementCounter;
        agreements[agreementId] = Agreement({
            farmer:      farmer,
            buyer:       msg.sender,
            produceType: produceType,
            quantityKg:  quantityKg,
            priceWei:    msg.value,
            agreedAt:    block.timestamp,
            confirmedAt: 0,
            status:      AgreementStatus.FUNDED
        });
        totalEscrowed += msg.value;
        emit AgreementFunded(agreementId, farmer, msg.sender, msg.value);
    }

    /// @notice Before delivery is confirmed, the buyer or admin can cancel; the buyer is refunded.
    function cancelAgreement(uint256 agreementId) external {
        Agreement storage a = agreements[agreementId];
        require(a.status == AgreementStatus.FUNDED, "Not cancellable");
        require(msg.sender == a.buyer || msg.sender == admin, "Not buyer or admin");

        a.status = AgreementStatus.CANCELLED;
        _release(a.buyer, a.priceWei);
        emit AgreementCancelled(agreementId, msg.sender);
    }

    // ── Delivery ───────────────────────────────────────────
    function confirmDelivery(uint256 agreementId) external onlyAdmin returns (uint256 tokenId) {
        Agreement storage a = agreements[agreementId];
        require(a.status == AgreementStatus.FUNDED, "Not awaiting delivery");

        a.status = AgreementStatus.DELIVERED;
        a.confirmedAt = block.timestamp;

        tokenId = ++tokenCounter;
        tokens[tokenId] = Token({
            agreementId: agreementId,
            farmer:      a.farmer,
            buyer:       a.buyer,
            amountWei:   a.priceWei,
            issuedAt:    block.timestamp,
            status:      TokenStatus.ACTIVE
        });
        emit DeliveryConfirmed(agreementId, tokenId);
    }

    // ── Settlement ─────────────────────────────────────────
    function redeemToken(uint256 tokenId) external {
        Token storage t = tokens[tokenId];
        require(t.farmer == msg.sender, "Not your token");
        require(t.status == TokenStatus.ACTIVE, "Token not active");

        t.status = TokenStatus.REDEEMED;
        _release(t.farmer, t.amountWei);
        emit TokenRedeemed(tokenId, t.farmer, t.amountWei);
    }

    /// @notice Dispute resolution: admin returns the escrowed amount to the buyer.
    function reclaimToken(uint256 tokenId) external onlyAdmin {
        Token storage t = tokens[tokenId];
        require(t.status == TokenStatus.ACTIVE, "Token not active");

        t.status = TokenStatus.RECLAIMED;
        _release(t.buyer, t.amountWei);
        emit TokenReclaimed(tokenId, t.buyer, t.amountWei);
    }

    // ── Payouts ────────────────────────────────────────────
    function withdraw() external {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Nothing to withdraw");

        // Effects (state and event) before interaction.
        pendingWithdrawals[msg.sender] = 0;
        totalOwed -= amount;
        emit Withdrawal(msg.sender, amount);

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
    }

    function _release(address to, uint256 amount) private {
        totalEscrowed -= amount;
        totalOwed += amount;
        pendingWithdrawals[to] += amount;
    }

    // ── Views ──────────────────────────────────────────────
    function getAgreement(uint256 agreementId) external view returns (Agreement memory) {
        return agreements[agreementId];
    }

    function getToken(uint256 tokenId) external view returns (Token memory) {
        return tokens[tokenId];
    }
}
