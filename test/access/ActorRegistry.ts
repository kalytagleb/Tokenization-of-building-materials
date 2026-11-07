import {expect} from "chai";
import {network} from "hardhat";
import { beforeEach, describe, it } from "node:test";

const {ethers} = await network.create();

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const MANUFACTURER_ROLE = ethers.id("MANUFACTURER_ROLE");

describe("ActorRegistry", function () {
    let admin: any;
    let company: any;
    let stranger: any;
    let registry: any;

    beforeEach(async function () {
        [admin, company, stranger] = await ethers.getSigners();
        registry = await ethers.deployContract("ActorRegistry", [admin.address]);
    });

    it("gives the admin role to the address passed to the constructor", async function () {
        expect(await registry.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
    });

    it("does not give any role to other address", async function () {
        expect(await registry.hasRole(DEFAULT_ADMIN_ROLE, stranger.address)).to.equal(false);
        expect(await registry.hasRole(MANUFACTURER_ROLE, company.address)).to.equal(false);
    });

    it("lets the admin grant a role and emits RoleGranted", async function () {
        await expect(registry.grantRole(MANUFACTURER_ROLE, company.address))
          .to.emit(registry, "RoleGranted")
          .withArgs(MANUFACTURER_ROLE, company.address, admin.address);

        expect(await registry.hasRole(MANUFACTURER_ROLE, company.address)).to.equal(true);
    });

    it("does not let a stranger grant a role", async function () {
        const message =
        `AccessControl: account ${stranger.address.toLowerCase()} ` +
        `is missing role ${DEFAULT_ADMIN_ROLE}`;

        await expect(
          registry.connect(stranger).grantRole(MANUFACTURER_ROLE, company.address),
        ).to.be.revertedWith(message);
    });

    it("lets the admin revoke a role and emits RoleRevoked", async function () {
        await registry.grantRole(MANUFACTURER_ROLE, company.address);

        await expect(registry.revokeRole(MANUFACTURER_ROLE, company.address))
          .to.emit(registry, "RoleRevoked")
          .withArgs(MANUFACTURER_ROLE, company.address, admin.address);

        expect(await registry.hasRole(MANUFACTURER_ROLE, company.address)).to.equal(false);
    });
});