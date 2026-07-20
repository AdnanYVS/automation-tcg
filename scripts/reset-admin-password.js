require('dotenv').config();

const { initDatabase } = require('../db');
const { hashPassword } = require('../services/auth');
const { findAdminUserByUsername, updateAdminUserPassword } = require('../db');

function printUsage() {
  console.log('Kullanım: node scripts/reset-admin-password.js <kullanici_adi> <yeni_sifre>');
}

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  printUsage();
  process.exit(1);
}

initDatabase();

const user = findAdminUserByUsername(username);
if (!user) {
  console.error(`"${username}" bulunamadı. Önce: npm run admin:create -- ${username} ${password}`);
  process.exit(1);
}

updateAdminUserPassword(user.id, hashPassword(password));
console.log(`"${username}" şifresi güncellendi.`);
