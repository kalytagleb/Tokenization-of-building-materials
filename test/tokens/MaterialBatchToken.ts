import {expect} from "chai";
import {network} from "hardhat";

const {ethers} = await network.create();

const ORCHESTRATOR_ROLE = ethers.id("ORCHESTRATOR_ROLE");

const TRANSFER_WHOLE_TOKEN = "transferFrom(address, address, uint256)";
const TRANSFER_VALUE_TO_TOKEN = "transferFrom(uint256, uint256, uint256)";
const TRANSFER_VALUE_TO_ADDRESS = "transferFrom(uint256, address, uint256)";
const BASE_URI = "https://passport.example/";

describe("MaterialBatchToken", function () {
    let admin: any;
    let orchestrator: any;
    let manufacturer: any;
    let builder: any;
    let stranger: any;

    let registry: any;
    let token: any;

    const SLOT = 4521n;
    const TOTAL = 100n;

    beforeEach(async function () {
        [admin, orchestrator, manufacturer, builder, stranger] = await ethers.getSigners();

        registry = await ethers.deployContract("ActorRegistry", [admin.address]);
        await registry.grantRole(ORCHESTRATOR_ROLE, orchestrator.address);

        token = await ethers.deployContract("MaterialBatchToken", [await registry.getAddress(), BASE_URI]);
    });

    async function mintFirstBatch() {
        await token.connect(orchestrator).mintBatch(manufacturer.address, SLOT, TOTAL);
        return 1n;
    }

    describe("minting", function() {
        it("creates a token with the right owner, slot and value", async function() {
            const id = await mintFirstBatch();

            expect(await token.ownerOf(id)).to.equal(manufacturer.address);
            expect(await token.slotOf(id)).to.equal(SLOT);
            expect(await token["balanceOf(uint256)"](id)).to.equal(TOTAL);
        });

        it("does not let a stranger mint", async function() {
            await expect(
                token.connect(stranger).mintBatch(stranger.address, SLOT, TOTAL),
            ).to.be.revertedWithCustomError(token, "NotOrchestrator");
        });
    });

    describe("splitting", function () {
        it("cuts a part into a new token of the same slot", async function () {
            const id = await mintFirstBatch();

            await token.connect(orchestrator).splitBatch(id, builder.address, 40n);
            const newId = 2n;

            expect(await token.ownerOf(newId)).to.equal(builder.address);
            expect(await token.slotOf(newId)).to.equal(SLOT);
            expect(await token["balanceOf(uint256)"](newId)).to.equal(40n);
            expect(await token["balanceOf(uint256)"](id)).to.equal(60n);
        });

        it("keeps the total value unchanged (conservation)", async function () {
            const id = await mintFirstBatch();

            await token.connect(orchestrator).splitBatch(id, builder.address, 40n);
            await token.connect(orchestrator).splitBatch(id, builder.address, 25n);

            const sum = 
              (await token["balanceOf(uint256)"](1n)) +
              (await token["balanceOf(uint256)"](2n)) +
              (await token["balanceOf(uint256)"](3n));
            expect(sum).to.equal(TOTAL);
        });

        it("does not let you cut more than the token has", async function () {
            const id = await mintFirstBatch();

            await expect(
                token.connect(orchestrator).splitBatch(id, builder.address, TOTAL + 1n),
            ).to.be.revertedWith("ERC3525: insufficient balance for transfer");
        });

        it("does not let a stranger split", async function () {
            const id = await mintFirstBatch();

            await expect(
                token.connect(stranger).splitBatch(id, stranger.address, 10n),
            ).to.be.revertedWithCustomError(token, "NotOrchestrator");
        });
    });

    describe("moving", function () {
        it("lets the orchestrator move a token to another owner", async function () {
            const id = await mintFirstBatch();

            await token.connect(orchestrator).moveToken(manufacturer.address, builder.address, id);

            expect(await token.ownerOf(id)).to.equal(builder.address);
        });

        it("does not the let the owner move the token directly", async function () {
            const id = await mintFirstBatch();

            await expect(
                token
                  .connect(manufacturer)
                  [TRANSFER_WHOLE_TOKEN](manufacturer.address, builder.address, id),
            ).to.be.revertedWithCustomError(token, "NotOrchestrator");
        });
    });

    describe("metadata addresses", function () {
        it("tokenURI is the base address plus the token id", async function () {
            const id = await mintFirstBatch();

            expect(await token.tokenURI(id)).to.equal(BASE_URI + "1");
        });

        it("slotURI and contractURI are built from the same base address", async function () {
            expect(await token.slotURI(SLOT)).to.equal(BASE_URI + "slot/" + SLOT.toString());
            expect(await token.contractURI()).to.equal(
                BASE_URI + "contract/" + (await token.getAddress()).toLowerCase(),
            );
        });

        it("tokenURI of a token that does not exist is refused", async function () {
            await expect(token.tokenURI(99)).to.be.revertedWith("ERC3525: invalid token ID");
        });

        it("the orchestrator can change the base address, a stranger can not", async function () {
            const id = await mintFirstBatch();

            await expect(token.connect(stranger).setBaseURI("https://evil.example/")).to.be.revertedWithCustomError(
                token,
                "NotOrchestrator",
            );

            await expect(token.connect(orchestrator).setBaseURI("https://new.example/"))
                .to.emit(token, "BaseURIChanged")
                .withArgs("https://new.example/");
            expect(await token.tokenURI(id)).to.equal("https://new.example/1");
        });

        it("changing the address does not touch owner, value or lock", async function () {
            const id = await mintFirstBatch();
            await token.connect(orchestrator).lockToken(id);

            await token.connect(orchestrator).setBaseURI("https://new.example/");

            expect(await token.ownerOf(id)).to.equal(manufacturer.address);
            expect(await token["balanceOf(uint256)"](id)).to.equal(TOTAL);
            expect(await token.locked(id)).to.equal(true);
        });

        it("an empty base address gives empty metadata addresses", async function () {
            const bare = await ethers.deployContract("MaterialBatchToken", [await registry.getAddress(), ""]);
            await bare.connect(orchestrator).mintBatch(manufacturer.address, SLOT, TOTAL);

            expect(await bare.tokenURI(1)).to.equal("");
        });
    });

    describe("locking (soulbound)", function () {
        it("locks a token and emits locked", async function () {
            const id = await mintFirstBatch();
            expect(await token.locked(id)).to.equal(false);

            await expect(token.connect(orchestrator).lockToken(id))
              .to.emit(token, "Locked")
              .withArgs(id);

            expect(await token.locked(id)).to.equal(true);
        });

        it("does not let a stranger lock", async function () {
            const id = await mintFirstBatch();

            await expect(
                token.connect(stranger).lockToken(id),
            ).to.be.revertedWithCustomError(token, "NotOrchestrator");
        });

        it("cannot be locked twice", async function () {
            const id = await mintFirstBatch();
            await token.connect(orchestrator).lockToken(id);

            await expect(
                token.connect(orchestrator).lockToken(id),
            ).to.be.revertedWithCustomError(token, "AlreadyLocked");
        });

        it("reverts locked() and lockToken() for a token that does not exist", async function () {
            await expect(token.locked(999n)).to.be.revertedWith("ERC3525: invalid token ID");
            await expect(token.connect(orchestrator).lockToken(999n)).to.be.revertedWith(
                "ERC3525: invalid token ID",
            );
        });

        it("announces EIP-5192 support through ERC-165", async function () {
            expect(await token.supportsInterface("0xb45a3c0e")).to.equal(true);
        });
    });

    describe("after the lock", function () {
        let lockedId: bigint;
        let otherId: bigint;

        beforeEach(async function () {
            lockedId = await mintFirstBatch();
            await token.connect(orchestrator).splitBatch(lockedId, manufacturer.address, 40n);
            otherId = 2n;

            await token.connect(orchestrator).lockToken(lockedId);
        });

        it("path 1: the whole token can not be moved by the orchestrator", async function () {
            await expect(
                token.connect(orchestrator).moveToken(manufacturer.address, builder.address, lockedId),
            ).to.be.revertedWithCustomError(token, "TokenIsLocked");
        });

        it("path 1: the whole token can not be moved by its owner", async function () {
            await expect(
                token.connect(manufacturer)[TRANSFER_WHOLE_TOKEN](manufacturer.address, builder.address, lockedId),
            ).to.be.revertedWithCustomError(token, "TokenIsLocked");
        });

        it("path 2: value can not leave the locked token to another token", async function () {
            await expect(
                token.connect(manufacturer)[TRANSFER_VALUE_TO_TOKEN](lockedId, otherId, 10n),
            ).to.be.revertedWithCustomError(token, "TokenIsLocked");
        });

        it("path 3: value can not leave the locked token to an address", async function () {
            await expect(
                token.connect(manufacturer)[TRANSFER_VALUE_TO_ADDRESS](lockedId, builder.address, 10n),
            ).to.be.revertedWithCustomError(token, "TokenIsLocked");
        });

        it("the orchestrator can not split a locked token", async function () {
            await expect(
                token.connect(orchestrator).splitBatch(lockedId, builder.address, 10n),
            ).to.be.revertedWithCustomError(token, "TokenIsLocked");
        });

        it("value can not be added INTO a locked token", async function () {
            await expect(
                token.connect(manufacturer)[TRANSFER_VALUE_TO_TOKEN](otherId, lockedId, 10n),
            ).to.be.revertedWithCustomError(token, "TokenIsLocked");
        });

        it("the locked token keeps its value and owner", async function () {
            expect(await token["balanceOf(uint256)"](lockedId)).to.equal(60n);
            expect(await token.ownerOf(lockedId)).to.equal(manufacturer.address);
        });
    });
})