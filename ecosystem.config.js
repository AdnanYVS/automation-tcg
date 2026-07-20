module.exports = {
  apps: [{
    name: 'automation-tcg',
    script: 'src/index.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
    },
  }],
};
