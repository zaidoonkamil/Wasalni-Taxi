const User = require("./user");
const UserDevice = require("./user_device");
const RideRequest = require("./ride_request");
const RideEvent = require("./ride_event");
const PricingSetting = require("./pricing_setting");
const SystemSetting = require("./system_setting");
const DriverDebtLedger = require("./driver_debt_ledger");

User.hasMany(UserDevice, { foreignKey: "user_id", as: "devices", onDelete: "CASCADE" });
UserDevice.belongsTo(User, { foreignKey: "user_id", as: "user" });

User.hasMany(RideRequest, { foreignKey: "rider_id", as: "rideRequests" });
User.hasMany(RideRequest, { foreignKey: "driver_id", as: "assignedRides" });
RideRequest.belongsTo(User, { foreignKey: "rider_id", as: "rider" });
RideRequest.belongsTo(User, { foreignKey: "driver_id", as: "driver" });

RideRequest.hasMany(RideEvent, { foreignKey: "ride_request_id", as: "events", onDelete: "CASCADE" });
RideEvent.belongsTo(RideRequest, { foreignKey: "ride_request_id", as: "ride" });

// Debt ledger associations
User.hasMany(DriverDebtLedger, { foreignKey: "driver_id", as: "debtLedger", onDelete: "CASCADE" });
DriverDebtLedger.belongsTo(User, { foreignKey: "driver_id", as: "driver" });

module.exports = {
  User,
  UserDevice,
  RideRequest,
  RideEvent,
  PricingSetting,
  SystemSetting,
  DriverDebtLedger,
};
