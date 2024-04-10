import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("TokenSale", function () {
  async function deploy() {
    const [owner, buyer, spender] = await ethers.getSigners();

    const DECIMALS = 18;
    const INITIAL_PRICE = "360000000000"; // 3600$ ETH/USDT
    const tokenPrice = ethers.parseUnits("7", 16); // 0.07$ 
    const tokensForPurchase = ethers.parseUnits("50000000", 18);

    const mockV3AggregatorFactory = await ethers.getContractFactory("MockV3Aggregator");
    const mockV3Aggregator = await mockV3AggregatorFactory.deploy(DECIMALS, INITIAL_PRICE);
    await mockV3Aggregator.waitForDeployment();

    const Tether = await ethers.getContractFactory("TestUSTD");
    const usdt = await Tether.deploy();
    await usdt.waitForDeployment();

    const SolarGreen = await ethers.getContractFactory("SolarGreen", owner);
    const token = await SolarGreen.deploy(owner.address);
    await token.waitForDeployment();

    const TokenSale = await ethers.getContractFactory("TokenSale", owner);
    const shop = await TokenSale.deploy(
      owner.address,
      usdt.target,
      mockV3Aggregator.target,
      token.target,
      tokenPrice
    );
    await shop.waitForDeployment();

    await token.mint(shop.target, tokensForPurchase);
    await shop.startSale();

    const saleEnd = (await time.latest()) + time.duration.weeks(5);
    await shop.setSaleEndTime(BigInt(saleEnd) - (await shop.START_AT()));
    await shop.setVestingEndTime(saleEnd + time.duration.days(30));

    return { owner, buyer, spender, shop, token, usdt, mockV3Aggregator };
  }

  it("should have an owner", async function () {
    const { owner, shop } = await loadFixture(deploy);

    expect(await shop.owner()).to.equal(owner.address);
    expect(shop.target).to.properAddress;
  });

  it("cannot deploy with addresses that are not contracts", async function () {
    const { owner, buyer, token, usdt, mockV3Aggregator } = await loadFixture(deploy);

    const TokenSale = await ethers.getContractFactory("TokenSale", owner);
    const tokenPrice = ethers.parseUnits("7", 16);

    await expect(
      TokenSale.deploy(owner.address, buyer.address, mockV3Aggregator.target, token.target, tokenPrice)
    ).to.be.revertedWithCustomError(TokenSale, "InvalidPurchaseToken");
    await expect(
      TokenSale.deploy(owner.address, usdt.target, mockV3Aggregator.target, buyer.address, tokenPrice)
    ).to.be.revertedWithCustomError(TokenSale, "InvalidSaleToken");
    await expect(
      TokenSale.deploy(owner.address, usdt.target, buyer.address, token.target, tokenPrice)
    ).to.be.revertedWithCustomError(TokenSale, "InvalidPriceFeed");
  });

  describe("Allowing to stop the sale", function () {
    it("should allow the owner to start the sale", async () => {
      const { shop } = await loadFixture(deploy);

      await shop.startSale();
      const isSaleActive = await shop.saleActive();
      expect(isSaleActive).to.be.true;
    });

    it("should allow the owner to pause the sale", async () => {
      const { shop } = await loadFixture(deploy);

      await shop.pauseSale();
      const isSaleActive = await shop.saleActive();
      expect(isSaleActive).to.be.false;
    });

    it("should allow the owner to resume the sale", async () => {
      const { shop } = await loadFixture(deploy);

      await shop.pauseSale();
      await shop.unPauseSale();
      const isSaleActive = await shop.saleActive();
      expect(isSaleActive).to.be.true;
    });

    it("cannot pause the sale if it is not active", async () => {
      const { shop } = await loadFixture(deploy);

      await shop.pauseSale();

      await expect(shop.pauseSale()).to.be.revertedWithCustomError(shop, "SaleNotActive");
    });

    it("cannot start the sale without enough tokens on the contract", async () => {
      const { owner, shop, token } = await loadFixture(deploy);

      await shop.withdrawTokens(token.target, owner.address, ethers.parseUnits("1", 18));

      await expect(shop.startSale()).to.be.revertedWithCustomError(shop, "InsufficientBalance");
    });
  });

  describe("Correct work of changing the token price, vesting, sale end time, auxiliary functions", function () {
    it("correct work of the function that calculates the number of ETH and USDT for the token", async function () {
      const { shop } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("700", 18);
      const ethPrice = await shop.getLatestPrice();

      const usdtAmount = (tokenAmount * await shop.saleTokenPrice()) / ethers.parseUnits("1", 18);
      const ethAmount = (usdtAmount * ethers.parseUnits("1", 18)) / ethPrice;

      expect(await shop.getPurchaseTokenAmount(tokenAmount)).to.equal(usdtAmount);
      expect(await shop.getNativeTokenAmount(tokenAmount)).to.equal(ethAmount);
    });

    it("correct work of USDT, tokens and ETH balances", async function () {
      const { buyer, shop, usdt, token } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const usdtAmount = await shop.getPurchaseTokenAmount(tokenAmount);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);
      const sumTokenAmount = tokenAmount * 2n;

      await usdt.connect(buyer).mint();
      await usdt.connect(buyer).approve(shop.target, usdtAmount);
      await shop.connect(buyer).buyWithERC20(tokenAmount);

      const txData = { value: ethAmount };
      await shop.connect(buyer).buyWithNative(tokenAmount, txData);

      expect(await shop.userBalances(buyer.address)).to.equal(sumTokenAmount);
      expect(await shop.availableSaleTokens()).to.equal(ethers.parseUnits("50000000", 18) - sumTokenAmount);
      expect(await usdt.balanceOf(shop.target)).to.equal(usdtAmount);
      expect(await token.balanceOf(shop.target)).to.equal(ethers.parseUnits("50000000", 18));
    });

    it("correct update of the token price", async function () {
      const { buyer, shop, usdt } = await loadFixture(deploy);

      const newPrice = ethers.parseUnits("1", 18); // 1$
      await shop.updateSaleTokenPrice(newPrice);
      const tokenAmount = ethers.parseUnits("100", 18);
      const usdtAmount = await shop.getPurchaseTokenAmount(tokenAmount);

      await usdt.connect(buyer).mint();
      await usdt.connect(buyer).approve(shop.target, usdtAmount);
      await shop.connect(buyer).buyWithERC20(tokenAmount);

      expect(await shop.userBalances(buyer.address)).to.equal(tokenAmount);
      expect(await usdt.balanceOf(shop.target)).to.equal(usdtAmount);
    });

    it("correct update of the sale end time", async function () {
      const { shop } = await loadFixture(deploy);

      const duration = 1000;

      const expectedSaleEndTime = (await shop.START_AT()) + BigInt(duration);

      const tx = await shop.setSaleEndTime(duration);

      expect(await shop.endsAt()).to.equal(expectedSaleEndTime);
      await expect(tx).to.emit(shop, "UpdatedSaleEndTime").withArgs(expectedSaleEndTime);
    });

    it("correct update of the vesting end time", async function () {
      const { shop } = await loadFixture(deploy);

      const newTime = 1000;

      const expectedVestingEndTime = BigInt(newTime);

      const tx = await shop.setVestingEndTime(newTime);

      expect(await shop.vestingEnd()).to.equal(expectedVestingEndTime);
      await expect(tx).to.emit(shop, "UpdatedVestingEndTime").withArgs(expectedVestingEndTime);
    });

    it("cannot get the price if the price feed returns negative value", async function () {
      const { shop, mockV3Aggregator } = await loadFixture(deploy);

      await mockV3Aggregator.updateAnswer(-1);

      await expect(shop.getLatestPrice()).to.be.revertedWithCustomError(shop, "InvalidPrice");
    });
  });

  describe("Allowing to buy tokens", function () {
    it("allows to buy with ETH", async function () {
      const { buyer, shop } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);

      const txData = { value: ethAmount };

      const tx = await shop.connect(buyer).buyWithNative(tokenAmount, txData);
      await tx.wait();

      await expect(tx).to.emit(shop, "Bought").withArgs(tokenAmount, buyer.address);
      expect(await shop.userBalances(buyer.address)).to.equal(tokenAmount);
      expect(await ethers.provider.getBalance(shop.target)).to.equal(ethAmount);
    });

    it("allows to buy with USDT", async function () {
      const { buyer, shop, usdt } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const usdtAmount = await shop.getPurchaseTokenAmount(tokenAmount);

      await usdt.connect(buyer).mint();
      await usdt.connect(buyer).approve(shop.target, usdtAmount);

      const tx = await shop.connect(buyer).buyWithERC20(tokenAmount);
      await tx.wait();

      await expect(tx).to.emit(shop, "Bought").withArgs(tokenAmount, buyer.address);
      expect(await shop.userBalances(buyer.address)).to.equal(tokenAmount);
      expect(await usdt.balanceOf(shop.target)).to.equal(usdtAmount);
    });
  });

  describe("Checking the main conditions for purchase", function () {
    it("cannot buy more than 50k tokens", async function () {
      const { buyer, shop } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("50001", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);

      const txData = { value: ethAmount };

      await expect(
        shop.connect(buyer).buyWithNative(tokenAmount, txData)
      ).to.be.revertedWithCustomError(shop, "LimitExceeded");
    });

    it("cannot buy less than 1 token", async function () {
      const { buyer, shop } = await loadFixture(deploy);
      const tokenAmount = ethers.parseUnits("0", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);

      const txData = { value: ethAmount };

      await expect(
        shop.connect(buyer).buyWithNative(tokenAmount, txData)
      ).to.be.revertedWithCustomError(shop, "InvalidAmount");
    });

    it("cannot buy tokens after the sale ends", async function () {
      const { buyer, shop } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("30000", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);

      const txData = { value: ethAmount };

      await shop.setSaleEndTime(0);

      await expect(
        shop.connect(buyer).buyWithNative(tokenAmount, txData)
      ).to.be.revertedWithCustomError(shop, "SaleEnded");
    });

    it("cannot buy tokens if the address is in the blacklist", async function () {
      const { buyer, shop, token } = await loadFixture(deploy);

      await token.addToBlacklist(buyer.address);

      const tokenAmount = ethers.parseUnits("100", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);

      const txData = { value: ethAmount };

      expect(await token.blacklist(buyer.address)).to.be.true;

      await expect(
        shop.connect(buyer).buyWithNative(tokenAmount, txData)
      ).to.be.revertedWithCustomError(shop, "BuyerBlacklisted");
    });

    it("cannot buy with not enough ETH", async function () {
      const { buyer, shop } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);

      const txData = { value: ethAmount - 1n };

      await expect(
        shop.connect(buyer).buyWithNative(tokenAmount, txData)
      ).to.be.revertedWithCustomError(shop, "InsufficientPayment");
    });

    it("returns excess ETH to the buyer", async function () {
      const { buyer, shop } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);

      const txData = { value: ethAmount + ethers.parseUnits("1", 18) };

      await expect(
        shop.connect(buyer).buyWithNative(tokenAmount, txData)
      ).to.changeEtherBalances([buyer, shop], [-ethAmount, ethAmount]);
    });
  });

  describe("Checking the functionality of claiming tokens", function () {
    it("can claim tokens after the vesting period ends", async function () {
      const { buyer, shop, token } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);
      const txData = { value: ethAmount };

      const txBuy = await shop.connect(buyer).buyWithNative(tokenAmount, txData);
      await txBuy.wait();

      const timeAfterVesting = (await shop.vestingEnd()) + 1000n;
      await time.increaseTo(timeAfterVesting);

      const txClaim = await shop.claimTokens(buyer.address);
      await txClaim.wait();

      expect(await shop.userBalances(buyer.address)).to.equal(0);
      expect(await token.balanceOf(buyer.address)).to.equal(tokenAmount);
      expect(await token.balanceOf(shop.target)).to.equal(ethers.parseUnits("50000000", 18) - tokenAmount);
      await expect(txClaim).to.emit(shop, "Claimed").withArgs(tokenAmount, buyer.address);
    });

    it("Cannot claim tokens during the vesting period", async function () {
      const { buyer, shop } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);
      const txData = { value: ethAmount };

      await shop.connect(buyer).buyWithNative(tokenAmount, txData);

      await expect(
        shop.claimTokens(buyer.address)
      ).to.be.revertedWithCustomError(shop, "VestingNotEnded");
    });

    it("cannot claim if nothing was bought", async function () {
      const { buyer, shop } = await loadFixture(deploy);

      await time.increaseTo((await shop.vestingEnd()) + 1n);

      await expect(
        shop.claimTokens(buyer.address)
      ).to.be.revertedWithCustomError(shop, "ZeroClaimAmount");
    });
  });

  describe("Withdrawing USDT, ETH, tokens from the contract", function () {
    it("Only owner can withdraw ETH", async function () {
      const { owner, buyer, shop } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);
      const txData = { value: ethAmount };

      await shop.connect(buyer).buyWithNative(tokenAmount, txData);

      const beforeBalance = await ethers.provider.getBalance(owner.address);

      const txWithdraw = await shop.connect(owner).withdrawAllNativeToken();
      await txWithdraw.wait();

      const afterBalance = await ethers.provider.getBalance(owner.address);

      expect(await shop.saleActive()).to.be.true;
      await expect(
        shop.connect(owner).withdrawNativeToken(owner.address, ethers.parseUnits("1", 18))
      ).to.be.reverted;

      await expect(
        shop.connect(buyer).withdrawNativeToken(owner.address, ethAmount)
      ).to.be.reverted;
    });

    it("correct amount of ETH after withdraw", async function () {
      const { owner, buyer, spender, shop } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);
      const txData = { value: ethAmount };

      await shop.connect(buyer).buyWithNative(tokenAmount, txData);

      const partAmount = ethAmount / 4n;
      const restAmount = ethAmount - partAmount;

      await expect(
        shop.withdrawNativeToken(spender.address, partAmount)
      ).to.changeEtherBalances([shop, spender], [-partAmount, partAmount]);
      await expect(
        shop.withdrawAllNativeToken()
      ).to.changeEtherBalances([shop, owner], [-restAmount, restAmount]);
    });

    it("cannot withdraw ETH to the contract that does not accept it", async function () {
      const { buyer, shop, token } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const ethAmount = await shop.getNativeTokenAmount(tokenAmount);
      const txData = { value: ethAmount };

      await shop.connect(buyer).buyWithNative(tokenAmount, txData);

      await expect(
        shop.withdrawNativeToken(token.target, ethAmount)
      ).to.be.revertedWithCustomError(shop, "NativeTransferFailed");
    });

    it("Only owner can withdraw USDT", async function () {
      const { owner, buyer, shop, usdt } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const usdtAmount = await shop.getPurchaseTokenAmount(tokenAmount);

      await usdt.connect(buyer).mint();
      await usdt.connect(buyer).approve(shop.target, usdtAmount * BigInt(2));

      await shop.connect(buyer).buyWithERC20(tokenAmount);
      await shop.connect(owner).withdrawAllPurchaseToken();

      expect(await shop.saleActive()).to.be.true; 
      await expect(
        shop.connect(owner).withdrawTokens(usdt.target, owner.address, ethers.parseUnits("1", 18))
      ).to.be.revertedWithCustomError(usdt, "ERC20InsufficientBalance");

      await expect(
        shop.connect(buyer).withdrawTokens(usdt.target, owner.address, usdtAmount)
      ).to.be.reverted;
    });

    it("Only owner can withdraw tokens", async function () {
      const { owner, buyer, shop, token } = await loadFixture(deploy);

      const tokenAmount = ethers.parseUnits("100", 18);
      const availableTokens = ethers.parseUnits("50000000", 18);

      const beforeBalance = await token.balanceOf(shop.target);
      const beforeOwnerBalance = await token.balanceOf(owner.address);

      const txWithdraw = await shop.connect(owner).withdrawTokens(token.target, owner.address, tokenAmount);
      await txWithdraw.wait();

      const afterBalance = await token.balanceOf(shop.target);
      const afterOwnerBalance = await token.balanceOf(owner.address);

      expect(afterBalance).to.equal(beforeBalance - tokenAmount);
      expect(afterOwnerBalance).to.equal(beforeOwnerBalance + tokenAmount);

      await expect(
        shop.connect(owner).withdrawTokens(token.target, owner.address, availableTokens)
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
      await expect(
        shop.connect(buyer).withdrawTokens(token.target, owner.address, ethers.parseUnits("1", 18))
      ).to.be.reverted;
    });
  });
});