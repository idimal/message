const db = require("../database");

db.serialize(()=>{

    db.run(`
    CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY,
        password TEXT
    )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender TEXT,
            receiver TEXT,
            text TEXT,
            chatId TEXT,
            timestamp INTEGER,
            delivered INTEGER
        )
    `);

});

console.log("DB initialized");