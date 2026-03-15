const db = require("./database");

function storeMessage(sender,receiver,text){

    const time = Date.now();

    db.run(
        `INSERT INTO messages
        (sender,receiver,text,timestamp,delivered)
        VALUES (?,?,?,?,0)`,
        [sender,receiver,text,time],
        function(err){

            if(err){
                console.error(err);
            }

        }
    );

}

function getMessages(user,callback){

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

function markDelivered(id){

    db.run(
        `UPDATE messages SET delivered=1 WHERE id=?`,
        [id]
    );

}

module.exports={
    storeMessage,
    getMessages,
    markDelivered
};