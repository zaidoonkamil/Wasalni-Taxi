const { DriverRewardLedger, DriverDebtLedger } = require("../models");
const redisService = require("./redis");

const parseAmount = (value) => {
  const amount = parseFloat(value || 0);
  return Number.isFinite(amount) ? amount : 0;
};

const grantDriverReward = async ({ driver, amount, note, adminId, transaction }) => {
  const parsed = parseAmount(amount);
  if (parsed <= 0) throw new Error("Invalid amount");

  const previousBalance = parseAmount(driver.driverRewardBalance);
  const nextBalance = previousBalance + parsed;
  driver.driverRewardBalance = nextBalance;

  await DriverRewardLedger.create(
    {
      driver_id: driver.id,
      type: "grant",
      amount: parsed,
      balanceAfter: nextBalance,
      note: note || "admin reward",
      admin_id: adminId || null,
    },
    { transaction }
  );

  await driver.save({ transaction });
  return { driver, granted: parsed, previousBalance, nextBalance };
};

const applyCommissionWithReward = async ({
  driver,
  rideRequestId,
  commissionAmount,
  debtLimit,
  transaction,
}) => {
  const commission = parseAmount(commissionAmount);
  if (commission <= 0) {
    return { usedReward: 0, addedDebt: 0, debt: parseAmount(driver.driverDebt), rewardBalance: parseAmount(driver.driverRewardBalance) };
  }

  const previousReward = parseAmount(driver.driverRewardBalance);
  const usedReward = Math.min(previousReward, commission);
  const addedDebt = commission - usedReward;
  const nextReward = previousReward - usedReward;

  if (usedReward > 0) {
    driver.driverRewardBalance = nextReward;
    await DriverRewardLedger.create(
      {
        driver_id: driver.id,
        ride_request_id: rideRequestId,
        type: "use",
        amount: usedReward,
        balanceAfter: nextReward,
        note: "commission covered by driver reward",
      },
      { transaction }
    );
  }

  if (addedDebt > 0) {
    const prevDebt = parseAmount(driver.driverDebt);
    const newDebt = prevDebt + addedDebt;
    driver.driverDebt = newDebt;

    await DriverDebtLedger.create(
      {
        driver_id: driver.id,
        ride_request_id: rideRequestId,
        type: "charge",
        amount: addedDebt,
        note: usedReward > 0
          ? `commission remainder after reward used: ${usedReward}`
          : "commission on completed ride",
      },
      { transaction }
    );

    if (debtLimit != null && newDebt >= debtLimit) {
      driver.isDebtBlocked = true;
      driver.blockReason = "debt";
      try {
        const redisClient = redisService.client();
        await redisClient.sAdd("drivers:debt_blocked", String(driver.id));
        await redisClient.del(`driver:state:${driver.id}`);
        await redisClient.sRem("drivers:online", String(driver.id));
        await redisClient.sendCommand(["ZREM", "drivers:geo", String(driver.id)]);
        await redisClient.del(`driver:loc:${driver.id}`);
      } catch (e) {}
    }
  }

  await driver.save({ transaction });
  return {
    usedReward,
    addedDebt,
    debt: parseAmount(driver.driverDebt),
    rewardBalance: parseAmount(driver.driverRewardBalance),
  };
};

module.exports = {
  grantDriverReward,
  applyCommissionWithReward,
};
