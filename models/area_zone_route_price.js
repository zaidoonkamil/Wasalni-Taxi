const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const AreaZoneRoutePrice = sequelize.define(
  "AreaZoneRoutePrice",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    fromZoneId: { type: DataTypes.INTEGER, allowNull: false },
    toZoneId: { type: DataTypes.INTEGER, allowNull: false },
    ordinaryPricePerKm: { type: DataTypes.DECIMAL(10, 3), allowNull: false },
    superPricePerKm: { type: DataTypes.DECIMAL(10, 3), allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    timestamps: true,
    tableName: "area_zone_route_prices",
    indexes: [
      { unique: true, fields: ["fromZoneId", "toZoneId"] },
      { fields: ["active"] },
    ],
  }
);

module.exports = AreaZoneRoutePrice;
