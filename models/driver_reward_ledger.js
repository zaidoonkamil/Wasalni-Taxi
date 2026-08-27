const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const DriverRewardLedger = sequelize.define(
  "DriverRewardLedger",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    driver_id: { type: DataTypes.INTEGER, allowNull: false },
    ride_request_id: { type: DataTypes.INTEGER, allowNull: true },
    type: { type: DataTypes.ENUM("grant", "use", "adjustment"), allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    balanceAfter: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    note: { type: DataTypes.TEXT, allowNull: true },
    admin_id: { type: DataTypes.INTEGER, allowNull: true },
  },
  {
    timestamps: true,
    tableName: "driver_reward_ledger",
    indexes: [{ fields: ["driver_id", "createdAt"] }],
  }
);

module.exports = DriverRewardLedger;
