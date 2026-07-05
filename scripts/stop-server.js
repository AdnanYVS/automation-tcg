require('dotenv').config();

const killPort = require('kill-port');
const port = Number(process.env.PORT || 3000);

killPort(port)
  .then(() => console.log(`Port ${port} üzerindeki sunucu durduruldu.`))
  .catch(() => console.log(`Port ${port} üzerinde çalışan bir süreç bulunamadı.`));
