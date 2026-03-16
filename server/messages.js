const db = require("./database");

function storeMessage(sender, receiver, text, chatId){

    const time = Date.now();

    db.run(
        `INSERT INTO messages
        (sender,receiver,text,chatId,timestamp,delivered)
        VALUES (?,?,?,?,?,0)`,
        [sender,receiver,text,chatId,time],
        function(err){
            if(err) console.error(err);
        }
    );

}

function getMessagesForUser(user, chatId, callback){

    if(chatId){

        db.all(
            `SELECT * FROM messages
             WHERE receiver=? AND chatId=? AND delivered=0`,
            [user,chatId],
            (err,rows)=>{
                if(err){
                    console.error(err);
                    callback([]);
                }else{
                    callback(rows);
                }
            }
        );

    }else{

        db.all(
            `SELECT * FROM messages
             WHERE receiver=? AND delivered=0`,
            [user],
            (err,rows)=>{
                if(err){
                    console.error(err);
                    callback([]);
                }else{
                    callback(rows);
                }
            }
        );

    }

}

function markDelivered(id){

    db.run(
        `UPDATE messages SET delivered=1 WHERE id=?`,
        [id]
    );

}

module.exports = {
    storeMessage,
    getMessagesForUser,
    markDelivered
};