const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const db = new sqlite3.Database(
    path.join(__dirname,"db","messages.db"),
    (err)=>{

        if(err){
            console.error("DB error",err);
        }else{
            console.log("Database connected");
        }

    }
);

module.exports = db;