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
};

module.exports = ensureSchema;
