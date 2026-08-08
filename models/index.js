const User = require("./user");
const UserDevice = require("./user_device");
const RideRequest = require("./ride_request");
const RideEvent = require("./ride_event");
const PricingSetting = require("./pricing_setting");
const SystemSetting = require("./system_setting");
const DriverDebtLedger = require("./driver_debt_ledger");
const ChatMessage = require("./ChatMessage");
const OtpCode = require("./OtpCode");
const PasswordResetOtp = require("./PasswordResetOtp");
const Advertisement = require("./advertisement");
const DriverRating = require("./driver_rating");

User.hasMany(UserDevice, { foreignKey: "user_id", as: "devices", onDelete: "CASCADE" });
UserDevice.belongsTo(User, { foreignKey: "user_id", as: "user" });

User.hasMany(RideRequest, { foreignKey: "rider_id", as: "rideRequests" });
User.hasMany(RideRequest, { foreignKey: "driver_id", as: "assignedRides" });
RideRequest.belongsTo(User, { foreignKey: "rider_id", as: "rider" });
RideRequest.belongsTo(User, { foreignKey: "driver_id", as: "driver" });

User.hasMany(DriverRating, { foreignKey: "driver_id", as: "receivedRatings", onDelete: "CASCADE" });
User.hasMany(DriverRating, { foreignKey: "rider_id", as: "givenDriverRatings", onDelete: "CASCADE" });
DriverRating.belongsTo(User, { foreignKey: "driver_id", as: "driver" });
DriverRating.belongsTo(User, { foreignKey: "rider_id", as: "rider" });
RideRequest.hasOne(DriverRating, { foreignKey: "ride_request_id", as: "driverRating", onDelete: "CASCADE" });
DriverRating.belongsTo(RideRequest, { foreignKey: "ride_request_id", as: "ride" });

RideRequest.hasMany(RideEvent, { foreignKey: "ride_request_id", as: "events", onDelete: "CASCADE" });
RideEvent.belongsTo(RideRequest, { foreignKey: "ride_request_id", as: "ride" });

// Debt ledger associations
User.hasMany(DriverDebtLedger, { foreignKey: "driver_id", as: "debtLedger", onDelete: "CASCADE" });
DriverDebtLedger.belongsTo(User, { foreignKey: "driver_id", as: "driver" });

ChatMessage.belongsTo(User, { as: "sender", foreignKey: "senderId" , onDelete: 'CASCADE'});
ChatMessage.belongsTo(User, { as: "receiver", foreignKey: "receiverId" , onDelete: 'CASCADE' });

User.hasMany(ChatMessage, { as: "sentMessages", foreignKey: "senderId" , onDelete: 'CASCADE' });
User.hasMany(ChatMessage, { as: "receivedMessages", foreignKey: "receiverId" , onDelete: 'CASCADE'});


module.exports = {
  User,
  UserDevice,
  RideRequest,
  RideEvent,
  PricingSetting,
  SystemSetting,
  DriverDebtLedger,
  ChatMessage,
  OtpCode,
  PasswordResetOtp,
  Advertisement,
  DriverRating,
};
