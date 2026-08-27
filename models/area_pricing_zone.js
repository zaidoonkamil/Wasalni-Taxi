const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const AreaPricingZone = sequelize.define(
  "AreaPricingZone",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: true },
    type: {
      type: DataTypes.ENUM("rich", "poor"),
      allowNull: false,
    },
    centerLat: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    centerLng: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
    radiusMeters: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1000 },
    ordinaryPricePerKm: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
    superPricePerKm: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    timestamps: true,
    tableName: "area_pricing_zones",
    indexes: [
      { fields: ["type"] },
      { fields: ["active"] },
    ],
  }
);

module.exports = AreaPricingZone;
