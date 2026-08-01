const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: false
});

pool.on('connect', () => {
  console.log('✅ PostgreSQL Connected');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL Error', err);
});

module.exports = pool;
