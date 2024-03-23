// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import "./SolarGreen.sol";

contract TokenSale {
    IERC20 public token;
    address public owner;
    uint public BASE_MULTIPLIER;
    uint public availableTokens;
    uint public startAt;
    uint public endsAt;
    uint public tokenPrice;

    AggregatorV3Interface internal aggregatorInterface;

    event Bought(uint _amount, address indexed _buyer);
    event TokenSaleEnded(uint _amoutUnpurchasedTokens, uint _endTime);

    constructor() {
        token = new SolarGreen(address(this));
        owner = msg.sender;
        availableTokens = token.balanceOf(address(this)) / 2;
        BASE_MULTIPLIER = 10 ** 18;
        startAt = block.timestamp;
        endsAt = 5 * 7 * 24 * 60 * 60 + startAt; // 5 week

        tokenPrice = (7 * BASE_MULTIPLIER) / 1000; // 0.007$
        aggregatorInterface = AggregatorV3Interface(
            address(0x694AA1769357215DE4FAC081bf1f309aDC325306)
        );
    }

    modifier onlyOwner() {
        require((msg.sender == owner), "not an owner");
        _;
    }

    function tokenBalance() public view returns (uint) {
        return token.balanceOf(address(this));
    }

    function setSaleEndTime(uint _newDuration) external onlyOwner {
        endsAt = _newDuration + startAt;
    }

    function setSaleStartTime(uint _startTime) external onlyOwner {
        startAt = _startTime;
    }

    function updateTokenPrice(uint _newPrice) external {
        tokenPrice = _newPrice;
    }

    function getLatestPrice() public view returns (uint) {
        (, int price, , , ) = aggregatorInterface.latestRoundData();
        price = (price * 10 ** 10);
        return uint(price);
    }

    function ethBuyHelper(uint _amount) external view returns (uint ethAmount) {
        uint256 usdPrice = _amount * tokenPrice;
        ethAmount = (usdPrice * BASE_MULTIPLIER) / getLatestPrice();
    }

    function usdtBuyHelper(uint _amount) external view returns (uint usdPrice) {
        usdPrice = _amount * tokenPrice;
    }

    receive() external payable {
        uint tokensToBuy = msg.value; // 1 token - 1 wei

        if (availableTokens == 0 || block.timestamp >= endsAt) {
            emit TokenSaleEnded(availableTokens, endsAt);
        }

        require(block.timestamp >= startAt, "sale has not started yet");
        require(block.timestamp < endsAt, "sale has ended");
        require(tokensToBuy > 0, "not enough funds!");
        require(tokensToBuy <= 50000, "can't buy more than 50k token");
        require(tokensToBuy <= availableTokens, "not enough tokens");

        token.transfer(msg.sender, tokensToBuy);
        availableTokens -= tokensToBuy;

        emit Bought(tokensToBuy, msg.sender);
    }
}
