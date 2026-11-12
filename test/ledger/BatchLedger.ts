import { expect } from "chai";
import { network } from "hardhat";

// Open a connection to the in-memory test blockchain that Hardhat provides.
const { ethers } = await network.create();

// Role id of the orchestrator (same rule as in Roles.sol: hash of the name).
const ORCHESTRATOR_ROLE = ethers.id("ORCHESTRATOR_ROLE");

// The enums of the contract are stored as small numbers. We give them names
// here so the tests are easy to read.
const BatchState = { None: 0n, Proposed: 1n, Certified: 2n, Rejected: 3n, Revoked: 4n };
const PieceState = { None: 0n, InTransit: 1n, Delivered: 2n, Accepted: 3n, Installed: 4n };

// A fake "document hash". In the real system this is the hash of a file in IPFS.
const HASH = ethers.id("some document");

describe("BatchLedger", function () {
  let admin: any;
  let orchestrator: any; // in the tests an ordinary account plays the orchestrator
  let miner: any;
  let manufacturer: any;
  let certifier: any;
  let transporter: any;
  let builder: any;
  let stranger: any;

  let registry: any;
  let ledger: any;

  const CLAIMED = 100n;
  const ATTESTED = 90n;
  const BUILDING = 7;
  const MAIN_TOKEN = 1n;
  const PIECE = 2n; // the id of the token of the first piece

  beforeEach(async function () {
    [admin, orchestrator, miner, manufacturer, certifier, transporter, builder, stranger] =
      await ethers.getSigners();

    registry = await ethers.deployContract("ActorRegistry", [admin.address]);
    await registry.grantRole(ORCHESTRATOR_ROLE, orchestrator.address);

    ledger = await ethers.deployContract("BatchLedger", [await registry.getAddress()]);
  });

  // ---- Helpers: each one builds a situation we need in many tests ----------

  // The current time of the test blockchain.
  async function now(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block!.timestamp;
  }

  // Moves the clock of the test blockchain forward.
  async function passTime(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  // A raw material is recorded and a batch is proposed. Returns the batch id.
  async function proposedBatch() {
    await ledger.connect(orchestrator).recordRawMaterial(miner.address, HASH);
    await ledger.connect(orchestrator).createBatch(manufacturer.address, 1, CLAIMED, HASH);
    return 1;
  }

  // ... and certified for 1000 seconds.
  async function certifiedBatch() {
    const batchId = await proposedBatch();
    const validUntil = (await now()) + 1000;
    await ledger
      .connect(orchestrator)
      .approveBatch(batchId, certifier.address, ATTESTED, validUntil, MAIN_TOKEN, HASH);
    return batchId;
  }

  // ... and one piece is sent to the building.
  async function sentPiece() {
    const batchId = await certifiedBatch();
    await ledger
      .connect(orchestrator)
      .createPiece(PIECE, batchId, transporter.address, BUILDING, 40n, manufacturer.address);
    return batchId;
  }

  // ---------------------------------------------------------------------------
  describe("raw material", function () {
    it("records a raw material and emits an event", async function () {
      await expect(ledger.connect(orchestrator).recordRawMaterial(miner.address, HASH))
        .to.emit(ledger, "RawMaterialRecorded")
        .withArgs(1, miner.address, HASH);

      const record = await ledger.rawMaterials(1);
      expect(record.miner).to.equal(miner.address);
      expect(await ledger.lastRawMaterialId()).to.equal(1);
    });

    it("gives every record its own id", async function () {
      await ledger.connect(orchestrator).recordRawMaterial(miner.address, HASH);
      await ledger.connect(orchestrator).recordRawMaterial(miner.address, HASH);

      expect(await ledger.lastRawMaterialId()).to.equal(2);
    });

    it("does not accept the zero address as a miner", async function () {
      await expect(
        ledger.connect(orchestrator).recordRawMaterial(ethers.ZeroAddress, HASH),
      ).to.be.revertedWithCustomError(ledger, "ZeroAddress");
    });
  });

  // ---------------------------------------------------------------------------
  describe("creating a batch", function () {
    it("creates a batch in the Proposed state", async function () {
      await ledger.connect(orchestrator).recordRawMaterial(miner.address, HASH);

      await expect(ledger.connect(orchestrator).createBatch(manufacturer.address, 1, CLAIMED, HASH))
        .to.emit(ledger, "BatchProposed")
        .withArgs(1, manufacturer.address, 1, CLAIMED, HASH);

      const batch = await ledger.batches(1);
      expect(batch.manufacturer).to.equal(manufacturer.address);
      expect(batch.state).to.equal(BatchState.Proposed);
      expect(batch.claimedAmount).to.equal(CLAIMED);
      expect(batch.attestedAmount).to.equal(0n);
    });

    it("needs a raw material that really exists", async function () {
      await expect(
        ledger.connect(orchestrator).createBatch(manufacturer.address, 99, CLAIMED, HASH),
      ).to.be.revertedWithCustomError(ledger, "RawMaterialNotFound");
    });

    it("does not accept a zero amount", async function () {
      await ledger.connect(orchestrator).recordRawMaterial(miner.address, HASH);

      await expect(
        ledger.connect(orchestrator).createBatch(manufacturer.address, 1, 0, HASH),
      ).to.be.revertedWithCustomError(ledger, "ZeroAmount");
    });
  });

  // ---------------------------------------------------------------------------
  describe("certification", function () {
    it("certifies a batch and stores what the certifier confirmed", async function () {
      const batchId = await proposedBatch();
      const validUntil = (await now()) + 1000;

      await expect(
        ledger
          .connect(orchestrator)
          .approveBatch(batchId, certifier.address, ATTESTED, validUntil, MAIN_TOKEN, HASH),
      )
        .to.emit(ledger, "BatchCertified")
        .withArgs(batchId, certifier.address, ATTESTED, validUntil, HASH);

      const batch = await ledger.batches(batchId);
      expect(batch.state).to.equal(BatchState.Certified);
      expect(batch.attestedAmount).to.equal(ATTESTED);
      expect(batch.validUntil).to.equal(validUntil);
      expect(batch.mainTokenId).to.equal(MAIN_TOKEN);
    });

    it("the certifier can not be the manufacturer of the batch", async function () {
      const batchId = await proposedBatch();
      const validUntil = (await now()) + 1000;

      await expect(
        ledger
          .connect(orchestrator)
          .approveBatch(batchId, manufacturer.address, ATTESTED, validUntil, MAIN_TOKEN, HASH),
      ).to.be.revertedWithCustomError(ledger, "CertifierIsManufacturer");

      await expect(
        ledger.connect(orchestrator).rejectBatch(batchId, manufacturer.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "CertifierIsManufacturer");
    });

    it("can not confirm more than the manufacturer claimed", async function () {
      const batchId = await proposedBatch();
      const validUntil = (await now()) + 1000;

      await expect(
        ledger
          .connect(orchestrator)
          .approveBatch(batchId, certifier.address, CLAIMED + 1n, validUntil, MAIN_TOKEN, HASH),
      ).to.be.revertedWithCustomError(ledger, "AmountAboveClaim");
    });

    it("can not confirm a zero amount", async function () {
      const batchId = await proposedBatch();
      const validUntil = (await now()) + 1000;

      await expect(
        ledger.connect(orchestrator).approveBatch(batchId, certifier.address, 0, validUntil, MAIN_TOKEN, HASH),
      ).to.be.revertedWithCustomError(ledger, "ZeroAmount");
    });

    it("needs a validity date in the future", async function () {
      const batchId = await proposedBatch();
      const past = (await now()) - 10;

      await expect(
        ledger.connect(orchestrator).approveBatch(batchId, certifier.address, ATTESTED, past, MAIN_TOKEN, HASH),
      ).to.be.revertedWithCustomError(ledger, "ValidityInThePast");
    });

    it("can not certify the same batch twice", async function () {
      const batchId = await certifiedBatch();
      const validUntil = (await now()) + 1000;

      await expect(
        ledger
          .connect(orchestrator)
          .approveBatch(batchId, certifier.address, ATTESTED, validUntil, MAIN_TOKEN, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongBatchState");
    });

    it("rejects a batch, and a rejected batch is final", async function () {
      const batchId = await proposedBatch();

      await expect(ledger.connect(orchestrator).rejectBatch(batchId, certifier.address, HASH))
        .to.emit(ledger, "BatchRejected")
        .withArgs(batchId, certifier.address, HASH);

      expect((await ledger.batches(batchId)).state).to.equal(BatchState.Rejected);

      // it can not be certified afterwards
      const validUntil = (await now()) + 1000;
      await expect(
        ledger
          .connect(orchestrator)
          .approveBatch(batchId, certifier.address, ATTESTED, validUntil, MAIN_TOKEN, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongBatchState");
    });

    it("can not certify a batch that does not exist", async function () {
      const validUntil = (await now()) + 1000;

      await expect(
        ledger.connect(orchestrator).approveBatch(99, certifier.address, ATTESTED, validUntil, MAIN_TOKEN, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongBatchState");
    });
  });

  // ---------------------------------------------------------------------------
  describe("sending a piece", function () {
    it("creates a piece in the InTransit state", async function () {
      const batchId = await certifiedBatch();

      await expect(
        ledger
          .connect(orchestrator)
          .createPiece(PIECE, batchId, transporter.address, BUILDING, 40n, manufacturer.address),
      )
        .to.emit(ledger, "PieceDispatched")
        .withArgs(PIECE, batchId, BUILDING, transporter.address, 40n, manufacturer.address);

      const piece = await ledger.pieces(PIECE);
      expect(piece.state).to.equal(PieceState.InTransit);
      expect(piece.batchId).to.equal(batchId);
      expect(piece.buildingId).to.equal(BUILDING);
      expect(piece.transporter).to.equal(transporter.address);
    });

    it("needs a certified batch (a Proposed one is not enough)", async function () {
      const batchId = await proposedBatch();

      await expect(
        ledger
          .connect(orchestrator)
          .createPiece(PIECE, batchId, transporter.address, BUILDING, 40n, manufacturer.address),
      ).to.be.revertedWithCustomError(ledger, "WrongBatchState");
    });

    it("does not work with an expired certificate", async function () {
      const batchId = await certifiedBatch();
      await passTime(2000); // the certificate was valid for 1000 seconds

      await expect(
        ledger
          .connect(orchestrator)
          .createPiece(PIECE, batchId, transporter.address, BUILDING, 40n, manufacturer.address),
      ).to.be.revertedWithCustomError(ledger, "CertificateExpired");
    });

    it("does not let two pieces share one token id", async function () {
      const batchId = await sentPiece();

      await expect(
        ledger
          .connect(orchestrator)
          .createPiece(PIECE, batchId, transporter.address, BUILDING, 10n, manufacturer.address),
      ).to.be.revertedWithCustomError(ledger, "PieceAlreadyExists");
    });

    it("does not accept a zero transporter or a zero amount", async function () {
      const batchId = await certifiedBatch();

      await expect(
        ledger
          .connect(orchestrator)
          .createPiece(PIECE, batchId, ethers.ZeroAddress, BUILDING, 40n, manufacturer.address),
      ).to.be.revertedWithCustomError(ledger, "ZeroAddress");

      await expect(
        ledger
          .connect(orchestrator)
          .createPiece(PIECE, batchId, transporter.address, BUILDING, 0n, manufacturer.address),
      ).to.be.revertedWithCustomError(ledger, "ZeroAmount");
    });
  });

  // ---------------------------------------------------------------------------
  describe("the way of a piece", function () {
    it("goes InTransit -> Delivered -> Accepted -> Installed and emits every step", async function () {
      const batchId = await sentPiece();

      await expect(ledger.connect(orchestrator).markDelivered(PIECE, transporter.address, HASH))
        .to.emit(ledger, "PieceDelivered")
        .withArgs(PIECE, transporter.address, HASH);
      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Delivered);

      await expect(ledger.connect(orchestrator).markAccepted(PIECE, builder.address, HASH))
        .to.emit(ledger, "PieceAccepted")
        .withArgs(PIECE, builder.address, HASH);
      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Accepted);

      // The building comes from the record made when the piece was sent.
      await expect(ledger.connect(orchestrator).markInstalled(PIECE, builder.address, HASH))
        .to.emit(ledger, "PieceInstalled")
        .withArgs(PIECE, batchId, BUILDING, builder.address, HASH);
      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Installed);
    });

    it("does not let you skip a step", async function () {
      await sentPiece(); // the piece is InTransit

      // can not accept before the delivery is confirmed
      await expect(
        ledger.connect(orchestrator).markAccepted(PIECE, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");

      // can not install before the acceptance
      await expect(
        ledger.connect(orchestrator).markInstalled(PIECE, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });

    it("does not let you repeat a step", async function () {
      await sentPiece();
      await ledger.connect(orchestrator).markDelivered(PIECE, transporter.address, HASH);

      await expect(
        ledger.connect(orchestrator).markDelivered(PIECE, transporter.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });

    it("an installed piece is final", async function () {
      await sentPiece();
      await ledger.connect(orchestrator).markDelivered(PIECE, transporter.address, HASH);
      await ledger.connect(orchestrator).markAccepted(PIECE, builder.address, HASH);
      await ledger.connect(orchestrator).markInstalled(PIECE, builder.address, HASH);

      await expect(
        ledger.connect(orchestrator).markInstalled(PIECE, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });

    it("does not know a piece that was never sent", async function () {
      await expect(
        ledger.connect(orchestrator).markDelivered(555n, transporter.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });
  });

  // ---------------------------------------------------------------------------
  describe("revoking a batch", function () {
    it("revokes a certified batch and emits an event", async function () {
      const batchId = await certifiedBatch();

      await expect(ledger.connect(orchestrator).revokeBatch(batchId, certifier.address, HASH))
        .to.emit(ledger, "BatchRevoked")
        .withArgs(batchId, certifier.address, HASH);

      expect((await ledger.batches(batchId)).state).to.equal(BatchState.Revoked);
    });

    it("a batch that is only Proposed can not be revoked", async function () {
      const batchId = await proposedBatch();

      await expect(
        ledger.connect(orchestrator).revokeBatch(batchId, certifier.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongBatchState");
    });

    it("no new pieces can be sent from a revoked batch", async function () {
      const batchId = await certifiedBatch();
      await ledger.connect(orchestrator).revokeBatch(batchId, certifier.address, HASH);

      await expect(
        ledger
          .connect(orchestrator)
          .createPiece(PIECE, batchId, transporter.address, BUILDING, 40n, manufacturer.address),
      ).to.be.revertedWithCustomError(ledger, "WrongBatchState");
    });

    it("freezes pieces that are on their way", async function () {
      const batchId = await sentPiece();
      await ledger.connect(orchestrator).revokeBatch(batchId, certifier.address, HASH);

      await expect(
        ledger.connect(orchestrator).markDelivered(PIECE, transporter.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongBatchState");
    });

    it("freezes a piece that was delivered but not installed yet", async function () {
      const batchId = await sentPiece();
      await ledger.connect(orchestrator).markDelivered(PIECE, transporter.address, HASH);
      await ledger.connect(orchestrator).markAccepted(PIECE, builder.address, HASH);
      await ledger.connect(orchestrator).revokeBatch(batchId, certifier.address, HASH);

      await expect(
        ledger.connect(orchestrator).markInstalled(PIECE, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongBatchState");
    });
  });

  // ---------------------------------------------------------------------------
  // Every function that changes something must refuse everybody except the
  // orchestrator. One loop checks all of them, so a function that is added
  // later and forgets the check is easy to catch.
  describe("access control", function () {
    it("only the orchestrator can write", async function () {
      const calls: Array<[string, () => Promise<any>]> = [
        ["recordRawMaterial", () => ledger.connect(stranger).recordRawMaterial(miner.address, HASH)],
        ["createBatch", () => ledger.connect(stranger).createBatch(manufacturer.address, 1, CLAIMED, HASH)],
        [
          "approveBatch",
          () => ledger.connect(stranger).approveBatch(1, certifier.address, ATTESTED, 9999999999, 1, HASH),
        ],
        ["rejectBatch", () => ledger.connect(stranger).rejectBatch(1, certifier.address, HASH)],
        ["revokeBatch", () => ledger.connect(stranger).revokeBatch(1, certifier.address, HASH)],
        [
          "createPiece",
          () =>
            ledger
              .connect(stranger)
              .createPiece(PIECE, 1, transporter.address, BUILDING, 40n, manufacturer.address),
        ],
        ["markDelivered", () => ledger.connect(stranger).markDelivered(PIECE, stranger.address, HASH)],
        ["markAccepted", () => ledger.connect(stranger).markAccepted(PIECE, stranger.address, HASH)],
        ["markInstalled", () => ledger.connect(stranger).markInstalled(PIECE, stranger.address, HASH)],
      ];

      for (const [name, call] of calls) {
        await expect(call(), name).to.be.revertedWithCustomError(ledger, "NotOrchestrator");
      }
    });
  });
});