const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Advertisement = sequelize.define(
  "Advertisement",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    title: { type: DataTypes.STRING, allowNull: false, defaultValue: "" },
    description: { type: DataTypes.STRING, allowNull: true },
    image: { type: DataTypes.STRING, allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    updatedByAdminId: { type: DataTypes.INTEGER, allowNull: true },
  },
  { timestamps: true, tableName: "advertisements" }
);

module.exports = Advertisement;
