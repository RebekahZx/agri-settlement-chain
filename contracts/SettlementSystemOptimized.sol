// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title SettlementSystemOptimized
/// @notice Behaviourally equivalent to SettlementSystem (same functions, events,
///         revert messages and view-function return shapes); only the storage
///         layout differs. The same unit-test suite runs against both contracts,
///         and scripts/gas_comparison.js measures the difference.
/// @dev    Where the gas goes in v1, and what changes here:
///         1. v1 stores a Transaction in 7 storage slots (each new slot ≈ 22.1k gas).
///            Here it is packed into 4: [farmer|agreedAt|confirmed], [buyer|confirmedAt],
///            [quantityKg|agreedPriceINR], [produceType]. Timestamps fit in uint64;
///            quantity and price are bounded to uint128 (checked on input).
///         2. v1's confirmDelivery copies farmer, buyer, amount and timestamp into a
///            new 4-slot Token. Here a token is one slot [txId|status]; the other
///            fields are read from its transaction (issuedAt == confirmedAt, since
///            both are set in the same call).
///         3. The public `transactions` / `tokens` mapping getters of v1 are not
///            exposed; use getTransaction / getToken (identical return shapes).
contract SettlementSystemOptimized {

    // ── Roles ──────────────────────────────────────────────
    address public immutable admin;
    mapping(address => bool) public registeredFarmers;
    mapping(address => bool) public registeredBuyers;

    // ── Public (view) shapes: identical to SettlementSystem ─
    enum Status { NONE, ACTIVE, REDEEMED, RECLAIMED }

    struct Token {
        address farmer;
        address buyer;
        uint256 amountINR;
        uint256 issuedAt;
        Status  status;
    }

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

    // ── Packed storage ─────────────────────────────────────
    struct TxRecord {
        address farmer;            // slot 0: 20 bytes
        uint64  agreedAt;          //         8 bytes
        bool    deliveryConfirmed; //         1 byte
        address buyer;             // slot 1: 20 bytes
        uint64  confirmedAt;       //         8 bytes
        uint128 quantityKg;        // slot 2
        uint128 agreedPriceINR;
        string  produceType;       // slot 3 (+ data slots if ≥ 32 bytes)
    }

    struct TokenRecord {
        uint64 txId;               // slot 0
        Status status;
    }

    uint256 public txCounter;
    uint256 public tokenCounter;
    mapping(uint256 => TxRecord) private txs;
    mapping(uint256 => TokenRecord) private tokenRecords;

    // ── Events (identical to SettlementSystem) ─────────────
    event FarmerRegistered(address indexed farmer);
    event BuyerRegistered(address indexed buyer);
    event TransactionCreated(uint256 indexed txId, address farmer, address buyer, uint256 priceINR);
    event DeliveryConfirmed(uint256 indexed txId, uint256 confirmedAt);
    event SettlementTokenIssued(uint256 indexed tokenId, address indexed farmer, uint256 amountINR);
    event SettlementTokenRedeemed(uint256 indexed tokenId, address indexed farmer, uint256 amountINR);
    event SettlementTokenReclaimed(uint256 indexed tokenId);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
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
        require(quantityKg <= type(uint128).max && agreedPriceINR <= type(uint128).max, "Value too large");

        uint256 txId = ++txCounter;
        TxRecord storage t = txs[txId];
        t.farmer         = farmer;
        t.agreedAt       = uint64(block.timestamp);
        t.buyer          = msg.sender;
        t.quantityKg     = uint128(quantityKg);
        t.agreedPriceINR = uint128(agreedPriceINR);
        t.produceType    = produceType;

        emit TransactionCreated(txId, farmer, msg.sender, agreedPriceINR);
        return txId;
    }

    // ── Delivery confirmation ──────────────────────────────
    function confirmDelivery(uint256 txId) external onlyAdmin {
        TxRecord storage t = txs[txId];
        require(t.farmer != address(0), "Unknown transaction");
        require(!t.deliveryConfirmed, "Already confirmed");
        t.deliveryConfirmed = true;
        t.confirmedAt = uint64(block.timestamp);
        emit DeliveryConfirmed(txId, block.timestamp);

        uint256 tokenId = ++tokenCounter;
        tokenRecords[tokenId] = TokenRecord({ txId: uint64(txId), status: Status.ACTIVE });
        emit SettlementTokenIssued(tokenId, t.farmer, t.agreedPriceINR);
    }

    // ── Redemption ─────────────────────────────────────────
    function redeemToken(uint256 tokenId) external {
        TokenRecord storage tok = tokenRecords[tokenId];
        TxRecord storage t = txs[tok.txId];
        require(t.farmer == msg.sender, "Not your token");
        require(tok.status == Status.ACTIVE, "Token not active");
        tok.status = Status.REDEEMED;
        emit SettlementTokenRedeemed(tokenId, msg.sender, t.agreedPriceINR);
    }

    // ── Admin reclaim (dispute resolution) ─────────────────
    function reclaimToken(uint256 tokenId) external onlyAdmin {
        TokenRecord storage tok = tokenRecords[tokenId];
        require(tok.status == Status.ACTIVE, "Token not active");
        tok.status = Status.RECLAIMED;
        emit SettlementTokenReclaimed(tokenId);
    }

    // ── View helpers (same return shapes as SettlementSystem) ─
    function getToken(uint256 tokenId) external view returns (Token memory out) {
        TokenRecord storage tok = tokenRecords[tokenId];
        if (tok.status == Status.NONE) return out; // all-zero, as in v1
        TxRecord storage t = txs[tok.txId];
        out = Token({
            farmer:    t.farmer,
            buyer:     t.buyer,
            amountINR: t.agreedPriceINR,
            issuedAt:  t.confirmedAt,
            status:    tok.status
        });
    }

    function getTransaction(uint256 txId) external view returns (Transaction memory) {
        TxRecord storage t = txs[txId];
        return Transaction({
            farmer:            t.farmer,
            buyer:             t.buyer,
            produceType:       t.produceType,
            quantityKg:        t.quantityKg,
            agreedPriceINR:    t.agreedPriceINR,
            deliveryConfirmed: t.deliveryConfirmed,
            agreedAt:          t.agreedAt,
            confirmedAt:       t.confirmedAt
        });
    }
}
