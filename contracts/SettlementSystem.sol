// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title SettlementSystem
/// @notice Records a farmer–buyer produce agreement, an admin-confirmed delivery,
///         and a settlement token whose lifecycle is ACTIVE -> REDEEMED | RECLAIMED.
/// @dev    The "settlement token" is a status record only: no ETH or ERC-20 value
///         is escrowed or transferred by this contract. Payment itself happens
///         off-chain; the contract provides an auditable record of its state.
contract SettlementSystem {

    // ── Roles ──────────────────────────────────────────────
    address public admin;
    mapping(address => bool) public registeredFarmers;
    mapping(address => bool) public registeredBuyers;

    // ── Token state ────────────────────────────────────────
    enum Status { NONE, ACTIVE, REDEEMED, RECLAIMED }

    struct Token {
        address farmer;
        address buyer;
        uint256 amountINR;   // copied from Transaction.agreedPriceINR; unit is whatever the caller supplies (scripts pass whole INR)
        uint256 issuedAt;
        Status  status;
    }

    uint256 public tokenCounter;
    mapping(uint256 => Token) public tokens;

    // ── Transaction records ────────────────────────────────
    struct Transaction {
        address farmer;
        address buyer;
        string  produceType;
        uint256 quantityKg;
        uint256 agreedPriceINR;
        bool    deliveryConfirmed;
        uint256 agreedAt;
        uint256 confirmedAt;
    }

    uint256 public txCounter;
    mapping(uint256 => Transaction) public transactions;

    // ── Events ─────────────────────────────────────────────
    event FarmerRegistered(address indexed farmer);
    event BuyerRegistered(address indexed buyer);
    event TransactionCreated(uint256 indexed txId, address farmer, address buyer, uint256 priceINR);
    event DeliveryConfirmed(uint256 indexed txId, uint256 confirmedAt);
    event SettlementTokenIssued(uint256 indexed tokenId, address indexed farmer, uint256 amountINR);
    event SettlementTokenRedeemed(uint256 indexed tokenId, address indexed farmer, uint256 amountINR);
    event SettlementTokenReclaimed(uint256 indexed tokenId);

    // ── Modifiers ──────────────────────────────────────────
    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }
    modifier onlyFarmer() {
        require(registeredFarmers[msg.sender], "Not a registered farmer");
        _;
    }
    modifier onlyBuyer() {
        require(registeredBuyers[msg.sender], "Not a registered buyer");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    // ── Registration ───────────────────────────────────────
    // Re-registering an already-registered address is allowed (idempotent);
    // the experiment scripts rely on this.
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

    // ── Transaction creation ───────────────────────────────
    function createTransaction(
        address farmer,
        string calldata produceType,
        uint256 quantityKg,
        uint256 agreedPriceINR
    ) external onlyBuyer returns (uint256) {
        require(registeredFarmers[farmer], "Farmer not registered");
        require(quantityKg > 0, "Quantity must be > 0");
        require(agreedPriceINR > 0, "Price must be > 0");
        uint256 txId = ++txCounter;
        transactions[txId] = Transaction({
            farmer:            farmer,
            buyer:             msg.sender,
            produceType:       produceType,
            quantityKg:        quantityKg,
            agreedPriceINR:    agreedPriceINR,
            deliveryConfirmed: false,
            agreedAt:          block.timestamp,
            confirmedAt:       0
        });
        emit TransactionCreated(txId, farmer, msg.sender, agreedPriceINR);
        return txId;
    }

    // ── Delivery confirmation ──────────────────────────────
    function confirmDelivery(uint256 txId) external onlyAdmin {
        Transaction storage t = transactions[txId];
        // Without this check, confirming a non-existent txId succeeded and
        // issued an ACTIVE token for farmer address(0) with amount 0.
        require(t.farmer != address(0), "Unknown transaction");
        require(!t.deliveryConfirmed, "Already confirmed");
        t.deliveryConfirmed = true;
        t.confirmedAt = block.timestamp;
        emit DeliveryConfirmed(txId, block.timestamp);

        // Auto-issue settlement token
        uint256 tokenId = ++tokenCounter;
        tokens[tokenId] = Token({
            farmer:    t.farmer,
            buyer:     t.buyer,
            amountINR: t.agreedPriceINR,
            issuedAt:  block.timestamp,
            status:    Status.ACTIVE
        });
        emit SettlementTokenIssued(tokenId, t.farmer, t.agreedPriceINR);
    }

    // ── Redemption ─────────────────────────────────────────
    function redeemToken(uint256 tokenId) external {
        Token storage tok = tokens[tokenId];
        require(tok.farmer == msg.sender, "Not your token");
        require(tok.status == Status.ACTIVE, "Token not active");
        tok.status = Status.REDEEMED;
        emit SettlementTokenRedeemed(tokenId, msg.sender, tok.amountINR);
    }

    // ── Admin reclaim (dispute resolution) ─────────────────
    function reclaimToken(uint256 tokenId) external onlyAdmin {
        Token storage tok = tokens[tokenId];
        require(tok.status == Status.ACTIVE, "Token not active");
        tok.status = Status.RECLAIMED;
        emit SettlementTokenReclaimed(tokenId);
    }

    // ── View helpers ───────────────────────────────────────
    function getToken(uint256 tokenId) external view returns (Token memory) {
        return tokens[tokenId];
    }

    function getTransaction(uint256 txId) external view returns (Transaction memory) {
        return transactions[txId];
    }
}
