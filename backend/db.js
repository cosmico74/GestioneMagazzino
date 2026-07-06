const mysql = require('mysql2/promise');
const fs = require('fs');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    ssl: {
        ca: fs.readFileSync('./ca.pem')  // il certificato scaricato da Aiven
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

function now() { return new Date(); }

module.exports = pool;
module.exports.now = now;