const db = require("./database");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatId TEXT NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      messageId INTEGER NOT NULL,
      chatId TEXT NOT NULL,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0
    )
  `);
});

function storeMessage(sender, chatId, text, recipients, callback) {
  const timestamp = Date.now();
  const cleanRecipients = Array.from(
    new Set((recipients || []).filter(u => u && u !== sender))
  );

  db.run(
    `INSERT INTO chat_history (chatId, sender, text, timestamp)
     VALUES (?, ?, ?, ?)`,
    [chatId, sender, text, timestamp],
    function (err) {
      if (err) {
        console.error("storeMessage history error:", err);
        if (callback) callback(false);
        return;
      }

      const messageId = this.lastID;

      if (cleanRecipients.length === 0) {
        if (callback) callback(true, { messageId, timestamp });
        return;
      }

      const stmt = db.prepare(`
        INSERT INTO pending_messages
          (messageId, chatId, sender, receiver, text, timestamp, delivered)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `);

      for (const receiver of cleanRecipients) {
        stmt.run([messageId, chatId, sender, receiver, text, timestamp]);
      }

      stmt.finalize(err2 => {
        if (err2) {
          console.error("storeMessage pending finalize error:", err2);
          if (callback) callback(false);
          return;
        }
        if (callback) callback(true, { messageId, timestamp });
      });
    }
  );
}

function getMessagesForUser(user, chatId, callback) {
  const sql = chatId
    ? `SELECT * FROM pending_messages
       WHERE receiver=? AND chatId=? AND delivered=0
       ORDER BY timestamp ASC`
    : `SELECT * FROM pending_messages
       WHERE receiver=? AND delivered=0
       ORDER BY timestamp ASC`;

  const params = chatId ? [user, chatId] : [user];

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error("getMessagesForUser error:", err);
      callback([]);
      return;
    }
    callback(rows || []);
  });
}

function markDelivered(messageId, receiver) {
  db.run(
    `UPDATE pending_messages
     SET delivered=1
     WHERE messageId=? AND receiver=?`,
    [messageId, receiver],
    err => {
      if (err) console.error("markDelivered error:", err);
    }
  );
}

function getHistory(chatId, limit, callback) {
  const lim = Number.isFinite(limit) ? limit : 200;

  db.all(
    `SELECT * FROM chat_history
     WHERE chatId=?
     ORDER BY timestamp ASC
     LIMIT ?`,
    [chatId, lim],
    (err, rows) => {
      if (err) {
        console.error("getHistory error:", err);
        callback([]);
        return;
      }
      callback(rows || []);
    }
  );
}

module.exports = {
  storeMessage,
  getMessagesForUser,
  markDelivered,
  getHistory
};