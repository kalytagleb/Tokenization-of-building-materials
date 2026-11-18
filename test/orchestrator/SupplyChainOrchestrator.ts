import { expect } from "chai";
import { network } from "hardhat";

// Open a connection to the in-memory test blockchain that Hardhat provides.
const { ethers } = await network.create();

// A role id is the hash of its name (the same rule as in Roles.sol).
const role = (name: string) => ethers.id(name);

// A fake "document hash". In the real system it is the hash of a file in IPFS.
const HASH = ethers.id("document");

// The enums of the contracts are stored as small numbers.
// We give them names so the tests are easy to read.
const BatchState = { Certified: 2n, Revoked: 4n };
const PieceState = { InTransit: 1n, Delivered: 2n, Accepted: 3n, Installed: 4n, Disputed: 5n, Returned: 6n };
const WINDOW = 1000;

describe("SupplyChainOrchestrator", function () {
  // The people of the supply chain. Each one is just an account of the test network.
  let admin: any, miner: any, manufacturer: any, certifier: any, transporter: any, builder: any, stranger: any;
  let certifier2: any, certifier3: any;

  // The five contracts of the system.
  let registry: any, token: any, ledger: any, buildings: any, environment: any, orch: any;

  // Runs before EVERY test: a fresh system, so tests never affect each other.
  beforeEach(async function () {
    [admin, miner, manufacturer, certifier, transporter, builder, stranger, certifier2, certifier3] =
      await ethers.getSigners();

    registry = await ethers.deployContract("ActorRegistry", [admin.address]);
    const r = await registry.getAddress();
    token = await ethers.deployContract("MaterialBatchToken", [r]);
    ledger = await ethers.deployContract("BatchLedger", [r, 2, WINDOW]); // 2 equal votes decide
    buildings = await ethers.deployContract("BuildingRegistry", [r]);
    environment = await ethers.deployContract("EnvironmentalRegistry", [r]);
    orch = await ethers.deployContract("SupplyChainOrchestrator", [
      r, await token.getAddress(), await ledger.getAddress(), await buildings.getAddress(),
      await environment.getAddress(),
    ]);

    // The orchestrator gets its role, so the workers obey it.
    await registry.grantRole(role("ORCHESTRATOR_ROLE"), await orch.getAddress());

    // Every company gets the role of its kind.
    await registry.grantRole(role("MINER_ROLE"), miner.address);
    await registry.grantRole(role("MANUFACTURER_ROLE"), manufacturer.address);
    await registry.grantRole(role("CERTIFIER_ROLE"), certifier.address);
    await registry.grantRole(role("CERTIFIER_ROLE"), certifier2.address);
    await registry.grantRole(role("CERTIFIER_ROLE"), certifier3.address);
    await registry.grantRole(role("TRANSPORTER_ROLE"), transporter.address);
    await registry.grantRole(role("BUILDER_ROLE"), builder.address);
  });

  // The current time of the test blockchain.
  async function now(): Promise<number> {
    return (await ethers.provider.getBlock("latest"))!.timestamp;
  }

  // Moves the clock of the test blockchain forward.
  async function passTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  // ---- Helpers: each one builds the situation up to some step ---------------

  // A raw material is recorded, a batch (100 units) is proposed, a building exists.
  async function proposed() {
    await orch.connect(miner).recordRawMaterial(HASH);
    await orch.connect(manufacturer).proposeBatch(1, 100, HASH);
    await orch.connect(builder).registerBuilding(HASH);
  }

  // ... and two certifiers vote "yes" for 90 units: the second vote wins
  // and the token is minted.
  async function certified() {
    await proposed();
    await orch.connect(certifier).approveBatch(1, 90, (await now()) + 10000, HASH);
    await orch.connect(certifier2).approveBatch(1, 90, (await now()) + 10000, HASH);
  }

  // Token 1 is the main token of the batch, so the first piece is token 2.
  const PIECE = 2n;

  // ... and a piece of 40 units is sent to building 1.
  async function dispatched() {
    await certified();
    await orch.connect(manufacturer).dispatchPiece(1, 40, transporter.address, 1);
  }

  // ... and the transporter confirmed the delivery.
  async function delivered() {
    await dispatched();
    await orch.connect(transporter).confirmDelivery(PIECE, HASH);
  }

  // ... and the builder accepted it (the token moved to him).
  async function accepted() {
    await delivered();
    await orch.connect(builder).acceptDelivery(PIECE, HASH);
  }

  // ---------------------------------------------------------------------------
  describe("the whole way", function () {
    it("takes a material from the mine to a locked token in the wall", async function () {
      await proposed();
      await orch.connect(certifier).approveBatch(1, 90, (await now()) + 10000, HASH);
      await orch.connect(certifier2).approveBatch(1, 90, (await now()) + 10000, HASH);

      // the main token exists, belongs to the manufacturer, holds the confirmed amount
      expect(await token.ownerOf(1)).to.equal(manufacturer.address);
      expect(await token["balanceOf(uint256)"](1)).to.equal(90n);
      expect((await ledger.batches(1)).state).to.equal(BatchState.Certified);

      await orch.connect(manufacturer).dispatchPiece(1, 40, transporter.address, 1);
      expect(await token["balanceOf(uint256)"](1)).to.equal(50n);
      expect(await token["balanceOf(uint256)"](PIECE)).to.equal(40n);
      expect(await token.ownerOf(PIECE)).to.equal(manufacturer.address); // still on the road
      expect(await token.slotOf(PIECE)).to.equal(await token.slotOf(1));

      await orch.connect(transporter).confirmDelivery(PIECE, HASH);
      expect(await token.ownerOf(PIECE)).to.equal(manufacturer.address); // not moved yet

      await orch.connect(builder).acceptDelivery(PIECE, HASH);
      expect(await token.ownerOf(PIECE)).to.equal(builder.address); // moved now

      await orch.connect(builder).installPiece(PIECE, HASH);
      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Installed);
      expect(await token.locked(PIECE)).to.equal(true);
    });

    it("an installed token can not be moved by anybody", async function () {
      await accepted();
      await orch.connect(builder).installPiece(PIECE, HASH);

      await expect(
        token.connect(builder)["transferFrom(address,address,uint256)"](builder.address, stranger.address, PIECE),
      ).to.be.revertedWithCustomError(token, "TokenIsLocked");
    });
  });

  // ---------------------------------------------------------------------------
  describe("voting of certifiers", function () {
    it("one vote creates no token yet", async function () {
      await proposed();
      await orch.connect(certifier).approveBatch(1, 90, (await now()) + 10000, HASH);

      await expect(token.ownerOf(1)).to.be.revertedWith("ERC3525: invalid token ID");
      expect((await ledger.batches(1)).state).to.equal(1n); // still Proposed
    });

    it("the token holds the SMALLEST amount that the certifiers named", async function () {
      await proposed();
      await orch.connect(certifier).approveBatch(1, 95, (await now()) + 10000, HASH);
      await orch.connect(certifier2).approveBatch(1, 80, (await now()) + 10000, HASH);

      expect(await token["balanceOf(uint256)"](1)).to.equal(80n);
      expect((await ledger.batches(1)).mainTokenId).to.equal(1n);
      expect(await token.ownerOf(1)).to.equal(manufacturer.address);
    });

    it("one certifier can not vote twice and cannot make the quorum alone", async function () {
      await proposed();
      await orch.connect(certifier).approveBatch(1, 90, (await now()) + 10000, HASH);

      await expect(
        orch.connect(certifier).approveBatch(1, 90, (await now()) + 10000, HASH),
      ).to.be.revertedWithCustomError(ledger, "AlreadyVoted");
    });

    it("a split vote is decided by the third certifier, and only one token is made", async function () {
      await proposed();
      await orch.connect(certifier).approveBatch(1, 90, (await now()) + 10000, HASH);
      await orch.connect(certifier2).rejectBatch(1, HASH);
      await expect(token.ownerOf(1)).to.be.revertedWith("ERC3525: invalid token ID");

      await orch.connect(certifier3).approveBatch(1, 90, (await now()) + 10000, HASH);
      expect(await token["balanceOf(uint256)"](1)).to.equal(90n);
      await expect(token.ownerOf(2)).to.be.revertedWith("ERC3525: invalid token ID");
    });

    it("the manufacturer can not vote even with the certifier role", async function () {
      await proposed();
      await registry.grantRole(role("CERTIFIER_ROLE"), manufacturer.address);

      await expect(
        orch.connect(manufacturer).approveBatch(1, 90, (await now()) + 10000, HASH),
      ).to.be.revertedWithCustomError(ledger, "CertifierIsManufacturer");
      await expect(orch.connect(manufacturer).rejectBatch(1, HASH)).to.be.revertedWithCustomError(
        ledger,
        "CertifierIsManufacturer",
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe("roles (is the caller allowed at all?)", function () {
    it("refuses a caller without the needed role", async function () {
      await expect(orch.connect(stranger).recordRawMaterial(HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
      await expect(orch.connect(stranger).registerBuilding(HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
      await expect(orch.connect(stranger).proposeBatch(1, 1, HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
      await expect(orch.connect(stranger).approveBatch(1, 1, 1, HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
      await expect(orch.connect(stranger).rejectBatch(1, HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
      await expect(orch.connect(stranger).revokeBatch(1, HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
      await expect(orch.connect(stranger).dispatchPiece(1, 1, stranger.address, 1)).to.be.revertedWithCustomError(orch, "MissingRole");
      await expect(orch.connect(stranger).confirmDelivery(2, HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
      await expect(orch.connect(stranger).acceptDelivery(2, HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
      await expect(orch.connect(stranger).installPiece(2, HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
    });

    it("a role of another kind does not help", async function () {
      await expect(orch.connect(manufacturer).approveBatch(1, 1, 1, HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
    });
  });

  // ---------------------------------------------------------------------------
  describe("identity (is it the RIGHT person for this object?)", function () {
    it("another manufacturer can not send pieces of my batch", async function () {
      await certified();
      await registry.grantRole(role("MANUFACTURER_ROLE"), stranger.address);

      await expect(
        orch.connect(stranger).dispatchPiece(1, 10, transporter.address, 1),
      ).to.be.revertedWithCustomError(orch, "NotBatchManufacturer");
    });

    it("another transporter can not confirm my delivery", async function () {
      await dispatched();
      await registry.grantRole(role("TRANSPORTER_ROLE"), stranger.address);

      await expect(
        orch.connect(stranger).confirmDelivery(PIECE, HASH),
      ).to.be.revertedWithCustomError(orch, "NotAssignedTransporter");
    });

    it("another builder can not accept a piece for my building", async function () {
      await delivered();
      await registry.grantRole(role("BUILDER_ROLE"), stranger.address);

      await expect(
        orch.connect(stranger).acceptDelivery(PIECE, HASH),
      ).to.be.revertedWithCustomError(orch, "NotBuildingOwner");
    });

    it("another builder can not install a piece he does not own", async function () {
      await accepted();
      await registry.grantRole(role("BUILDER_ROLE"), stranger.address);

      await expect(
        orch.connect(stranger).installPiece(PIECE, HASH),
      ).to.be.revertedWithCustomError(orch, "NotTokenOwner");
    });

    it("the certifier can not be the manufacturer (the ledger refuses)", async function () {
      await proposed();
      await registry.grantRole(role("CERTIFIER_ROLE"), manufacturer.address);

      await expect(
        orch.connect(manufacturer).approveBatch(1, 90, (await now()) + 10000, HASH),
      ).to.be.revertedWithCustomError(ledger, "CertifierIsManufacturer");
    });
  });

  // ---------------------------------------------------------------------------
  describe("everything is rolled back when a worker refuses", function () {
    it("a refused vote creates no token", async function () {
      await proposed();
      await expect(
        orch.connect(certifier).approveBatch(1, 101, (await now()) + 10000, HASH), // more than claimed
      ).to.be.revertedWithCustomError(ledger, "AmountAboveClaim");

      await expect(token.ownerOf(1)).to.be.revertedWith("ERC3525: invalid token ID");
    });

    it("an unknown batch is reported clearly", async function () {
      await expect(
        orch.connect(certifier).approveBatch(99, 1, (await now()) + 10000, HASH),
      ).to.be.revertedWithCustomError(orch, "BatchNotFound");
    });

    it("a rejected batch gets no token and can not send pieces", async function () {
      await proposed();
      await orch.connect(certifier).rejectBatch(1, HASH);
      await orch.connect(certifier2).rejectBatch(1, HASH);

      await expect(token.ownerOf(1)).to.be.revertedWith("ERC3525: invalid token ID");
      await expect(
        orch.connect(manufacturer).dispatchPiece(1, 10, transporter.address, 1),
      ).to.be.revertedWithCustomError(orch, "BatchNotCertified");
    });

    it("can not send more than the batch holds", async function () {
      await certified(); // 90 units
      await expect(
        orch.connect(manufacturer).dispatchPiece(1, 91, transporter.address, 1),
      ).to.be.revertedWith("ERC3525: insufficient balance for transfer");
    });

    it("refuses a carrier without the role and an unknown building", async function () {
      await certified();
      await expect(
        orch.connect(manufacturer).dispatchPiece(1, 10, stranger.address, 1),
      ).to.be.revertedWithCustomError(orch, "TransporterWithoutRole");
      await expect(
        orch.connect(manufacturer).dispatchPiece(1, 10, transporter.address, 99),
      ).to.be.revertedWithCustomError(orch, "UnknownBuilding");
    });

    it("steps can not be skipped (ledger rules still apply)", async function () {
      await dispatched();
      await expect(
        orch.connect(builder).acceptDelivery(PIECE, HASH), // not delivered yet
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });
  });

  describe("dispute and silence", function () {
    it("the builder objects, the piece is frozen and the token does not move", async function () {
      await delivered();

      await expect(orch.connect(builder).disputeDelivery(PIECE, HASH))
        .to.emit(ledger, "PieceDisputed")
        .withArgs(PIECE, builder.address, HASH);

      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Disputed);
      expect(await token.ownerOf(PIECE)).to.equal(manufacturer.address);

      await expect(
        orch.connect(builder).acceptDelivery(PIECE, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });

    it("only the owner of the building can object", async function () {
      await delivered();
      await registry.grantRole(role("BUILDER_ROLE"), stranger.address);

      await expect(
        orch.connect(stranger).disputeDelivery(PIECE, HASH),
      ).to.be.revertedWithCustomError(orch, "NotBuildingOwner");
      await expect(
        orch.connect(manufacturer).disputeDelivery(PIECE, HASH),
      ).to.be.revertedWithCustomError(orch, "MissingRole");
    });

    it("can not object after the window", async function () {
      await delivered();
      await passTime(WINDOW + 100);

      await expect(
        orch.connect(builder).disputeDelivery(PIECE, HASH),
      ).to.be.revertedWithCustomError(ledger, "DisputeWindowClosed");
    });

    it("the judge accepts: the token goes to the builder who can install it", async function () {
      await delivered();
      await orch.connect(builder).disputeDelivery(PIECE, HASH);

      await orch.connect(admin).resolveDispute(PIECE, true, HASH);

      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Accepted);
      expect(await token.ownerOf(PIECE)).to.equal(builder.address);

      await orch.connect(builder).installPiece(PIECE, HASH);
      expect(await token.locked(PIECE)).to.equal(true);
    });

    it("the judge returns: the token stays with the manufacturer and can not be installed", async function () {
      await delivered();
      await orch.connect(builder).disputeDelivery(PIECE, HASH);

      await orch.connect(admin).resolveDispute(PIECE, false, HASH);

      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Returned);
      expect(await token.ownerOf(PIECE)).to.equal(manufacturer.address);
      await expect(
        orch.connect(builder).installPiece(PIECE, HASH),
      ).to.be.revertedWithCustomError(orch, "NotTokenOwner");
    });

    it("only the admin is the judge", async function () {
      await delivered();
      await orch.connect(builder).disputeDelivery(PIECE, HASH);

      await expect(
        orch.connect(builder).resolveDispute(PIECE, true, HASH),
      ).to.be.revertedWithCustomError(orch, "NotAdmin");
      await expect(
        orch.connect(manufacturer).resolveDispute(PIECE, false, HASH),
      ).to.be.revertedWithCustomError(orch, "NotAdmin");
    });

    it("silence: not before the end of the window", async function () {
      await delivered();

      await expect(
        orch.connect(manufacturer).acceptByTimeout(PIECE),
      ).to.be.revertedWithCustomError(ledger, "AcceptanceWindowOpen");
    });

    it("silence: after the window the manufacturer can close it, the token goes to the builder", async function () {
      await delivered();
      await passTime(WINDOW + 100);

      await orch.connect(manufacturer).acceptByTimeout(PIECE);

      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Accepted);
      expect(await token.ownerOf(PIECE)).to.equal(builder.address);

      await orch.connect(builder).installPiece(PIECE, HASH);
      expect(await token.locked(PIECE)).to.equal(true);
    });

    it("silence: the assigned transporter can close it too", async function () {
      await delivered();
      await passTime(WINDOW + 100);

      await orch.connect(transporter).acceptByTimeout(PIECE);
      expect(await token.ownerOf(PIECE)).to.equal(builder.address);
    });

    it("silence: a stranger and the builder can not use it", async function () {
      await delivered();
      await passTime(WINDOW + 100);

      await expect(
        orch.connect(stranger).acceptByTimeout(PIECE),
      ).to.be.revertedWithCustomError(orch, "NotPartyOfPiece");
      await expect(
        orch.connect(builder).acceptByTimeout(PIECE),
      ).to.be.revertedWithCustomError(orch, "NotPartyOfPiece");
    });

    it("silence: another transporter or another manufacturer is not a party of this piece", async function () {
      await delivered();
      await passTime(WINDOW + 100);
      await registry.grantRole(role("TRANSPORTER_ROLE"), stranger.address);
      await registry.grantRole(role("MANUFACTURER_ROLE"), stranger.address);

      await expect(
        orch.connect(stranger).acceptByTimeout(PIECE),
      ).to.be.revertedWithCustomError(orch, "NotPartyOfPiece");
    });

    it("silence: after it the builder can not object any more", async function () {
      await delivered();
      await passTime(WINDOW + 100);
      await orch.connect(manufacturer).acceptByTimeout(PIECE);

      await expect(
        orch.connect(builder).disputeDelivery(PIECE, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });

    it("everything stops on pause", async function () {
      await delivered();
      await orch.connect(admin).pause();

      await expect(orch.connect(builder).disputeDelivery(PIECE, HASH)).to.be.revertedWith("Pausable: paused");
      await expect(orch.connect(admin).resolveDispute(PIECE, true, HASH)).to.be.revertedWith("Pausable: paused");
      await expect(orch.connect(manufacturer).acceptByTimeout(PIECE)).to.be.revertedWith("Pausable: paused");
    });
  });

  // ---------------------------------------------------------------------------
  describe("revoking", function () {
    it("a certifier or the admin can revoke, a manufacturer can not", async function () {
      await certified();
      await expect(orch.connect(manufacturer).revokeBatch(1, HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
      await orch.connect(admin).revokeBatch(1, HASH);
      expect((await ledger.batches(1)).state).to.equal(BatchState.Revoked);
    });

    it("a revoked batch stops pieces that are already on the way", async function () {
      await dispatched();
      await orch.connect(certifier).revokeBatch(1, HASH);

      await expect(
        orch.connect(transporter).confirmDelivery(PIECE, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongBatchState");
    });
  });

  // ---------------------------------------------------------------------------
  describe("emergency stop", function () {
    it("only the admin can pause and unpause", async function () {
      await expect(orch.connect(stranger).pause()).to.be.revertedWithCustomError(orch, "NotAdmin");
      await expect(orch.connect(stranger).unpause()).to.be.revertedWithCustomError(orch, "NotAdmin");
    });

    it("nothing works while paused, everything works after unpause", async function () {
      await orch.connect(admin).pause();
      await expect(orch.connect(miner).recordRawMaterial(HASH)).to.be.revertedWith("Pausable: paused");

      await orch.connect(admin).unpause();
      await orch.connect(miner).recordRawMaterial(HASH);
      expect(await ledger.lastRawMaterialId()).to.equal(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe("environmental data", function () {
    // The id of an indicator is the hash of its name.
    const GWP = ethers.id("GWP_TOTAL");
    const WATER = ethers.id("WATER_USE");
    let verifier: any;

    beforeEach(async function () {
      verifier = stranger; // in this group the "stranger" account is an accredited verifier
      await registry.grantRole(role("EPD_VERIFIER_ROLE"), verifier.address);
      await orch.connect(admin).defineIndicator("GWP_TOTAL", ethers.encodeBytes32String("gCO2e"));
      await orch.connect(admin).defineIndicator("WATER_USE", ethers.encodeBytes32String("l"));
    });

    it("only the admin can add an indicator to the catalog", async function () {
      await expect(
        orch.connect(manufacturer).defineIndicator("X", ethers.encodeBytes32String("u")),
      ).to.be.revertedWithCustomError(orch, "NotAdmin");
    });

    it("an accredited verifier records many indicators of a certified batch", async function () {
      await certified();
      const until = (await now()) + 5000;

      await orch.connect(verifier).recordEnvironmentalData(1, [GWP, WATER], [300000n, 150n], until, HASH);

      expect(await environment.isValid(1, GWP)).to.equal(true);
      expect((await environment.measurements(1, WATER)).value).to.equal(150n);
    });

    it("the data is optional: the whole supply chain works without it", async function () {
      await accepted();
      await orch.connect(builder).installPiece(PIECE, HASH);
      expect(await environment.isValid(1, GWP)).to.equal(false);
    });

    it("the manufacturer can NOT write his own numbers, even with the role", async function () {
      await certified();
      await registry.grantRole(role("EPD_VERIFIER_ROLE"), manufacturer.address);

      await expect(
        orch.connect(manufacturer).recordEnvironmentalData(1, [GWP], [1n], (await now()) + 5000, HASH),
      ).to.be.revertedWithCustomError(orch, "VerifierIsManufacturer");
    });

    it("a company without the verifier role can not write", async function () {
      await certified();
      await expect(
        orch.connect(certifier).recordEnvironmentalData(1, [GWP], [1n], (await now()) + 5000, HASH),
      ).to.be.revertedWithCustomError(orch, "MissingRole");
    });

    it("needs an existing certified batch", async function () {
      await expect(
        orch.connect(verifier).recordEnvironmentalData(99, [GWP], [1n], (await now()) + 5000, HASH),
      ).to.be.revertedWithCustomError(orch, "BatchNotFound");

      await proposed(); // only proposed, not certified
      await expect(
        orch.connect(verifier).recordEnvironmentalData(1, [GWP], [1n], (await now()) + 5000, HASH),
      ).to.be.revertedWithCustomError(orch, "BatchNotCertified");
    });

    it("a verifier or the admin can revoke, others can not", async function () {
      await certified();
      await orch.connect(verifier).recordEnvironmentalData(1, [GWP], [1n], (await now()) + 5000, HASH);

      await expect(orch.connect(manufacturer).revokeEnvironmentalData(1, GWP, HASH)).to.be.revertedWithCustomError(orch, "MissingRole");
      await orch.connect(admin).revokeEnvironmentalData(1, GWP, HASH);
      expect(await environment.isValid(1, GWP)).to.equal(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe("the workers obey only the orchestrator", function () {
    it("people can not call the token, ledger or buildings directly", async function () {
      await expect(token.connect(manufacturer).mintBatch(manufacturer.address, 1, 5)).to.be.revertedWithCustomError(token, "NotOrchestrator");
      await expect(ledger.connect(miner).recordRawMaterial(miner.address, HASH)).to.be.revertedWithCustomError(ledger, "NotOrchestrator");
      await expect(buildings.connect(builder).registerBuilding(builder.address, HASH)).to.be.revertedWithCustomError(buildings, "NotOrchestrator");
    });
  });
});