require('dotenv').config();

const { initDatabase } = require('../db');
const { hashPassword, seedAdminUsersFromEnv } = require('../services/auth');
const { findAdminUserByUsername, createAdminUser } = require('../db');

function printUsage() {
  console.log('Kullanım: node scripts/create-admin.js <kullanici_adi> <sifre> [gorunen_ad]');
}

const username = process.argv[2];
const password = process.argv[3];
const displayName = process.argv[4] || username;

if (!username || !password) {
  printUsage();
  process.exit(1);
}

initDatabase();
seedAdminUsersFromEnv();

if (findAdminUserByUsername(username)) {
  console.error(`"${username}" kullanıcı adı zaten kayıtlı.`);
  process.exit(1);
}

createAdminUser({
  username,
  passwordHash: hashPassword(password),
  displayName,
});

console.log(`Admin kullanıcısı oluşturuldu: ${username}`);
