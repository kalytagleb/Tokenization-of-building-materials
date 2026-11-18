import { expect } from "chai";
import { id } from "ethers";
import { network } from "hardhat";

// Open a connection to the in-memory test blockchain that Hardhat provides.
const { ethers } = await network.create();

// Role id of the orchestrator (same rule as in Roles.sol: hash of the name).
const ORCHESTRATOR_ROLE = ethers.id("ORCHESTRATOR_ROLE");

// The enums of the contract are stored as small numbers. We give them names
// here so the tests are easy to read.
const BatchState = { None: 0n, Proposed: 1n, Certified: 2n, Rejected: 3n, Revoked: 4n };
const PieceState = { None: 0n, InTransit: 1n, Delivered: 2n, Accepted: 3n, Installed: 4n, Disputed: 5n, Returned: 6n };

// A fake "document hash". In the real system this is the hash of a file in IPFS.
const HASH = ethers.id("some document");
const REQUIRED_VOTES = 2;
const WINDOW = 500;

describe("BatchLedger", function () {
  let admin: any;
  let orchestrator: any; // in the tests an ordinary account plays the orchestrator
  let miner: any;
  let manufacturer: any;
  let certifier: any;
  let certifier2: any;
  let certifier3: any;
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
    [admin, orchestrator, miner, manufacturer, certifier, transporter, builder, stranger, certifier2, certifier3] =
      await ethers.getSigners();

    registry = await ethers.deployContract("ActorRegistry", [admin.address]);
    await registry.grantRole(ORCHESTRATOR_ROLE, orchestrator.address);

    ledger = await ethers.deployContract("BatchLedger", [await registry.getAddress(), REQUIRED_VOTES, WINDOW]);
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
      .voteApprove(batchId, certifier.address, ATTESTED, validUntil, HASH);
    await ledger
      .connect(orchestrator)
      .voteApprove(batchId, certifier2.address, ATTESTED, validUntil, HASH);
    await ledger
      .connect(orchestrator)
      .attachToken(batchId, MAIN_TOKEN);
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

  async function deliveredPiece() {
    const batchId = await sentPiece();
    await ledger.connect(orchestrator).markDelivered(PIECE, transporter.address, HASH);
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
  describe("certification (a vote of certifiers)", function () {
    const approve = (id: number, who: any, amount: bigint, until: number) =>
      ledger.connect(orchestrator).voteApprove(id, who.address, amount, until, HASH);
    const reject = (id: number, who: any) =>
      ledger.connect(orchestrator).voteReject(id, who.address, HASH);

    it("one vote is not enough: the batch stays Proposed", async function () {
      const batchId = await proposedBatch();
      const until = (await now()) + 1000;

      await expect(approve(batchId, certifier, ATTESTED, until))
        .to.emit(ledger, "BatchVoted")
        .withArgs(batchId, certifier.address, true, ATTESTED, until, HASH);

      const batch = await ledger.batches(batchId);
      expect(batch.state).to.equal(BatchState.Proposed);
      expect(batch.approvals).to.equal(1n);
      expect(await ledger.hasVoted(batchId, certifier.address)).to.equal(true);
    });

    it("the second equal vote certifies the batch and ends the voting", async function () {
      const batchId = await proposedBatch();
      const until = (await now()) + 1000;
      await approve(batchId, certifier, ATTESTED, until);

      await expect(approve(batchId, certifier2, ATTESTED, until))
        .to.emit(ledger, "BatchCertified")
        .withArgs(batchId, ATTESTED, until);

      const batch = await ledger.batches(batchId);
      expect(batch.state).to.equal(BatchState.Certified);
      expect(batch.attestedAmount).to.equal(ATTESTED);
      expect(batch.validUntil).to.equal(until);

      // the third certifier is too late
      await expect(approve(batchId, certifier3, ATTESTED, until)).to.be.revertedWithCustomError(
        ledger,
        "WrongBatchState",
      );
    });

    it("takes the SMALLEST amount and the EARLIEST date that were named", async function () {
      const batchId = await proposedBatch();
      const now0 = await now();

      await approve(batchId, certifier, 90n, now0 + 5000);
      await approve(batchId, certifier2, 70n, now0 + 3000);

      const batch = await ledger.batches(batchId);
      expect(batch.state).to.equal(BatchState.Certified);
      expect(batch.attestedAmount).to.equal(70n);
      expect(batch.validUntil).to.equal(now0 + 3000);
    });

    it("the order of the votes does not matter: a LARGER second vote changes nothing", async function () {
      const batchId = await proposedBatch();
      const now0 = await now();

      // the first certifier is the most cautious, the second one is more generous
      await approve(batchId, certifier, 70n, now0 + 3000);
      await approve(batchId, certifier2, 90n, now0 + 5000);

      const batch = await ledger.batches(batchId);
      expect(batch.attestedAmount).to.equal(70n);
      expect(batch.validUntil).to.equal(now0 + 3000);
    });

    it("tells the orchestrator who won and with which amount", async function () {
      const batchId = await proposedBatch();
      const until = (await now()) + 1000;

      const first = await ledger.connect(orchestrator).voteApprove.staticCall(batchId, certifier.address, 90n, until, HASH);
      expect(first[0]).to.equal(false);

      await approve(batchId, certifier, 90n, until);
      const second = await ledger.connect(orchestrator).voteApprove.staticCall(batchId, certifier2.address, 80n, until, HASH);
      expect(second[0]).to.equal(true);
      expect(second[1]).to.equal(80n);
    });

    it("one certifier can not vote twice (not even with another opinion)", async function () {
      const batchId = await proposedBatch();
      const until = (await now()) + 1000;
      await approve(batchId, certifier, ATTESTED, until);

      await expect(approve(batchId, certifier, ATTESTED, until)).to.be.revertedWithCustomError(ledger, "AlreadyVoted");
      await expect(reject(batchId, certifier)).to.be.revertedWithCustomError(ledger, "AlreadyVoted");
    });

    it("the manufacturer can not vote on his own batch", async function () {
      const batchId = await proposedBatch();
      const until = (await now()) + 1000;

      await expect(approve(batchId, manufacturer, ATTESTED, until)).to.be.revertedWithCustomError(
        ledger,
        "CertifierIsManufacturer",
      );
      await expect(reject(batchId, manufacturer)).to.be.revertedWithCustomError(ledger, "CertifierIsManufacturer");
    });

    it("can not confirm more than the manufacturer claimed, or zero", async function () {
      const batchId = await proposedBatch();
      const until = (await now()) + 1000;

      await expect(approve(batchId, certifier, CLAIMED + 1n, until)).to.be.revertedWithCustomError(
        ledger,
        "AmountAboveClaim",
      );
      await expect(approve(batchId, certifier, 0n, until)).to.be.revertedWithCustomError(ledger, "ZeroAmount");
    });

    it("needs a validity date in the future", async function () {
      const batchId = await proposedBatch();

      await expect(approve(batchId, certifier, ATTESTED, (await now()) - 10)).to.be.revertedWithCustomError(
        ledger,
        "ValidityInThePast",
      );
    });

    it("a refused vote leaves no trace (the certifier can vote again correctly)", async function () {
      const batchId = await proposedBatch();
      const until = (await now()) + 1000;

      await expect(approve(batchId, certifier, CLAIMED + 1n, until)).to.be.revertedWithCustomError(
        ledger,
        "AmountAboveClaim",
      );
      expect(await ledger.hasVoted(batchId, certifier.address)).to.equal(false);

      await approve(batchId, certifier, ATTESTED, until); // now it works
    });

    it("two votes 'no' reject the batch, and a rejected batch is final", async function () {
      const batchId = await proposedBatch();

      await expect(reject(batchId, certifier))
        .to.emit(ledger, "BatchVoted")
        .withArgs(batchId, certifier.address, false, 0, 0, HASH);
      expect((await ledger.batches(batchId)).state).to.equal(BatchState.Proposed);

      await expect(reject(batchId, certifier2)).to.emit(ledger, "BatchRejected").withArgs(batchId);
      expect((await ledger.batches(batchId)).state).to.equal(BatchState.Rejected);

      const until = (await now()) + 1000;
      await expect(approve(batchId, certifier3, ATTESTED, until)).to.be.revertedWithCustomError(
        ledger,
        "WrongBatchState",
      );
    });

    it("when the votes are split, the THIRD certifier decides", async function () {
      const until = (await now()) + 1000;

      // case 1: yes, no, yes -> certified
      let batchId = await proposedBatch();
      await approve(batchId, certifier, ATTESTED, until);
      await reject(batchId, certifier2);
      expect((await ledger.batches(batchId)).state).to.equal(BatchState.Proposed);
      await approve(batchId, certifier3, ATTESTED, until);
      expect((await ledger.batches(batchId)).state).to.equal(BatchState.Certified);

      // case 2: yes, no, no -> rejected (a second batch)
      await ledger.connect(orchestrator).createBatch(manufacturer.address, 1, CLAIMED, HASH);
      batchId = 2;
      await approve(batchId, certifier, ATTESTED, until);
      await reject(batchId, certifier2);
      await reject(batchId, certifier3);
      expect((await ledger.batches(batchId)).state).to.equal(BatchState.Rejected);
    });

    it("can not vote on a batch that does not exist", async function () {
      const until = (await now()) + 1000;
      await expect(approve(99, certifier, ATTESTED, until)).to.be.revertedWithCustomError(ledger, "WrongBatchState");
    });

    it("the token is attached once, and only to a certified batch", async function () {
      const batchId = await proposedBatch();
      await expect(
        ledger.connect(orchestrator).attachToken(batchId, MAIN_TOKEN),
      ).to.be.revertedWithCustomError(ledger, "WrongBatchState");

      const until = (await now()) + 1000;
      await approve(batchId, certifier, ATTESTED, until);
      await approve(batchId, certifier2, ATTESTED, until);

      await ledger.connect(orchestrator).attachToken(batchId, MAIN_TOKEN);
      expect((await ledger.batches(batchId)).mainTokenId).to.equal(MAIN_TOKEN);

      await expect(
        ledger.connect(orchestrator).attachToken(batchId, 5n),
      ).to.be.revertedWithCustomError(ledger, "TokenAlreadyAttached");
    });

    it("the number of required votes is set at deployment and can not be zero", async function () {
      expect(await ledger.requiredVotes()).to.equal(REQUIRED_VOTES);

      await expect(
        ethers.deployContract("BatchLedger", [await registry.getAddress(), 0, WINDOW]),
      ).to.be.revertedWithCustomError(ledger, "InvalidQuorum");
    });

    it("with a quorum of 1 one certifier is enough", async function () {
      const single = await ethers.deployContract("BatchLedger", [await registry.getAddress(), 1, WINDOW]);
      await single.connect(orchestrator).recordRawMaterial(miner.address, HASH);
      await single.connect(orchestrator).createBatch(manufacturer.address, 1, CLAIMED, HASH);

      await single.connect(orchestrator).voteApprove(1, certifier.address, ATTESTED, (await now()) + 1000, HASH);
      expect((await single.batches(1)).state).to.equal(BatchState.Certified);
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

  describe("dispute and silence", function () {
    it("remembers when the delivery was confirmed", async function () {
      await sentPiece();
      expect((await ledger.pieces(PIECE)).deliveredAt).to.equal(0n);

      await ledger.connect(orchestrator).markDelivered(PIECE, transporter.address, HASH);
      expect((await ledger.pieces(PIECE)).deliveredAt).to.equal(await now());
    });

    it("the window is set at deployment and can not be zero", async function () {
      expect(await ledger.acceptanceWindow()).to.equal(WINDOW);

      await expect(
        ethers.deployContract("BatchLedger", [await registry.getAddress(), 2, 0]),
      ).to.be.revertedWithCustomError(ledger, "InvalidWindow");
    });

    it("the builder can object inside the window: the piece is Disputed", async function () {
      await deliveredPiece();

      await expect(ledger.connect(orchestrator).markDisputed(PIECE, builder.address, HASH))
        .to.emit(ledger, "PieceDisputed")
        .withArgs(PIECE, builder.address, HASH);

      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Disputed);
    });

    it("can not object after the window is closed", async function () {
      await deliveredPiece();
      await passTime(WINDOW + 100);

      await expect(
        ledger.connect(orchestrator).markDisputed(PIECE, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "DisputeWindowClosed");
    });

    it("can object only to a delivered piece", async function () {
      await sentPiece(); // still InTransit
      await expect(
        ledger.connect(orchestrator).markDisputed(PIECE, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");

      await ledger.connect(orchestrator).markDelivered(PIECE, transporter.address, HASH);
      await ledger.connect(orchestrator).markAccepted(PIECE, builder.address, HASH);
      await expect(
        ledger.connect(orchestrator).markDisputed(PIECE, builder.address, HASH), // already Accepted
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });

    it("a disputed piece is frozen until the judge decides", async function () {
      await deliveredPiece();
      await ledger.connect(orchestrator).markDisputed(PIECE, builder.address, HASH);

      await expect(
        ledger.connect(orchestrator).markAccepted(PIECE, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
      await expect(
        ledger.connect(orchestrator).markInstalled(PIECE, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");

      // silence does not work either: the piece is not Delivered any more
      await passTime(WINDOW + 100);
      await expect(
        ledger.connect(orchestrator).markAcceptedByTimeout(PIECE, manufacturer.address),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });

    it("the judge can accept the piece, and then it can be installed", async function () {
      await deliveredPiece();
      await ledger.connect(orchestrator).markDisputed(PIECE, builder.address, HASH);

      await expect(ledger.connect(orchestrator).resolveDispute(PIECE, admin.address, true, HASH))
        .to.emit(ledger, "PieceDisputeResolved")
        .withArgs(PIECE, admin.address, true, HASH);
      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Accepted);

      await ledger.connect(orchestrator).markInstalled(PIECE, builder.address, HASH);
      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Installed);
    });

    it("the judge can return the piece, and Returned is final", async function () {
      await deliveredPiece();
      await ledger.connect(orchestrator).markDisputed(PIECE, builder.address, HASH);

      await expect(ledger.connect(orchestrator).resolveDispute(PIECE, admin.address, false, HASH))
        .to.emit(ledger, "PieceDisputeResolved")
        .withArgs(PIECE, admin.address, false, HASH);
      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Returned);

      await expect(
        ledger.connect(orchestrator).markAccepted(PIECE, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
      await expect(
        ledger.connect(orchestrator).markInstalled(PIECE, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });

    it("the judge can decide only a piece that is Disputed", async function () {
      await deliveredPiece();
      await expect(
        ledger.connect(orchestrator).resolveDispute(PIECE, admin.address, true, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });

    it("silence: inside the window the piece can not be accepted by timeout", async function () {
      await deliveredPiece();

      await expect(
        ledger.connect(orchestrator).markAcceptedByTimeout(PIECE, manufacturer.address),
      ).to.be.revertedWithCustomError(ledger, "AcceptanceWindowOpen");
    });

    it("silence: after the window the piece counts as accepted", async function () {
      await deliveredPiece();
      await passTime(WINDOW + 100);

      await expect(ledger.connect(orchestrator).markAcceptedByTimeout(PIECE, manufacturer.address))
        .to.emit(ledger, "PieceAcceptedByTimeout")
        .withArgs(PIECE, manufacturer.address);
      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Accepted);

      // and the right to object is gone
      await expect(
        ledger.connect(orchestrator).markDisputed(PIECE, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });

    it("the builder can still accept himself after the window (nobody did it before)", async function () {
      await deliveredPiece();
      await passTime(WINDOW + 100);

      await ledger.connect(orchestrator).markAccepted(PIECE, builder.address, HASH);
      expect((await ledger.pieces(PIECE)).state).to.equal(PieceState.Accepted);
    });

    it("a piece that was never sent can not be disputed or accepted by silence", async function () {
      await expect(
        ledger.connect(orchestrator).markDisputed(555n, builder.address, HASH),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
      await expect(
        ledger.connect(orchestrator).markAcceptedByTimeout(555n, builder.address),
      ).to.be.revertedWithCustomError(ledger, "WrongPieceState");
    });

    it("a revoked batch freezes a disputed piece too", async function () {
      const batchId = await deliveredPiece();
      await ledger.connect(orchestrator).markDisputed(PIECE, builder.address, HASH);
      await ledger.connect(orchestrator).revokeBatch(batchId, certifier.address, HASH);

      await expect(
        ledger.connect(orchestrator).resolveDispute(PIECE, admin.address, true, HASH),
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
          "voteApprove",
          () => ledger.connect(stranger).voteApprove(1, certifier.address, ATTESTED, 9999999999, HASH),
        ],
        ["voteReject", () => ledger.connect(stranger).voteReject(1, certifier.address, HASH)],
        ["attachToken", () => ledger.connect(stranger).attachToken(1, 1)],
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
        ["markDisputed", () => ledger.connect(stranger).markDisputed(PIECE, stranger.address, HASH)],
        ["resolveDispute", () => ledger.connect(stranger).resolveDispute(PIECE, stranger.address, true, HASH)],
        ["markAcceptedByTimeout", () => ledger.connect(stranger).markAcceptedByTimeout(PIECE, stranger.address)],
      ];

      for (const [name, call] of calls) {
        await expect(call(), name).to.be.revertedWithCustomError(ledger, "NotOrchestrator");
      }
    });
  });
});