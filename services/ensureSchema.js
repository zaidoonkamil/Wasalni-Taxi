const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const addColumnIfMissing = async (tableName, columnName, definition) => {
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable(tableName);
  if (!table[columnName]) {
    await queryInterface.addColumn(tableName, columnName, definition);
  }
};

const ensureSchema = async () => {
  await addColumnIfMissing("Users", "vehicleCategory", {
    type: DataTypes.ENUM("ordinary", "super"),
    allowNull: false,
    defaultValue: "ordinary",
  });

  await addColumnIfMissing("Users", "driverRewardBalance", {
    type: DataTypes.DECIMAL(14, 2),
    allowNull: false,
    defaultValue: 0,
  });

  await addColumnIfMissing("ride_requests", "serviceType", {
    type: DataTypes.ENUM("ordinary", "super"),
    allowNull: false,
    defaultValue: "ordinary",
  });

  await addColumnIfMissing("ride_requests", "pricingAreaType", {
    type: DataTypes.ENUM("rich", "poor", "mixed"),
    allowNull: false,
    defaultValue: "mixed",
  });

  await addColumnIfMissing("ride_requests", "pricingZoneId", {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  });

  await addColumnIfMissing("pricing_settings", "serviceType", {
    type: DataTypes.ENUM("ordinary", "super"),
    allowNull: false,
    defaultValue: "ordinary",
  });

  await addColumnIfMissing("pricing_settings", "areaType", {
    type: DataTypes.ENUM("rich", "poor", "mixed"),
    allowNull: false,
    defaultValue: "mixed",
  });

  await addColumnIfMissing("area_pricing_zones", "ordinaryPricePerKm", {
    type: DataTypes.DECIMAL(10, 3),
    allowNull: true,
  });

  await addColumnIfMissing("area_pricing_zones", "superPricePerKm", {
    type: DataTypes.DECIMAL(10, 3),
    allowNull: true,
  });
};

module.exports = ensureSchema;
