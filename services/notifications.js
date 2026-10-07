const { User, UserDevice } = require("../models");
const NotificationLog = require("../models/notification_log");
const axios = require("axios");

// إعدادات الصوت لإشعار طلب الرحلة (نغمة alirt_driver)
const RIDE_REQUEST_SOUND = {
  existing_android_channel_id: "ride_requests",
  android_sound: "alirt_driver",
  ios_sound: "alirt_driver.wav",
};

const sendNotificationToDevices = async (playerIds, message, title = "Notification", extra = {}) => {
  const url = 'https://onesignal.com/api/v1/notifications';
  const headers = {
    'Authorization': `Basic ${process.env.ONESIGNAL_API_KEY}`,
    'Content-Type': 'application/json',
  };
  const data = {
    app_id: process.env.ONESIGNAL_APP_ID,
    include_player_ids: playerIds,
    contents: { en: message },
    headings: { en: title },
    ...extra,
  };

  return axios.post(url, data, { headers });
};

const sendNotificationToAll = async (message, title = "Notification") => {
  const users = await User.findAll({ attributes: ["id"] });
  for (const user of users) {
    const devices = await UserDevice.findAll({ where: { user_id: user.id } });
    const playerIds = devices.map(d => d.player_id);

    const logData = {
      title,
      message,
      target_type: "user",
      target_value: user.id.toString(),
      user_id: user.id, 
    };

    if (playerIds.length === 0) {
      logData.status = "failed";
      await NotificationLog.create(logData);
      continue;
    }

    try {
      await sendNotificationToDevices(playerIds, message, title);
      logData.status = "sent";
      await NotificationLog.create(logData);
    } catch (err) {
      console.error(`❌ Error sending notification to user ${user.id}:`, err.message);
      logData.status = "failed";
      await NotificationLog.create(logData);
    }
  }
};

const sendNotificationToRole = async (role, message, title = "Notification") => {
  const devices = await UserDevice.findAll({
    include: [{ model: User, as: "user", where: { role } }]
  });

  const devicesByUser = {};
  devices.forEach(d => {
    if (!devicesByUser[d.user_id]) devicesByUser[d.user_id] = [];
    devicesByUser[d.user_id].push(d.player_id);
  });

  for (const [userId, playerIds] of Object.entries(devicesByUser)) {
    const logData = {
      title,
      message,
      target_type: "user",
      target_value: userId.toString(),
      user_id: parseInt(userId), 
    };

    try {
      await sendNotificationToDevices(playerIds, message, title);
      logData.status = "sent";
      await NotificationLog.create(logData);
    } catch (err) {
      console.error(`❌ Error sending notification to user ${userId}:`, err.message);
      logData.status = "failed";
      await NotificationLog.create(logData);
    }
  }
};

const sendNotificationToUser = async (userId, message, title = "Notification", extra = {}) => {
  const devices = await UserDevice.findAll({
    where: { user_id: userId }  
  });

  console.log("🔎 Devices for user:", userId, devices.map(d => d.toJSON()));

  const playerIds = devices.map(d => d.player_id);

  const logData = {
    title,
    message,
    target_type: "user",
    target_value: userId.toString(),
    user_id: userId,
  };

  if (playerIds.length === 0) {
    logData.status = "failed";
    await NotificationLog.create(logData);
    return { success: false, message: `لا توجد أجهزة للمستخدم ${userId}` };
  }

  try {
    await sendNotificationToDevices(playerIds, message, title, extra);
    logData.status = "sent";
    await NotificationLog.create(logData);
    return { success: true };
  } catch (err) {
    console.error(`❌ Error sending notification to user ${userId}:`, err.message);
    logData.status = "failed";
    await NotificationLog.create(logData);
    return { success: false, error: err.message };
  }
};



// إشعار طلب رحلة جديد للكابتن. نفس الدالة تستخدمها كل طرق إنشاء الطلب.
// data.type يستخدمه التطبيق حتى يخفي الإشعار إذا جان مفتوح ويشغل نغمته الداخلية بدله
const sendRideRequestNotification = (driverId, requestId, priority = null) => {
  const title = priority ? `وصلني - ${priority.title}` : "زبون بالقرب منك! 📍";
  const message = priority
    ? priority.message
    : "زبون متواجد بالقرب منك يحتاج إلى توصيلة الآن. اقبل الرحلة عبر وصلني ولا تفوت الفرصة";

  return sendNotificationToUser(driverId, message, title, {
    ...RIDE_REQUEST_SOUND,
    data: { type: "ride_request", requestId: String(requestId) },
    // نفس الطلب ما يطلع إشعارين
    collapse_id: `ride_request_${requestId}`,
    // الطلب يصير قديم بسرعة، فإذا التلفون جان مطفي ما نوصله بعد دقيقة
    ttl: 60,
    // أولوية عالية حتى يوصل فوراً حتى لو التلفون بوضع توفير الطاقة
    priority: 10,
  });
};

module.exports = {
  sendNotificationToAll,
  sendNotificationToRole,
  sendNotificationToUser,
  sendRideRequestNotification,
  RIDE_REQUEST_SOUND,
};
