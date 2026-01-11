require('dotenv').config();
const express = require("express");
const sequelize = require("./config/db");

const usersRouter = require("./routes/user");
const notificationsRouter = require("./routes/notifications.js");
const ridesRouter = require("./routes/rides");
const adminRouter = require("./routes/admin");
const adminStatsRouter = require("./routes/adminStats");
const adminDebtRouter = require("./routes/adminDebt");

const redisService = require("./services/redis");
const socketService = require("./services/socket");
const chat = require("./routes/chatRoutes");

const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());
app.use("/uploads", express.static("./uploads"));

app.use("/", usersRouter);
app.use("/", notificationsRouter);
app.use("/", ridesRouter);
app.use("/", adminRouter);
app.use("/", adminStatsRouter);
app.use("/", adminDebtRouter);
app.use("/", chat.router);

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] }
});

(async () => {
  try {
    await redisService.init();
    await socketService.init(io);
    chat.initChatSocket(io);
 
    await sequelize.sync({ alter: true });
    console.log("✅ Database & tables synced!");

    server.listen(process.env.PORT || 1002, () => {
      console.log(`🚀 Server running on http://localhost:${process.env.PORT || 1002}`);
    });
  } catch (err) {
    console.error("❌ Startup error:", err);
    process.exit(1);
  }
})();
