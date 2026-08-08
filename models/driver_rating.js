const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const DriverRating = sequelize.define(
  "DriverRating",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    ride_request_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
    },
    rider_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    driver_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    rating: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1, max: 5 },
    },
    tags: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    comment: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    skipped: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    timestamps: true,
    tableName: "driver_ratings",
    indexes: [
      { fields: ["driver_id", "createdAt"] },
      { fields: ["rider_id", "createdAt"] },
      { fields: ["ride_request_id"], unique: true },
    ],
  }
);

module.exports = DriverRating;
