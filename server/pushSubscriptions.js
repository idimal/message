// pushSubscriptions.js
const db = require("./database");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      expirationTime INTEGER,
      createdAt INTEGER NOT NULL
    )
  `);
});

function saveSubscription(userId, subscription, callback) {
  try {
    if (!userId || !subscription || !subscription.endpoint || !subscription.keys) {
      if (callback) callback(false);
      return;
    }

    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys.p256dh;
    const auth = subscription.keys.auth;
    const expirationTime = subscription.expirationTime ?? null;

    if (!p256dh || !auth) {
      if (callback) callback(false);
      return;
    }

    db.run(
      `
      INSERT INTO push_subscriptions
        (endpoint, userId, p256dh, auth, expirationTime, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        userId=excluded.userId,
        p256dh=excluded.p256dh,
        auth=excluded.auth,
        expirationTime=excluded.expirationTime,
        createdAt=excluded.createdAt
      `,
      [endpoint, userId, p256dh, auth, expirationTime, Date.now()],
      err => {
        if (err) {
          console.error("saveSubscription error:", err);
          if (callback) callback(false);
          return;
        }
        if (callback) callback(true);
      }
    );
  } catch (e) {
    console.error("saveSubscription fatal:", e);
    if (callback) callback(false);
  }
}

function getSubscriptionsForUser(userId, callback) {
  db.all(
    `SELECT * FROM push_subscriptions WHERE userId=?`,
    [userId],
    (err, rows) => {
      if (err) {
        console.error("getSubscriptionsForUser error:", err);
        callback([]);
        return;
      }
      callback(rows || []);
    }
  );
}

function deleteSubscription(endpoint, callback) {
  db.run(
    `DELETE FROM push_subscriptions WHERE endpoint=?`,
    [endpoint],
    err => {
      if (err) console.error("deleteSubscription error:", err);
      if (callback) callback(!err);
    }
  );
}

module.exports = {
  saveSubscription,
  getSubscriptionsForUser,
  deleteSubscription
};