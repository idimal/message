const db = require("./database");

function createUser(id,password,callback){

    db.run(
        `INSERT INTO users(id,password) VALUES(?,?)`,
        [id,password],
        function(err){

            if(err){
                callback(false);
            }else{
                callback(true);
            }

        }
    );

}

function authUser(id,password,callback){

    db.get(
        `SELECT * FROM users WHERE id=? AND password=?`,
        [id,password],
        (err,row)=>{

            if(row){
                callback(true);
            }else{
                callback(false);
            }

        }
    );

}

function getAllUsers(callback){

    db.all(
        `SELECT id FROM users`,
        [],
        (err,rows)=>{

            callback(rows.map(r=>r.id));

        }
    );

}

module.exports={
    createUser,
    authUser,
    getAllUsers
};